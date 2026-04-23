"""Keyed workqueue for coalescing trigger events into agent runs.

Modeled on Kubernetes' ``client-go/util/workqueue.Interface``.  Solves
the problem that plugin triggers can fire events faster than the agent
can process them, and multiple events often refer to the same logical
unit of work (e.g. two @-mentions on the same PR thread within the
same poll cycle; a new-PR event and a review-request event arriving
near-simultaneously for the same PR).

Design — three state sets + one payload map, all under a single lock:

  _queue:      deque[key]                — FIFO of keys ready to process
  _processing: set[key]                  — keys currently held by a worker
  _payloads:   dict[key, list[payload]]  — events accumulated per key

Semantics:

  add(key, payload):
    - Append payload to _payloads[key].
    - If key is not in _processing AND not in _queue → append to _queue.
    - (If key is in _processing, payloads accumulate; they'll flush
      when the worker calls done(key) and sees a non-empty list.)

  get() -> (key, payloads) | None:
    - Block until _queue is non-empty or shutdown.
    - Pop key from _queue, move to _processing.
    - Return (key, payloads) with a fresh copy of the payloads list,
      emptying _payloads[key].
    - Returns None after shutdown when nothing remains to pop.

  done(key):
    - Remove key from _processing.
    - If _payloads[key] is non-empty (events arrived during processing),
      re-enqueue the key.  This is the "dirty" re-run that drives
      coalescing: one worker pop handles the burst that accumulated
      during the prior run.

The emergent behavior:

  * N events for the same key while it's processing = 1 additional run
    (the coalesced follow-up), not N additional runs.
  * Events for different keys run serially in FIFO order.
  * No starvation: K1's dirty re-run goes to the back of the queue
    behind K2 if K2 was queued earlier.
  * Safe under concurrent producers + one consumer (single-worker model)
    or concurrent producers + concurrent consumers (multi-worker pool)
    — the ``_processing`` set prevents two workers from grabbing the
    same key.

Callers MUST call done(key) exactly once for every (key, payloads)
returned by get(), otherwise the key leaks into ``_processing`` and
can never be re-enqueued.  The engine wraps this in try/finally.
"""

from __future__ import annotations

import threading
from collections import deque
from typing import Any


class WorkQueue:
    """Keyed workqueue with coalescing — see module docstring."""

    def __init__(self) -> None:
        self._queue: deque[str] = deque()
        self._processing: set[str] = set()
        self._payloads: dict[str, list[Any]] = {}
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._shutdown = False
        # Observability — incremented on every add/get/done; test
        # hooks can wait on these counters to avoid sleep-based races.
        self._adds = 0
        self._gets = 0
        self._dones = 0

    def add(self, key: str, payload: Any) -> None:
        """Enqueue a payload under ``key``.

        Coalescing: if ``key`` is already queued or currently being
        processed, the payload is appended to the key's payload list
        rather than creating a new queue entry.  The key becomes
        eligible for a follow-up run (populating ``_queue`` again) when
        the current worker calls ``done(key)``.

        Raises RuntimeError if called after shutdown — callers that
        race with shutdown should handle the exception.
        """
        if not key:
            raise ValueError("WorkQueue.add requires a non-empty key")
        with self._cond:
            if self._shutdown:
                raise RuntimeError("WorkQueue.add after shutdown")
            self._payloads.setdefault(key, []).append(payload)
            self._adds += 1
            # Only enqueue the key if neither processing nor already
            # queued — prevents duplicate queue entries for the same
            # key, which is what coalescing means at the queue level.
            if key not in self._processing and key not in self._queue:
                self._queue.append(key)
                self._cond.notify()

    def get(self, timeout: float | None = None) -> tuple[str, list[Any]] | None:
        """Pop the next ready (key, payloads) or return None on shutdown.

        Blocks until a key is available or the queue is shut down.
        ``timeout`` (seconds, or None for infinite) bounds the wait —
        timeout returns None so the caller can check for shutdown and
        retry instead of being permanently parked.

        The returned ``payloads`` is a fresh list — the worker owns it
        and may mutate freely.  After return, ``_payloads[key]`` is a
        fresh empty list ready to collect events arriving during this
        run (which drive the dirty re-enqueue in ``done``).
        """
        with self._cond:
            while not self._queue and not self._shutdown:
                if not self._cond.wait(timeout=timeout):
                    return None  # timed out
            if self._shutdown and not self._queue:
                return None
            key = self._queue.popleft()
            # Hand off the accumulated payloads, reset the slot so
            # adds during processing go into a fresh list (which
            # done(key) will notice and use to drive the re-enqueue).
            payloads = self._payloads.get(key, [])
            self._payloads[key] = []
            self._processing.add(key)
            self._gets += 1
            return key, payloads

    def done(self, key: str) -> None:
        """Mark ``key`` as processed; re-enqueue if new events arrived.

        MUST be called exactly once per successful ``get(key)`` call,
        even if the processing raised — otherwise ``key`` leaks into
        ``_processing`` and cannot be re-added.  Callers wrap in
        try/finally.
        """
        with self._cond:
            self._processing.discard(key)
            self._dones += 1
            # Dirty check: events arrived while we held this key, so
            # put it back in the queue for a follow-up run.  The
            # payloads accumulated in _payloads[key] and will be
            # handed to the next get() call.
            if self._payloads.get(key):
                self._queue.append(key)
                self._cond.notify()
            else:
                # Clean slate — drop the empty list to prevent unbounded
                # growth of the payload map for keys that never recur.
                self._payloads.pop(key, None)

    def shutdown(self) -> None:
        """Refuse new adds and wake all blocked get() callers.

        After shutdown:
          * ``add`` raises RuntimeError (caller-visible signal that the
            engine is tearing down).
          * ``get`` returns None once the queue is drained (or
            immediately if the queue was empty when shutdown was called).
          * ``done`` still works so in-flight runs can finish cleanly.
        """
        with self._cond:
            self._shutdown = True
            self._cond.notify_all()

    def stats(self) -> dict[str, int]:
        """Snapshot of queue state — for observability/tests.

        Returns counts only; safe to call from any thread.  The
        ``pending`` count reflects keys with accumulated payloads that
        aren't yet in ``_queue`` (e.g. during processing), which is
        the primary signal of "dirty" keys waiting for re-enqueue.
        """
        with self._lock:
            return {
                "queue_len": len(self._queue),
                "processing": len(self._processing),
                "pending_keys": sum(
                    1 for k, v in self._payloads.items() if v
                ),
                "total_adds": self._adds,
                "total_gets": self._gets,
                "total_dones": self._dones,
            }
