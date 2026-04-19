"""No-op compatibility alias for the retired hivemoot-identity plugin.

The plugin-as-identity model was retired in #581; identity content is
now supplied by the deployer via ``AGENT_IDENTITY_FILE``, and security
guardrails live in the runtime's always-applied root system prompt at
``cli/hivemoot_agent/root_system_prompt.md``.

This module remains as a **no-op alias** for one release so stale
``AGENT_PLUGINS=hivemoot-identity,...`` configs don't turn into a
FATAL ``requested plugin 'hivemoot-identity' not found`` on startup.
The shim contributes nothing to the system prompt (root + identity
file already cover what it used to carry) and emits a one-time
deprecation warning at setup time.

Remove this directory when the next release cycle begins and all
deployers have dropped the name from their plugin lists.
"""

from __future__ import annotations

import sys

from hivemoot_agent.plugins.interfaces import (
    AgentResult,
    Job,
    Plugin,
    PluginConfig,
    Trigger,
)


class HivemootIdentityPlugin:
    name = "hivemoot-identity"
    version = "0.3.0-noop"
    description = (
        "DEPRECATED no-op alias; identity moved to AGENT_IDENTITY_FILE"
    )

    def __init__(self) -> None:
        self._warned = False

    def validate(self, config: PluginConfig) -> list[str]:
        return []

    def setup(self, config: PluginConfig) -> None:
        if not self._warned:
            print(
                "[hivemoot-identity] DEPRECATED no-op alias.  Security "
                "rules now live in the engine's always-applied root "
                "system prompt; voice / mission / conventions should "
                "be supplied via AGENT_IDENTITY_FILE.  Drop "
                "'hivemoot-identity' from AGENT_PLUGINS at your "
                "convenience — this alias will be removed in the "
                "next release.",
                file=sys.stderr, flush=True,
            )
            self._warned = True

    def triggers(self) -> list[Trigger]:
        return []

    def system_prompt(self, config: PluginConfig) -> str:
        # Nothing to contribute.  The runtime's <root> layer carries
        # the security guardrails; the deployer's <identity> layer
        # carries voice / mission.  Emitting anything here would
        # duplicate content that's already present.
        return ""

    def on_job_started(self, job: Job, config: PluginConfig) -> None:
        pass

    def on_job_finished(
        self, job: Job, result: AgentResult, config: PluginConfig
    ) -> None:
        pass


def create_plugin() -> Plugin:
    return HivemootIdentityPlugin()  # type: ignore[return-value]
