"""Tests for the health op."""

from __future__ import annotations

import time

import pytest

from apiarist.core.registry import Registry
from apiarist.features import health as health_feature
from apiarist.version import __version__


@pytest.mark.asyncio
async def test_health_initial_state() -> None:
    state = health_feature.HealthState()
    registry = Registry()
    health_feature.register(registry, state=state)

    op = registry.get("health")
    assert op is not None
    snap = await op({})
    assert snap["version"] == __version__
    assert snap["uptime_s"] >= 0
    assert snap["last_backend_status"] is None
    assert snap["last_backend_roundtrip_ms"] is None


@pytest.mark.asyncio
async def test_health_after_backend_call() -> None:
    state = health_feature.HealthState()
    state.record(status="ok", roundtrip_ms=42.5)
    registry = Registry()
    health_feature.register(registry, state=state)

    snap = await registry.get("health")({})
    assert snap["last_backend_status"] == "ok"
    assert snap["last_backend_roundtrip_ms"] == 42.5


@pytest.mark.asyncio
async def test_health_uptime_increases() -> None:
    state = health_feature.HealthState()
    registry = Registry()
    health_feature.register(registry, state=state)

    op = registry.get("health")
    first = await op({})
    time.sleep(0.05)
    second = await op({})
    assert second["uptime_s"] >= first["uptime_s"]
