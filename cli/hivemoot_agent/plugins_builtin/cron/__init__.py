"""Cron plugin — schedule arbitrary agent tasks by cron expression.

Each entry in ``CRON_SCHEDULES_JSON`` is a self-contained task:

    [
      {
        "name": "autonomous-contribute",
        "schedule": "@every 1h",
        "jitter_secs": 300,
        "prompt": "Make meaningful contributions to the repository."
      },
      {
        "name": "weekly-security-sweep",
        "schedule": "0 10 * * 1",
        "prompt": "Audit new dependencies added in the past week."
      }
    ]

The plugin replaces the retired host-side ``controller/triggers/periodic.sh``
and the short-lived ``periodic`` plugin that tried to do the same job
with less expressive config.  A fleet that only wants hourly
autonomous contributions still needs a single-entry schedule list —
explicit config is the feature, not a burden.

Enable via ``AGENT_PLUGINS=...,cron``.  The plugin is idle (but
cooperatively blocked) if ``CRON_SCHEDULES_JSON`` is unset or empty,
so listing the plugin without configuring it is a no-op rather than
an error — makes it safer to enable by default in fleet templates.
"""

from __future__ import annotations

from typing import Any

from hivemoot_agent.plugins.interfaces import (
    AgentResult,
    Job,
    Plugin,
    PluginConfig,
    Trigger,
)
from hivemoot_agent.plugins_builtin.cron.schedule import (
    ScheduleConfigError,
    parse_schedules,
)
from hivemoot_agent.plugins_builtin.cron.trigger import CronTrigger


class CronPlugin:
    name = "cron"
    version = "0.1.0"
    description = "Cron-expression-based task scheduling"

    def validate(self, config: PluginConfig) -> list[str]:
        # Fail-closed at startup on malformed config: an operator who
        # typo'd a cron expression should see the error immediately,
        # not hours later when the schedule silently fails to fire.
        raw = config.get("CRON_SCHEDULES_JSON", "") or ""
        try:
            parse_schedules(raw)
        except ScheduleConfigError as exc:
            return [str(exc)]
        return []

    def setup(self, config: PluginConfig) -> None:
        pass

    def triggers(self) -> list[Trigger]:
        return [CronTrigger(self)]

    def system_prompt(self, config: PluginConfig) -> str:
        return ""

    def on_job_started(self, job: Job, config: PluginConfig) -> None:
        pass

    def on_job_finished(
        self, job: Job, result: AgentResult, config: PluginConfig
    ) -> None:
        pass


def create_plugin() -> Plugin:
    return CronPlugin()  # type: ignore[return-value]
