"""Container-wide lifecycle FSM with subscriber/event-bus pattern.

Per `apiarist/DESIGN.md` §12.3: the engine owns a generic IDLE/ACTIVE
state machine; plugins (and other cross-cutting concerns) implement
:class:`LifecycleSubscriber` and register at setup time. Subscribers
receive ``on_active`` when the container transitions IDLE → ACTIVE
(first job in flight) and ``on_idle`` when it transitions back
(last job done).

The engine wraps each job dispatch with ``on_job_starting`` /
``on_job_finished``. Reference counting handles overlapping jobs:
intermediate counter changes (1→2, 2→1) don't fire subscribers, only
the 0↔1 boundary.

The first user is GitHub token auth (apiarist):

- Hivemoot plugin's auth subscriber mints a token via apiarist at
  ``setup_lifecycle`` time AND keeps ``GH_TOKEN`` / ``GITHUB_TOKEN``
  populated for the container lifetime via a background refresh
  thread. ``on_active`` is a defensive proactive-refresh
  (re-mints when the current token is within the lead-time window);
  ``on_idle`` is a NO-OP. Watch-driven services (drone) need env
  populated between jobs so trigger threads can poll — clearing on
  idle would deadlock those services.
- Github plugin's clone subscriber runs ``_validate_repo_access``
  and ``clone_or_sync`` on ``on_active`` (after the auth subscriber
  has populated env per registration order — see
  :meth:`ContainerLifecycle.subscribe`).

The "always-on env" model trades one layer of defense-in-depth
(env-clear-when-idle) for trigger viability between jobs. The
strong guarantee — short token TTL via apiarist's policy + the
GitHub App 1h cap — is preserved by the refresh thread. See
``plugins_builtin/hivemoot/auth_subscriber.py`` module docstring
for the trade-off rationale in full.

Future cross-cutting concerns reuse the same surface (metrics on
state changes, secret rotation, audit logging, …).

Synchronicity: this module is **synchronous** to match the existing
plugin contract in `plugins/interfaces.py`. Subscribers that spawn
background threads (e.g. the hivemoot apiarist subscriber's
refresh thread) own their thread lifecycle outside the
``on_active`` / ``on_idle`` hooks — they may start the thread from
their plugin's ``setup_lifecycle`` and rely on ``daemon=True``
exit at process shutdown, OR expose an explicit ``stop()`` for
clean test teardown. The lifecycle module doesn't track those
subscriber-internal tasks. The reference-count invariant remains
correct under sync dispatch because ``on_job_starting`` /
``on_job_finished`` calls are serialized by the engine's per-job
sequential loop.
"""

from __future__ import annotations

import abc
import sys
import threading
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from hivemoot_agent.plugins.interfaces import Job


class LifecycleSubscriber(abc.ABC):
    """Plugin-agnostic contract for receiving container lifecycle events.

    Subscribers register via :meth:`ContainerLifecycle.subscribe` at
    plugin setup time, before the engine starts dispatching jobs.
    Implementations should:

    - Be idempotent on ``on_active`` (may run multiple times across
      the process lifetime — once per IDLE→ACTIVE transition).
    - Raise on critical setup failure in ``on_active``. The engine
      runs subscribers SEQUENTIALLY in registration order; a raise
      stops the chain, then engine awaits ``on_idle`` on every prior
      successful subscriber in REVERSE registration order
      (best-effort cleanup, each wrapped so one bad cleanup doesn't
      mask the original error), rolls the active-job counter back,
      and re-raises. The triggering job fails to start; the runtime's
      normal retry path re-attempts the full chain cleanly.
    - Tolerate own-errors in ``on_idle``. Engine logs and continues
      with other subscribers' cleanup; the lifecycle transition
      completes regardless. Best-effort.
    """

    @abc.abstractmethod
    def on_active(self) -> None:
        """Container transitioned IDLE → ACTIVE. Setup phase.

        The engine waits for this to return before dispatching the
        triggering job. Raise to fail-closed (engine rolls back the
        counter, the triggering job fails, runtime retries).
        """

    @abc.abstractmethod
    def on_idle(self) -> None:
        """Container transitioned ACTIVE → IDLE. Cleanup phase.

        Best-effort. Engine logs exceptions but continues with other
        subscribers' cleanup.
        """


class ContainerLifecycle:
    """Container-wide IDLE/ACTIVE state with subscriber events.

    The engine wires this around its job-dispatch loop:
    :meth:`on_job_starting` runs before the engine hands a job to its
    plugin; :meth:`on_job_finished` runs after. Subscribers register
    once at process setup and receive ``on_active`` / ``on_idle`` on
    the 0↔1 active-job-counter boundary. The engine waits for
    subscribers (sequentially in registration order on ``on_active``;
    sequentially in any order on ``on_idle``), so they can do setup
    work (e.g., mint a token, set env, open a connection) and the
    engine doesn't proceed until they're done.

    Five invariants the lifecycle guarantees (DESIGN.md §12.3.2):

    - **I1**: when the engine dispatches a job, every subscriber's
      ``on_active`` has completed.
    - **I2**: on full drain (last job ends), every subscriber's
      ``on_idle`` is invoked before the engine returns to the next
      idle iteration.
    - **I3**: a subscriber raising in ``on_active`` rolls the counter
      back to its prior value so the next job-start retries cleanly.
    - **I4**: a subscriber raising in ``on_idle`` is logged but
      doesn't block other subscribers' cleanup.
    - **I5**: subscribers own the lifecycle of any background
      threads / tasks they spawn. This module does NOT track
      subscriber-internal work. Concretely, each implementer must:

      a) **Surface failures themselves.** Unhandled exceptions in a
         subscriber's background thread won't reach the lifecycle's
         exception logger — the implementer must wrap their loop
         and log to stderr (or whatever channel the operator
         observes).
      b) **Pick — and document — the lifetime model that fits its
         job.** Two valid shapes:

         - *Per-cycle* (spawn-and-join inside on_active/on_idle):
           the subscriber starts the thread in ``on_active`` and
           joins it in ``on_idle``. Right when the thread's work
           is conceptually paired with a single ACTIVE period
           (e.g. a per-job metrics-flush task).

         - *Container-lifetime* (start once, stop on shutdown):
           the subscriber starts a daemon thread before subscribing
           (typically from the plugin's ``setup_lifecycle``) and
           lets process exit handle the join, OR exposes an
           explicit ``stop()`` for clean test teardown. Right when
           the subscriber owns state that must persist across
           ACTIVE/IDLE boundaries (e.g. the apiarist auth
           subscriber's token-refresh thread, which keeps the env
           valid for trigger threads polling between jobs).

      Either pattern is fine; the implementer documents the
      choice in their subscriber's class docstring so future
      maintainers don't accidentally regress one model into the
      other. The lifecycle module does not enforce or police the
      choice.
    """

    def __init__(self) -> None:
        self._active_jobs: int = 0
        self._subscribers: list[LifecycleSubscriber] = []
        # Reentrant lock because a subscriber's on_active could in
        # principle call back into the engine, which would in turn
        # call on_job_starting. RLock prevents the inner call from
        # deadlocking on the outer call's lock; subscriber-callback
        # patterns aren't expected in V1 but the cost of RLock vs
        # Lock is negligible and the safer default avoids a class
        # of subtle hangs.
        self._lock = threading.RLock()

    def subscribe(self, sub: LifecycleSubscriber) -> None:
        """Register a subscriber.

        CONTRACT — registration order is load-bearing:

        - ``on_active`` fires subscribers in REGISTRATION order (so a
          subscriber that depends on a prior subscriber's setup must
          register AFTER its dependency — e.g., github clone needs
          hivemoot auth's env var, so hivemoot registers first).
        - Rollback on partial-success ``on_active`` failure runs
          subscribers in REVERSE registration order (mirrors
          dependency teardown).
        - ``on_idle`` (full drain) runs sequentially in registration
          order; cleanup is best-effort and doesn't depend on
          completion order.

        Plugins control registration order by calling
        :meth:`subscribe` during their ``setup()``. Plugins are
        loaded in YAML insertion order under ADR-003, so the
        operator-visible plugin order in ``hivemoot.yaml`` is the
        subscriber order.

        Called ONCE per subscriber during plugin setup, before the
        engine starts dispatching jobs. NOT thread/async-safe — V1
        relies on plugin setup being single-threaded and pre-dispatch.
        """
        self._subscribers.append(sub)

    def on_job_starting(self, job: Job | None = None) -> None:
        """Engine calls this before dispatching the job.

        On the 0→1 transition, runs all subscribers' ``on_active``.

        Asymmetric ordering vs ``on_idle``:

        - ``on_active`` is **sequential** (registration order)
          because subscribers may have setup-time dependencies (one
          subscriber's effects must be visible to the next). E.g.,
          hivemoot auth subscriber writes env → github subscriber's
          clone reads it.
        - ``on_idle`` is **sequential, best-effort** (any-order):
          cleanup is order-independent and one bad cleanup must not
          mask the rest.

        Subscriber failure semantics (invariant I3 + atomicity):
        if any subscriber raises in ``on_active``, every PRIOR
        successful subscriber's ``on_idle`` is awaited in REVERSE
        registration order (best-effort cleanup mirroring dependency
        teardown), then the counter is rolled back and the original
        exception bubbles to the engine's job-dispatch loop, which
        fails the triggering job. The runtime's normal retry path
        then re-attempts the full subscriber chain cleanly.
        """
        with self._lock:
            self._active_jobs += 1
            if self._active_jobs == 1:
                # IDLE → ACTIVE — block on subscribers (invariant I1).
                completed: list[LifecycleSubscriber] = []
                try:
                    for sub in self._subscribers:
                        sub.on_active()
                        completed.append(sub)
                except Exception:
                    # Tear down successful subscribers in reverse
                    # registration order. Each cleanup wrapped so one
                    # bad cleanup doesn't mask the original setup
                    # failure.
                    for done_sub in reversed(completed):
                        try:
                            done_sub.on_idle()
                        except Exception as cleanup_exc:
                            print(
                                f"[lifecycle] subscriber on_idle raised "
                                f"during rollback: "
                                f"{type(done_sub).__name__}: "
                                f"{type(cleanup_exc).__name__}: {cleanup_exc}",
                                file=sys.stderr,
                                flush=True,
                            )
                    # Roll back counter so next job-start retries
                    # the full chain cleanly (I3).
                    self._active_jobs -= 1
                    raise

    def on_job_finished(self, job: Job | None = None) -> None:
        """Engine calls this after the job completes (success or fail).

        On the 1→0 transition, runs all subscribers' ``on_idle`` for
        cleanup. Subscriber errors here are logged but don't propagate
        (invariant I4) — the job is done, cleanup should be
        best-effort across all subscribers.

        Defensive early-return when counter is already 0: defends
        against a stray ``on_job_finished`` call (buggy engine path
        or test setup). Without this, every spurious call would
        re-fire ``on_idle`` (subscribers tearing down already-torn-
        down state) AND would be impossible to distinguish from a
        real 1→0 transition. Returning early keeps the counter
        non-negative, prevents the next 0→1 transition from being
        missed, and ensures ``on_idle`` fires exactly once per cycle.
        """
        with self._lock:
            if self._active_jobs == 0:
                return
            self._active_jobs -= 1
            if self._active_jobs == 0:
                # ACTIVE → IDLE — all subscribers' cleanup runs (I2, I4).
                for sub in self._subscribers:
                    try:
                        sub.on_idle()
                    except Exception as exc:
                        print(
                            f"[lifecycle] subscriber on_idle raised: "
                            f"{type(sub).__name__}: "
                            f"{type(exc).__name__}: {exc}",
                            file=sys.stderr,
                            flush=True,
                        )

    @property
    def is_active(self) -> bool:
        """Whether the container currently has any in-flight jobs.

        Snapshot — not lock-protected; useful for diagnostics and
        tests, not for control flow (anything depending on this
        should use the lifecycle's own state-machine semantics
        instead).
        """
        return self._active_jobs > 0

    @property
    def active_job_count(self) -> int:
        """Number of in-flight jobs. Snapshot — diagnostics only."""
        return self._active_jobs

    @property
    def subscriber_count(self) -> int:
        """Number of registered subscribers. Diagnostics."""
        return len(self._subscribers)
