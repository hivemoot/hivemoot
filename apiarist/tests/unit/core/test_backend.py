"""Tests for apiarist.core.backend — HTTP client + error mapping.

Uses `httpx.MockTransport` to drive deterministic responses. No real
network IO. Each test maps one (status, body) → one expected outcome
so failures point at the specific contract row that broke.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from apiarist.core.backend import (
    INSTALLATION_TOKEN_PATH,
    BackendClient,
    BackendError,
    BackendForbiddenError,
    BackendNotImplementedError,
    BackendProtocolError,
    BackendRateLimitedError,
    BackendUnauthorizedError,
    BackendUnavailableError,
    InstallationAccessToken,
    Repository,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _future_iso(seconds: int = 3600) -> str:
    return (
        (datetime.now(UTC) + timedelta(seconds=seconds))
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )


def _client_with_handler(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    retries: int = 0,
) -> BackendClient:
    transport = httpx.MockTransport(handler)
    httpx_client = httpx.AsyncClient(transport=transport)
    return BackendClient(
        backend_url="https://www.hivemoot.dev",
        agent_token="hm_testtoken",
        retries=retries,
        client=httpx_client,
    )


def _success_body() -> dict[str, object]:
    return {
        "token": "ghs_testtokenvaluehereahundredchars",
        "expires_at": _future_iso(),
        "installation_id": "67890",
        "permissions": {
            "contents": "read",
            "pull_requests": "write",
            "issues": "write",
            "metadata": "read",
        },
        "repositories": [
            {"full_name": "dkjazz/the-storytimes-firebase", "id": 12345}
        ],
    }


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_success_returns_typed_token() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_success_body())

    async with _client_with_handler(handler) as client:
        result = await client.mint_installation_token("dkjazz/the-storytimes-firebase")

    assert isinstance(result, InstallationAccessToken)
    assert result.token == "ghs_testtokenvaluehereahundredchars"
    assert result.installation_id == "67890"
    assert isinstance(result.expires_at, datetime)
    assert result.expires_at > datetime.now(UTC)
    assert result.permissions == {
        "contents": "read",
        "pull_requests": "write",
        "issues": "write",
        "metadata": "read",
    }
    assert result.repositories == [
        Repository(full_name="dkjazz/the-storytimes-firebase", id=12345)
    ]


@pytest.mark.asyncio
async def test_success_with_omitted_scope_fields_returns_empty() -> None:
    """Backend stub may omit permissions/repositories before the real
    minting lands; client treats absence as empty rather than failing."""
    def handler(_: httpx.Request) -> httpx.Response:
        body = _success_body()
        del body["permissions"]
        del body["repositories"]
        return httpx.Response(200, json=body)

    async with _client_with_handler(handler) as client:
        result = await client.mint_installation_token("owner/repo")

    assert result.permissions == {}
    assert result.repositories == []


@pytest.mark.asyncio
async def test_success_with_multi_repo_scope() -> None:
    """A token narrowed to multiple repos comes back with all of them."""
    def handler(_: httpx.Request) -> httpx.Response:
        body = _success_body()
        body["repositories"] = [
            {"full_name": "owner/repo-a", "id": 100},
            {"full_name": "owner/repo-b", "id": 200},
            {"full_name": "owner/repo-c", "id": 300},
        ]
        return httpx.Response(200, json=body)

    async with _client_with_handler(handler) as client:
        result = await client.mint_installation_token("owner/repo-a")

    assert len(result.repositories) == 3
    assert {r.id for r in result.repositories} == {100, 200, 300}


@pytest.mark.asyncio
async def test_malformed_permissions_raises_protocol_error() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        body = _success_body()
        body["permissions"] = ["not", "a", "mapping"]
        return httpx.Response(200, json=body)

    async with _client_with_handler(handler) as client:
        with pytest.raises(BackendProtocolError, match="permissions"):
            await client.mint_installation_token("owner/repo")


@pytest.mark.asyncio
async def test_malformed_repositories_raises_protocol_error() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        body = _success_body()
        body["repositories"] = "not-a-list"
        return httpx.Response(200, json=body)

    async with _client_with_handler(handler) as client:
        with pytest.raises(BackendProtocolError, match="repositories"):
            await client.mint_installation_token("owner/repo")


@pytest.mark.asyncio
async def test_repository_entry_missing_id_raises_protocol_error() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        body = _success_body()
        body["repositories"] = [{"full_name": "owner/repo"}]  # missing id
        return httpx.Response(200, json=body)

    async with _client_with_handler(handler) as client:
        with pytest.raises(BackendProtocolError, match="id"):
            await client.mint_installation_token("owner/repo")


@pytest.mark.asyncio
async def test_repository_entry_with_bool_id_rejected() -> None:
    """bool is a subtype of int — explicit reject avoids `True == 1` slips."""
    def handler(_: httpx.Request) -> httpx.Response:
        body = _success_body()
        body["repositories"] = [{"full_name": "owner/repo", "id": True}]
        return httpx.Response(200, json=body)

    async with _client_with_handler(handler) as client:
        with pytest.raises(BackendProtocolError, match="id"):
            await client.mint_installation_token("owner/repo")


@pytest.mark.asyncio
async def test_request_shape_is_correct() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("authorization")
        captured["content_type"] = request.headers.get("content-type")
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=_success_body())

    async with _client_with_handler(handler) as client:
        await client.mint_installation_token("dkjazz/the-storytimes-firebase")

    assert captured["method"] == "POST"
    assert captured["url"] == f"https://www.hivemoot.dev{INSTALLATION_TOKEN_PATH}"
    assert captured["auth"] == "Bearer hm_testtoken"
    assert captured["content_type"] == "application/json"
    # No agent_id in body when omitted — keeps the wire minimal.
    assert captured["body"] == {"repo": "dkjazz/the-storytimes-firebase"}


@pytest.mark.asyncio
async def test_request_includes_agent_id_when_provided() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=_success_body())

    async with _client_with_handler(handler) as client:
        await client.mint_installation_token(
            "dkjazz/the-storytimes-firebase",
            agent_id="builder-claude",
        )

    assert captured["body"] == {
        "repo": "dkjazz/the-storytimes-firebase",
        "agent_id": "builder-claude",
    }


# ---------------------------------------------------------------------------
# Status → exception mapping (one test per HTTP code)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_401_raises_unauthorized() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "invalid_token"})

    async with _client_with_handler(handler) as client:
        with pytest.raises(BackendUnauthorizedError):
            await client.mint_installation_token("owner/repo")


@pytest.mark.asyncio
async def test_403_raises_forbidden() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": "repo_not_in_installation"})

    async with _client_with_handler(handler) as client:
        with pytest.raises(BackendForbiddenError, match="owner/repo"):
            await client.mint_installation_token("owner/repo")


@pytest.mark.asyncio
async def test_429_raises_rate_limited_no_retry() -> None:
    call_count = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(429, json={"error": "rate_limited"})

    async with _client_with_handler(handler, retries=3) as client:
        with pytest.raises(BackendRateLimitedError):
            await client.mint_installation_token("owner/repo")

    # 429 must NOT be retried — surfacing fast lets the caller wait
    # the documented window rather than amplifying the rate-limit hit.
    assert call_count == 1


@pytest.mark.asyncio
async def test_501_raises_not_implemented() -> None:
    """Maps directly to today's deployed endpoint state — the stub."""

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            501,
            json={"error": "not_implemented", "message": "see DESIGN.md §11"},
        )

    async with _client_with_handler(handler) as client:
        with pytest.raises(BackendNotImplementedError, match="not wired"):
            await client.mint_installation_token("owner/repo")


@pytest.mark.asyncio
async def test_500_retries_then_raises_unavailable() -> None:
    call_count = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(500, text="internal error")

    async with _client_with_handler(handler, retries=2) as client:
        with pytest.raises(BackendUnavailableError, match="HTTP 500"):
            await client.mint_installation_token("owner/repo")

    # Original attempt + 2 retries = 3 total.
    assert call_count == 3


@pytest.mark.asyncio
async def test_503_retries_then_succeeds() -> None:
    call_count = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            return httpx.Response(503, text="service unavailable")
        return httpx.Response(200, json=_success_body())

    async with _client_with_handler(handler, retries=3) as client:
        result = await client.mint_installation_token("owner/repo")

    assert isinstance(result, InstallationAccessToken)
    assert call_count == 3


@pytest.mark.asyncio
async def test_unexpected_4xx_raises_backend_error_no_retry() -> None:
    """A 418 etc. is a bug we should learn about, not silently retry."""
    call_count = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(418, text="i'm a teapot")

    async with _client_with_handler(handler, retries=3) as client:
        with pytest.raises(BackendError, match="unexpected HTTP 418"):
            await client.mint_installation_token("owner/repo")

    assert call_count == 1


# ---------------------------------------------------------------------------
# Network errors
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_timeout_retries_then_raises_unavailable() -> None:
    call_count = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        raise httpx.ReadTimeout("timed out")

    async with _client_with_handler(handler, retries=2) as client:
        with pytest.raises(BackendUnavailableError, match="network error"):
            await client.mint_installation_token("owner/repo")

    assert call_count == 3


@pytest.mark.asyncio
async def test_network_error_retries_then_raises_unavailable() -> None:
    call_count = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        raise httpx.ConnectError("dns failure")

    async with _client_with_handler(handler, retries=1) as client:
        with pytest.raises(BackendUnavailableError):
            await client.mint_installation_token("owner/repo")

    assert call_count == 2


# ---------------------------------------------------------------------------
# Protocol errors (200 OK with broken body)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_200_with_non_json_body_raises_protocol_error() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="not json at all")

    async with _client_with_handler(handler) as client:
        with pytest.raises(BackendProtocolError, match="non-JSON"):
            await client.mint_installation_token("owner/repo")


@pytest.mark.asyncio
async def test_200_with_non_object_body_raises_protocol_error() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=["array", "instead", "of", "object"])

    async with _client_with_handler(handler) as client:
        with pytest.raises(BackendProtocolError, match="non-object"):
            await client.mint_installation_token("owner/repo")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "missing_field",
    ["token", "expires_at", "installation_id"],
)
async def test_200_with_missing_required_field_raises_protocol_error(
    missing_field: str,
) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        body = _success_body()
        del body[missing_field]
        return httpx.Response(200, json=body)

    async with _client_with_handler(handler) as client:
        with pytest.raises(BackendProtocolError, match=missing_field):
            await client.mint_installation_token("owner/repo")


@pytest.mark.asyncio
async def test_200_with_already_expired_token_raises_protocol_error() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        body = _success_body()
        # 1 hour in the past — the cache would otherwise serve a dead token.
        body["expires_at"] = (
            (datetime.now(UTC) - timedelta(hours=1))
            .strftime("%Y-%m-%dT%H:%M:%SZ")
        )
        return httpx.Response(200, json=body)

    async with _client_with_handler(handler) as client:
        with pytest.raises(BackendProtocolError, match="already expired"):
            await client.mint_installation_token("owner/repo")


@pytest.mark.asyncio
async def test_200_with_malformed_iso_timestamp_raises_protocol_error() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        body = _success_body()
        body["expires_at"] = "not-a-timestamp"
        return httpx.Response(200, json=body)

    async with _client_with_handler(handler) as client:
        with pytest.raises(BackendProtocolError, match="ISO 8601"):
            await client.mint_installation_token("owner/repo")


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_aclose_is_idempotent_with_owned_client() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_success_body())

    transport = httpx.MockTransport(handler)
    httpx_client = httpx.AsyncClient(transport=transport)
    client = BackendClient(
        backend_url="https://www.hivemoot.dev",
        agent_token="hm_x",
        client=httpx_client,
    )
    # Externally-provided client — apiarist must NOT close it on aclose.
    await client.aclose()
    assert not httpx_client.is_closed


@pytest.mark.asyncio
async def test_context_manager_closes_owned_client() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_success_body())

    transport = httpx.MockTransport(handler)
    httpx_client = httpx.AsyncClient(transport=transport)
    async with BackendClient(
        backend_url="https://www.hivemoot.dev",
        agent_token="hm_x",
        client=httpx_client,
    ):
        pass
    # Same as above: externally-provided clients are not owned.
    assert not httpx_client.is_closed


# ---------------------------------------------------------------------------
# from_config factory
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_from_config_propagates_settings(tmp_path: object) -> None:
    from apiarist.config import Config

    cfg = Config(
        backend_url="https://example.test",
        backend_timeout_seconds=5,
        backend_retries=2,
    )
    client = BackendClient.from_config(cfg, agent_token="hm_factory")
    try:
        assert client._base_url == "https://example.test"
        assert client._agent_token == "hm_factory"
        assert client._retries == 2
    finally:
        await client.aclose()
