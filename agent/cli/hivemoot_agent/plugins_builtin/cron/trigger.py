"""Cron trigger — one loop, N schedules, N prompts.

Architecture: a single ``CronTrigger.start()`` loop owns all configured
schedules.  Every iteration it asks each schedule for its next fire
time, sleeps until the earliest one, dispatches any schedule whose
fire time is <= now, and loops.  That keeps the loop simple (no
per-schedule threads) and makes dispatch order deterministic when two
schedules fire in the same minute (alphabetical by name).

Dispatch is synchronous: ``dispatcher.dispatch(job)`` blocks until the
engine's ``run_agent`` returns.  If a schedule's next fire time has
already passed by the time we wake up, we fire it immediately rather
than skipping — better to run a little late than silently drop work.
The expression's ``next_fire(after)`` contract guarantees strict
progress, so we never get stuck on the same minute.
"""

from __future__ import annotations

import random
import sys
import threading
from datetime import datetime, timedelta
from typing import Any

from hivemoot_agent.plugins.interfaces import Job, JobDispatcher, PluginConfig
from hivemoot_agent.plugins_builtin.cron import expression as _expression_mod
from hivemoot_agent.plugins_builtin.cron.config import CronConfig, ScheduleEntry
from hivemoot_agent.plugins_builtin.cron.expression import parse_expression
from hivemoot_agent.plugins_builtin.cron.schedule import Schedule


def _entry_to_schedule(entry: ScheduleEntry) -> Schedule:
    """Convert a Pydantic ScheduleEntry to the runtime Schedule dataclass.

    Re-parses the expression — Pydantic already validated it during
    config load, so the parse is guaranteed to succeed.  We re-parse
    rather than storing the parsed Expression on ScheduleEntry to
    keep the Pydantic model JSON-serializable for schema export.
    """
    return Schedule(
        name=entry.name,
        expression=parse_expression(entry.schedule),
        prompt=entry.prompt,
        jitter_secs=entry.jitter_secs,
        resume=entry.resume,
    )


def _compute_next_fire(schedule: Schedule, input_time: datetime) -> datetime:
    """Next effective fire time = expression.next_fire(input) + jitter.

    Baking jitter into the stored fire time (rather than sleeping for
    it inside the dispatch path) is load-bearing for two reasons:

      1. The main loop's "wait until earliest" handles the jitter as
         part of its natural sleep, so a jittered schedule never blocks
         a non-jittered one that came due during the delay window.
      2. Advancing from the previous *effective* fire preserves
         ``@every Nh`` elapsed-time semantics — using the planned time
         as the advance anchor would let a jittered fire re-fire less
         than N hours after the actual fire (e.g. planned 13:00, fired
         13:05 after 5-min jitter, next "planned from planned" would
         be 14:00 = only 55 minutes elapsed).  Cron expressions don't
         drift because their ``next_fire`` walk finds the next valid
         slot regardless of where within a slot the input was.
    """
    fire_time = schedule.expression.next_fire(input_time)
    if schedule.jitter_secs > 0:
        fire_time = fire_time + timedelta(
            seconds=random.randint(0, schedule.jitter_secs),
        )
    return fire_time


class CronTrigger:
    name = "cron"

    def __init__(self, plugin: Any) -> None:
        self._plugin = plugin
        self._stop_event = threading.Event()

    def validate(self, config: PluginConfig) -> list[str]:
        # Pydantic (CronConfig) validates grammar + reachability at
        # load time; nothing to add here.
        return []

    def start(self, config: PluginConfig, dispatcher: JobDispatcher) -> None:
        cfg: CronConfig = config.typed
        if not isinstance(cfg, CronConfig):
            print(
                "[cron] invalid runtime config; trigger disabled",
                file=sys.stderr, flush=True,
            )
            return

        schedules = [_entry_to_schedule(e) for e in cfg.schedules]

        if not schedules:
            print(
                "[cron] no schedules configured; trigger idle",
                file=sys.stderr, flush=True,
            )
            # Still block in stop_event.wait() so the engine's shutdown
            # path doesn't see a degenerate trigger that returns instantly.
            self._stop_event.wait()
            return

        self._stop_event.clear()
        self._log_startup(schedules)

        # All schedules share one `seed_now` read so schedules with
        # identical expressions can't land on opposite sides of their
        # fire boundary and diverge — previously a pair of "0 9 * * *"
        # schedules seeded 1ms apart at 08:59:59.999 vs 09:00:00.001
        # would land on today-9am vs tomorrow-9am respectively.
        seed_now = _expression_mod.now_utc()
        # ``next_fires[name]`` stores the EFFECTIVE fire time (planned
        # + this-fire's random jitter).  Advancing from the effective
        # time preserves:
        #   * @every Nh semantics — "no earlier than N hours after last
        #     actual fire" (fixes a bug where advancing from planned
        #     let a jittered fire re-fire <N hours later).
        #   * cron anchor semantics — ``next_fire`` for a cron
        #     expression finds the next valid slot regardless of
        #     where within a slot the input was, so the anchor holds.
        next_fires: dict[str, datetime] = {
            s.name: _compute_next_fire(s, seed_now) for s in schedules
        }

        while not self._stop_event.is_set():
            now = _expression_mod.now_utc()
            # Find the earliest scheduled fire.  If multiple schedules
            # share the same fire time, they all fire in this loop
            # iteration (sorted by name for deterministic order).
            earliest = min(next_fires.values())
            delay = max(0.0, (earliest - now).total_seconds())

            if delay > 0:
                print(
                    f"[cron] next fire in {int(delay)}s "
                    f"({earliest.isoformat()})",
                    file=sys.stderr, flush=True,
                )
                if self._stop_event.wait(delay):
                    return

            now = _expression_mod.now_utc()
            due = sorted(
                (s for s in schedules if next_fires[s.name] <= now),
                key=lambda s: s.name,
            )
            for schedule in due:
                if self._stop_event.is_set():
                    return
                self._fire_one(schedule, dispatcher)
                # Advance from the effective fire time (see seed
                # comment above).  If the previous run overran its
                # cadence, the newly computed cursor can still be in
                # the past — skip any additional missed ticks in one
                # hop instead of replaying them as a backlog storm.
                # Matches the legacy controller's on_duplicate_agent
                # semantics (one run queued, duplicates dropped while
                # busy).
                last_fired = next_fires[schedule.name]
                next_effective = _compute_next_fire(schedule, last_fired)
                now_after = _expression_mod.now_utc()
                skipped = 0
                while next_effective <= now_after:
                    next_effective = _compute_next_fire(
                        schedule, next_effective,
                    )
                    skipped += 1
                if skipped:
                    print(
                        f"[cron] {schedule.name}: coalesced {skipped} "
                        f"missed tick(s) (previous run overran cadence); "
                        f"next fire at {next_effective.isoformat()}",
                        file=sys.stderr, flush=True,
                    )
                next_fires[schedule.name] = next_effective

    def _fire_one(
        self, schedule: Schedule, dispatcher: JobDispatcher,
    ) -> None:
        # Jitter is baked into ``next_fires`` at compute time, so the
        # main loop's natural wait absorbs it.  Sleeping here would
        # block *other* schedules that became due during the wait —
        # e.g., a 09:00 schedule with 300s jitter would delay a 09:01
        # schedule by up to 5 minutes even though the agent was idle.
        print(
            f"[cron] firing {schedule.name}",
            file=sys.stderr, flush=True,
        )
        job = Job(
            session_key=schedule.session_key,
            prompt=schedule.prompt,
            metadata={
                "cron": {
                    "schedule_name": schedule.name,
                    "resume": schedule.resume,
                },
            },
        )
        ok = dispatcher.dispatch(job)
        if not ok:
            print(
                f"[cron] {schedule.name}: dispatch returned False",
                file=sys.stderr, flush=True,
            )

    def _log_startup(self, schedules: list[Schedule]) -> None:
        print(
            f"[cron] started with {len(schedules)} schedule(s):",
            file=sys.stderr, flush=True,
        )
        for s in schedules:
            expr_repr = getattr(s.expression, "raw", None) or repr(s.expression)
            resume_tag = " resume" if s.resume else ""
            jitter_tag = f" ±{s.jitter_secs}s" if s.jitter_secs else ""
            print(
                f"  - {s.name}: {expr_repr}{jitter_tag}{resume_tag}",
                file=sys.stderr, flush=True,
            )

    def stop(self) -> None:
        self._stop_event.set()
