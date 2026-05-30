"""Tests for apiarist.features.tokens.cache — TTL, single-flight, eviction."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from apiarist.core.backend import InstallationAccessToken, Repository
from apiarist.features.tokens import cache as cache_mod
from apiarist.features.tokens.cache import TokenCache


def _token(
    *, expires_in_seconds: int = 3600, installation_id: str = "i1"
) -> InstallationAccessToken:
    return InstallationAccessToken(
        token=f"ghs_test_{installation_id}",
        expires_at=datetime.now(UTC) + timedelta(seconds=expires_in_seconds),
        installation_id=installation_id,
        permissions={"contents": "read"},
        repositories=[Repository(full_name="owner/repo", id=1)],
    )


@pytest.mark.asyncio
async def test_cache_miss_then_hit() -> None:
    cache = TokenCache(safety_margin_seconds=60, max_seconds=300)
    fetched = _token()
    calls = 0

    async def fetch() -> InstallationAccessToken:
        nonlocal calls
        calls += 1
        return fetched

    # First call → miss → fetch.
    t1 = await cache.get_or_fetch(
        installation_id="i1",
        repo="owner/repo",
        permissions={"contents": "read"},
        fetch=fetch,
    )
    assert t1 is fetched
    assert calls == 1

    # Second call same key → hit → no fetch.
    t2 = await cache.get_or_fetch(
        installation_id="i1",
        repo="owner/repo",
        permissions={"contents": "read"},
        fetch=fetch,
    )
    assert t2 is fetched
    assert calls == 1


@pytest.mark.asyncio
async def test_different_repos_use_different_cache_slots() -> None:
    cache = TokenCache(safety_margin_seconds=60, max_seconds=300)
    calls: list[str] = []

    async def fetch_factory(repo_label: str):
        async def fetch() -> InstallationAccessToken:
            calls.append(repo_label)
            return _token(installation_id=repo_label)

        return fetch

    f_a = await fetch_factory("a")
    f_b = await fetch_factory("b")

    await cache.get_or_fetch(
        installation_id="same",
        repo="owner/a",
        permissions={"contents": "read"},
        fetch=f_a,
    )
    await cache.get_or_fetch(
        installation_id="same",
        repo="owner/b",
        permissions={"contents": "read"},
        fetch=f_b,
    )

    assert calls == ["a", "b"]
    assert cache.size() == 2


@pytest.mark.asyncio
async def test_different_permissions_use_different_cache_slots() -> None:
    cache = TokenCache(safety_margin_seconds=60, max_seconds=300)
    fetch_count = 0

    async def fetch() -> InstallationAccessToken:
        nonlocal fetch_count
        fetch_count += 1
        return _token()

    await cache.get_or_fetch(
        installation_id="i1",
        repo="owner/repo",
        permissions={"contents": "read"},
        fetch=fetch,
    )
    await cache.get_or_fetch(
        installation_id="i1",
        repo="owner/repo",
        permissions={"contents": "write"},
        fetch=fetch,
    )
    # Different permissions → different cache slot → second fetch happens.
    assert fetch_count == 2


@pytest.mark.asyncio
async def test_single_flight_per_installation() -> None:
    """Concurrent fetches for the same installation must serialize."""
    cache = TokenCache(safety_margin_seconds=60, max_seconds=300)
    in_flight = 0
    max_in_flight = 0
    completed = 0

    async def fetch() -> InstallationAccessToken:
        nonlocal in_flight, max_in_flight, completed
        in_flight += 1
        max_in_flight = max(max_in_flight, in_flight)
        await asyncio.sleep(0.05)  # let other tasks pile up
        in_flight -= 1
        completed += 1
        return _token(installation_id="i1")

    # 5 parallel requests for the SAME installation but DIFFERENT repos
    # — different cache slots, but per-installation lock should
    # serialize the underlying fetches.
    tasks = [
        cache.get_or_fetch(
            installation_id="i1",
            repo=f"owner/repo-{i}",
            permissions={"contents": "read"},
            fetch=fetch,
        )
        for i in range(5)
    ]
    await asyncio.gather(*tasks)
    assert max_in_flight == 1, "fetches should have serialized on the per-installation lock"
    assert completed == 5


@pytest.mark.asyncio
async def test_different_installations_run_in_parallel() -> None:
    cache = TokenCache(safety_margin_seconds=60, max_seconds=300)
    in_flight = 0
    max_in_flight = 0

    async def fetch_factory(inst_id: str):
        async def fetch() -> InstallationAccessToken:
            nonlocal in_flight, max_in_flight
            in_flight += 1
            max_in_flight = max(max_in_flight, in_flight)
            await asyncio.sleep(0.05)
            in_flight -= 1
            return _token(installation_id=inst_id)

        return fetch

    tasks = [
        cache.get_or_fetch(
            installation_id=f"inst-{i}",
            repo="owner/repo",
            permissions={"contents": "read"},
            fetch=await fetch_factory(f"inst-{i}"),
        )
        for i in range(5)
    ]
    await asyncio.gather(*tasks)
    assert max_in_flight >= 2, (
        "different installations should run in parallel; per-installation "
        f"locks must NOT collide. observed max_in_flight={max_in_flight}"
    )


@pytest.mark.asyncio
async def test_eviction_uses_expires_at_minus_safety_margin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = TokenCache(safety_margin_seconds=60, max_seconds=3600)
    # Token expires in 100s; with 60s safety margin, eviction at +40s.
    fetched = _token(expires_in_seconds=100)
    calls = 0

    async def fetch() -> InstallationAccessToken:
        nonlocal calls
        calls += 1
        return fetched

    await cache.get_or_fetch(
        installation_id="i1",
        repo="owner/repo",
        permissions={"contents": "read"},
        fetch=fetch,
    )
    assert calls == 1

    # Advance time to 50s in the future (past eviction at 40s) →
    # cache should miss, fetch again.
    fixed_now = datetime.now(UTC) + timedelta(seconds=50)
    monkeypatch.setattr(cache_mod, "_now_utc", lambda: fixed_now)

    await cache.get_or_fetch(
        installation_id="i1",
        repo="owner/repo",
        permissions={"contents": "read"},
        fetch=fetch,
    )
    assert calls == 2


@pytest.mark.asyncio
async def test_max_seconds_caps_eviction(monkeypatch: pytest.MonkeyPatch) -> None:
    cache = TokenCache(safety_margin_seconds=60, max_seconds=10)
    # Token would last 1h, but max_seconds caps cache TTL at 10s.
    fetched = _token(expires_in_seconds=3600)
    calls = 0

    async def fetch() -> InstallationAccessToken:
        nonlocal calls
        calls += 1
        return fetched

    await cache.get_or_fetch(
        installation_id="i1",
        repo="owner/repo",
        permissions={"contents": "read"},
        fetch=fetch,
    )
    assert calls == 1

    # Advance 30s; well past the 10s cap, well below expires_at.
    fixed_now = datetime.now(UTC) + timedelta(seconds=30)
    monkeypatch.setattr(cache_mod, "_now_utc", lambda: fixed_now)

    await cache.get_or_fetch(
        installation_id="i1",
        repo="owner/repo",
        permissions={"contents": "read"},
        fetch=fetch,
    )
    assert calls == 2  # cap forced re-fetch


@pytest.mark.asyncio
async def test_already_expired_token_not_cached() -> None:
    """Backend returning an already-expired token should not poison the cache."""
    cache = TokenCache(safety_margin_seconds=60, max_seconds=3600)
    # 30s remaining < 60s safety margin → eviction deadline already in the past.
    fetched = _token(expires_in_seconds=30)
    calls = 0

    async def fetch() -> InstallationAccessToken:
        nonlocal calls
        calls += 1
        return fetched

    await cache.get_or_fetch(
        installation_id="i1",
        repo="owner/repo",
        permissions={"contents": "read"},
        fetch=fetch,
    )
    # First fetch happens.
    assert calls == 1
    # Cache rejected the entry; second call re-fetches.
    await cache.get_or_fetch(
        installation_id="i1",
        repo="owner/repo",
        permissions={"contents": "read"},
        fetch=fetch,
    )
    assert calls == 2
