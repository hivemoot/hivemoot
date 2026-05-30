"""Background reconcile loop + UDS ops (`reconcile_now`, `list_managed`).

The loop runs one cycle at startup, then every `interval_seconds`. A single
asyncio.Lock serializes the periodic loop against the on-demand `reconcile_now`
op so they never race on the reconciler's etag/state.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

import structlog

from apiarist.core.registry import Registry
from apiarist.features.reconcile.models import ReconcileResult
from apiarist.features.reconcile.reconcile import Reconciler


class ReconcileLoop:
    def __init__(self, *, reconciler: Reconciler, interval_seconds: int) -> None:
        self._reconciler = reconciler
        self._interval = interval_seconds
        self._stop = asyncio.Event()
        self._lock = asyncio.Lock()
        self._last_result: ReconcileResult | None = None
        self._log = structlog.get_logger().bind(component="reconcile.loop")

    async def _run_once(self) -> ReconcileResult:
        async with self._lock:
            result = await self._reconciler.run_cycle()
        self._last_result = result
        self._log.info("reconcile cycle", **result.as_dict())
        return result

    async def run(self) -> None:
        """Run until stop() — one cycle now, then every interval."""
        while not self._stop.is_set():
            try:
                await self._run_once()
            except Exception as exc:  # never let a cycle crash the daemon
                self._log.error("reconcile cycle raised", error=str(exc))
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=self._interval)

    def stop(self) -> None:
        self._stop.set()

    async def reconcile_now_op(self, _params: dict[str, Any]) -> dict[str, Any]:
        result = await self._run_once()
        return {"result": result.as_dict()}

    async def list_managed_op(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {"last_result": self._last_result.as_dict() if self._last_result else None}


def register(registry: Registry, *, loop: ReconcileLoop) -> None:
    registry.register("reconcile_now", loop.reconcile_now_op)
    registry.register("list_managed", loop.list_managed_op)
