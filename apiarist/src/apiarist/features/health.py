"""health op — daemon liveness + last backend roundtrip.

Trivial dispatch: returns a snapshot of the daemon's `HealthState`,
which is updated by the backend client (Phase E feature plugin) on
each call. Operators use this via `socat` for ad-hoc liveness checks
and (eventually) via a systemd watchdog that calls it periodically.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from apiarist.core.registry import Registry
from apiarist.version import __version__


@dataclass
class HealthState:
    """Mutable shared state read by the health op handler.

    Single-writer (the backend client wrapper) / multi-reader (every
    health op call). asyncio is single-threaded so no lock is needed
    for these primitive-only updates.
    """

    started_at: float = field(default_factory=time.monotonic)
    last_backend_status: str | None = None  # "ok" | "error" | None
    last_backend_roundtrip_ms: float | None = None

    def record(self, *, status: str, roundtrip_ms: float) -> None:
        self.last_backend_status = status
        self.last_backend_roundtrip_ms = roundtrip_ms

    def snapshot(self) -> dict[str, Any]:
        return {
            "version": __version__,
            "uptime_s": round(time.monotonic() - self.started_at, 3),
            "last_backend_status": self.last_backend_status,
            "last_backend_roundtrip_ms": self.last_backend_roundtrip_ms,
        }


def register(registry: Registry, *, state: HealthState) -> None:
    """Register the `health` op handler on `registry`."""

    async def health(_params: dict[str, Any]) -> dict[str, Any]:
        return state.snapshot()

    registry.register("health", health)
