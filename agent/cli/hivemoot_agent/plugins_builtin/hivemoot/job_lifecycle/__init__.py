"""Engine-side lifecycle substrate shared by tasks and war rooms.

This module is the central piece of the JOB_LIFECYCLE_UNIFICATION RFC
(``docs/architecture/JOB_LIFECYCLE_UNIFICATION.md``). It owns the
heartbeat thread, the per-domain reporter dispatch, and the matcher
registry. Per-domain plugins (``tasks/``, ``war_rooms/``) provide
``JobLifecycleReporter`` subclasses that translate lifecycle events
into domain-specific HTTP calls — but the threading / lifecycle
orchestration lives here, in one place.

The fleet's RFC review locked the following:

* **Reporter shape (Q2):** ``ABC`` with ``abstractmethod`` rather than
  ``Protocol`` — guard's call. ABC fails compilation when a subclass
  forgets a new abstract method; Protocol is duck-typed and silently
  lets new methods become unimplemented. Forward-compat matters here
  because hooks like ``on_progress`` and ``on_cancellation`` will be
  added incrementally.
* **Heartbeat semantics (Q3):** pure liveness, no payload. Progress
  streaming, if it ever ships, lives on a separate ``on_progress``
  hook with its own dispatch path — never piggybacked on the
  heartbeat. Closes a payload-injection / data-leakage vector.
* **Matcher fall-through (Q6):** explicit precedence + dev-mode
  mutex assert + zero-match-error fallback.

  * Registrations are an ordered list of ``(JobMatcher, ReporterFactory)``
    pairs. **First match wins** in production for cheap dispatch.
  * In dev/test, ``select_reporter`` iterates ALL matchers and asserts
    at most one returned ``True``. Any overlap is a programming error
    surfaced at unit-test time, not at runtime.
  * If zero matchers claim a ``Job``, the multiplexer raises
    ``NoMatchingReporterError`` rather than silently dropping. An
    operator gets a clear signal that a ``Job`` arrived with metadata
    no plugin recognizes.

The substrate is deliberately decoupled from the HTTP wire shapes —
each reporter knows how to translate ``on_heartbeat`` into the right
endpoint (``POST /api/tasks/<id>/heartbeat`` vs
``POST /api/rooms/<id>/heartbeat``). Token re-resolution per tick
(needed so token rotation takes effect within one interval rather
than waiting for process restart) is also the reporter's
responsibility — the substrate just passes the ``Job`` through.
"""

from __future__ import annotations

import sys
import threading
from abc import ABC, abstractmethod
from typing import Callable

from hivemoot_agent.plugins.interfaces import AgentResult, Job

__all__ = [
    "JobLifecycleReporter",
    "JobMatcher",
    "ReporterFactory",
    "LifecycleMultiplexer",
    "NoMatchingReporterError",
    "MultipleMatchingReportersError",
]


class JobLifecycleReporter(ABC):
    """Domain-specific server-side reporting for a single ``Job``.

    One concrete subclass per domain (``RoomLifecycleReporter``,
    ``TaskLifecycleReporter``). One instance per ``Job`` — the
    multiplexer constructs a fresh reporter each time
    ``on_job_start`` runs so subclasses can cache the bearer / role /
    job_id without worrying about cross-job leakage.

    All hooks are best-effort: a reporter raising in any hook should
    log the error and return; the multiplexer guards the heartbeat
    loop so an exception there cannot kill the thread.
    """

    @abstractmethod
    def on_start(self, job: Job) -> None:
        """Job has been claimed and the engine is about to spawn the
        agent subprocess. Domains use this for the initial "starting"
        progress post (tasks) or the ``/present`` RSVP (war rooms).
        """

    @abstractmethod
    def on_heartbeat(self, job: Job) -> None:
        """Liveness ping fired every ``heartbeat_interval`` seconds.

        **Pure liveness — no payload.** Reporters MUST NOT include
        progress text, partial output, or any other domain data here.
        The fleet's RFC review (Q3) made this an explicit invariant.
        """

    def on_progress(self, job: Job, text: str) -> None:
        """Optional hook for streaming partial progress to the dashboard.

        Default no-op so existing reporters compile after the hook is
        added. Override only when a domain has a real progress channel
        — never piggyback on ``on_heartbeat``.
        """
        del job, text

    @abstractmethod
    def on_finish(self, job: Job, result: AgentResult) -> None:
        """Agent subprocess exited normally. ``result.exit_code == 0``
        is the happy path; non-zero with a result still flows here so
        the reporter can decide whether to treat it as failure
        (tasks) or as a withdraw with parse_error (war rooms).
        """

    @abstractmethod
    def on_failure(self, job: Job, error_text: str) -> None:
        """Engine-side failure that prevented a normal finish (timeout,
        provider auth error, internal exception). The reporter posts
        a domain-specific failure record.
        """


JobMatcher = Callable[[Job], bool]
"""Predicate that returns True iff this domain's reporter should
handle the given Job. Matchers inspect ``Job.metadata`` keys
(``task_id``, ``room_id``, ``kind``, etc.) and MUST be mutually
exclusive across domains — see :class:`MultipleMatchingReportersError`.
"""

ReporterFactory = Callable[[Job], JobLifecycleReporter]
"""Builds a fresh reporter instance for a single Job. The factory is
responsible for capturing per-job context (job_id, role, bearer
source) so the returned reporter can serve every lifecycle hook
without re-deriving it.
"""


class NoMatchingReporterError(RuntimeError):
    """Raised when zero registered matchers claim a ``Job``.

    Per RFC Q6, this is fail-loud — the operator sees immediately
    that a ``Job`` arrived with metadata no plugin recognizes,
    instead of the multiplexer silently dropping it.
    """


class MultipleMatchingReportersError(AssertionError):
    """Raised in dev/test when 2+ matchers claim the same ``Job``.

    Per RFC Q6, mutual exclusion across domains is an enforced
    invariant. Subclassing ``AssertionError`` (rather than plain
    ``Exception``) makes it obvious in test output that a programming
    error was caught — not a runtime data issue.
    """


class LifecycleMultiplexer:
    """Owns the heartbeat thread + reporter dispatch for one engine run.

    Usage from the plugin layer::

        mux = LifecycleMultiplexer(dev_mode=True, heartbeat_interval=45)
        mux.register(is_task_job, build_task_reporter)
        mux.register(is_war_room_job, build_room_reporter)

        # In on_job_started hook:
        mux.on_job_start(job)

        # In on_job_finished hook:
        mux.on_job_finish(job, result)

    Threading invariants:

    * ``_spawn_heartbeat`` creates a fresh ``threading.Event`` per job
      so an orphaned thread from a slow shutdown cannot post heartbeats
      for a stale job_id once the next job starts.
    * ``_stop_heartbeat`` joins with a 5s timeout. Stops the thread
      *before* invoking the reporter's ``on_finish`` so a heartbeat
      cannot land AFTER the terminal post.
    * Reporter exceptions in ``_heartbeat_loop`` are caught and logged;
      a single failure does not kill the thread.
    """

    def __init__(
        self,
        *,
        dev_mode: bool = False,
        heartbeat_interval: int = 45,
    ) -> None:
        self._registrations: list[tuple[JobMatcher, ReporterFactory]] = []
        self._dev_mode = dev_mode
        self._interval = heartbeat_interval
        self._stop_event: threading.Event | None = None
        self._thread: threading.Thread | None = None
        self._reporter: JobLifecycleReporter | None = None

    @property
    def reporter(self) -> JobLifecycleReporter | None:
        """The active reporter for the in-flight job, or ``None``."""
        return self._reporter

    @property
    def heartbeat_interval(self) -> int:
        return self._interval

    def register(
        self, matcher: JobMatcher, factory: ReporterFactory,
    ) -> None:
        """Register a (matcher, factory) pair.

        Order matters in production: ``select_reporter`` returns the
        FIRST factory whose matcher returns ``True``. In ``dev_mode``,
        the multiplexer iterates all matchers and asserts at most one
        matched; the ordering then becomes a tiebreaker that should
        never fire (because the assertion would have caught the
        overlap first).
        """
        self._registrations.append((matcher, factory))

    def select_reporter(self, job: Job) -> JobLifecycleReporter:
        """Pick a reporter for ``job`` per the matcher registry.

        Raises:
            MultipleMatchingReportersError: in dev_mode when 2+
              matchers claim the job (programming error — fix matchers).
            NoMatchingReporterError: when zero matchers claim the job.
        """
        if self._dev_mode:
            matched = [
                (matcher, factory)
                for matcher, factory in self._registrations
                if matcher(job)
            ]
            if len(matched) > 1:
                raise MultipleMatchingReportersError(
                    f"Job {job.session_key!r} matched by "
                    f"{len(matched)} reporters; matchers must be "
                    "mutually exclusive. Job metadata: "
                    f"{sorted(job.metadata.keys())}",
                )
            if not matched:
                raise NoMatchingReporterError(
                    f"No reporter matched Job {job.session_key!r}. "
                    f"Job metadata keys: {sorted(job.metadata.keys())}. "
                    "Register a matcher or fix the dispatcher.",
                )
            return matched[0][1](job)

        # Production fast path — first match wins; no all-matchers scan.
        for matcher, factory in self._registrations:
            if matcher(job):
                return factory(job)
        raise NoMatchingReporterError(
            f"No reporter matched Job {job.session_key!r}. "
            f"Job metadata keys: {sorted(job.metadata.keys())}.",
        )

    def on_job_start(self, job: Job) -> None:
        """Pick a reporter, fire ``on_start``, and spawn the heartbeat.

        Idempotency: calling twice without an intervening
        ``on_job_finish`` / ``on_job_failure`` will leak the previous
        reporter's heartbeat thread; callers must drive the lifecycle
        in pairs. The plugin's existing
        ``on_job_started``/``on_job_finished`` hooks already do.
        """
        self._reporter = self.select_reporter(job)
        self._reporter.on_start(job)
        self._spawn_heartbeat(job)

    def on_job_finish(self, job: Job, result: AgentResult) -> None:
        """Stop the heartbeat (ordering invariant), then dispatch
        ``on_finish``. The reporter is cleared so a stray callback
        cannot fire on stale state.
        """
        self._stop_heartbeat()
        reporter = self._reporter
        self._reporter = None
        if reporter is not None:
            reporter.on_finish(job, result)

    def on_job_failure(self, job: Job, error_text: str) -> None:
        """Failure path twin of :meth:`on_job_finish`. Reporter is
        cleared after dispatch, regardless of whether ``on_failure``
        raises.
        """
        self._stop_heartbeat()
        reporter = self._reporter
        self._reporter = None
        if reporter is not None:
            reporter.on_failure(job, error_text)

    def _spawn_heartbeat(self, job: Job) -> None:
        # interval=0 disables heartbeats; skip thread startup entirely
        # to avoid a tight Event.wait(0) busy-loop. Mirrors the
        # tasks/__init__.py convention so operators rolling out the
        # substrate can keep the existing AGENT_TASK_HEARTBEAT_INTERVAL=0
        # opt-out semantics.
        if self._interval <= 0:
            self._stop_event = None
            self._thread = None
            return
        stop_event = threading.Event()
        self._stop_event = stop_event
        self._thread = threading.Thread(
            target=self._heartbeat_loop,
            args=(job, stop_event),
            name=f"lifecycle-heartbeat-{job.session_key}",
            daemon=True,
        )
        self._thread.start()

    def _stop_heartbeat(self) -> None:
        # Clear instance refs first so a fresh on_job_start during the
        # join window cannot resurrect this stop_event.
        stop_event = self._stop_event
        thread = self._thread
        self._stop_event = None
        self._thread = None
        if stop_event is not None:
            stop_event.set()
        if thread is not None:
            thread.join(timeout=5)

    def _heartbeat_loop(
        self, job: Job, stop_event: threading.Event,
    ) -> None:
        # `Event.wait(timeout)` returns True iff the event was set
        # within `timeout` seconds — i.e. shutdown signal received.
        # Returning False means the timeout expired and we should fire
        # another heartbeat.
        while not stop_event.wait(self._interval):
            reporter = self._reporter
            if reporter is None:
                # Job finished between ticks; bail without firing a
                # heartbeat that would race the terminal post.
                return
            try:
                reporter.on_heartbeat(job)
            except Exception as exc:  # noqa: BLE001 — best-effort log
                print(
                    f"[lifecycle] heartbeat error for "
                    f"{job.session_key}: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
