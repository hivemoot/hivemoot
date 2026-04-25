"""End-to-end integration: real UDS server + real client + fake backend.

Spins up the full daemon stack against a short /tmp socket path
(macOS caps AF_UNIX paths at ~104 bytes; pytest's tmp_path can blow
through that on CI), fires real socket connections (not mocked),
exercises happy path + error paths + concurrency.

Skipped on Windows (no UDS).
"""

from __future__ import annotations

import asyncio
import grp
import json
import os
import stat
import struct
import sys
import tempfile
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest

from apiarist.core.backend import BackendClient
from apiarist.core.ipc import (
    LENGTH_PREFIX_BYTES,
    LENGTH_PREFIX_FORMAT,
    MAX_PAYLOAD_BYTES,
    encode_message,
)
from apiarist.core.registry import Registry
from apiarist.features import health as health_feature
from apiarist.features.tokens import plugin as tokens_plugin
from apiarist.features.tokens.cache import TokenCache
from apiarist.server import Server

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="Unix-domain sockets are POSIX-only"
)


@pytest.fixture
def sock_path() -> Iterator[Path]:
    """Short-path socket file under /tmp (macOS AF_UNIX path limit).

    Generates a unique short name per test, removes the file afterward
    if the server didn't already.
    """
    fd, name = tempfile.mkstemp(prefix="apiarist-", suffix=".sock", dir="/tmp")
    os.close(fd)
    os.unlink(name)  # mkstemp creates a regular file; we only wanted the path
    path = Path(name)
    yield path
    if path.exists():
        path.unlink()


def _success_body() -> dict[str, Any]:
    return {
        "token": "ghs_e2e_test_token",
        "expires_at": (
            (datetime.now(UTC) + timedelta(seconds=3600))
            .strftime("%Y-%m-%dT%H:%M:%SZ")
        ),
        "installation_id": "67890",
        "permissions": {"contents": "read"},
        "repositories": [{"full_name": "owner/repo", "id": 1}],
    }


def _current_user_group() -> str:
    """Group name we can chown the socket to without sudo.

    bind() validates that the configured group exists. In CI we can't
    use 'apiarist' because the user doesn't exist; pick the current
    process's primary group.
    """
    return grp.getgrgid(os.getgid()).gr_name


async def _build_server(socket_path: Path, handler) -> tuple[Server, BackendClient]:
    """Wire a full server stack with the given httpx mock handler."""
    transport = httpx.MockTransport(handler)
    backend = BackendClient(
        backend_url="https://www.hivemoot.dev",
        agent_token="hm_test",
        client=httpx.AsyncClient(transport=transport),
    )
    cache = TokenCache(safety_margin_seconds=60, max_seconds=300)
    registry = Registry()
    # Share one HealthState across health and tokens features so the
    # health op surfaces telemetry the tokens path records (builder #1).
    health_state = health_feature.HealthState()
    health_feature.register(registry, state=health_state)
    tokens_plugin.register(
        registry,
        backend=backend,
        cache=cache,
        health_state=health_state,
        agent_token="hm_test",
    )

    server = Server(
        socket_path=socket_path,
        socket_group=_current_user_group(),
        registry=registry,
    )
    await server.bind()
    return server, backend


async def _request(socket_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    """Open a UDS connection, send one framed request, read one response."""
    reader, writer = await asyncio.open_unix_connection(path=str(socket_path))
    try:
        writer.write(encode_message(payload))
        await writer.drain()
        prefix = await reader.readexactly(LENGTH_PREFIX_BYTES)
        (length,) = struct.unpack(LENGTH_PREFIX_FORMAT, prefix)
        body = await reader.readexactly(length)
        return json.loads(body)
    finally:
        writer.close()
        await writer.wait_closed()


# ---------------------------------------------------------------------------
# Happy paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_health_op_e2e(sock_path: Path) -> None:
    server, backend = await _build_server(
        sock_path,
        lambda r: httpx.Response(200, json=_success_body()),
    )
    serve_task = asyncio.create_task(server.serve_forever())
    try:
        resp = await _request(
            sock_path,
            {"op": "health", "request_id": "hreq1"},
        )
        assert resp["request_id"] == "hreq1"
        assert resp["ok"] is True
        assert "version" in resp["data"]
    finally:
        await server.stop()
        serve_task.cancel()
        await asyncio.gather(serve_task, return_exceptions=True)
        await backend.aclose()


@pytest.mark.asyncio
async def test_mint_token_op_e2e(sock_path: Path) -> None:
    server, backend = await _build_server(
        sock_path,
        lambda r: httpx.Response(200, json=_success_body()),
    )
    serve_task = asyncio.create_task(server.serve_forever())
    try:
        resp = await _request(
            sock_path,
            {
                "op": "mint_token",
                "request_id": "m1",
                "params": {"service": "builder", "repo": "owner/repo"},
            },
        )
        assert resp["request_id"] == "m1"
        assert resp["ok"] is True
        assert resp["data"]["token"] == "ghs_e2e_test_token"
        assert resp["data"]["installation_id"] == "67890"
        assert resp["data"]["repositories"] == [{"full_name": "owner/repo", "id": 1}]
    finally:
        await server.stop()
        serve_task.cancel()
        await asyncio.gather(serve_task, return_exceptions=True)
        await backend.aclose()


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unknown_op_returns_error_envelope(sock_path: Path) -> None:
    server, backend = await _build_server(
        sock_path,
        lambda r: httpx.Response(200, json=_success_body()),
    )
    serve_task = asyncio.create_task(server.serve_forever())
    try:
        resp = await _request(
            sock_path,
            {"op": "noop_does_not_exist", "request_id": "x"},
        )
        assert resp["ok"] is False
        assert resp["error"]["code"] == "UNKNOWN_OP"
    finally:
        await server.stop()
        serve_task.cancel()
        await asyncio.gather(serve_task, return_exceptions=True)
        await backend.aclose()


@pytest.mark.asyncio
async def test_backend_501_maps_to_wire_code(sock_path: Path) -> None:
    server, backend = await _build_server(
        sock_path,
        lambda r: httpx.Response(501, json={"error": "not_implemented"}),
    )
    serve_task = asyncio.create_task(server.serve_forever())
    try:
        resp = await _request(
            sock_path,
            {
                "op": "mint_token", "request_id": "m1",
                "params": {"service": "s", "repo": "owner/r"},
            },
        )
        assert resp["ok"] is False
        assert resp["error"]["code"] == "BACKEND_NOT_IMPLEMENTED"
    finally:
        await server.stop()
        serve_task.cancel()
        await asyncio.gather(serve_task, return_exceptions=True)
        await backend.aclose()


@pytest.mark.asyncio
async def test_invalid_params_returns_bad_request(sock_path: Path) -> None:
    server, backend = await _build_server(
        sock_path,
        lambda r: httpx.Response(200, json=_success_body()),
    )
    serve_task = asyncio.create_task(server.serve_forever())
    try:
        resp = await _request(
            sock_path,
            {
                "op": "mint_token", "request_id": "m1",
                "params": {"service": "s"},  # missing repo
            },
        )
        assert resp["ok"] is False
        assert resp["error"]["code"] == "BAD_REQUEST"
        assert "repo" in resp["error"]["message"]
    finally:
        await server.stop()
        serve_task.cancel()
        await asyncio.gather(serve_task, return_exceptions=True)
        await backend.aclose()


@pytest.mark.asyncio
async def test_malformed_json_returns_bad_request(sock_path: Path) -> None:
    """Send a length-prefix + non-JSON body; server should respond, not crash."""
    server, backend = await _build_server(
        sock_path,
        lambda r: httpx.Response(200, json=_success_body()),
    )
    serve_task = asyncio.create_task(server.serve_forever())
    try:
        reader, writer = await asyncio.open_unix_connection(
            path=str(sock_path)
        )
        try:
            body = b"not even close to json"
            writer.write(struct.pack(LENGTH_PREFIX_FORMAT, len(body)) + body)
            await writer.drain()
            prefix = await reader.readexactly(LENGTH_PREFIX_BYTES)
            (length,) = struct.unpack(LENGTH_PREFIX_FORMAT, prefix)
            resp_body = await reader.readexactly(length)
            resp = json.loads(resp_body)
            assert resp["ok"] is False
            assert resp["error"]["code"] == "BAD_REQUEST"
        finally:
            writer.close()
            await writer.wait_closed()
    finally:
        await server.stop()
        serve_task.cancel()
        await asyncio.gather(serve_task, return_exceptions=True)
        await backend.aclose()


# ---------------------------------------------------------------------------
# Concurrency
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_concurrent_mints_for_different_services(sock_path: Path) -> None:
    """N parallel mint requests should all succeed and not block each other."""
    server, backend = await _build_server(
        sock_path,
        lambda r: httpx.Response(200, json=_success_body()),
    )
    serve_task = asyncio.create_task(server.serve_forever())
    try:
        async def one(i: int) -> dict[str, Any]:
            return await _request(
                sock_path,
                {
                    "op": "mint_token", "request_id": f"r{i}",
                    "params": {"service": f"svc-{i}", "repo": f"owner/repo-{i}"},
                },
            )

        results = await asyncio.gather(*[one(i) for i in range(10)])
        assert all(r["ok"] for r in results)
        assert {r["request_id"] for r in results} == {f"r{i}" for i in range(10)}
    finally:
        await server.stop()
        serve_task.cancel()
        await asyncio.gather(serve_task, return_exceptions=True)
        await backend.aclose()


@pytest.mark.asyncio
async def test_concurrent_mints_across_services_share_single_flight(
    sock_path: Path,
) -> None:
    """Builder #2 regression: services backed by the same agent token
    must serialize on the same single-flight lock.

    Without the fingerprint-keyed cache namespace, two services would
    independently race the backend. With it, they share the cache slot
    + lock and only one upstream call happens.
    """
    backend_call_count = 0
    in_flight = 0
    max_in_flight = 0

    async def slow_handler(_req: httpx.Request) -> httpx.Response:
        nonlocal backend_call_count, in_flight, max_in_flight
        in_flight += 1
        max_in_flight = max(max_in_flight, in_flight)
        backend_call_count += 1
        await asyncio.sleep(0.05)
        in_flight -= 1
        return httpx.Response(200, json=_success_body())

    server, backend = await _build_server(sock_path, slow_handler)
    serve_task = asyncio.create_task(server.serve_forever())
    try:
        # Two DIFFERENT services, SAME repo (so they'd share a cache
        # slot once fingerprint-keyed). Without single-flight they'd
        # both hit the backend; with it, only one upstream call.
        results = await asyncio.gather(
            _request(
                sock_path,
                {"op": "mint_token", "request_id": "a",
                 "params": {"service": "svc-a", "repo": "owner/repo"}},
            ),
            _request(
                sock_path,
                {"op": "mint_token", "request_id": "b",
                 "params": {"service": "svc-b", "repo": "owner/repo"}},
            ),
        )
        assert all(r["ok"] for r in results)
        assert max_in_flight == 1, (
            "two services backed by same token must single-flight; "
            f"observed max_in_flight={max_in_flight} (cache namespace bug?)"
        )
        # Cache hit on the second one — only one upstream call total.
        assert backend_call_count == 1
    finally:
        await server.stop()
        serve_task.cancel()
        await asyncio.gather(serve_task, return_exceptions=True)
        await backend.aclose()


@pytest.mark.asyncio
async def test_health_records_after_mint(sock_path: Path) -> None:
    """Builder #1 regression: health op surfaces last-call telemetry.

    Before this fix, last_backend_status and last_backend_roundtrip_ms
    stayed null forever. Mint then health → both fields populated.
    """
    server, backend = await _build_server(
        sock_path,
        lambda r: httpx.Response(200, json=_success_body()),
    )
    serve_task = asyncio.create_task(server.serve_forever())
    try:
        # First a mint to populate the recorder.
        await _request(
            sock_path,
            {"op": "mint_token", "request_id": "m",
             "params": {"service": "svc", "repo": "owner/repo"}},
        )
        # Then health — last_backend_* must be populated.
        h = await _request(
            sock_path, {"op": "health", "request_id": "h"},
        )
        assert h["data"]["last_backend_status"] == "ok"
        assert isinstance(h["data"]["last_backend_roundtrip_ms"], (int, float))
        assert h["data"]["last_backend_roundtrip_ms"] >= 0
    finally:
        await server.stop()
        serve_task.cancel()
        await asyncio.gather(serve_task, return_exceptions=True)
        await backend.aclose()


@pytest.mark.asyncio
async def test_health_records_after_mint_error(sock_path: Path) -> None:
    """Same as above but for the error path — last_backend_status
    captures the BackendError class name."""
    server, backend = await _build_server(
        sock_path,
        lambda r: httpx.Response(501, json={"error": "not_implemented"}),
    )
    serve_task = asyncio.create_task(server.serve_forever())
    try:
        # Mint that fails server-side.
        await _request(
            sock_path,
            {"op": "mint_token", "request_id": "m",
             "params": {"service": "svc", "repo": "owner/repo"}},
        )
        h = await _request(
            sock_path, {"op": "health", "request_id": "h"},
        )
        # Status carries the exception class name so operators see at
        # a glance which failure mode hit (vs just "error").
        assert h["data"]["last_backend_status"] == "BackendNotImplementedError"
        assert isinstance(h["data"]["last_backend_roundtrip_ms"], (int, float))
    finally:
        await server.stop()
        serve_task.cancel()
        await asyncio.gather(serve_task, return_exceptions=True)
        await backend.aclose()


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bind_refuses_unknown_socket_group(sock_path: Path) -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json=_success_body()))
    backend = BackendClient(
        backend_url="https://www.hivemoot.dev",
        agent_token="hm_test",
        client=httpx.AsyncClient(transport=transport),
    )
    try:
        registry = Registry()
        health_feature.register(registry, state=health_feature.HealthState())
        server = Server(
            socket_path=sock_path,
            socket_group="this-group-definitely-does-not-exist-xyz",
            registry=registry,
        )
        with pytest.raises(RuntimeError, match="does not exist"):
            await server.bind()
    finally:
        await backend.aclose()


@pytest.mark.asyncio
async def test_stop_removes_socket_file(sock_path: Path) -> None:
    server, backend = await _build_server(
        sock_path,
        lambda r: httpx.Response(200, json=_success_body()),
    )
    socket_path = sock_path
    assert socket_path.exists()
    serve_task = asyncio.create_task(server.serve_forever())
    await asyncio.sleep(0.01)
    await server.stop()
    serve_task.cancel()
    await asyncio.gather(serve_task, return_exceptions=True)
    await backend.aclose()
    assert not socket_path.exists(), "stop() should clean up the socket file"


@pytest.mark.asyncio
async def test_stop_is_idempotent(sock_path: Path) -> None:
    server, backend = await _build_server(
        sock_path,
        lambda r: httpx.Response(200, json=_success_body()),
    )
    serve_task = asyncio.create_task(server.serve_forever())
    await asyncio.sleep(0.01)
    await server.stop()
    await server.stop()  # second call should not raise
    serve_task.cancel()
    await asyncio.gather(serve_task, return_exceptions=True)
    await backend.aclose()


@pytest.mark.asyncio
async def test_bind_clears_stale_socket_file(sock_path: Path) -> None:
    """Pre-existing socket file (from prior crashed daemon) is removed.

    Stand up a real socket via socket.socket(), close it without
    unlinking, then call bind() — it should detect the stale socket
    via S_ISSOCK and clear it. Touching a regular file would be
    refused per the safety check below.
    """
    import socket

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.bind(str(sock_path))
    finally:
        sock.close()
    # Don't unlink; the socket file remains on disk as a stale leftover.

    server, backend = await _build_server(
        sock_path,
        lambda r: httpx.Response(200, json=_success_body()),
    )
    await server.stop()
    await backend.aclose()


@pytest.mark.asyncio
async def test_socket_has_mode_660_and_correct_group(sock_path: Path) -> None:
    """Positive contract: bind() leaves the socket at exactly 0o660 with
    the configured group. Pairs with the umask fix in bind() — without
    it, the brief world-writable window between bind and chmod could
    let an unprivileged process connect (guard P3 #2).
    """
    server, backend = await _build_server(
        sock_path,
        lambda r: httpx.Response(200, json=_success_body()),
    )
    try:
        st = sock_path.stat()
        assert stat.S_IMODE(st.st_mode) == 0o660, (
            f"socket mode should be 0o660 (group rw, others none); "
            f"got {oct(stat.S_IMODE(st.st_mode))}"
        )
        expected_gid = grp.getgrnam(_current_user_group()).gr_gid
        assert st.st_gid == expected_gid, (
            f"socket group ownership wrong: expected gid {expected_gid} "
            f"({_current_user_group()}), got {st.st_gid}"
        )
    finally:
        await server.stop()
        await backend.aclose()


@pytest.mark.asyncio
async def test_oversize_length_prefix_returns_bad_request(sock_path: Path) -> None:
    """A client declaring a payload over MAX_PAYLOAD_BYTES must get a
    BAD_REQUEST envelope, not have the server allocate a giant buffer
    or hang reading bytes that will never arrive (guard P3 #3).
    """
    server, backend = await _build_server(
        sock_path,
        lambda r: httpx.Response(200, json=_success_body()),
    )
    serve_task = asyncio.create_task(server.serve_forever())
    try:
        reader, writer = await asyncio.open_unix_connection(
            path=str(sock_path)
        )
        try:
            # Length prefix declaring a body 1 byte over the cap; send
            # NO body — the server must reject on the prefix alone, so
            # whether or not the body would have arrived is moot.
            oversize = MAX_PAYLOAD_BYTES + 1
            writer.write(struct.pack(LENGTH_PREFIX_FORMAT, oversize))
            await writer.drain()
            prefix = await reader.readexactly(LENGTH_PREFIX_BYTES)
            (length,) = struct.unpack(LENGTH_PREFIX_FORMAT, prefix)
            resp_body = await reader.readexactly(length)
            resp = json.loads(resp_body)
            assert resp["ok"] is False
            assert resp["error"]["code"] == "BAD_REQUEST"
            assert "exceeds cap" in resp["error"]["message"]
        finally:
            writer.close()
            await writer.wait_closed()
    finally:
        await server.stop()
        serve_task.cancel()
        await asyncio.gather(serve_task, return_exceptions=True)
        await backend.aclose()


@pytest.mark.asyncio
async def test_slow_client_hits_read_timeout(sock_path: Path) -> None:
    """A client that opens the socket but never writes must be hung up
    on (with a BAD_REQUEST error envelope) within the configured read
    timeout. Guard P3 #4 — defends against slowloris parking many
    accepted-but-idle connections.

    Override the timeout to 0.1s so the test runs quickly; the
    behaviour is identical to the production 30s default.
    """
    transport = httpx.MockTransport(
        lambda r: httpx.Response(200, json=_success_body())
    )
    backend = BackendClient(
        backend_url="https://www.hivemoot.dev",
        agent_token="hm_test",
        client=httpx.AsyncClient(transport=transport),
    )
    cache = TokenCache(safety_margin_seconds=60, max_seconds=300)
    registry = Registry()
    health_state = health_feature.HealthState()
    health_feature.register(registry, state=health_state)
    tokens_plugin.register(
        registry,
        backend=backend,
        cache=cache,
        health_state=health_state,
        agent_token="hm_test",
    )
    server = Server(
        socket_path=sock_path,
        socket_group=_current_user_group(),
        registry=registry,
        read_timeout_seconds=0.1,
    )
    await server.bind()
    serve_task = asyncio.create_task(server.serve_forever())
    try:
        reader, writer = await asyncio.open_unix_connection(
            path=str(sock_path)
        )
        try:
            # Don't write anything; just wait for the server to give up.
            # If the response doesn't arrive within ~1s, the timeout
            # logic is broken.
            prefix = await asyncio.wait_for(
                reader.readexactly(LENGTH_PREFIX_BYTES), timeout=1.0
            )
            (length,) = struct.unpack(LENGTH_PREFIX_FORMAT, prefix)
            resp_body = await reader.readexactly(length)
            resp = json.loads(resp_body)
            assert resp["ok"] is False
            assert resp["error"]["code"] == "BAD_REQUEST"
            assert "no complete request" in resp["error"]["message"]
        finally:
            writer.close()
            await writer.wait_closed()
    finally:
        await server.stop()
        serve_task.cancel()
        await asyncio.gather(serve_task, return_exceptions=True)
        await backend.aclose()


@pytest.mark.asyncio
async def test_bind_refuses_non_socket_file(sock_path: Path) -> None:
    """Defense against typo'd socket_path pointing at a real file.

    Builder caught this in PR #485 review: an unconditional unlink of
    whatever is at socket_path would silently destroy /etc/passwd if
    the deploy config had a typo. bind() must check S_ISSOCK first
    and refuse anything else.
    """
    sock_path.write_text("important data the operator does NOT want deleted")
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json=_success_body()))
    backend = BackendClient(
        backend_url="https://www.hivemoot.dev",
        agent_token="hm_test",
        client=httpx.AsyncClient(transport=transport),
    )
    try:
        registry = Registry()
        health_feature.register(registry, state=health_feature.HealthState())
        server = Server(
            socket_path=sock_path,
            socket_group=_current_user_group(),
            registry=registry,
        )
        with pytest.raises(RuntimeError, match="not a Unix socket"):
            await server.bind()
        # The original file content must be preserved.
        assert sock_path.read_text() == (
            "important data the operator does NOT want deleted"
        )
    finally:
        await backend.aclose()
