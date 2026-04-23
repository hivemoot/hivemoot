"""Tests for CronTrigger + CronPlugin lifecycle."""

from __future__ import annotations

import io
import json
import os
import sys
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins.interfaces import AgentResult, Job, PluginConfig
from hivemoot_agent.plugins_builtin.cron import CronPlugin, create_plugin
from hivemoot_agent.plugins_builtin.cron.config import CronConfig
from hivemoot_agent.plugins_builtin.cron.schedule import parse_schedules
from hivemoot_agent.plugins_builtin.cron.trigger import (
    CronTrigger,
    _compute_next_fire,
)


def _make_cfg(entries: list[dict]) -> PluginConfig:
    return PluginConfig(name="cron", typed=CronConfig(schedules=entries))


# ── Plugin lifecycle ──────────────────────────────────────────────


class PluginLifecycleTests(unittest.TestCase):
    def test_validate_empty_config_ok(self) -> None:
        plugin = create_plugin()
        self.assertEqual(
            plugin.validate(PluginConfig(name="cron", typed=CronConfig())),
            [],
        )

    def test_invalid_config_fails_at_typed_config_load(self) -> None:
        with self.assertRaises(Exception) as ctx:
            CronConfig(schedules=[
                {"name": "x", "schedule": "bad", "prompt": "p"},
            ])
        self.assertIn("invalid cron expression", str(ctx.exception))

    def test_triggers_returns_single_instance(self) -> None:
        plugin = create_plugin()
        trigs = plugin.triggers()
        self.assertEqual(len(trigs), 1)
        self.assertIsInstance(trigs[0], CronTrigger)

    def test_empty_system_prompt(self) -> None:
        plugin = create_plugin()
        self.assertEqual(
            plugin.system_prompt(PluginConfig(name="cron", settings={})),
            "",
        )

    def test_lifecycle_hooks_are_noops(self) -> None:
        plugin = create_plugin()
        cfg = PluginConfig(name="cron", typed=CronConfig())
        self.assertIsNone(plugin.setup(cfg))
        self.assertIsNone(
            plugin.on_job_started(Job(session_key="", prompt="x"), cfg),
        )
        self.assertIsNone(
            plugin.on_job_finished(
                Job(session_key="", prompt="x"),
                AgentResult(exit_code=0, response=""),
                cfg,
            ),
        )


# ── Trigger.validate ──────────────────────────────────────────────


class TriggerValidationTests(unittest.TestCase):
    def test_valid_config_passes(self) -> None:
        trig = CronTrigger(MagicMock())
        cfg = _make_cfg([
            {"name": "a", "schedule": "@every 1h", "prompt": "p"},
        ])
        self.assertEqual(trig.validate(cfg), [])

    def test_invalid_config_fails(self) -> None:
        with self.assertRaises(Exception):
            _make_cfg([
                {"name": "a", "schedule": "not a cron", "prompt": "p"},
            ])


# ── Trigger dispatch loop ────────────────────────────────────────


class TriggerDispatchTests(unittest.TestCase):
    def test_empty_config_idles(self) -> None:
        """No schedules → blocks until stop, does not crash."""
        trig = CronTrigger(MagicMock())
        cfg = PluginConfig(name="cron", typed=CronConfig())
        dispatcher = MagicMock()

        done = threading.Event()

        def runner():
            with patch("sys.stderr", io.StringIO()):
                trig.start(cfg, dispatcher)
            done.set()

        t = threading.Thread(target=runner, daemon=True)
        t.start()
        time.sleep(0.05)
        trig.stop()
        self.assertTrue(done.wait(timeout=2.0))
        dispatcher.dispatch.assert_not_called()

    def test_dispatches_single_schedule(self) -> None:
        trig = CronTrigger(MagicMock())
        cfg = _make_cfg([
            {"name": "auto", "schedule": "@every 1h", "prompt": "do things"},
        ])
        dispatcher = MagicMock()

        def stop_after_first(_job):
            trig.stop()
            return True
        dispatcher.dispatch.side_effect = stop_after_first

        # The seed call sets next_fire to (seed + 1h); subsequent calls
        # return a time past that so delay = 0 and dispatch runs
        # immediately with no real sleep.
        from hivemoot_agent.plugins_builtin.cron import expression as expr_mod
        base = datetime(2026, 4, 18, 12, 0, tzinfo=timezone.utc)
        past_fire = base + timedelta(hours=2)
        # 4 calls: seed, top-of-loop, post-wait, coalesce-probe.
        call_times = iter([base, past_fire, past_fire, past_fire])
        with patch.object(expr_mod, "now_utc", lambda: next(call_times)):
            with patch("sys.stderr", io.StringIO()):
                trig.start(cfg, dispatcher)

        dispatcher.dispatch.assert_called_once()
        job = dispatcher.dispatch.call_args.args[0]
        self.assertEqual(job.session_key, "")
        self.assertEqual(job.prompt, "do things")
        self.assertEqual(job.metadata["cron"]["schedule_name"], "auto")
        self.assertFalse(job.metadata["cron"]["resume"])

    def test_resume_true_sets_session_key(self) -> None:
        trig = CronTrigger(MagicMock())
        cfg = _make_cfg([{
            "name": "weekly", "schedule": "@every 1h",
            "prompt": "p", "resume": True,
        }])
        dispatcher = MagicMock()

        def stop_after_first(_job):
            trig.stop()
            return True
        dispatcher.dispatch.side_effect = stop_after_first

        from hivemoot_agent.plugins_builtin.cron import expression as expr_mod
        base = datetime(2026, 4, 18, 12, 0, tzinfo=timezone.utc)
        past_fire = base + timedelta(hours=2)
        # 4 calls: seed, top-of-loop, post-wait, coalesce-probe.
        call_times = iter([base, past_fire, past_fire, past_fire])
        with patch.object(expr_mod, "now_utc", lambda: next(call_times)):
            with patch("sys.stderr", io.StringIO()):
                trig.start(cfg, dispatcher)

        job = dispatcher.dispatch.call_args.args[0]
        self.assertEqual(job.session_key, "cron:weekly")
        self.assertTrue(job.metadata["cron"]["resume"])

    def test_multiple_schedules_fire_in_order(self) -> None:
        """When two schedules come due simultaneously, dispatch is sorted by name."""
        trig = CronTrigger(MagicMock())
        cfg = _make_cfg([
            {"name": "zebra", "schedule": "@every 1h", "prompt": "z"},
            {"name": "alpha", "schedule": "@every 1h", "prompt": "a"},
        ])
        dispatcher = MagicMock()
        dispatched: list[str] = []

        def record(job):
            dispatched.append(job.metadata["cron"]["schedule_name"])
            if len(dispatched) >= 2:
                trig.stop()
            return True
        dispatcher.dispatch.side_effect = record

        from hivemoot_agent.plugins_builtin.cron import expression as expr_mod
        base = datetime(2026, 4, 18, 12, 0, tzinfo=timezone.utc)
        past_fire = base + timedelta(hours=2)
        # 1 shared seed + top-of-loop + post-wait + 2 coalesce probes = 5.
        call_times = iter([base, past_fire, past_fire, past_fire, past_fire])
        with patch.object(expr_mod, "now_utc", lambda: next(call_times)):
            with patch("sys.stderr", io.StringIO()):
                trig.start(cfg, dispatcher)

        self.assertEqual(dispatched, ["alpha", "zebra"])

    def test_stop_unblocks_long_wait(self) -> None:
        trig = CronTrigger(MagicMock())
        # @every is used deliberately: its reachability probe is O(1),
        # unlike a grammar-valid cron with a rare match (say yearly
        # schedules) which iterate up to a year minute-by-minute.
        cfg = _make_cfg([
            {"name": "a", "schedule": "@every 365d", "prompt": "p"},
        ])
        dispatcher = MagicMock()

        done = threading.Event()

        def runner():
            with patch("sys.stderr", io.StringIO()):
                trig.start(cfg, dispatcher)
            done.set()

        t = threading.Thread(target=runner, daemon=True)
        t.start()
        time.sleep(0.05)
        trig.stop()
        self.assertTrue(done.wait(timeout=2.0),
                        "trigger.start did not exit after stop()")
        dispatcher.dispatch.assert_not_called()

    def test_missing_typed_config_fails_closed(self) -> None:
        """Runtime config without typed CronConfig is a programmer error."""
        trig = CronTrigger(MagicMock())
        cfg = PluginConfig(name="cron", settings={
            "CRON_SCHEDULES_JSON": "not json",
        })
        dispatcher = MagicMock()
        with self.assertRaises(TypeError) as ctx:
            trig.start(cfg, dispatcher)
        self.assertIn("typed CronConfig", str(ctx.exception))
        self.assertIn("NoneType", str(ctx.exception))
        dispatcher.dispatch.assert_not_called()

    def test_slow_run_coalesces_missed_ticks(self) -> None:
        """A previous run that overran the cadence must NOT produce a
        backlog storm — the cursor advances past ``now`` in one hop,
        matching the legacy on_duplicate_agent semantics.

        Regression test for: ``* * * * *`` schedule, dispatch takes
        5 minutes, naive advance-from-planned would fire 4 more times
        back-to-back after the first dispatch returned (one for each
        minute in the past).  Fix: coalesce into one skip.
        """
        trig = CronTrigger(MagicMock())
        cfg = _make_cfg([
            {"name": "minutely", "schedule": "* * * * *", "prompt": "p"},
        ])
        dispatcher = MagicMock()
        dispatch_count = {"n": 0}

        def stop_after_first(_job):
            dispatch_count["n"] += 1
            trig.stop()
            return True
        dispatcher.dispatch.side_effect = stop_after_first

        from hivemoot_agent.plugins_builtin.cron import expression as expr_mod
        base = datetime(2026, 4, 18, 12, 0, tzinfo=timezone.utc)
        # Simulates "dispatch took 5 minutes."  By the time we're back
        # in the loop the clock is at 12:05 but the last planned fire
        # was 12:00.  Naive advance would fire for 12:01/02/03/04
        # before the while-condition check.
        late = base + timedelta(minutes=5)
        # now_utc call sites: (1) seed, (2) top-of-loop, (3) post-wait,
        # (4) coalesce-probe after dispatch.
        call_times = iter([base, late, late, late])

        stderr_io = io.StringIO()
        with patch.object(expr_mod, "now_utc", lambda: next(call_times)):
            with patch("sys.stderr", stderr_io):
                trig.start(cfg, dispatcher)

        self.assertEqual(
            dispatch_count["n"], 1,
            "expected exactly one dispatch; backlog storm regression",
        )
        output = stderr_io.getvalue()
        self.assertIn("coalesced", output)
        self.assertIn("missed tick", output)

    def test_on_time_run_does_not_coalesce(self) -> None:
        """Normal on-time runs must NOT log coalesce — only overruns do."""
        trig = CronTrigger(MagicMock())
        cfg = _make_cfg([
            {"name": "hourly", "schedule": "@every 1h", "prompt": "p"},
        ])
        dispatcher = MagicMock()

        def stop_after_first(_job):
            trig.stop()
            return True
        dispatcher.dispatch.side_effect = stop_after_first

        from hivemoot_agent.plugins_builtin.cron import expression as expr_mod
        base = datetime(2026, 4, 18, 12, 0, tzinfo=timezone.utc)
        # "Slight overrun" model: first fire planned at base+1h, actual
        # dispatch returned 5s later.  Post-fire advance gives base+2h
        # which is strictly after now (base+1h+5s) → no coalesce.
        past_fire = base + timedelta(hours=1, seconds=5)
        call_times = iter([base, past_fire, past_fire, past_fire])

        stderr_io = io.StringIO()
        with patch.object(expr_mod, "now_utc", lambda: next(call_times)):
            with patch("sys.stderr", stderr_io):
                trig.start(cfg, dispatcher)

        output = stderr_io.getvalue()
        self.assertNotIn("coalesced", output)


# ── Seed boundary race (P1a) ──────────────────────────────────────


class SeedBoundaryRaceTests(unittest.TestCase):
    """Regression: per-schedule ``now_utc()`` calls at seed time could
    straddle a schedule's fire boundary, making identical schedules
    diverge by a full cron period.
    """

    def test_seed_uses_single_now_utc_call(self) -> None:
        """Three identical schedules must all produce the same first
        fire time — which requires seeding against a single ``now``."""
        trig = CronTrigger(MagicMock())
        cfg = _make_cfg([
            {"name": f"s{i}", "schedule": "0 9 * * *", "prompt": "p"}
            for i in range(3)
        ])

        call_count = 0
        far_future = datetime(2030, 1, 1, tzinfo=timezone.utc)

        def spy_now():
            nonlocal call_count
            call_count += 1
            return far_future

        from hivemoot_agent.plugins_builtin.cron import expression as expr_mod
        done = threading.Event()

        def runner():
            with patch.object(expr_mod, "now_utc", spy_now):
                with patch("sys.stderr", io.StringIO()):
                    trig.start(cfg, MagicMock())
            done.set()

        t = threading.Thread(target=runner, daemon=True)
        t.start()
        time.sleep(0.05)
        trig.stop()
        self.assertTrue(done.wait(timeout=2.0))

        # Expected call pattern (fixed): 1 seed + 1 top-of-loop + (0 or
        # 1 post-wait depending on when stop landed) = 2 or 3.  Buggy
        # per-schedule seed with 3 schedules would be 3 + 1 or 2 = 4-5.
        self.assertLessEqual(
            call_count, 3,
            f"now_utc called {call_count} times — expected <=3; "
            f"regression in per-schedule seeding (3 schedules × 1 "
            f"seed call each = 3 seed calls instead of 1)",
        )


# ── Jitter semantics (P1b and @every preservation) ─────────────────


class JitterBehaviorTests(unittest.TestCase):
    """Jitter is baked into the stored fire time (``next_fires``) at
    compute time, not applied as a sleep in ``_fire_one``.  This is
    load-bearing for two properties:

      * A jittered schedule does not block other schedules that come
        due during its jitter window (the main loop's natural wait
        handles the jitter and wakes for any earlier fire).
      * ``@every Nh`` keeps "at least N hours between actual fires"
        because advancement happens from the jittered fire, not the
        planned fire.
    """

    def _schedules(self, entries: list[dict]):
        return parse_schedules(json.dumps(entries))

    def test_jitter_applied_to_stored_fire_time(self) -> None:
        """With jitter=300 and mocked randint=180, the fire time is
        planned + 180s, not planned."""
        schedules = self._schedules([
            {"name": "a", "schedule": "@every 1h",
             "jitter_secs": 300, "prompt": "p"},
        ])
        s = schedules[0]
        base = datetime(2026, 4, 18, 12, 0, tzinfo=timezone.utc)
        from hivemoot_agent.plugins_builtin.cron import trigger as trig_mod
        with patch.object(trig_mod.random, "randint", return_value=180):
            fire = _compute_next_fire(s, base)
        self.assertEqual(fire, base + timedelta(hours=1, seconds=180))

    def test_jitter_does_not_affect_other_schedules(self) -> None:
        """Two schedules sharing a seed: one with jitter, one without.
        The unjittered schedule's fire time must not be shifted by
        the other's jitter — which can only hold if jitter is per-
        schedule state (baked into each entry), not a shared sleep."""
        schedules = self._schedules([
            {"name": "a", "schedule": "@every 1h",
             "jitter_secs": 300, "prompt": "p"},
            {"name": "b", "schedule": "@every 1h", "prompt": "p"},
        ])
        base = datetime(2026, 4, 18, 12, 0, tzinfo=timezone.utc)
        from hivemoot_agent.plugins_builtin.cron import trigger as trig_mod
        with patch.object(trig_mod.random, "randint", return_value=240):
            a_fire = _compute_next_fire(schedules[0], base)
            b_fire = _compute_next_fire(schedules[1], base)
        self.assertEqual(a_fire, base + timedelta(hours=1, seconds=240))
        self.assertEqual(b_fire, base + timedelta(hours=1))
        # B fires *before* A — A's jitter cannot delay B.
        self.assertLess(b_fire, a_fire)

    def test_every_advances_from_effective_fire(self) -> None:
        """@every 1h with jitter: next fire MUST be at least 1h after
        the previous actual (jittered) fire.  Regression: advancing
        from planned let a fire at 13:05 schedule the next at 14:00
        (only 55 min elapsed)."""
        schedules = self._schedules([
            {"name": "hourly", "schedule": "@every 1h",
             "jitter_secs": 300, "prompt": "p"},
        ])
        s = schedules[0]
        base = datetime(2026, 4, 18, 12, 0, tzinfo=timezone.utc)
        from hivemoot_agent.plugins_builtin.cron import trigger as trig_mod

        # Worst case: first jitter is max (+300s), second jitter is 0.
        # If advancement were from planned, fire2 would be exactly
        # fire1.planned + 1h = 14:00 = only 55 min after fire1 (13:05).
        # With effective-based advancement, fire2 is fire1 + 1h = 14:05.
        with patch.object(trig_mod.random, "randint",
                          side_effect=[300, 0]):
            fire1 = _compute_next_fire(s, base)
            fire2 = _compute_next_fire(s, fire1)

        elapsed = (fire2 - fire1).total_seconds()
        self.assertGreaterEqual(
            elapsed, 3600,
            f"elapsed {elapsed}s < 3600s; @every 1h semantics violated",
        )

    def test_cron_advance_preserves_anchor_through_jitter(self) -> None:
        """For cron expressions, jitter must NOT drift the anchor:
        ``0 9 * * *`` must fire at 09:00 tomorrow no matter where
        within today's jitter window the actual fire landed."""
        schedules = self._schedules([
            {"name": "daily9am", "schedule": "0 9 * * *",
             "jitter_secs": 300, "prompt": "p"},
        ])
        s = schedules[0]
        # Seed at 8am, jitter +240s → fire 1 lands at 09:04 today.
        base = datetime(2026, 4, 18, 8, 0, tzinfo=timezone.utc)
        from hivemoot_agent.plugins_builtin.cron import trigger as trig_mod
        with patch.object(trig_mod.random, "randint",
                          side_effect=[240, 0]):
            fire1 = _compute_next_fire(s, base)
            fire2 = _compute_next_fire(s, fire1)

        # Fire 2 planned is 09:00 tomorrow (cron anchor), with 0 jitter.
        self.assertEqual(
            fire2.replace(tzinfo=timezone.utc),
            datetime(2026, 4, 19, 9, 0, tzinfo=timezone.utc),
        )

    def test_zero_jitter_reduces_to_planned(self) -> None:
        """jitter_secs=0 must yield fire time exactly at the planned
        slot — no off-by-one from random.randint(0, 0)."""
        schedules = self._schedules([
            {"name": "a", "schedule": "@every 1h", "prompt": "p"},
        ])
        base = datetime(2026, 4, 18, 12, 0, tzinfo=timezone.utc)
        fire = _compute_next_fire(schedules[0], base)
        self.assertEqual(fire, base + timedelta(hours=1))


if __name__ == "__main__":
    unittest.main()
