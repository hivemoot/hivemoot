"""Tests for the engine-side lifecycle substrate (PR B of the
JOB_LIFECYCLE_UNIFICATION RFC). The substrate itself is domain-agnostic
— these tests pin its threading invariants, the matcher registry's
fall-through semantics, and the per-job ABC contract that future
domain reporters will subclass.

What's NOT tested here: the per-domain reporters (TaskLifecycleReporter,
RoomLifecycleReporter). Those land in PRs C and D and have their own
test files. PR B's substrate is exercised here against fake reporters
that record what happened.
"""

from __future__ import annotations

import os
import sys
import threading
import time
import unittest
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins.interfaces import AgentResult, Job
from hivemoot_agent.plugins_builtin.hivemoot.job_lifecycle import (
    JobLifecycleReporter,
    LifecycleMultiplexer,
    MultipleMatchingReportersError,
    NoMatchingReporterError,
)


# ── Fake reporter used in most tests ─────────────────────────────────


@dataclass
class FakeReporter(JobLifecycleReporter):
    """Records every callback so tests can assert ordering + counts."""

    label: str = "fake"
    starts: list[Job] = field(default_factory=list)
    heartbeats: list[Job] = field(default_factory=list)
    progresses: list[tuple[Job, str]] = field(default_factory=list)
    finishes: list[tuple[Job, AgentResult]] = field(default_factory=list)
    failures: list[tuple[Job, str]] = field(default_factory=list)
    raise_in_heartbeat: bool = False

    def on_start(self, job: Job) -> None:
        self.starts.append(job)

    def on_heartbeat(self, job: Job) -> None:
        self.heartbeats.append(job)
        if self.raise_in_heartbeat:
            raise RuntimeError("simulated heartbeat failure")

    def on_progress(self, job: Job, text: str) -> None:
        self.progresses.append((job, text))

    def on_finish(self, job: Job, result: AgentResult) -> None:
        self.finishes.append((job, result))

    def on_failure(self, job: Job, error_text: str) -> None:
        self.failures.append((job, error_text))


def _job(session_key: str = "j1", **metadata: Any) -> Job:
    return Job(session_key=session_key, prompt="p", metadata=dict(metadata))


# ── ABC enforcement (Q2: ABC over Protocol for forward-compat) ─────


class AbcContractTests(unittest.TestCase):
    """The fleet picked ABC over Protocol so future hooks fail
    compile if a subclass forgets them. Pin that promise."""

    def test_subclass_missing_required_method_cannot_instantiate(self):
        class Incomplete(JobLifecycleReporter):
            # Only implements on_start; missing heartbeat/finish/failure
            def on_start(self, job: Job) -> None:
                pass

        with self.assertRaises(TypeError) as ctx:
            Incomplete()  # type: ignore[abstract]
        self.assertIn("abstract", str(ctx.exception).lower())

    def test_on_progress_default_is_noop(self):
        # on_progress is intentionally optional — subclasses that
        # don't have a progress channel inherit a no-op.
        class NoProgress(JobLifecycleReporter):
            def on_start(self, job: Job) -> None: pass
            def on_heartbeat(self, job: Job) -> None: pass
            def on_finish(self, job: Job, r: AgentResult) -> None: pass
            def on_failure(self, job: Job, e: str) -> None: pass

        # Construct + call — must not raise.
        NoProgress().on_progress(_job(), "anything")


# ── Matcher registry (Q6 decisions) ──────────────────────────────────


class MatcherRegistryTests(unittest.TestCase):

    def test_first_match_wins_in_production_mode(self):
        # Two matchers both match — production picks the first one
        # registered without scanning the rest.
        mux = LifecycleMultiplexer(dev_mode=False)
        first = FakeReporter(label="first")
        second = FakeReporter(label="second")
        mux.register(lambda j: True, lambda j: first)
        mux.register(lambda j: True, lambda j: second)
        chosen = mux.select_reporter(_job())
        self.assertIs(chosen, first)

    def test_dev_mode_raises_on_matcher_overlap(self):
        # Mutual exclusion is the invariant — dev_mode=True iterates
        # ALL matchers and rejects any overlap.
        mux = LifecycleMultiplexer(dev_mode=True)
        mux.register(lambda j: True, lambda j: FakeReporter("a"))
        mux.register(lambda j: True, lambda j: FakeReporter("b"))
        with self.assertRaises(MultipleMatchingReportersError) as ctx:
            mux.select_reporter(_job(task_id="t1"))
        # Error message exposes job context for debugging.
        self.assertIn("task_id", str(ctx.exception))

    def test_zero_match_raises_no_matching_reporter(self):
        # Per Q6, zero-match is fail-loud rather than silent drop.
        mux = LifecycleMultiplexer(dev_mode=False)
        mux.register(lambda j: False, lambda j: FakeReporter())
        with self.assertRaises(NoMatchingReporterError):
            mux.select_reporter(_job())

    def test_zero_match_raises_in_dev_mode_too(self):
        mux = LifecycleMultiplexer(dev_mode=True)
        mux.register(lambda j: False, lambda j: FakeReporter())
        with self.assertRaises(NoMatchingReporterError):
            mux.select_reporter(_job())

    def test_matcher_inspects_metadata(self):
        # Realistic shape: matchers discriminate on metadata keys
        # (`task_id` for tasks, `room_id` for war rooms).
        mux = LifecycleMultiplexer(dev_mode=True)
        task_reporter = FakeReporter("task")
        room_reporter = FakeReporter("room")
        mux.register(
            lambda j: "task_id" in j.metadata,
            lambda j: task_reporter,
        )
        mux.register(
            lambda j: "room_id" in j.metadata,
            lambda j: room_reporter,
        )
        self.assertIs(
            mux.select_reporter(_job(task_id="t1")),
            task_reporter,
        )
        self.assertIs(
            mux.select_reporter(_job(room_id="r1")),
            room_reporter,
        )

    def test_dev_mode_overlap_message_is_actionable(self):
        # The error message has to tell the operator what to fix.
        mux = LifecycleMultiplexer(dev_mode=True)
        mux.register(lambda j: True, lambda j: FakeReporter())
        mux.register(lambda j: True, lambda j: FakeReporter())
        with self.assertRaises(MultipleMatchingReportersError) as ctx:
            mux.select_reporter(_job(task_id="t1", room_id="r1"))
        msg = str(ctx.exception)
        self.assertIn("mutually exclusive", msg)
        self.assertIn("metadata", msg)


# ── Lifecycle ordering + heartbeat threading ────────────────────────


class LifecycleOrderingTests(unittest.TestCase):

    def _build(self, **kwargs: Any) -> tuple[LifecycleMultiplexer, FakeReporter]:
        reporter = FakeReporter()
        mux = LifecycleMultiplexer(
            heartbeat_interval=kwargs.pop("interval", 0),
            **kwargs,
        )
        mux.register(lambda j: True, lambda j: reporter)
        return mux, reporter

    def test_on_job_start_invokes_on_start_then_spawns_heartbeat(self):
        mux, reporter = self._build(interval=0)  # interval=0 → no thread
        job = _job()
        mux.on_job_start(job)
        self.assertEqual(reporter.starts, [job])
        # interval=0 path skips thread spawn entirely.
        self.assertIsNone(mux._stop_event)
        self.assertIsNone(mux._thread)

    def test_interval_zero_disables_heartbeat_thread(self):
        # Mirrors the existing AGENT_TASK_HEARTBEAT_INTERVAL=0 opt-out.
        mux, reporter = self._build(interval=0)
        mux.on_job_start(_job())
        time.sleep(0.05)
        self.assertEqual(len(reporter.heartbeats), 0)
        mux.on_job_finish(_job(), AgentResult(exit_code=0, response=""))

    def test_heartbeat_thread_fires_at_interval(self):
        # Use a tiny interval so the test runs fast. The substrate's
        # default is 45s in production.
        mux, reporter = self._build(interval=0.05)
        job = _job()
        mux.on_job_start(job)
        time.sleep(0.18)  # ~3 ticks worth
        # At least 2 heartbeats should have fired by now.
        observed = len(reporter.heartbeats)
        mux.on_job_finish(job, AgentResult(exit_code=0, response=""))
        self.assertGreaterEqual(observed, 2)
        for hb in reporter.heartbeats:
            self.assertIs(hb, job)

    def test_on_job_finish_stops_heartbeat_before_calling_on_finish(self):
        # The ordering invariant: a heartbeat must NEVER land after
        # on_finish — that would race the terminal post and confuse
        # the dashboard.
        mux, reporter = self._build(interval=0.02)
        mux.on_job_start(_job())
        time.sleep(0.08)  # let some heartbeats fire
        result = AgentResult(exit_code=0, response="ok")
        mux.on_job_finish(_job(), result)
        # After on_finish, no further heartbeats can land.
        snapshot_count = len(reporter.heartbeats)
        time.sleep(0.10)
        self.assertEqual(len(reporter.heartbeats), snapshot_count)
        # And on_finish itself was called exactly once.
        self.assertEqual(len(reporter.finishes), 1)
        self.assertIs(reporter.finishes[0][1], result)

    def test_on_job_failure_stops_heartbeat_and_dispatches(self):
        mux, reporter = self._build(interval=0.02)
        mux.on_job_start(_job())
        time.sleep(0.06)
        mux.on_job_failure(_job(), "kaboom")
        time.sleep(0.10)
        # Heartbeat thread is dead.
        self.assertIsNone(mux._thread)
        # on_failure was called with the error text.
        self.assertEqual(len(reporter.failures), 1)
        self.assertEqual(reporter.failures[0][1], "kaboom")

    def test_heartbeat_exception_does_not_kill_thread(self):
        # The thread guards reporter exceptions — one bad tick must
        # not silently end heartbeats for the rest of the job.
        reporter = FakeReporter(raise_in_heartbeat=True)
        mux = LifecycleMultiplexer(heartbeat_interval=0.03)
        mux.register(lambda j: True, lambda j: reporter)
        mux.on_job_start(_job())
        time.sleep(0.15)  # ~5 ticks; every one raises
        observed = len(reporter.heartbeats)
        mux.on_job_finish(_job(), AgentResult(exit_code=0, response=""))
        # Thread kept firing despite raising every time.
        self.assertGreaterEqual(observed, 3)

    def test_reporter_cleared_after_finish(self):
        # Stray callbacks must not fire on stale state once the job
        # ends. .reporter is the public observable.
        mux, reporter = self._build(interval=0)
        mux.on_job_start(_job())
        self.assertIs(mux.reporter, reporter)
        mux.on_job_finish(_job(), AgentResult(exit_code=0, response=""))
        self.assertIsNone(mux.reporter)

    def test_reporter_cleared_after_failure(self):
        mux, reporter = self._build(interval=0)
        mux.on_job_start(_job())
        mux.on_job_failure(_job(), "boom")
        self.assertIsNone(mux.reporter)

    def test_per_job_stop_event_isolation(self):
        # Job 2's start must spawn a fresh stop_event so a slow
        # join from job 1 cannot bleed into job 2.
        mux, reporter = self._build(interval=0.05)
        mux.on_job_start(_job("j1"))
        first_event = mux._stop_event
        mux.on_job_finish(_job("j1"), AgentResult(0, ""))
        mux.on_job_start(_job("j2"))
        second_event = mux._stop_event
        self.assertIsNotNone(second_event)
        self.assertIsNot(second_event, first_event)
        mux.on_job_finish(_job("j2"), AgentResult(0, ""))

    def test_heartbeat_loop_inner_guard_terminates_thread_when_reporter_cleared(self):
        # Specifically exercises the `if reporter is None: return`
        # guard INSIDE the loop body, distinct from the outer
        # `while not stop_event.wait(...)` exit.
        #
        # Guard-feedback fix (#614): an earlier version of this test
        # checked `len(reporter.heartbeats)` after clearing
        # _reporter. That assertion held regardless of the inner
        # guard — when the loop reads `self._reporter` into a fresh
        # local on each tick, both paths (guard or no guard) end up
        # with `reporter = None` and the original FakeReporter never
        # gets called. So the test couldn't fail.
        #
        # The actual observable difference is **thread liveness**:
        # WITH the guard, the loop sees `reporter is None` and
        # returns, terminating the thread.
        # WITHOUT the guard, the loop calls `None.on_heartbeat(job)`,
        # the except clause logs AttributeError, and the loop spins
        # forever (until stop_event is set). So we assert the thread
        # has terminated WITHOUT setting stop_event.
        reporter = FakeReporter()
        mux = LifecycleMultiplexer(heartbeat_interval=0.02)
        mux.register(lambda j: True, lambda j: reporter)
        mux.on_job_start(_job())
        thread = mux._thread
        self.assertIsNotNone(thread)
        time.sleep(0.06)  # ~3 ticks; proves the loop is iterating
        self.assertGreater(
            len(reporter.heartbeats), 0,
            "loop never ticked — test setup broken",
        )
        self.assertTrue(thread.is_alive())

        # Clear the reporter ref. Crucially, do NOT set stop_event —
        # the only way the thread can terminate is via the inner
        # guard's `return`.
        mux._reporter = None
        time.sleep(0.15)  # several intervals — guard has had time to fire

        # If the inner guard worked, the thread is dead AND
        # stop_event was never set.
        self.assertFalse(
            thread.is_alive(),
            "thread is still spinning after _reporter cleared — "
            "inner guard did not fire",
        )
        self.assertFalse(
            mux._stop_event.is_set() if mux._stop_event else False,
            "stop_event was set — test would have passed even "
            "without the inner guard via the outer while-condition",
        )


# ── Smoke test exercising both reporters at once (the realistic
#    end-state where tasks + war_rooms each register one matcher). ──


class MultiDomainSmokeTests(unittest.TestCase):

    def test_two_domains_with_disjoint_matchers(self):
        mux = LifecycleMultiplexer(dev_mode=True, heartbeat_interval=0)
        task_reporter = FakeReporter("task")
        room_reporter = FakeReporter("room")
        mux.register(
            lambda j: "task_id" in j.metadata,
            lambda j: task_reporter,
        )
        mux.register(
            lambda j: "room_id" in j.metadata,
            lambda j: room_reporter,
        )

        # Drive a task job end-to-end.
        task_job = _job("task-job", task_id="t1")
        mux.on_job_start(task_job)
        mux.on_job_finish(task_job, AgentResult(exit_code=0, response="r"))

        # Then a room job.
        room_job = _job("room-job", room_id="r1")
        mux.on_job_start(room_job)
        mux.on_job_failure(room_job, "timeout")

        # Each reporter saw only its own job.
        self.assertEqual([j.session_key for j in task_reporter.starts], ["task-job"])
        self.assertEqual([j.session_key for j in room_reporter.starts], ["room-job"])
        self.assertEqual(len(task_reporter.finishes), 1)
        self.assertEqual(len(room_reporter.failures), 1)
        # No cross-talk:
        self.assertEqual(task_reporter.failures, [])
        self.assertEqual(room_reporter.finishes, [])


if __name__ == "__main__":
    unittest.main()
