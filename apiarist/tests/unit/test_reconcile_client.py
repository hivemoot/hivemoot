"""Tests for the desired-state client: parse (plugins shape) + status handling.

Exercises the full FleetClient via httpx.MockTransport (no network). The wire
shape is the canonical `plugins` contract (v2) the web app ships — `repos` live
ONLY under `plugins.github`. Parsing is FAIL-CLOSED: a malformed/type-wrong
plugin block (or a bad agent name) aborts the whole cycle with FleetProtocolError.

POSTURE: the web ALWAYS normalizes and ships fully-populated plugin blocks
(interval/jitter/poll clamped, watch flags + prompt + contribute always set), so
apiarist REQUIRES every such field and fails closed on absence — it never re-
applies an input-side default that would silently degrade a live container. The
only genuinely-optional field is `watch_new_prs_authors`.
"""

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


def _github(**over: Any) -> dict[str, Any]:
    """A fully-populated github block (every field the web always emits)."""
    base: dict[str, Any] = {
        "enabled": True,
        "repos": ["hivemoot/hivemoot"],
        "watch_new_prs": True,
        "watch_review_requests": False,
        "watch_mentions": False,
        "poll_interval_secs": 90,
    }
    base.update(over)
    return base


def _schedule(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "enabled": True,
        "interval_secs": 21600,
        "jitter_secs": 600,
        "prompt": "go",
    }
    base.update(over)
    return base


def _war_rooms(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"enabled": True, "contribute": True}
    base.update(over)
    return base


def _valid_payload() -> dict[str, Any]:
    """A fresh, fully-populated desired-state payload on every call. A factory
    (not a module constant) so a test that mutates its result — e.g. ``del
    block[drop]`` — can never corrupt another test's fixture."""
    return {
        "version": 2,
        "etag": "roster-v3",
        "generated_at": "2026-05-29T12:00:00.000Z",
        "agents": [
            {
                "name": "builder",
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
                "plugins": {
                    "github": _github(),
                    "schedule": _schedule(),
                    "tasks": {"enabled": True},
                    "war_rooms": _war_rooms(),
                },
                "token": {"name": "builder", "agent_role": "builder"},
            }
        ],
    }


def _payload_with_plugins(plugins: object) -> dict[str, Any]:
    payload = _valid_payload()
    payload["agents"][0]["plugins"] = plugins
    return payload


def _client(handler: Any) -> FleetClient:
    transport = httpx.MockTransport(handler)
    return FleetClient(
        backend_url="https://x", fleet_token="t", client=httpx.AsyncClient(transport=transport)
    )


def _serving(payload: object) -> FleetClient:
    return _client(lambda request: httpx.Response(200, json=payload))


# --- happy path -------------------------------------------------------------


async def test_parse_valid_payload_full_plugins() -> None:
    client = _serving(_valid_payload())
    ds = await client.fetch_desired_state()
    assert not isinstance(ds, NotModified)
    assert ds.etag == "roster-v3"
    agent = ds.agents[0]
    assert agent.name == "builder"
    assert agent.engine.tool == "claude"
    assert agent.plugins.github is not None
    assert agent.plugins.github.enabled is True
    assert agent.plugins.github.repos == ("hivemoot/hivemoot",)
    assert agent.plugins.github.watch_new_prs is True
    assert agent.plugins.github.poll_interval_secs == 90
    assert agent.plugins.schedule is not None
    assert agent.plugins.schedule.interval_secs == 21600
    assert agent.plugins.schedule.jitter_secs == 600
    assert agent.plugins.schedule.prompt == "go"
    assert agent.plugins.tasks is not None
    assert agent.plugins.tasks.enabled is True
    assert agent.plugins.war_rooms is not None
    assert agent.plugins.war_rooms.contribute is True
    await client.aclose()


async def test_parse_task_only_agent_no_github() -> None:
    client = _serving(_payload_with_plugins({"tasks": {"enabled": True}}))
    ds = await client.fetch_desired_state()
    assert not isinstance(ds, NotModified)
    assert ds.agents[0].plugins.github is None
    assert ds.agents[0].plugins.tasks is not None
    await client.aclose()


async def test_parse_multi_repo_github() -> None:
    client = _serving(_payload_with_plugins({"github": _github(repos=["a/b", "c/d"])}))
    ds = await client.fetch_desired_state()
    assert not isinstance(ds, NotModified)
    assert ds.agents[0].plugins.github is not None
    assert ds.agents[0].plugins.github.repos == ("a/b", "c/d")
    await client.aclose()


async def test_parse_authors_optional_present_and_absent() -> None:
    # watch_new_prs_authors is the ONLY optional github field (web omits when empty).
    client = _serving(_payload_with_plugins({"github": _github()}))
    ds = await client.fetch_desired_state()
    assert not isinstance(ds, NotModified)
    assert ds.agents[0].plugins.github is not None
    assert ds.agents[0].plugins.github.watch_new_prs_authors == ()
    await client.aclose()

    with_authors = _github(watch_new_prs_authors=["octocat"])
    client2 = _serving(_payload_with_plugins({"github": with_authors}))
    ds2 = await client2.fetch_desired_state()
    assert not isinstance(ds2, NotModified)
    assert ds2.agents[0].plugins.github is not None
    assert ds2.agents[0].plugins.github.watch_new_prs_authors == ("octocat",)
    await client2.aclose()


# --- enabled-github + empty repos (the #1 critical edge) --------------------


async def test_github_enabled_empty_repos_fails_closed() -> None:
    client = _serving(_payload_with_plugins({"github": _github(repos=[])}))
    with pytest.raises(FleetProtocolError):
        await client.fetch_desired_state()
    await client.aclose()


async def test_github_disabled_empty_repos_parses() -> None:
    # A DISABLED github plugin with empty repos is structurally fine (no repo
    # is needed when nothing is watched). Keep tasks enabled so the agent is real.
    client = _serving(
        _payload_with_plugins(
            {
                "github": {
                    "enabled": False,
                    "repos": [],
                    "watch_new_prs": False,
                    "watch_review_requests": False,
                    "watch_mentions": False,
                    "poll_interval_secs": 90,
                },
                "tasks": {"enabled": True},
            }
        )
    )
    ds = await client.fetch_desired_state()
    assert not isinstance(ds, NotModified)
    assert ds.agents[0].plugins.github is not None
    assert ds.agents[0].plugins.github.enabled is False
    assert ds.agents[0].plugins.github.repos == ()
    await client.aclose()


# --- repo slug tightening ---------------------------------------------------


async def test_repo_slug_valid_owner_name_parses() -> None:
    client = _serving(_payload_with_plugins({"github": _github(repos=["owner/name"])}))
    ds = await client.fetch_desired_state()
    assert not isinstance(ds, NotModified)
    assert ds.agents[0].plugins.github is not None
    assert ds.agents[0].plugins.github.repos == ("owner/name",)
    await client.aclose()


@pytest.mark.parametrize("bad_repo", ["a/", "/b", "a/b/c", "a//b", "a/ b", "owner/../x"])
async def test_repo_slug_malformed_fails_closed(bad_repo: str) -> None:
    client = _serving(_payload_with_plugins({"github": _github(repos=[bad_repo])}))
    with pytest.raises(FleetProtocolError):
        await client.fetch_desired_state()
    await client.aclose()


# --- status handling (unchanged behavior) -----------------------------------


async def test_304_returns_not_modified() -> None:
    client = _client(lambda request: httpx.Response(304))
    ds = await client.fetch_desired_state(etag="roster-v3")
    assert isinstance(ds, NotModified)
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


# --- fail-closed: malformed plugin blocks -----------------------------------


async def test_non_object_plugins_fails_closed() -> None:
    client = _serving(_payload_with_plugins("nope"))
    with pytest.raises(FleetProtocolError):
        await client.fetch_desired_state()
    await client.aclose()


@pytest.mark.parametrize(
    "drop",
    ["enabled", "watch_new_prs", "watch_review_requests", "watch_mentions", "poll_interval_secs"],
)
async def test_github_missing_required_field_fails_closed(drop: str) -> None:
    block = _github()
    del block[drop]
    client = _serving(_payload_with_plugins({"github": block}))
    with pytest.raises(FleetProtocolError):
        await client.fetch_desired_state()
    await client.aclose()


@pytest.mark.parametrize(
    "github",
    [
        {"enabled": "yes"},  # enabled wrong type
        _github(repos="a/b"),  # repos not a list
        _github(repos=[123]),  # non-string repo
        _github(watch_new_prs=1),  # watch flag wrong type (int)
        _github(watch_review_requests="no"),  # watch flag wrong type (str)
        _github(poll_interval_secs="fast"),  # poll wrong type
        _github(poll_interval_secs=True),  # bool not an int
        _github(watch_new_prs_authors="octocat"),  # authors not a list
        _github(watch_new_prs_authors=[1]),  # author not a string
    ],
)
async def test_malformed_github_plugin_fails_closed(github: object) -> None:
    client = _serving(_payload_with_plugins({"github": github}))
    with pytest.raises(FleetProtocolError):
        await client.fetch_desired_state()
    await client.aclose()


@pytest.mark.parametrize("drop", ["enabled", "interval_secs", "jitter_secs", "prompt"])
async def test_schedule_missing_required_field_fails_closed(drop: str) -> None:
    block = _schedule()
    del block[drop]
    client = _serving(_payload_with_plugins({"schedule": block}))
    with pytest.raises(FleetProtocolError):
        await client.fetch_desired_state()
    await client.aclose()


@pytest.mark.parametrize(
    "schedule",
    [
        _schedule(interval_secs="soon"),  # interval wrong type
        _schedule(interval_secs=True),  # bool not an int
        _schedule(jitter_secs="lots"),  # jitter wrong type
        _schedule(jitter_secs=True),  # bool not an int
        _schedule(prompt=123),  # prompt wrong type
        _schedule(enabled="yes"),  # enabled wrong type
    ],
)
async def test_malformed_schedule_plugin_fails_closed(schedule: object) -> None:
    client = _serving(_payload_with_plugins({"schedule": schedule}))
    with pytest.raises(FleetProtocolError):
        await client.fetch_desired_state()
    await client.aclose()


@pytest.mark.parametrize("drop", ["enabled", "contribute"])
async def test_war_rooms_missing_required_field_fails_closed(drop: str) -> None:
    block = _war_rooms()
    del block[drop]
    client = _serving(_payload_with_plugins({"war_rooms": block}))
    with pytest.raises(FleetProtocolError):
        await client.fetch_desired_state()
    await client.aclose()


async def test_war_rooms_contribute_wrong_type_fails_closed() -> None:
    client = _serving(_payload_with_plugins({"war_rooms": _war_rooms(contribute="yes")}))
    with pytest.raises(FleetProtocolError):
        await client.fetch_desired_state()
    await client.aclose()


async def test_malformed_tasks_plugin_fails_closed() -> None:
    client = _serving(_payload_with_plugins({"tasks": {}}))  # missing enabled
    with pytest.raises(FleetProtocolError):
        await client.fetch_desired_state()
    await client.aclose()


async def test_missing_plugins_fails_closed() -> None:
    payload = _valid_payload()
    del payload["agents"][0]["plugins"]
    client = _serving(payload)
    with pytest.raises(FleetProtocolError):
        await client.fetch_desired_state()
    await client.aclose()


# --- fail-closed: agent-name trust boundary (unchanged) ---------------------


@pytest.mark.parametrize(
    "bad_name",
    ["../etc", "a/../x", "owner/repo", "BUILDER", "1agent", "_x", "-x", "has space", "a" * 33, ""],
)
async def test_invalid_agent_name_fails_closed(bad_name: str) -> None:
    # The agent name becomes a host path + Docker bind source on the apiarist
    # side, so a non-identifier name must be rejected at THIS trust boundary
    # (defense in depth, independent of the backend) → the whole cycle fails closed.
    payload = _valid_payload()
    payload["agents"][0]["name"] = bad_name
    client = _serving(payload)
    with pytest.raises(FleetProtocolError):
        await client.fetch_desired_state()
    await client.aclose()


async def test_missing_engine_fails_closed() -> None:
    payload = _valid_payload()
    del payload["agents"][0]["engine"]
    client = _serving(payload)
    with pytest.raises(FleetProtocolError):
        await client.fetch_desired_state()
    await client.aclose()
