"""Feature plugin registry — maps op names to async handlers.

Each feature plugin (V1: tokens; V2+: spawning, etc.) registers one or
more ops at startup. The server's request dispatcher looks up the
handler by op name and awaits it.

The registry is intentionally just a typed dict — no plugin lifecycle
hooks, no priority ordering, no middleware. If a feature needs setup,
it does that work before calling `register()`.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

# An op handler is an async callable taking the params dict and returning
# the response data dict. Errors should be raised as typed exceptions
# (BackendError subclasses, ValueError for bad params, etc.) — the
# server dispatcher in `server.py` translates them into wire error codes.
OpHandler = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


class Registry:
    """Op-name → handler map.

    Not thread-safe; intended to be populated synchronously during
    daemon startup and then read-only during request dispatch. The
    dispatcher reads `_handlers[op]` without locking.
    """

    def __init__(self) -> None:
        self._handlers: dict[str, OpHandler] = {}

    def register(self, op: str, handler: OpHandler) -> None:
        """Register `handler` to dispatch for op `op`.

        Raises ValueError if `op` is already registered — features that
        legitimately need to override (none today) should `unregister`
        first.
        """
        if op in self._handlers:
            raise ValueError(f"op {op!r} is already registered to {self._handlers[op]!r}")
        self._handlers[op] = handler

    def unregister(self, op: str) -> None:
        """Remove a handler. No-op if not registered."""
        self._handlers.pop(op, None)

    def get(self, op: str) -> OpHandler | None:
        """Lookup an op handler. Returns None if not registered.

        Used by the server dispatcher: `None` means UNKNOWN_OP error
        code, found means dispatch.
        """
        return self._handlers.get(op)

    def list_ops(self) -> list[str]:
        """Sorted list of registered op names. Useful for the health op
        + debug logging."""
        return sorted(self._handlers.keys())
