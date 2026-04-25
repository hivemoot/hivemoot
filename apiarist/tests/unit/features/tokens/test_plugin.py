"""Tests for the mint_token op handler — wires backend + cache + IPC."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest

from apiarist.core.backend import (
    BackendClient,
    BackendForbiddenError,
    BackendNotImplementedError,
)
from apiarist.core.registry import Registry
from apiarist.features.tokens import plugin as tokens_plugin
from apiarist.features.tokens.cache import TokenCache


def _success_body() -> dict[str, Any]:
    return {
        "token": "ghs_minted_token_value_test",
        "expires_at": (
            (datetime.now(UTC) + timedelta(seconds=3600))
            .strftime("%Y-%m-%dT%H:%M:%SZ")
        ),
        "installation_id": "67890",
        "permissions": {"contents": "read", "pull_requests": "write"},
        "repositories": [{"full_name": "owner/repo", "id": 12345}],
    }


def _client_with_handler(handler) -> BackendClient:
    transport = httpx.MockTransport(handler)
    return BackendClient(
        backend_url="https://www.hivemoot.dev",
        agent_token="hm_test",
        client=httpx.AsyncClient(transport=transport),
    )


@pytest.mark.asyncio
async def test_mint_token_happy_path() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_success_body())

    backend = _client_with_handler(handler)
    cache = TokenCache(safety_margin_seconds=60, max_seconds=300)
    registry = Registry()
    tokens_plugin.register(registry, backend=backend, cache=cache)

    op = registry.get("mint_token")
    assert op is not None
    response = await op({"service": "builder", "repo": "owner/repo"})

    assert response["token"] == "ghs_minted_token_value_test"
    assert response["installation_id"] == "67890"
    assert response["permissions"] == {"contents": "read", "pull_requests": "write"}
    assert response["repositories"] == [{"full_name": "owner/repo", "id": 12345}]
    assert response["expires_at"].endswith("Z")
    await backend.aclose()


@pytest.mark.asyncio
async def test_mint_token_uses_cache_on_repeat() -> None:
    call_count = 0

    def handler(_req: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(200, json=_success_body())

    backend = _client_with_handler(handler)
    cache = TokenCache(safety_margin_seconds=60, max_seconds=300)
    registry = Registry()
    tokens_plugin.register(registry, backend=backend, cache=cache)

    op = registry.get("mint_token")
    assert op is not None
    await op({"service": "builder", "repo": "owner/repo"})
    await op({"service": "builder", "repo": "owner/repo"})
    assert call_count == 1, "second call should hit cache"
    await backend.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", ["service", "repo"])
async def test_mint_token_rejects_missing_required_param(missing: str) -> None:
    backend = _client_with_handler(lambda r: httpx.Response(200, json=_success_body()))
    cache = TokenCache(safety_margin_seconds=60, max_seconds=300)
    registry = Registry()
    tokens_plugin.register(registry, backend=backend, cache=cache)

    op = registry.get("mint_token")
    params: dict[str, Any] = {"service": "builder", "repo": "owner/repo"}
    del params[missing]
    with pytest.raises(ValueError, match=missing):
        await op(params)
    await backend.aclose()


@pytest.mark.asyncio
async def test_mint_token_rejects_wrong_type_agent_id() -> None:
    backend = _client_with_handler(lambda r: httpx.Response(200, json=_success_body()))
    cache = TokenCache(safety_margin_seconds=60, max_seconds=300)
    registry = Registry()
    tokens_plugin.register(registry, backend=backend, cache=cache)

    op = registry.get("mint_token")
    with pytest.raises(ValueError, match="agent_id"):
        await op({"service": "s", "repo": "r", "agent_id": 12345})
    await backend.aclose()


@pytest.mark.asyncio
async def test_mint_token_passes_agent_id_through() -> None:
    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        import json
        captured["body"] = json.loads(req.content)
        return httpx.Response(200, json=_success_body())

    backend = _client_with_handler(handler)
    cache = TokenCache(safety_margin_seconds=60, max_seconds=300)
    registry = Registry()
    tokens_plugin.register(registry, backend=backend, cache=cache)

    op = registry.get("mint_token")
    await op({"service": "builder", "repo": "owner/repo", "agent_id": "builder-claude"})
    assert captured["body"]["agent_id"] == "builder-claude"
    await backend.aclose()


@pytest.mark.asyncio
async def test_mint_token_propagates_backend_501() -> None:
    """501 from backend → BackendNotImplementedError out of the op handler.

    The server dispatcher in server.py is responsible for translating
    this to the wire-level BACKEND_NOT_IMPLEMENTED code; the op
    handler itself just lets the exception propagate.
    """
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(501, json={"error": "not_implemented"})

    backend = _client_with_handler(handler)
    cache = TokenCache(safety_margin_seconds=60, max_seconds=300)
    registry = Registry()
    tokens_plugin.register(registry, backend=backend, cache=cache)

    op = registry.get("mint_token")
    with pytest.raises(BackendNotImplementedError):
        await op({"service": "builder", "repo": "owner/repo"})
    await backend.aclose()


@pytest.mark.asyncio
async def test_mint_token_propagates_backend_403() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": "repo_not_in_installation"})

    backend = _client_with_handler(handler)
    cache = TokenCache(safety_margin_seconds=60, max_seconds=300)
    registry = Registry()
    tokens_plugin.register(registry, backend=backend, cache=cache)

    op = registry.get("mint_token")
    with pytest.raises(BackendForbiddenError):
        await op({"service": "builder", "repo": "owner/forbidden"})
    await backend.aclose()
