"""In-memory cache + per-installation single-flight for installation tokens.

Cache key is `(installation_id, repo, permissions_hash)` per DESIGN.md
§9 — sharing on `installation_id` alone would let two callers asking
for different scopes collide on the same cache slot. Each cache entry
holds a minted `InstallationAccessToken` plus the eviction deadline.

Single-flight is per-installation_id (NOT per-key). Rationale: a burst
of mint requests for the SAME installation but different repos should
serialize on the underlying GitHub API call (one App-JWT exchange,
multiple narrow tokens) rather than racing the App's secondary rate
limit. Conversely, requests for DIFFERENT installations are fully
parallel — they hit independent App installations, no contention.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any

from apiarist.core.backend import InstallationAccessToken


@dataclass(frozen=True)
class _CacheKey:
    installation_id: str
    repo: str
    permissions_hash: str


@dataclass
class _CacheEntry:
    token: InstallationAccessToken
    evict_at: datetime


def _hash_permissions(permissions: dict[str, str]) -> str:
    """Stable hash for a permissions dict.

    Sorted by key to make the hash insensitive to dict iteration order
    (insertion order in 3.7+, but defensive). Empty/None permissions
    hashes to a fixed sentinel so callers don't need a special case.
    """
    if not permissions:
        return "EMPTY"
    canonical = ",".join(f"{k}={v}" for k, v in sorted(permissions.items()))
    return sha256(canonical.encode("utf-8")).hexdigest()[:16]


# A fetch function gets called on cache miss. Async because backend
# calls are async. Returns the freshly-minted token; the cache wraps it
# with the eviction deadline.
TokenFetcher = Callable[[], Awaitable[InstallationAccessToken]]


class TokenCache:
    """In-memory installation-token cache with per-installation single-flight."""

    def __init__(
        self,
        *,
        safety_margin_seconds: int,
        max_seconds: int,
    ) -> None:
        self._entries: dict[_CacheKey, _CacheEntry] = {}
        # Per-installation locks for single-flight. Created lazily on
        # first use. Different installations get different locks.
        #
        # Bounded growth: the keys here are token fingerprints (V1: one
        # agent token → one entry forever) or installation IDs (V2
        # multi-installation: one per token slot, still O(installations)).
        # No unbounded growth from request volume — it's a small fixed
        # set per host. Reviewed in PR #485 (guard P3 #5); revisit if a
        # future variant ever lets caller-controlled strings into the
        # key (e.g. per-request namespaces) where an attacker could
        # blow up the dict.
        self._locks: dict[str, asyncio.Lock] = {}
        self._safety_margin = timedelta(seconds=safety_margin_seconds)
        self._max = timedelta(seconds=max_seconds)

    async def get_or_fetch(
        self,
        *,
        installation_id: str,
        repo: str,
        permissions: dict[str, str],
        fetch: TokenFetcher,
    ) -> InstallationAccessToken:
        """Return a cached token or fetch + cache a new one.

        Single-flight: concurrent calls with the same `installation_id`
        share one upstream fetch. The first caller does the work; the
        rest wait on the lock and then read the cache.
        """
        key = _CacheKey(
            installation_id=installation_id,
            repo=repo,
            permissions_hash=_hash_permissions(permissions),
        )

        # Fast path — no lock if we have a fresh entry.
        cached = self._lookup(key)
        if cached is not None:
            return cached

        lock = self._lock_for(installation_id)
        async with lock:
            # Re-check inside the lock — another waiter may have just
            # populated the cache while we were blocked.
            cached = self._lookup(key)
            if cached is not None:
                return cached
            token = await fetch()
            self._insert(key, token)
            return token

    def _lookup(self, key: _CacheKey) -> InstallationAccessToken | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        if entry.evict_at <= _now_utc():
            # Stale; evict and behave as a miss. Caller will re-fetch.
            self._entries.pop(key, None)
            return None
        return entry.token

    def _insert(self, key: _CacheKey, token: InstallationAccessToken) -> None:
        evict_at = self._eviction_deadline(token)
        # If the freshly-minted token is somehow already past its
        # eviction deadline (clock skew, expires_at on the server side
        # being in the past), don't pollute the cache — the next call
        # will re-fetch.
        if evict_at <= _now_utc():
            return
        self._entries[key] = _CacheEntry(token=token, evict_at=evict_at)

    def _eviction_deadline(self, token: InstallationAccessToken) -> datetime:
        """min(expires_at - safety_margin, now + max).

        DESIGN.md §9: backend `expires_at` is the source of truth, max
        is a defense-in-depth ceiling.
        """
        upstream = token.expires_at - self._safety_margin
        ceiling = _now_utc() + self._max
        return min(upstream, ceiling)

    def _lock_for(self, installation_id: str) -> asyncio.Lock:
        lock = self._locks.get(installation_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[installation_id] = lock
        return lock

    # --- Inspection helpers (used by health op + tests) -----------

    def size(self) -> int:
        """Number of currently-cached entries (including stale ones not
        yet evicted — `_lookup` evicts lazily on read)."""
        return len(self._entries)


def _now_utc() -> datetime:
    """Wrapped for test monkeypatching."""
    return datetime.now(UTC)


# Re-export Any for typing in callers without an extra import.
__all__ = ["Any", "TokenCache", "TokenFetcher", "_now_utc"]
