"""asyncio Unix-domain-socket server + request dispatcher.

Binds at `config.socket_path`, accepts connections (one per agent
container in V1), reads length-prefixed JSON requests via `core/ipc.py`,
dispatches to the right handler via `core/registry.py`, writes the
response, closes the connection.

One connection per request — no keepalive, no multiplexing. Connection
overhead is dominated by the actual mint roundtrip (10s of ms), so the
extra TCP handshake equivalent is in the noise.

Lifecycle:
- `bind()` creates the socket file with the right ownership/perms.
  Refuses to start if the configured `socket_group` doesn't exist on
  the host (per DESIGN.md §10 — silent misconfiguration is the
  failure mode we're explicitly defending against).
- `serve_forever()` is the daemon's main loop.
- `stop()` is called by SIGTERM/SIGINT handlers — stops accepting
  new connections, drains in-flight requests, removes the socket file.

Error isolation: any exception inside a request handler is caught,
logged, and translated into a wire-level error response. A panicking
handler does NOT take down the daemon.
"""

from __future__ import annotations

import asyncio
import contextlib
import grp
import os
import stat as stat_module
import struct
import traceback
from pathlib import Path
from typing import Any

import structlog

from apiarist.core.ipc import (
    LENGTH_PREFIX_BYTES,
    LENGTH_PREFIX_FORMAT,
    MAX_PAYLOAD_BYTES,
    ErrorCode,
    ErrorResponse,
    FramingError,
    ProtocolError,
    SuccessResponse,
    decode_request,
    encode_message,
)
from apiarist.core.registry import Registry

log = structlog.get_logger()


class Server:
    """asyncio UDS server bound to one socket path.

    Construct once per daemon, share the registry between this and
    feature setup code.
    """

    def __init__(
        self,
        *,
        socket_path: Path,
        socket_group: str,
        registry: Registry,
        read_timeout_seconds: float = 30.0,
    ) -> None:
        self._socket_path = socket_path
        self._socket_group = socket_group
        self._registry = registry
        # Bound the time a client can hold an accepted connection without
        # finishing a request. Defends against slowloris-style attackers
        # parking many sockets under our connection limit. 30s is well
        # above expected p99 (clients fire one request immediately on
        # connect; the round-trip is bounded by backend timeout, not by
        # client behaviour).
        self._read_timeout = read_timeout_seconds
        self._server: asyncio.base_events.Server | None = None

    async def bind(self) -> None:
        """Create the socket, set perms, refuse to start on misconfig.

        Three things must succeed before we accept any connections:
          1. `socket_group` exists in /etc/group (else operator typo).
          2. Socket file gets created with that group ownership.
          3. Socket mode is 660 — no world bits.

        Any failure is loud (stderr + structured log + exception). The
        daemon should not start on a half-configured socket because the
        next step (chmod 666 by a panicking operator) is exactly the
        privilege-escalation foot-gun we're defending against.
        """
        try:
            group_info = grp.getgrnam(self._socket_group)
        except KeyError as exc:
            raise RuntimeError(
                f"socket_group {self._socket_group!r} does not exist on this host; "
                "refusing to start (would otherwise create a socket no client could read). "
                "Create the group via the deploy script, or fix apiarist.yaml's socket_group."
            ) from exc

        # Pre-bind cleanup. If a previous daemon crashed without removing
        # its socket, the bind would fail with EADDRINUSE. Removing a
        # stale stream socket file is safe — there can be no in-flight
        # process holding it (we'd be that process).
        #
        # Refuse to delete anything that ISN'T a socket: if a typo in
        # the deploy config points apiarist at, say, /etc/passwd, an
        # unconditional unlink would silently destroy it. Use lstat
        # (not stat) so a symlink to a non-socket also fails closed.
        if self._socket_path.exists() or self._socket_path.is_symlink():
            existing_mode = self._socket_path.lstat().st_mode
            if not stat_module.S_ISSOCK(existing_mode):
                raise RuntimeError(
                    f"socket_path {self._socket_path} exists but is not a Unix "
                    f"socket (mode={oct(existing_mode)}); refusing to overwrite. "
                    "Check apiarist.yaml's socket_path or remove the file manually."
                )
            log.info("removing stale socket file", path=str(self._socket_path))
            self._socket_path.unlink()

        # Make sure the parent dir exists before binding.
        self._socket_path.parent.mkdir(parents=True, exist_ok=True)

        # Close the TOCTOU window between socket creation and chmod by
        # tightening umask BEFORE bind. Linux creates the socket with
        # mode `0o777 & ~umask`; with a typical operator umask of 022
        # that produces a world-readable+writable socket for the
        # microseconds between start_unix_server returning and our
        # explicit chmod below. A racing inotify watcher inside the
        # socket-group user could connect in that window. Tightening
        # umask to 0o117 guarantees the socket is born with mode 0o660.
        # We restore the prior umask immediately so this binding step
        # doesn't bleed into the rest of the process. The explicit
        # chown + chmod below is belt-and-braces.
        old_umask = os.umask(0o117)
        try:
            self._server = await asyncio.start_unix_server(
                self._handle_connection, path=str(self._socket_path)
            )
        finally:
            os.umask(old_umask)

        # asyncio doesn't set group ownership on the socket file — we
        # have to. SO_PEERCRED-based attestation (DESIGN.md §11 future
        # hardening) is the only thing that gates per-caller identity
        # beyond this; for V1 the group permission IS the gate.
        os.chown(self._socket_path, -1, group_info.gr_gid)
        os.chmod(self._socket_path, 0o660)

        log.info(
            "uds server bound",
            socket_path=str(self._socket_path),
            socket_group=self._socket_group,
            ops=self._registry.list_ops(),
        )

    async def serve_forever(self) -> None:
        """Block forever serving the socket. Returns when `stop()` is called."""
        if self._server is None:
            raise RuntimeError("call bind() before serve_forever()")
        async with self._server:
            await self._server.serve_forever()

    async def stop(self) -> None:
        """Stop accepting new connections, wait for in-flight, remove socket file.

        Idempotent — calling twice is safe (the second call is a no-op).
        Used by SIGTERM/SIGINT handlers.
        """
        if self._server is None:
            return
        log.info("uds server stopping")
        self._server.close()
        with contextlib.suppress(asyncio.CancelledError):
            await self._server.wait_closed()
        with contextlib.suppress(FileNotFoundError):
            self._socket_path.unlink()
        self._server = None
        log.info("uds server stopped")

    # -----------------------------------------------------------------
    # Per-connection handler
    # -----------------------------------------------------------------

    async def _handle_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        """One request → one response → close.

        Catches every exception class so a malformed client or a buggy
        handler can't kill the server loop. All errors that reach the
        wire go through `_send_error`.
        """
        request_id: str | None = None
        try:
            request = await asyncio.wait_for(
                self._read_request(reader), timeout=self._read_timeout
            )
            request_id = request.request_id
            log.debug("request received", op=request.op, request_id=request_id)

            handler = self._registry.get(request.op)
            if handler is None:
                await self._send_error(
                    writer, request_id, ErrorCode.UNKNOWN_OP,
                    f"op {request.op!r} not registered (known ops: {self._registry.list_ops()})",
                )
                return

            try:
                data = await handler(request.params)
            except Exception as exc:
                code, message = _classify_handler_error(exc)
                # INTERNAL gets the traceback in the structured log so
                # we can debug without it ever reaching the wire.
                if code == ErrorCode.INTERNAL:
                    log.error(
                        "handler raised unhandled exception",
                        op=request.op,
                        request_id=request_id,
                        exc_class=type(exc).__name__,
                        traceback=traceback.format_exc(),
                    )
                else:
                    log.info(
                        "handler returned typed error",
                        op=request.op,
                        request_id=request_id,
                        code=code,
                    )
                await self._send_error(writer, request_id, code, message)
                return

            response = SuccessResponse(request_id=request_id, data=data)
            await self._send(writer, response.to_wire())
            log.debug("request ok", op=request.op, request_id=request_id)

        except FramingError as exc:
            log.info("framing error from client", error=str(exc))
            await self._send_error(writer, request_id, ErrorCode.BAD_REQUEST, str(exc))
        except ProtocolError as exc:
            log.info("protocol error from client", error=str(exc))
            await self._send_error(writer, request_id, ErrorCode.BAD_REQUEST, str(exc))
        except TimeoutError:
            # Client opened the connection but didn't finish a complete
            # request within self._read_timeout. Reply with BAD_REQUEST
            # so a well-behaved (just slow) client still sees a useful
            # error envelope before we hang up.
            log.info(
                "client read timeout",
                request_id=request_id,
                timeout_seconds=self._read_timeout,
            )
            await self._send_error(
                writer, request_id, ErrorCode.BAD_REQUEST,
                f"no complete request within {self._read_timeout}s",
            )
        except (ConnectionResetError, BrokenPipeError):
            # Client hung up mid-request — nothing useful to log beyond debug.
            log.debug("client disconnected mid-request", request_id=request_id)
        except Exception:
            log.error(
                "unexpected error in connection handler",
                request_id=request_id,
                traceback=traceback.format_exc(),
            )
            with contextlib.suppress(Exception):
                await self._send_error(
                    writer, request_id, ErrorCode.INTERNAL,
                    "internal error (see daemon logs)",
                )
        finally:
            with contextlib.suppress(Exception):
                writer.close()
                await writer.wait_closed()

    # -----------------------------------------------------------------
    # Wire helpers
    # -----------------------------------------------------------------

    async def _read_request(self, reader: asyncio.StreamReader) -> Any:
        """Read one length-prefixed message from the wire, parse to Request."""
        prefix = await reader.readexactly(LENGTH_PREFIX_BYTES)
        (length,) = struct.unpack(LENGTH_PREFIX_FORMAT, prefix)
        if length > MAX_PAYLOAD_BYTES:
            raise FramingError(
                f"declared payload length {length} exceeds cap {MAX_PAYLOAD_BYTES}"
            )
        body = await reader.readexactly(length)
        return decode_request(body)

    async def _send(
        self, writer: asyncio.StreamWriter, payload: dict[str, Any]
    ) -> None:
        """Encode + write one framed message."""
        writer.write(encode_message(payload))
        await writer.drain()

    async def _send_error(
        self,
        writer: asyncio.StreamWriter,
        request_id: str | None,
        code: str,
        message: str,
    ) -> None:
        envelope = ErrorResponse(request_id=request_id, code=code, message=message).to_wire()
        with contextlib.suppress(Exception):
            await self._send(writer, envelope)


def _classify_handler_error(exc: Exception) -> tuple[str, str]:
    """Translate a feature handler's exception into (wire_code, wire_message).

    Imports BackendError lazily so this module doesn't take a hard
    dependency on the tokens feature — a future apiarist with no
    backend client (e.g. spawn-only V2 minimal build) should still
    work without circular imports.
    """
    from apiarist.core.backend import (
        BackendForbiddenError,
        BackendNotImplementedError,
        BackendProtocolError,
        BackendRateLimitedError,
        BackendUnauthorizedError,
        BackendUnavailableError,
    )

    # Specific Backend* subclasses → specific wire codes.
    mapping = {
        BackendUnauthorizedError: ErrorCode.BACKEND_UNAUTHORIZED,
        BackendForbiddenError: ErrorCode.BACKEND_FORBIDDEN,
        BackendRateLimitedError: ErrorCode.BACKEND_RATE_LIMITED,
        BackendNotImplementedError: ErrorCode.BACKEND_NOT_IMPLEMENTED,
        BackendProtocolError: ErrorCode.BACKEND_PROTOCOL_ERROR,
        BackendUnavailableError: ErrorCode.BACKEND_UNAVAILABLE,
    }
    for exc_class, code in mapping.items():
        if isinstance(exc, exc_class):
            return code, str(exc)

    # ValueError from handlers means the request params didn't pass
    # the handler's own validation (the IPC layer only validates the
    # envelope; per-op param validation lives in the handler).
    if isinstance(exc, ValueError):
        return ErrorCode.BAD_REQUEST, str(exc)

    # Anything else is a bug — the handler should have caught it.
    return ErrorCode.INTERNAL, "internal error (see daemon logs)"
