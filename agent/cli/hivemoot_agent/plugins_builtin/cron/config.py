"""Pydantic config schema for the cron plugin.

The big win of the ADR-003 migration: we kill ``CRON_SCHEDULES_JSON``
— a JSON string inside an env var — in favor of a native YAML list
under ``plugins.cron.schedules`` in hivemoot.yaml.

Cron expression validation happens in a Pydantic field validator so
the operator sees grammar errors + semantic-impossibility errors
(e.g. "Feb 31") at config load time, not hours later when a
schedule silently fails to fire.
"""

from __future__ import annotations

from pydantic import Field, field_validator

from hivemoot_agent.config import StrictPluginConfig


_VALID_NAME_CHARS = set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
)


class ScheduleEntry(StrictPluginConfig):
    """One scheduled task."""

    name: str = Field(description="Unique name (used as session_key suffix).")
    schedule: str = Field(
        description=(
            "Cron expression: 5-field standard cron "
            "(minute hour day-of-month month day-of-week) with "
            "*, ,, -, */N; plus '@every Nh/Nm/Ns/Nd' shorthand.  "
            "All times UTC."
        ),
    )
    prompt: str = Field(description="Prompt sent to the agent when this schedule fires.")
    jitter_secs: int = Field(
        default=0,
        ge=0,
        description="Random 0–N second offset applied per fire (anti-thundering-herd).",
    )
    resume: bool = Field(
        default=False,
        description=(
            "Reuse a stable session key so context carries across fires.  "
            "Useful for weekly / long-interval tasks that want to "
            "remember prior runs."
        ),
    )

    @field_validator("name")
    @classmethod
    def _check_name(cls, v: str) -> str:
        if not v:
            raise ValueError("name must be non-empty")
        if any(c not in _VALID_NAME_CHARS for c in v):
            raise ValueError(
                f"name must match [A-Za-z0-9_-]+: {v!r}"
            )
        return v

    @field_validator("schedule")
    @classmethod
    def _check_expression(cls, v: str) -> str:
        # Parse + probe for reachability at load time — catches
        # "Feb 31" impossible expressions early.  Import locally to
        # keep the schema module light when only introspection is
        # needed (e.g. JSON Schema export).
        from datetime import datetime, timezone

        from hivemoot_agent.plugins_builtin.cron.expression import (
            CronParseError,
            parse_expression,
        )

        try:
            expr = parse_expression(v)
            expr.next_fire(datetime(1970, 1, 1, tzinfo=timezone.utc))
        except CronParseError as exc:
            raise ValueError(f"invalid cron expression {v!r}: {exc}") from exc
        return v


class CronConfig(StrictPluginConfig):
    """Cron plugin config — list of named scheduled tasks."""

    schedules: list[ScheduleEntry] = Field(
        default_factory=list,
        description=(
            "Scheduled tasks.  Empty list = plugin idles (loaded but "
            "does nothing).  Listing the plugin without scheduling "
            "anything is explicitly safe."
        ),
    )

    @field_validator("schedules")
    @classmethod
    def _check_unique_names(cls, v: list[ScheduleEntry]) -> list[ScheduleEntry]:
        names = [s.name for s in v]
        seen: set[str] = set()
        for n in names:
            if n in seen:
                raise ValueError(f"duplicate schedule name: {n!r}")
            seen.add(n)
        return v
