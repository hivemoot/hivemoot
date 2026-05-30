"""Tests for the desired-state client: parse + status handling (no network)."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from apiarist.features.reconcile.client import (
    FleetClient,
    FleetForbiddenError,
    FleetProtocolError,
    FleetUnauthorizedError,
    NotModified,
)

VALID_PAYLOAD: dict[str, Any] = {
    "version": 1,
    "etag": "roster-v3",
    "generated_at": "2026-05-29T12:00:00.000Z",
    "agents": [
        {
            "name": "builder",
            "repo": "hivemoot/hivemoot",
            "enabled": True,
            "managed": True,
            "config_version": 3,
            "engine": {
                "id": "claude",
                "tool": "claude",
                "provider": None,
                "model": None,
                "tool_options": None,
            },
            "skills": ["code-reviewer"],
            "system_prompt": "hi",
            "triggers": {
                "schedule": {
                    "enabled": True,
                    "settings": {"interval_secs": 21600, "jitter_secs": 600, "prompt": "go"},
                },
                "pull_requests": {
                    "enabled": False,
                    "settings": {
                        "watch_new_prs": True,
                        "watch_review_requests": True,
                        "author_allowlist": [],
                        "poll_interval_secs": 300,
                    },
                },
                "mentions": {"enabled": False, "settings": {"poll_interval_secs": 90}},
                "tasks": {"enabled": False, "settings": {}},
                "war_rooms": {"enabled": False, "settings": {"contribute": False}},
            },
            "token": {"name": "builder", "agent_role": "builder"},
        }
    ],
}


def _client(handler: Any) -> FleetClient:
    transport = httpx.MockTransport(handler)
    return FleetClient(
        backend_url="https://x", fleet_token="t", client=httpx.AsyncClient(transport=transport)
    )


async def test_parse_valid_payload() -> None:
    client = _client(lambda request: httpx.Response(200, json=VALID_PAYLOAD))
    ds = await client.fetch_desired_state()
    assert not isinstance(ds, NotModified)
    assert ds.etag == "roster-v3"
    assert ds.agents[0].name == "builder"
    assert ds.agents[0].triggers.schedule_enabled is True
    assert ds.agents[0].engine.tool == "claude"
    await client.aclose()


async def test_304_returns_not_modified() -> None:
    client = _client(lambda request: httpx.Response(304))
    ds = await client.fetch_desired_state(etag="roster-v3")
    assert isinstance(ds, NotModified)
    await client.aclose()


async def test_if_none_match_header_sent() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["inm"] = request.headers.get("if-none-match", "")
        return httpx.Response(304)

    client = _client(handler)
    await client.fetch_desired_state(etag="roster-v7")
    assert seen["inm"] == '"roster-v7"'
    await client.aclose()


async def test_401_raises_unauthorized() -> None:
    client = _client(lambda request: httpx.Response(401))
    with pytest.raises(FleetUnauthorizedError):
        await client.fetch_desired_state()
    await client.aclose()


async def test_403_raises_forbidden() -> None:
    client = _client(lambda request: httpx.Response(403))
    with pytest.raises(FleetForbiddenError):
        await client.fetch_desired_state()
    await client.aclose()


async def test_malformed_agent_raises_protocol_error() -> None:
    bad = {"version": 1, "etag": "x", "agents": [{"name": "a"}]}  # missing required fields
    client = _client(lambda request: httpx.Response(200, json=bad))
    with pytest.raises(FleetProtocolError):
        await client.fetch_desired_state()
    await client.aclose()


@pytest.mark.parametrize(
    "bad_name",
    ["../etc", "a/../x", "owner/repo", "BUILDER", "1agent", "_x", "-x", "has space", "a" * 33, ""],
)
async def test_invalid_agent_name_fails_closed(bad_name: str) -> None:
    # The agent name becomes a host path + Docker bind source on the apiarist
    # side, so a non-identifier name must be rejected at THIS trust boundary
    # (defense in depth, independent of the backend) → the whole cycle fails closed.
    payload = {**VALID_PAYLOAD, "agents": [{**VALID_PAYLOAD["agents"][0], "name": bad_name}]}
    client = _client(lambda request: httpx.Response(200, json=payload))
    with pytest.raises(FleetProtocolError):
        await client.fetch_desired_state()
    await client.aclose()
