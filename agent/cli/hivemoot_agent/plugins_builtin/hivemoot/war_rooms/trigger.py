"""War-room watcher trigger — polls /api/rooms/watching and
dispatches a Job per new room.

Phase F.2 of the post-apiarist-V1 ultra plan. Workers' agent
runtime spawns this trigger alongside the existing
`hivemoot-tasks` trigger; both share the runtime's job dispatch
pipeline.

V1 layering:
  * F.1 wire layer (api.py): HTTP client wrapping `/api/rooms/*`.
  * **F.2 (this slice):** trigger that polls /watching every N
    seconds, tracks per-(roomId, sequence) state, and dispatches
    a Job for each newly-visible room.
  * F.3 (future): per-Job logic that does triage (cheap LLM call:
    RSVP-vs-withdraw decision) + heavy contribution dispatch.
  * F.4 (future): plugin manifest + config-schema wiring so the
    trigger is reachable from `hivemoot-agent run`.

The trigger does NOT call the LLM directly — it just translates
"watching list says I should attend to this room" into a Job that
the worker's existing dispatch pipeline executes. The LLM-driven
decision logic lives in the Job handler (F.3).

State tracking: per-(roomId, currentSequence) seen set with bounded
size. Without it, the same room would dispatch a fresh Job on
every poll tick (60s by default), saturating the worker. The cache
is in-memory only — process restart loses state, but the storage
layer's idempotency keys (per /present, /contribute) make repeat
events benign at the API level.
"""

from __future__ import annotations

import sys
import threading
from collections import OrderedDict
from typing import Any, Callable, Optional

from hivemoot_agent.plugins_builtin.hivemoot.war_rooms import api as wr_api


# Cap on the per-(roomId, sequence) seen-set size. A worker
# attending to many rooms across a long-lived process needs an
# upper bound; OrderedDict + popleft is O(1) eviction.
DEFAULT_SEEN_CACHE_MAX = 1000

# Default poll interval in seconds. Aligns with the cron tick on
# the watchdog side (60s) — workers hear about new rooms within
# one tick of them being eligible.
DEFAULT_POLL_INTERVAL_SECS = 60


class _BoundedSeenCache:
    """Bounded LRU of (roomId, currentSequence) tuples.

    Key shape: `{room_id}@{sequence}`. A room that goes
    awaiting_rsvp → awaiting_contributions emits a fresh sequence,
    so the cache key changes and the trigger dispatches a new Job
    (matching the design's "watcher dispatches per relevant
    sequence" model).
    """

    def __init__(self, max_size: int = DEFAULT_SEEN_CACHE_MAX) -> None:
        self._cache: OrderedDict[str, None] = OrderedDict()
        self._max_size = max(1, max_size)

    def __contains__(self, key: str) -> bool:
        if key in self._cache:
            self._cache.move_to_end(key)
            return True
        return False

    def add(self, key: str) -> None:
        if key in self._cache:
            self._cache.move_to_end(key)
            return
        self._cache[key] = None
        while len(self._cache) > self._max_size:
            self._cache.popitem(last=False)

    def __len__(self) -> int:
        return len(self._cache)


def _seen_key(room: wr_api.WatchingRoom) -> str:
    return f"{room.room_id}@{room.current_sequence}"


class WarRoomWatcherTrigger:
    """Poll /api/rooms/watching and dispatch a Job per new room.

    Mirrors `HivemootTaskTrigger`'s shape:
      * `start(...)` runs the poll loop (blocks until `stop()`)
      * `stop()` flips the stop event
      * `validate()` returns config errors (deferred to plugin
        manifest wiring in F.4 — currently always returns [])

    Dispatch shape: each visible room becomes one `Job` with:
      * session_key = `war-room:{roomId}@{sequence}`
      * prompt = the room's enriched JSON (core + participants)
      * metadata = roomId, sequence, subject_ref, status (so the
        Job handler in F.3 can act without re-fetching)
    """

    name = "hivemoot-war-rooms"

    def __init__(
        self,
        *,
        base_url: str,
        token_resolver: Callable[[], str],
        poll_interval_secs: int = DEFAULT_POLL_INTERVAL_SECS,
        seen_cache_max: int = DEFAULT_SEEN_CACHE_MAX,
        log_prefix: str = "[hivemoot-war-rooms]",
        # Injectable for tests. Real callers use the module-level
        # `wr_api.list_watching_rooms`.
        list_watching_fn: Callable[
            [str, str], list[wr_api.WatchingRoom]
        ] = wr_api.list_watching_rooms,
    ) -> None:
        self._base_url = base_url
        self._token_resolver = token_resolver
        self._poll_interval_secs = max(1, poll_interval_secs)
        self._seen = _BoundedSeenCache(seen_cache_max)
        self._log_prefix = log_prefix
        self._list_watching = list_watching_fn
        self._stop_event = threading.Event()

    def stop(self) -> None:
        self._stop_event.set()

    def evict_seen_key(
        self,
        room_id: str,
        sequence: int,
        op_kind: str = "",
        exc: Optional[BaseException] = None,
    ) -> None:
        """Remove a (room, sequence) entry from the seen cache so
        the next tick re-dispatches it.

        Wired in F.5 as the handler's `on_post_failure` callback —
        signature matches `handler.PostFailureCallback`
        (`Callable[[str, int, str, Exception], None]`) so the
        bridge can pass this method directly without an adapter
        lambda. Closes #546 drone B1: prior 2-arg signature would
        TypeError when invoked from `_safe_callback` with the full
        4-arg shape, and the handler's swallow-and-log would
        silently break the recovery loop.

        `op_kind` and `exc` are accepted but not used — they're
        already logged by the handler's `[hivemoot-war-rooms] ERROR`
        line at the failure site, so the trigger doesn't need to
        re-log. Future enhancement: surface them in a metric.

        Idempotent — eviction of a non-existent key is a no-op.
        """
        del op_kind, exc  # silence "unused" — matched for callback shape
        key = f"{room_id}@{sequence}"
        if key in self._seen._cache:
            del self._seen._cache[key]

    def validate(self, config: Any) -> list[str]:
        """Return config errors (empty = valid).

        Conforms to `plugins.interfaces.Trigger.validate`. F.2's
        construction takes its config via __init__ kwargs (base_url,
        token_resolver, etc.), so there's nothing to validate here
        — the engine's plugin-manifest wiring (deferred to F.4)
        will route config-schema fields through __init__ instead
        of through this hook. Always returns `[]` until F.4 lands.

        Closes #532 builder R1: protocol-compatibility now, even
        though config-schema wiring is deferred. The class must
        satisfy `isinstance(trigger, Trigger)` so the engine's
        `triggers()` reflection accepts it.
        """
        del config  # unused in F.2; F.4 will wire schema through here
        return []

    def start(
        self,
        config: Any,  # `PluginConfig` shape — kept generic in F.2
        dispatcher: Any,  # `JobDispatcher` shape
    ) -> None:
        """Run the poll loop. Blocks until `stop()` is called.

        Signature matches `plugins.interfaces.Trigger.start(config, dispatcher)`
        (closes #532 builder R1 — runtime needs (config, dispatcher),
        not (dispatcher) alone). F.2 ignores `config` since
        construction injected the runtime parameters via __init__;
        F.4 will read the war-room block off `config.typed` instead.


        Errors are logged and the loop continues — a transient API
        failure shouldn't kill the trigger; the next tick will
        retry. The 60s tick interval bounds backoff.
        """
        del config  # unused in F.2 — see method docstring
        self._stop_event.clear()
        print(
            f"{self._log_prefix} polling {self._base_url}/api/rooms/watching "
            f"every {self._poll_interval_secs}s",
            file=sys.stderr,
            flush=True,
        )

        while not self._stop_event.is_set():
            try:
                self._tick(dispatcher)
            except Exception as exc:
                # Defensive: any uncaught exception in tick processing
                # logs and lets the loop continue. The trigger is
                # daemon-shaped — operator-visible failures should
                # surface in logs, not crash the process.
                print(
                    f"{self._log_prefix} tick error: "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )

            # Sleep until next tick OR stop event. Wait returns
            # promptly when stop is signaled, so shutdown is clean.
            self._stop_event.wait(self._poll_interval_secs)

    def _tick(self, dispatcher: Any) -> None:
        """One poll cycle. Internal — used by `start` and tests."""
        bearer = self._token_resolver()
        if not bearer:
            # No token resolved — treat as opted-out (mirrors the
            # bot's auth-gated pattern). The plugin manifest is the
            # operator's tell that this is misconfigured; here we
            # just skip the tick.
            return

        try:
            rooms = self._list_watching(self._base_url, bearer)
        except Exception as exc:
            print(
                f"{self._log_prefix} list_watching_rooms failed: "
                f"{type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )
            return

        for room in rooms:
            key = _seen_key(room)
            if key in self._seen:
                continue
            self._seen.add(key)

            job = self._build_job(room)
            try:
                ok = dispatcher.dispatch(job)
            except Exception as exc:
                print(
                    f"{self._log_prefix} dispatch raised for "
                    f"room={room.room_id}: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                # Remove from cache so the next tick can retry.
                # OrderedDict has no public .discard, mirror it.
                if key in self._seen._cache:
                    del self._seen._cache[key]
                continue

            if not ok:
                print(
                    f"{self._log_prefix} dispatch refused for "
                    f"room={room.room_id} (worker queue full?)",
                    file=sys.stderr,
                    flush=True,
                )
                # Same retry semantics as raised dispatch — drop
                # from cache so the next tick re-presents the room.
                if key in self._seen._cache:
                    del self._seen._cache[key]
                continue

            print(
                f"{self._log_prefix} dispatched room={room.room_id} "
                f"subject={room.subject_ref} status={room.status} "
                f"seq={room.current_sequence}",
                file=sys.stderr,
                flush=True,
            )

    def _build_job(self, room: wr_api.WatchingRoom) -> Any:
        """Construct the Job dispatched to the worker pipeline.

        Carries the room context in metadata so the on_job_finished
        handler can post the engine's triage decision back to the
        war-room API without re-reading the room's state. Returns a
        duck-typed object so the test fixture doesn't need to
        import the real `Job` dataclass (which lives in
        `hivemoot_agent.plugins.interfaces`).
        """
        from .handler import JOB_KIND_TRIAGE
        from .triage import build_triage_prompt

        metadata = {
            # Job-kind discriminator so the parent plugin's
            # on_job_finished can dispatch deterministically.
            "job_kind": JOB_KIND_TRIAGE,
            "room_id": room.room_id,
            "current_sequence": room.current_sequence,
            "subject_type": room.subject_type,
            "subject_ref": room.subject_ref,
            "manager": room.manager,
            "status": room.status,
            "participants": room.participants,
        }
        prompt = build_triage_prompt(room)
        session_key = f"war-room:{room.room_id}@{room.current_sequence}"

        # Lazy import: the real Job dataclass requires pydantic +
        # the plugin-interface dependency graph. Tests inject a
        # fake dispatcher, so the lazy import keeps the trigger
        # testable in isolation.
        try:
            from hivemoot_agent.plugins.interfaces import Job  # type: ignore[import-not-found]

            return Job(
                session_key=session_key,
                prompt=prompt,
                metadata=metadata,
            )
        except ImportError:
            # Fallback for tests that don't have the plugin interface
            # loaded — return a plain dict with the same shape.
            return {
                "session_key": session_key,
                "prompt": prompt,
                "metadata": metadata,
            }
