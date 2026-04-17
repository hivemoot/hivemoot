"""Hivemoot identity plugin.

Contributes the Hivemoot security guardrails and communication-style
block (soul.md) to the merged system prompt. Stack this plugin ahead
of any Hivemoot workflow plugin (hivemoot-github, hivemoot-task, …)
so the guardrails frame everything else the agent reads.

The file is a pure prompt contributor — no triggers, no setup side
effects. Putting it in the plugin tree lets the engine's
`<plugin name="hivemoot-identity">` wrapper attribute the guardrails
to a distinct, visible source rather than invisibly embedding them
inside every other plugin's prompt.
"""

from __future__ import annotations

from hivemoot_agent.plugins.interfaces import (
    AgentResult,
    Job,
    Plugin,
    PluginConfig,
    Trigger,
)
from hivemoot_agent.plugins_builtin.hivemoot_identity.system_prompt import (
    load_soul_prompt,
)


class HivemootIdentityPlugin:
    name = "hivemoot-identity"
    version = "0.1.0"
    description = "Hivemoot identity: security guardrails and communication style"

    def validate(self, config: PluginConfig) -> list[str]:
        return []

    def setup(self, config: PluginConfig) -> None:
        pass

    def triggers(self) -> list[Trigger]:
        return []

    def system_prompt(self, config: PluginConfig) -> str:
        return load_soul_prompt()

    def on_job_started(self, job: Job, config: PluginConfig) -> None:
        pass

    def on_job_finished(
        self, job: Job, result: AgentResult, config: PluginConfig
    ) -> None:
        pass


def create_plugin() -> Plugin:
    return HivemootIdentityPlugin()  # type: ignore[return-value]
