"""Schedule config — one scheduled task, its prompt, and firing rules.

A plugin's config is a JSON list of ``Schedule`` entries.  Each entry
is a self-contained unit: name + cron expression + prompt body +
optional jitter + optional session-resume flag.  The trigger's loop
fans across all entries, firing each at its own cadence.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from hivemoot_agent.plugins_builtin.cron.expression import (
    CronParseError,
    Expression,
    parse_expression,
)


class ScheduleConfigError(ValueError):
    """Raised when the JSON schedule list is malformed."""


# Probe anchor for reachability checks.  A fixed UTC datetime so
# validation is deterministic and doesn't depend on the wall clock at
# startup.  Chosen pre-epoch-safe and far enough past that any
# schedule's "next fire from here" behaves identically to production.
_PROBE_ANCHOR = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _require_reachable(expression: Expression, name: str) -> None:
    """Validate that ``expression`` produces at least one fire time.

    Grammar-valid expressions can still be semantically impossible
    (``0 0 31 2 *`` = "Feb 31, midnight" — no such date exists).
    Without this check, the impossible expression passes
    ``CronPlugin.validate()`` and only blows up later inside the
    trigger loop when ``next_fire()`` exhausts its bounded search —
    at which point the whole trigger thread dies and the engine sees
    a disabled plugin, not a config error the operator can fix.

    Runs synchronously at config parse time; the ~4-year bounded
    search in ``CronExpression.next_fire`` gives us an upper bound of
    a few seconds on truly impossible expressions.  Normal expressions
    match within milliseconds.
    """
    try:
        expression.next_fire(_PROBE_ANCHOR)
    except CronParseError as exc:
        raise ScheduleConfigError(
            f"schedule[{name!r}].schedule is unreachable: {exc}"
        ) from exc


_VALID_NAME_CHARS = set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
)


def _require_name(raw: Any) -> str:
    """Schedule names are used as session keys — constrain the charset."""
    if not isinstance(raw, str) or not raw:
        raise ScheduleConfigError(
            "schedule.name must be a non-empty string"
        )
    if any(c not in _VALID_NAME_CHARS for c in raw):
        raise ScheduleConfigError(
            f"schedule.name must match [A-Za-z0-9_-]+: {raw!r}"
        )
    return raw


@dataclass(frozen=True)
class Schedule:
    """One scheduled task.

    ``resume``: when True, repeated fires reuse a session keyed by the
    schedule name so the provider can carry context across ticks.
    Default False — most scheduled tasks want a fresh context each
    run (the shell ``periodic`` trigger had this behaviour baked in).

    ``jitter_secs``: additional random 0..jitter delay applied *after*
    the cron expression matches.  Anti-thundering-herd for fleets where
    multiple agents share the same schedule.  Only meaningful for
    standard cron expressions — for ``@every`` you'd typically just
    use a different interval.
    """

    name: str
    expression: Expression
    prompt: str
    jitter_secs: int = 0
    resume: bool = False

    @property
    def session_key(self) -> str:
        """Stable key when resume is enabled; otherwise empty."""
        return f"cron:{self.name}" if self.resume else ""


def parse_schedules(raw: str) -> list[Schedule]:
    """Parse ``CRON_SCHEDULES_JSON`` into validated ``Schedule`` objects.

    Empty / whitespace-only input yields an empty list — a fleet that
    hasn't configured any schedules is valid (the trigger will log and
    idle).  Partial failures raise: if any entry is malformed, we fail
    the whole config so the operator sees the problem at startup
    rather than discovering one missing schedule weeks later.
    """
    raw = (raw or "").strip()
    if not raw:
        return []

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ScheduleConfigError(
            f"CRON_SCHEDULES_JSON is not valid JSON: {exc.msg}"
        ) from exc

    if not isinstance(parsed, list):
        raise ScheduleConfigError(
            "CRON_SCHEDULES_JSON must be a JSON list"
        )

    schedules: list[Schedule] = []
    seen_names: set[str] = set()
    for index, entry in enumerate(parsed):
        if not isinstance(entry, dict):
            raise ScheduleConfigError(
                f"CRON_SCHEDULES_JSON[{index}] must be a JSON object"
            )

        name = _require_name(entry.get("name"))
        if name in seen_names:
            raise ScheduleConfigError(
                f"duplicate schedule name: {name!r}"
            )
        seen_names.add(name)

        expression_raw = entry.get("schedule")
        if not isinstance(expression_raw, str) or not expression_raw.strip():
            raise ScheduleConfigError(
                f"schedule[{name!r}].schedule must be a non-empty string"
            )
        try:
            expression = parse_expression(expression_raw)
        except CronParseError as exc:
            raise ScheduleConfigError(
                f"schedule[{name!r}].schedule: {exc}"
            ) from exc
        _require_reachable(expression, name)

        prompt = entry.get("prompt", "")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ScheduleConfigError(
                f"schedule[{name!r}].prompt must be a non-empty string"
            )

        jitter = entry.get("jitter_secs", 0)
        # bool is a subclass of int in Python, so ``isinstance(True, int)``
        # is True — which would silently accept ``{"jitter_secs": true}``
        # as jitter=1.  Reject explicitly so the config error surfaces
        # at startup instead of quietly mis-scheduling.
        if isinstance(jitter, bool) or not isinstance(jitter, int) or jitter < 0:
            raise ScheduleConfigError(
                f"schedule[{name!r}].jitter_secs must be a non-negative "
                f"integer"
            )

        resume = entry.get("resume", False)
        if not isinstance(resume, bool):
            raise ScheduleConfigError(
                f"schedule[{name!r}].resume must be a boolean"
            )

        schedules.append(Schedule(
            name=name,
            expression=expression,
            prompt=prompt,
            jitter_secs=jitter,
            resume=resume,
        ))

    return schedules
