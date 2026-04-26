"""Tests for ``hivemoot_agent.lifecycle.ContainerLifecycle``.

Validates the five invariants documented in the class docstring
(I1-I5 — apiarist DESIGN.md §12.3.2):

- I1: when ``on_job_starting`` returns, every subscriber's
  ``on_active`` has run exactly once on the IDLE→ACTIVE boundary.
- I2: ``on_job_finished`` triggers every subscriber's ``on_idle``
  on the ACTIVE→IDLE boundary.
- I3: a subscriber raising in ``on_active`` rolls the counter back
  and tears down prior successful subscribers in reverse order.
- I4: a subscriber raising in ``on_idle`` is logged but doesn't
  block other subscribers' cleanup.
- I5: counter ``max(0, …)`` clamp defends against a stray
  ``on_job_finished`` call (e.g. a buggy engine path).

Plus reference-counting (intermediate 1→2 / 2→1 don't fire
subscribers — only the 0↔1 boundary does).
"""

from __future__ import annotations

import io
import os
import sys
import unittest
from contextlib import redirect_stderr

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.lifecycle import ContainerLifecycle, LifecycleSubscriber


class _RecordingSubscriber(LifecycleSubscriber):
    """Simple subscriber that records the order of lifecycle calls.

    Optionally raises on ``on_active`` / ``on_idle`` to exercise
    failure paths. The shared ``events`` list is supplied by the test
    so multiple subscribers can be ordered against each other.
    """

    def __init__(
        self,
        name: str,
        events: list[str],
        *,
        raise_on_active: bool = False,
        raise_on_idle: bool = False,
    ) -> None:
        self.name = name
        self.events = events
        self.raise_on_active = raise_on_active
        self.raise_on_idle = raise_on_idle

    def on_active(self) -> None:
        self.events.append(f"{self.name}:on_active")
        if self.raise_on_active:
            raise RuntimeError(f"{self.name} on_active failed")

    def on_idle(self) -> None:
        self.events.append(f"{self.name}:on_idle")
        if self.raise_on_idle:
            raise RuntimeError(f"{self.name} on_idle failed")


# ── Empty / single-subscriber baselines ────────────────────────────


class EmptySubscriberListTest(unittest.TestCase):
    """No subscribers → counter still tracked, no callbacks attempted."""

    def test_starts_idle(self) -> None:
        lc = ContainerLifecycle()
        self.assertFalse(lc.is_active)
        self.assertEqual(lc.active_job_count, 0)
        self.assertEqual(lc.subscriber_count, 0)

    def test_no_op_transitions_with_no_subscribers(self) -> None:
        lc = ContainerLifecycle()
        lc.on_job_starting()
        self.assertTrue(lc.is_active)
        self.assertEqual(lc.active_job_count, 1)
        lc.on_job_finished()
        self.assertFalse(lc.is_active)
        self.assertEqual(lc.active_job_count, 0)


class SingleSubscriberBoundaryTest(unittest.TestCase):
    """I1+I2 minimum case: one subscriber sees one on_active, one on_idle per cycle."""

    def test_single_subscriber_fires_on_0_to_1_and_1_to_0(self) -> None:
        events: list[str] = []
        lc = ContainerLifecycle()
        lc.subscribe(_RecordingSubscriber("only", events))

        lc.on_job_starting()
        lc.on_job_finished()

        self.assertEqual(events, ["only:on_active", "only:on_idle"])

    def test_subscriber_count_reflects_registration(self) -> None:
        lc = ContainerLifecycle()
        self.assertEqual(lc.subscriber_count, 0)
        lc.subscribe(_RecordingSubscriber("a", []))
        self.assertEqual(lc.subscriber_count, 1)
        lc.subscribe(_RecordingSubscriber("b", []))
        self.assertEqual(lc.subscriber_count, 2)


# ── Multi-subscriber ordering ─────────────────────────────────────


class RegistrationOrderTest(unittest.TestCase):
    """on_active runs subscribers in registration order (load-bearing)."""

    def test_on_active_in_registration_order(self) -> None:
        events: list[str] = []
        lc = ContainerLifecycle()
        lc.subscribe(_RecordingSubscriber("first", events))
        lc.subscribe(_RecordingSubscriber("second", events))
        lc.subscribe(_RecordingSubscriber("third", events))

        lc.on_job_starting()
        lc.on_job_finished()

        self.assertEqual(
            events,
            [
                "first:on_active",
                "second:on_active",
                "third:on_active",
                "first:on_idle",
                "second:on_idle",
                "third:on_idle",
            ],
            "on_active and on_idle must both run in registration order "
            "(load-bearing for hivemoot→github auth env handoff)",
        )


# ── Reference counting (overlapping jobs) ─────────────────────────


class ReferenceCountingTest(unittest.TestCase):
    """Intermediate counter changes (1↔2) MUST NOT fire subscribers."""

    def test_overlapping_jobs_only_fire_subscribers_at_boundary(self) -> None:
        events: list[str] = []
        lc = ContainerLifecycle()
        lc.subscribe(_RecordingSubscriber("sub", events))

        lc.on_job_starting()  # 0→1: fires on_active
        lc.on_job_starting()  # 1→2: no-op
        lc.on_job_starting()  # 2→3: no-op
        self.assertEqual(lc.active_job_count, 3)
        self.assertEqual(events, ["sub:on_active"])

        lc.on_job_finished()  # 3→2: no-op
        lc.on_job_finished()  # 2→1: no-op
        self.assertEqual(events, ["sub:on_active"])

        lc.on_job_finished()  # 1→0: fires on_idle
        self.assertEqual(events, ["sub:on_active", "sub:on_idle"])
        self.assertEqual(lc.active_job_count, 0)

    def test_repeated_cycles_re_fire_subscribers(self) -> None:
        """Subscribers must be idempotent across cycles — each IDLE→ACTIVE
        boundary fires on_active again."""
        events: list[str] = []
        lc = ContainerLifecycle()
        lc.subscribe(_RecordingSubscriber("sub", events))

        for _ in range(3):
            lc.on_job_starting()
            lc.on_job_finished()

        self.assertEqual(
            events,
            [
                "sub:on_active", "sub:on_idle",
                "sub:on_active", "sub:on_idle",
                "sub:on_active", "sub:on_idle",
            ],
        )


# ── Failure paths (I3 + I4) ───────────────────────────────────────


class OnActiveFailureRollsBackTest(unittest.TestCase):
    """I3: subscriber raising in on_active rolls back counter + reverse-order cleanup."""

    def test_failure_in_first_subscriber_raises_no_cleanup_no_increment(self) -> None:
        events: list[str] = []
        lc = ContainerLifecycle()
        lc.subscribe(_RecordingSubscriber("fail", events, raise_on_active=True))

        with self.assertRaises(RuntimeError):
            lc.on_job_starting()

        self.assertEqual(events, ["fail:on_active"])
        self.assertEqual(
            lc.active_job_count, 0,
            "counter must be rolled back to its pre-call value (I3) "
            "so the next job-start retries the full chain cleanly",
        )

    def test_failure_in_middle_subscriber_unwinds_priors_in_reverse(self) -> None:
        events: list[str] = []
        lc = ContainerLifecycle()
        lc.subscribe(_RecordingSubscriber("a", events))
        lc.subscribe(_RecordingSubscriber("b", events))
        lc.subscribe(_RecordingSubscriber("c_fails", events, raise_on_active=True))
        lc.subscribe(_RecordingSubscriber("d_never", events))

        with self.assertRaises(RuntimeError):
            lc.on_job_starting()

        self.assertEqual(
            events,
            [
                "a:on_active",
                "b:on_active",
                "c_fails:on_active",
                # Rollback in REVERSE registration order — b before a.
                "b:on_idle",
                "a:on_idle",
            ],
            "rollback must call on_idle on completed subscribers in "
            "reverse registration order (mirrors dependency teardown)",
        )
        self.assertEqual(lc.active_job_count, 0)

    def test_cleanup_failure_during_rollback_does_not_mask_original(self) -> None:
        """A bad on_idle during rollback must not mask the on_active error."""
        events: list[str] = []
        lc = ContainerLifecycle()
        lc.subscribe(_RecordingSubscriber("a_bad_cleanup", events, raise_on_idle=True))
        lc.subscribe(_RecordingSubscriber("b_fails", events, raise_on_active=True))

        stderr = io.StringIO()
        with redirect_stderr(stderr), self.assertRaises(RuntimeError) as ctx:
            lc.on_job_starting()

        # The ORIGINAL on_active failure bubbles, not the cleanup error.
        self.assertIn("b_fails on_active failed", str(ctx.exception))
        # All three events recorded: a's on_active, b's failed on_active,
        # a's failed on_idle (during rollback).
        self.assertEqual(
            events,
            ["a_bad_cleanup:on_active", "b_fails:on_active", "a_bad_cleanup:on_idle"],
        )
        # Cleanup failure was logged (not silently swallowed).
        log = stderr.getvalue()
        self.assertIn("[lifecycle]", log)
        self.assertIn("rollback", log)
        self.assertIn("a_bad_cleanup", log)
        self.assertEqual(lc.active_job_count, 0)


class OnIdleFailureContinuesTest(unittest.TestCase):
    """I4: on_idle errors are logged + cleanup continues across other subscribers."""

    def test_on_idle_failure_does_not_block_others(self) -> None:
        events: list[str] = []
        lc = ContainerLifecycle()
        lc.subscribe(_RecordingSubscriber("a_bad", events, raise_on_idle=True))
        lc.subscribe(_RecordingSubscriber("b_ok", events))
        lc.subscribe(_RecordingSubscriber("c_bad", events, raise_on_idle=True))

        lc.on_job_starting()

        stderr = io.StringIO()
        with redirect_stderr(stderr):
            # Must NOT raise — best-effort cleanup (I4).
            lc.on_job_finished()

        # All three saw on_idle even though two raised.
        self.assertEqual(
            [e for e in events if e.endswith("on_idle")],
            ["a_bad:on_idle", "b_ok:on_idle", "c_bad:on_idle"],
        )
        # Both failures logged.
        log = stderr.getvalue()
        self.assertIn("a_bad", log)
        self.assertIn("c_bad", log)
        self.assertEqual(lc.active_job_count, 0)


# ── Counter clamp (I5) ────────────────────────────────────────────


class CounterClampTest(unittest.TestCase):
    """I5: extra on_job_finished must not drive counter negative."""

    def test_extra_on_job_finished_clamps_at_zero(self) -> None:
        events: list[str] = []
        lc = ContainerLifecycle()
        lc.subscribe(_RecordingSubscriber("sub", events))

        lc.on_job_starting()
        lc.on_job_finished()
        self.assertEqual(lc.active_job_count, 0)
        self.assertEqual(events, ["sub:on_active", "sub:on_idle"])

        # Buggy extra call — must clamp, not go negative.
        lc.on_job_finished()
        self.assertEqual(
            lc.active_job_count, 0,
            "max(0, ...) clamp must keep counter non-negative so the "
            "next 0→1 transition still fires on_active",
        )

        # Crucially the next start must still fire on_active.
        lc.on_job_starting()
        self.assertEqual(
            events,
            ["sub:on_active", "sub:on_idle", "sub:on_active"],
            "after counter clamp, the next IDLE→ACTIVE boundary must "
            "still fire on_active (otherwise the clamp masks bugs that "
            "would silently disable lifecycle events)",
        )

    def test_extra_on_job_finished_does_not_re_fire_on_idle(self) -> None:
        events: list[str] = []
        lc = ContainerLifecycle()
        lc.subscribe(_RecordingSubscriber("sub", events))

        lc.on_job_starting()
        lc.on_job_finished()
        # Already at 0; clamp keeps us at 0 and on_idle does NOT re-fire.
        lc.on_job_finished()
        lc.on_job_finished()

        self.assertEqual(
            events,
            ["sub:on_active", "sub:on_idle"],
            "on_idle must fire exactly once per cycle — extra "
            "on_job_finished calls at zero must be a no-op",
        )


# ── Diagnostic property snapshots ─────────────────────────────────


class DiagnosticPropertiesTest(unittest.TestCase):
    def test_is_active_reflects_counter(self) -> None:
        lc = ContainerLifecycle()
        self.assertFalse(lc.is_active)
        lc.on_job_starting()
        self.assertTrue(lc.is_active)
        lc.on_job_starting()
        self.assertTrue(lc.is_active)
        lc.on_job_finished()
        self.assertTrue(lc.is_active)
        lc.on_job_finished()
        self.assertFalse(lc.is_active)


if __name__ == "__main__":
    unittest.main()
