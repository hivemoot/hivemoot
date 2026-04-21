"""Cron plugin — schedule arbitrary agent tasks by cron expression.

Config lives in ``hivemoot.yaml`` under ``plugins.cron.schedules`` as
a native YAML list — each entry is a self-contained task with its
own cron expression and prompt body.  Example::

    plugins:
      cron:
        schedules:
          - name: autonomous
            schedule: "@every 1h"
            jitter_secs: 300
            prompt: "Make meaningful contributions."
          - name: weekly-security
            schedule: "0 10 * * 1"
            prompt: "Audit new dependencies this week."

Schedules fire inside daemon mode (``hivemoot-agent run``), each at
its own cadence.  Grammar errors and impossible expressions (Feb 31
etc.) fail at config load time rather than silently never firing.
"""

from __future__ import annotations

from hivemoot_agent.plugins.interfaces import (
    AgentResult,
    Job,
    Plugin,
    PluginConfig,
    Trigger,
)
from hivemoot_agent.plugins_builtin.cron.config import CronConfig
from hivemoot_agent.plugins_builtin.cron.trigger import CronTrigger


class CronPlugin:
    name = "cron"
    version = "0.2.0"
    description = "Cron-expression-based task scheduling"

    def validate(self, config: PluginConfig) -> list[str]:
        # Pydantic (CronConfig) already validates schedule grammar,
        # reachability, name uniqueness, etc. at config load time —
        # the engine surfaces those errors before we get here.
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
