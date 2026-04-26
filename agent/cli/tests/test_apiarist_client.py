"""Tests for ``hivemoot_agent.apiarist_client.ApiaristClient``.

Uses a real Unix-domain-socket server in a background thread so the
client exercises actual socket + framing code (no mocks past the
wire). Each test creates a temp socket path, spins up a fake server
that returns a scripted response, and asserts the client behavior.

Coverage:

- mint_token success — happy path round trip with full response shape.
- mint_token error envelope — server returns ok=false → raises
  ApiaristRemoteError with code+message.
- mint_token bad shape — missing fields raise ApiaristProtocolError.
- Connect refused (no server) → ApiaristTransportError.
- Server EOFs after length prefix → ApiaristTransportError.
- Server sends oversize length prefix → ApiaristProtocolError.
- Server sends invalid JSON → ApiaristProtocolError.
- Response request_id mismatch → ApiaristProtocolError.
- Health round trip.
- ISO 8601 'Z' and '+00:00' suffix accepted; naive timestamp rejected.
"""

from __future__ import annotations

import json
import os
import socket
import struct
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from typing import Any, Callable

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.apiarist_client import (
    ApiaristClient,
    ApiaristProtocolError,
    ApiaristRemoteError,
    ApiaristTransportError,
    MintedToken,
    Repository,
)


# Same wire constants as apiarist_client (mirror to avoid private import).
_LENGTH_PREFIX_FORMAT = "!I"
_LENGTH_PREFIX_BYTES = 4


# ── Fake server harness ────────────────────────────────────────────


class _FakeServer:
    """Single-shot UDS server that serves one scripted response and exits.

    ``handler(request_dict) -> bytes`` returns the raw bytes to send
    back. This lets a test fabricate any response (well-formed or
    malformed) without going through the client's encode helpers.
    """

    def __init__(
        self,
        socket_path: str,
        handler: Callable[[dict[str, Any]], bytes],
    ) -> None:
        self.socket_path = socket_path
        self.handler = handler
        self.received: dict[str, Any] | None = None
        self.error: BaseException | None = None
        self._thread: threading.Thread | None = None
        self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)

    def __enter__(self) -> _FakeServer:
        self._sock.bind(self.socket_path)
        self._sock.listen(1)
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc_info: Any) -> None:
        try:
            self._sock.close()
        except OSError:
            pass
        if self._thread is not None:
            self._thread.join(timeout=2)
        try:
            os.unlink(self.socket_path)
        except FileNotFoundError:
            pass

    def _serve(self) -> None:
        try:
            self._sock.settimeout(2)
            conn, _ = self._sock.accept()
            try:
                conn.settimeout(2)
                prefix = _recv_exact(conn, _LENGTH_PREFIX_BYTES)
                (length,) = struct.unpack(_LENGTH_PREFIX_FORMAT, prefix)
                body = _recv_exact(conn, length)
                self.received = json.loads(body.decode("utf-8"))
                conn.sendall(self.handler(self.received))
            finally:
                conn.close()
        except BaseException as exc:  # noqa: BLE001 — captured for the test
            self.error = exc


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    """Read exactly n bytes from the server side."""
    chunks: list[bytes] = []
    remaining = n
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk:
            raise EOFError(f"short read: {n - remaining} of {n}")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _frame(payload: dict[str, Any]) -> bytes:
    body = json.dumps(payload).encode("utf-8")
    return struct.pack(_LENGTH_PREFIX_FORMAT, len(body)) + body


def _temp_socket_path() -> str:
    """Generate a fresh temp socket path that hasn't been bound yet."""
    fd, path = tempfile.mkstemp(prefix="apiarist-client-test-", suffix=".sock")
    os.close(fd)
    os.unlink(path)
    return path


# ── Success paths ──────────────────────────────────────────────────


class MintTokenSuccessTest(unittest.TestCase):
    def test_round_trip_returns_minted_token(self) -> None:
        sock_path = _temp_socket_path()

        def handler(req: dict[str, Any]) -> bytes:
            return _frame(
                {
                    "request_id": req["request_id"],
                    "ok": True,
                    "data": {
                        "token": "ghs_fake12345",
                        "expires_at": "2026-04-25T12:34:56Z",
                        "installation_id": "98765",
                        "permissions": {
                            "contents": "read",
                            "pull_requests": "write",
                        },
                        "repositories": [
                            {"full_name": "hivemoot/colony", "id": 4242},
                        ],
                    },
                }
            )

        with _FakeServer(sock_path, handler) as server:
            client = ApiaristClient(sock_path, timeout_seconds=2.0)
            result = client.mint_token(
                "colony-codex", "hivemoot/colony", agent_id="codex-1",
            )

        self.assertIsNone(server.error, f"server raised: {server.error!r}")
        self.assertIsInstance(result, MintedToken)
        self.assertEqual(result.token, "ghs_fake12345")
        self.assertEqual(result.installation_id, "98765")
        self.assertEqual(
            result.expires_at,
            datetime(2026, 4, 25, 12, 34, 56, tzinfo=timezone.utc),
        )
        self.assertEqual(
            result.permissions, {"contents": "read", "pull_requests": "write"},
        )
        self.assertEqual(result.repositories, [Repository("hivemoot/colony", 4242)])

        # Server should have received the well-formed request.
        self.assertIsNotNone(server.received)
        assert server.received is not None  # for type-checker
        self.assertEqual(server.received["op"], "mint_token")
        self.assertEqual(server.received["params"]["service"], "colony-codex")
        self.assertEqual(server.received["params"]["repo"], "hivemoot/colony")
        self.assertEqual(server.received["params"]["agent_id"], "codex-1")
        self.assertTrue(server.received.get("request_id"))

    def test_omits_agent_id_when_not_supplied(self) -> None:
        sock_path = _temp_socket_path()

        def handler(req: dict[str, Any]) -> bytes:
            return _frame(
                {
                    "request_id": req["request_id"],
                    "ok": True,
                    "data": {
                        "token": "ghs_fake",
                        "expires_at": "2026-04-25T12:34:56+00:00",
                        "installation_id": "1",
                    },
                }
            )

        with _FakeServer(sock_path, handler) as server:
            client = ApiaristClient(sock_path, timeout_seconds=2.0)
            client.mint_token("svc", "owner/name")

        assert server.received is not None
        self.assertNotIn("agent_id", server.received["params"])


class HealthSuccessTest(unittest.TestCase):
    def test_health_returns_raw_dict(self) -> None:
        sock_path = _temp_socket_path()

        def handler(req: dict[str, Any]) -> bytes:
            return _frame(
                {
                    "request_id": req["request_id"],
                    "ok": True,
                    "data": {"status": "ok", "uptime_seconds": 1234},
                }
            )

        with _FakeServer(sock_path, handler):
            client = ApiaristClient(sock_path, timeout_seconds=2.0)
            snap = client.health()

        self.assertEqual(snap.raw, {"status": "ok", "uptime_seconds": 1234})


# ── Error envelope handling ────────────────────────────────────────


class RemoteErrorTest(unittest.TestCase):
    def test_error_envelope_raises_remote_error(self) -> None:
        sock_path = _temp_socket_path()

        def handler(req: dict[str, Any]) -> bytes:
            return _frame(
                {
                    "request_id": req["request_id"],
                    "ok": False,
                    "error": {
                        "code": "BACKEND_FORBIDDEN",
                        "message": "repo not in token policy",
                    },
                }
            )

        with _FakeServer(sock_path, handler):
            client = ApiaristClient(sock_path, timeout_seconds=2.0)
            with self.assertRaises(ApiaristRemoteError) as ctx:
                client.mint_token("svc", "denied/repo")

        self.assertEqual(ctx.exception.code, "BACKEND_FORBIDDEN")
        self.assertEqual(ctx.exception.message, "repo not in token policy")

    def test_error_envelope_with_missing_message_uses_empty_string(self) -> None:
        sock_path = _temp_socket_path()

        def handler(req: dict[str, Any]) -> bytes:
            return _frame(
                {
                    "request_id": req["request_id"],
                    "ok": False,
                    "error": {"code": "INTERNAL"},
                }
            )

        with _FakeServer(sock_path, handler):
            client = ApiaristClient(sock_path, timeout_seconds=2.0)
            with self.assertRaises(ApiaristRemoteError) as ctx:
                client.mint_token("svc", "owner/name")

        self.assertEqual(ctx.exception.code, "INTERNAL")
        self.assertEqual(ctx.exception.message, "")


# ── Protocol violations ────────────────────────────────────────────


class ProtocolErrorTest(unittest.TestCase):
    def test_oversize_length_prefix_rejected(self) -> None:
        sock_path = _temp_socket_path()
        # MAX_PAYLOAD_BYTES is 64 KiB; declare 1 MiB.
        oversize_prefix = struct.pack(_LENGTH_PREFIX_FORMAT, 1024 * 1024)

        def handler(req: dict[str, Any]) -> bytes:
            return oversize_prefix  # client should reject before reading body

        with _FakeServer(sock_path, handler):
            client = ApiaristClient(sock_path, timeout_seconds=2.0)
            with self.assertRaises(ApiaristProtocolError) as ctx:
                client.mint_token("svc", "owner/name")

        self.assertIn("exceeds wire cap", str(ctx.exception))

    def test_invalid_json_body_rejected(self) -> None:
        sock_path = _temp_socket_path()
        bad_body = b"not valid json {{{"
        bad_frame = struct.pack(_LENGTH_PREFIX_FORMAT, len(bad_body)) + bad_body

        def handler(req: dict[str, Any]) -> bytes:
            return bad_frame

        with _FakeServer(sock_path, handler):
            client = ApiaristClient(sock_path, timeout_seconds=2.0)
            with self.assertRaises(ApiaristProtocolError):
                client.mint_token("svc", "owner/name")

    def test_response_array_root_rejected(self) -> None:
        sock_path = _temp_socket_path()

        def handler(req: dict[str, Any]) -> bytes:
            body = b"[1, 2, 3]"
            return struct.pack(_LENGTH_PREFIX_FORMAT, len(body)) + body

        with _FakeServer(sock_path, handler):
            client = ApiaristClient(sock_path, timeout_seconds=2.0)
            with self.assertRaises(ApiaristProtocolError) as ctx:
                client.mint_token("svc", "owner/name")
        self.assertIn("must be a JSON object", str(ctx.exception))

    def test_request_id_mismatch_rejected(self) -> None:
        sock_path = _temp_socket_path()

        def handler(req: dict[str, Any]) -> bytes:
            return _frame(
                {
                    "request_id": "WRONG",  # not what client sent
                    "ok": True,
                    "data": {
                        "token": "ghs_x",
                        "expires_at": "2026-04-25T12:34:56Z",
                        "installation_id": "1",
                    },
                }
            )

        with _FakeServer(sock_path, handler):
            client = ApiaristClient(sock_path, timeout_seconds=2.0)
            with self.assertRaises(ApiaristProtocolError) as ctx:
                client.mint_token("svc", "owner/name")
        self.assertIn("does not match", str(ctx.exception))

    def test_missing_ok_field_rejected(self) -> None:
        sock_path = _temp_socket_path()

        def handler(req: dict[str, Any]) -> bytes:
            return _frame({"request_id": req["request_id"], "data": {}})

        with _FakeServer(sock_path, handler):
            client = ApiaristClient(sock_path, timeout_seconds=2.0)
            with self.assertRaises(ApiaristProtocolError):
                client.mint_token("svc", "owner/name")

    def test_missing_token_field_rejected(self) -> None:
        sock_path = _temp_socket_path()

        def handler(req: dict[str, Any]) -> bytes:
            return _frame(
                {
                    "request_id": req["request_id"],
                    "ok": True,
                    "data": {
                        # No 'token' field
                        "expires_at": "2026-04-25T12:34:56Z",
                        "installation_id": "1",
                    },
                }
            )

        with _FakeServer(sock_path, handler):
            client = ApiaristClient(sock_path, timeout_seconds=2.0)
            with self.assertRaises(ApiaristProtocolError) as ctx:
                client.mint_token("svc", "owner/name")
        self.assertIn("'token'", str(ctx.exception))

    def test_naive_expires_at_rejected(self) -> None:
        sock_path = _temp_socket_path()

        def handler(req: dict[str, Any]) -> bytes:
            return _frame(
                {
                    "request_id": req["request_id"],
                    "ok": True,
                    "data": {
                        "token": "ghs_x",
                        "expires_at": "2026-04-25T12:34:56",  # no tz
                        "installation_id": "1",
                    },
                }
            )

        with _FakeServer(sock_path, handler):
            client = ApiaristClient(sock_path, timeout_seconds=2.0)
            with self.assertRaises(ApiaristProtocolError) as ctx:
                client.mint_token("svc", "owner/name")
        self.assertIn("timezone", str(ctx.exception))


# ── Transport errors ───────────────────────────────────────────────


class TransportErrorTest(unittest.TestCase):
    def test_connect_refused_when_no_server_present(self) -> None:
        sock_path = _temp_socket_path()  # nothing binds it
        client = ApiaristClient(sock_path, timeout_seconds=2.0)
        with self.assertRaises(ApiaristTransportError) as ctx:
            client.mint_token("svc", "owner/name")
        self.assertIn("connect", str(ctx.exception))

    def test_server_eof_after_length_prefix(self) -> None:
        sock_path = _temp_socket_path()
        # Declare 100 bytes incoming, then close → client reads 0 bytes.
        partial_frame = struct.pack(_LENGTH_PREFIX_FORMAT, 100)

        def handler(req: dict[str, Any]) -> bytes:
            return partial_frame

        with _FakeServer(sock_path, handler):
            client = ApiaristClient(sock_path, timeout_seconds=2.0)
            with self.assertRaises(ApiaristTransportError) as ctx:
                client.mint_token("svc", "owner/name")
        self.assertIn("connection closed", str(ctx.exception))


# ── Construction validation ────────────────────────────────────────


class ConstructionTest(unittest.TestCase):
    def test_empty_socket_path_rejected(self) -> None:
        with self.assertRaises(ValueError):
            ApiaristClient("")

    def test_non_positive_timeout_rejected(self) -> None:
        with self.assertRaises(ValueError):
            ApiaristClient("/tmp/x.sock", timeout_seconds=0)
        with self.assertRaises(ValueError):
            ApiaristClient("/tmp/x.sock", timeout_seconds=-1)

    def test_socket_path_property_exposes_value(self) -> None:
        c = ApiaristClient("/run/apiarist.sock")
        self.assertEqual(c.socket_path, "/run/apiarist.sock")


class CallParamValidationTest(unittest.TestCase):
    def test_empty_service_rejected(self) -> None:
        c = ApiaristClient("/run/apiarist.sock")
        with self.assertRaises(ValueError):
            c.mint_token("", "owner/name")

    def test_empty_repo_rejected(self) -> None:
        c = ApiaristClient("/run/apiarist.sock")
        with self.assertRaises(ValueError):
            c.mint_token("svc", "")


if __name__ == "__main__":
    unittest.main()
