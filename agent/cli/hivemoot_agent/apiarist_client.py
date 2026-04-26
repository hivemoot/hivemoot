"""Sync Python client for the apiarist Unix-domain-socket protocol.

Mirrors apiarist's wire format (see ``apiarist/src/apiarist/core/ipc.py``):

    | 4 bytes (big-endian uint32, payload length N) | N bytes UTF-8 JSON |

Each method opens a fresh socket, sends one request, reads one
response, closes. No connection pooling, no streaming — V1 ops are
infrequent (one mint per IDLE→ACTIVE transition, plus background
refresh once per token-lifetime) and the cost of a UDS connect is
trivial. Stateless connect-per-call also means a stale FD can't
poison subsequent requests.

This module is intentionally pure stdlib (socket + struct + json) so
it can be imported from any plugin without dragging asyncio runtime
state into a sync codepath. The engine's lifecycle subscriber pattern
(see :mod:`hivemoot_agent.lifecycle`) is sync, and so is the bash
helper that the apiary controller may eventually shell out to.

Error model:

- :class:`ApiaristTransportError` — socket-level failure (connect
  refused, EOF, timeout, broken pipe). Caller can retry or fail-closed.
- :class:`ApiaristProtocolError` — wire framing or response shape is
  malformed (length above cap, invalid JSON, missing envelope keys).
  Indicates a bug or version skew; retrying won't help.
- :class:`ApiaristRemoteError` — server returned a typed error envelope
  with ``code`` + ``message``. Caller inspects ``code`` for retry
  policy (``BACKEND_RATE_LIMITED`` is retryable;
  ``BACKEND_UNAUTHORIZED`` is not).

All three derive from :class:`ApiaristError` for callers that just
want "anything went wrong, fail this job".
"""

from __future__ import annotations

import json
import socket
import struct
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Final

# Wire constants — must match apiarist's ipc.py. If apiarist changes
# them it's a breaking protocol bump and this client must follow.
_LENGTH_PREFIX_FORMAT: Final[str] = "!I"
_LENGTH_PREFIX_BYTES: Final[int] = 4
_MAX_PAYLOAD_BYTES: Final[int] = 64 * 1024  # 64 KiB

# Conservative default request timeout. The end-to-end mint takes a
# backend roundtrip (typically <500ms) plus apiarist's local dispatch
# (<10ms), so 10 seconds covers the long tail without leaving the
# subscriber wedged on a stuck backend. Callers can tighten via the
# constructor for hot paths.
_DEFAULT_TIMEOUT_SECONDS: Final[float] = 10.0


# ── Errors ─────────────────────────────────────────────────────────


class ApiaristError(Exception):
    """Base class for all client-side errors talking to apiarist."""


class ApiaristTransportError(ApiaristError):
    """Socket-level failure — connect refused, EOF, timeout, broken pipe.

    Indicates the daemon is unreachable, restarting, or unresponsive.
    Distinct from :class:`ApiaristProtocolError` so callers can
    distinguish "service down, may recover" from "version skew, won't".
    """


class ApiaristProtocolError(ApiaristError):
    """Wire framing or response shape is malformed.

    Includes: length prefix above cap, payload not valid UTF-8 JSON,
    response envelope missing required keys. Indicates a bug or
    version skew between client and server; retrying does not help.
    """


class ApiaristRemoteError(ApiaristError):
    """Server returned a typed error envelope.

    The ``code`` field is the wire-level upper-snake string from
    apiarist's ``ErrorCode`` (``BACKEND_UNAUTHORIZED``,
    ``BACKEND_RATE_LIMITED``, ``BACKEND_FORBIDDEN``, ...). Callers
    branch on it for retry policy. ``message`` is human-readable and
    safe to log/surface.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code: str = code
        self.message: str = message


# ── Response data shapes ───────────────────────────────────────────


@dataclass(frozen=True)
class Repository:
    """One repository entry from a mint_token response."""

    full_name: str
    id: int


@dataclass(frozen=True)
class MintedToken:
    """Decoded mint_token response (DESIGN.md §8)."""

    token: str
    expires_at: datetime  # tz-aware UTC
    installation_id: str
    permissions: dict[str, str] = field(default_factory=dict)
    repositories: list[Repository] = field(default_factory=list)


@dataclass(frozen=True)
class HealthSnapshot:
    """Decoded health response.

    Shape is best-effort — apiarist may evolve the health payload
    without bumping the protocol, so we expose the raw dict for
    diagnostics-only consumers.
    """

    raw: dict[str, Any]


# ── Client ─────────────────────────────────────────────────────────


class ApiaristClient:
    """Sync UDS client for apiarist.

    Thread-safe by virtue of stateless construction — every call opens
    a fresh socket. The instance only holds the socket path and the
    request timeout, both immutable after init.
    """

    def __init__(
        self,
        socket_path: str,
        *,
        timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        if not socket_path:
            raise ValueError("socket_path must be non-empty")
        if timeout_seconds <= 0:
            raise ValueError(
                f"timeout_seconds must be positive (got {timeout_seconds!r})"
            )
        self._socket_path: str = socket_path
        self._timeout_seconds: float = timeout_seconds

    @property
    def socket_path(self) -> str:
        return self._socket_path

    # ── Public ops ─────────────────────────────────────────────────

    def mint_token(
        self,
        service: str,
        repo: str,
        *,
        agent_id: str | None = None,
    ) -> MintedToken:
        """Request a freshly-minted GitHub installation token.

        Both ``service`` and ``repo`` are required by the apiarist
        protocol (``service`` for caller identification in logs,
        ``repo`` for the policy check + per-repo scoping). ``agent_id``
        is audit-only (DESIGN.md §11) — included in the apiarist log
        line, ignored for authorization.
        """
        if not service:
            raise ValueError("service must be non-empty")
        if not repo:
            raise ValueError("repo must be non-empty")

        params: dict[str, Any] = {"service": service, "repo": repo}
        if agent_id is not None:
            params["agent_id"] = agent_id

        data = self._call("mint_token", params)
        return _parse_minted_token(data)

    def health(self) -> HealthSnapshot:
        """Liveness + last-call telemetry from the daemon.

        Diagnostics surface; not a control-plane signal. Callers
        should not gate behavior on health beyond logging.
        """
        data = self._call("health", {})
        return HealthSnapshot(raw=data)

    # ── Internal: framed request/response ──────────────────────────

    def _call(self, op: str, params: dict[str, Any]) -> dict[str, Any]:
        """Send one framed request, return the response ``data`` dict.

        Raises:
            ApiaristTransportError: socket-level failure.
            ApiaristProtocolError: wire framing or envelope malformed.
            ApiaristRemoteError: server returned an error envelope.
        """
        request_id = uuid.uuid4().hex
        payload = {"op": op, "params": params, "request_id": request_id}

        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self._timeout_seconds)
        try:
            try:
                sock.connect(self._socket_path)
            except OSError as exc:
                raise ApiaristTransportError(
                    f"connect to {self._socket_path!r} failed: "
                    f"{type(exc).__name__}: {exc}"
                ) from exc

            try:
                sock.sendall(_encode_message(payload))
            except OSError as exc:
                raise ApiaristTransportError(
                    f"send to {self._socket_path!r} failed: "
                    f"{type(exc).__name__}: {exc}"
                ) from exc

            response = _recv_response(sock)
        finally:
            try:
                sock.close()
            except OSError:
                pass

        return _validate_response(response, request_id)


# ── Helpers (module-level for testability) ─────────────────────────


def _encode_message(payload: dict[str, Any]) -> bytes:
    """Serialize a payload dict into a length-prefixed JSON frame.

    Mirror of apiarist's :func:`apiarist.core.ipc.encode_message`. We
    can't import that directly (apiarist isn't a dependency of the
    agent runtime), so the framing is duplicated here. If the format
    changes both sides must be bumped in lockstep.
    """
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(body) > _MAX_PAYLOAD_BYTES:
        raise ApiaristProtocolError(
            f"encoded request {len(body)} bytes exceeds wire cap "
            f"{_MAX_PAYLOAD_BYTES}"
        )
    return struct.pack(_LENGTH_PREFIX_FORMAT, len(body)) + body


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    """Read exactly ``n`` bytes; raise ApiaristTransportError on short read.

    A short read here means the server closed mid-stream — a transport
    failure, not a protocol violation, because we have no way to know
    if the server even framed a complete reply.
    """
    chunks: list[bytes] = []
    remaining = n
    while remaining:
        try:
            chunk = sock.recv(remaining)
        except OSError as exc:
            raise ApiaristTransportError(
                f"recv failed after {n - remaining} of {n} bytes: "
                f"{type(exc).__name__}: {exc}"
            ) from exc
        if not chunk:
            raise ApiaristTransportError(
                f"connection closed after {n - remaining} of {n} bytes"
            )
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _recv_response(sock: socket.socket) -> dict[str, Any]:
    """Read one length-prefixed JSON response from ``sock``."""
    prefix = _recv_exact(sock, _LENGTH_PREFIX_BYTES)
    (length,) = struct.unpack(_LENGTH_PREFIX_FORMAT, prefix)
    if length > _MAX_PAYLOAD_BYTES:
        raise ApiaristProtocolError(
            f"response declared length {length} exceeds wire cap "
            f"{_MAX_PAYLOAD_BYTES}"
        )
    body = _recv_exact(sock, length)
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ApiaristProtocolError(
            f"response body is not valid UTF-8 JSON: {exc}"
        ) from exc
    if not isinstance(parsed, dict):
        raise ApiaristProtocolError(
            f"response must be a JSON object (got {type(parsed).__name__})"
        )
    return parsed


def _validate_response(
    response: dict[str, Any],
    expected_request_id: str,
) -> dict[str, Any]:
    """Validate the response envelope and return the ``data`` payload.

    Echo'd ``request_id`` MUST match what we sent — a mismatch points
    at a multi-tenant socket bug or a request/response interleave on
    the server. Treat as protocol error rather than silently accepting
    cross-talk.
    """
    echoed = response.get("request_id")
    ok = response.get("ok")
    if not isinstance(ok, bool):
        raise ApiaristProtocolError(
            "response missing required boolean field 'ok'"
        )
    # Allow a None echoed id ONLY when the server couldn't parse our
    # request (its envelope echoes null per apiarist DESIGN §8). A
    # successful response MUST echo the request_id.
    if ok and echoed != expected_request_id:
        raise ApiaristProtocolError(
            f"response request_id {echoed!r} does not match "
            f"sent {expected_request_id!r}"
        )

    if ok:
        data = response.get("data")
        if not isinstance(data, dict):
            raise ApiaristProtocolError(
                "successful response missing required object field 'data'"
            )
        return data

    error = response.get("error")
    if not isinstance(error, dict):
        raise ApiaristProtocolError(
            "error response missing required object field 'error'"
        )
    code = error.get("code")
    message = error.get("message")
    if not isinstance(code, str) or not code:
        raise ApiaristProtocolError(
            "error envelope missing required string 'code'"
        )
    if not isinstance(message, str):
        # Accept missing/empty message — server may emit codes only.
        message = ""
    raise ApiaristRemoteError(code=code, message=message)


def _parse_minted_token(data: dict[str, Any]) -> MintedToken:
    """Decode a mint_token data payload, raising on shape mismatch."""
    token = data.get("token")
    expires_raw = data.get("expires_at")
    installation_id = data.get("installation_id")
    if not isinstance(token, str) or not token:
        raise ApiaristProtocolError(
            "mint_token response missing required string 'token'"
        )
    if not isinstance(expires_raw, str) or not expires_raw:
        raise ApiaristProtocolError(
            "mint_token response missing required string 'expires_at'"
        )
    if not isinstance(installation_id, str) or not installation_id:
        raise ApiaristProtocolError(
            "mint_token response missing required string 'installation_id'"
        )

    expires_at = _parse_iso8601_utc(expires_raw)

    permissions_raw = data.get("permissions", {})
    if not isinstance(permissions_raw, dict):
        raise ApiaristProtocolError(
            "mint_token response 'permissions' must be an object"
        )
    permissions: dict[str, str] = {}
    for key, value in permissions_raw.items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise ApiaristProtocolError(
                f"mint_token response 'permissions' entry "
                f"{key!r}: {value!r} is not string→string"
            )
        permissions[key] = value

    repos_raw = data.get("repositories", [])
    if not isinstance(repos_raw, list):
        raise ApiaristProtocolError(
            "mint_token response 'repositories' must be a list"
        )
    repos: list[Repository] = []
    for entry in repos_raw:
        if not isinstance(entry, dict):
            raise ApiaristProtocolError(
                "mint_token response 'repositories' entry must be an object"
            )
        full_name = entry.get("full_name")
        rid = entry.get("id")
        if not isinstance(full_name, str) or not full_name:
            raise ApiaristProtocolError(
                "repositories entry missing required string 'full_name'"
            )
        if not isinstance(rid, int):
            raise ApiaristProtocolError(
                "repositories entry missing required int 'id'"
            )
        repos.append(Repository(full_name=full_name, id=rid))

    return MintedToken(
        token=token,
        expires_at=expires_at,
        installation_id=installation_id,
        permissions=permissions,
        repositories=repos,
    )


def _parse_iso8601_utc(raw: str) -> datetime:
    """Parse the ISO 8601 timestamp emitted by apiarist into tz-aware UTC.

    apiarist emits ``"YYYY-MM-DDTHH:MM:SSZ"`` (trailing Z). Python's
    ``datetime.fromisoformat`` accepts ``+00:00`` but not the bare Z
    suffix until 3.11; since the agent runtime targets 3.11+ this works,
    but normalizing the suffix first keeps the parser robust to either
    form (some servers may emit ``+00:00``).
    """
    normalized = raw.replace("Z", "+00:00") if raw.endswith("Z") else raw
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ApiaristProtocolError(
            f"expires_at {raw!r} is not a valid ISO 8601 timestamp: {exc}"
        ) from exc
    if parsed.tzinfo is None:
        # Defensive — a naive timestamp from the server would be a bug
        # (apiarist always emits UTC). Treat as protocol error rather
        # than guessing a timezone.
        raise ApiaristProtocolError(
            f"expires_at {raw!r} must include a timezone (got naive)"
        )
    return parsed
