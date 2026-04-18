"""Deprecated: hivemoot-identity plugin.

Identity is no longer modeled as a plugin.  The runtime now has a
three-layer system prompt:

  * ``<root>`` — universal baseline from ``cli/hivemoot_agent/root_system_prompt.md``
    (security, honesty, reasoning discipline).  Always applied; lives in
    this repo.
  * ``<identity>`` — per-agent content supplied by the deployer at
    container-setup time via ``AGENT_IDENTITY_FILE``.  Role, voice,
    mission, domain conventions.
  * ``<plugin>`` — capability modules.  This is where plugins belong;
    identity is not a capability.

This plugin is a **transitional deprecation shim** that remains in
``AGENT_PLUGINS`` compatibility until deployers migrate to the new
``AGENT_IDENTITY_FILE`` mount.  Its ``system_prompt()`` still returns
the legacy voice/commit content (so an unmigrated apiary fleet doesn't
lose its teammate voice while the rollout is in flight) but the
security guardrails have moved to the root, which is applied
unconditionally by the engine.

Remove this plugin from ``AGENT_PLUGINS`` once your deployer supplies
an ``AGENT_IDENTITY_FILE``; then this directory can be deleted.
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
from hivemoot_agent.plugins_builtin.hivemoot_identity.system_prompt import (
    load_soul_prompt,
)


class HivemootIdentityPlugin:
    name = "hivemoot-identity"
    version = "0.2.0-deprecated"
    description = "DEPRECATED: use AGENT_IDENTITY_FILE (see module docstring)"

    def __init__(self) -> None:
        self._warned = False

    def validate(self, config: PluginConfig) -> list[str]:
        return []

    def setup(self, config: PluginConfig) -> None:
        # One-time deprecation warning per process — noisy enough to
        # catch operator attention, not so noisy that it spams logs.
        if not self._warned:
            print(
                "[hivemoot-identity] DEPRECATED: identity is no longer a "
                "plugin.  Security rules now live in the engine's root "
                "system prompt (always applied); voice / mission / "
                "conventions should be supplied via AGENT_IDENTITY_FILE. "
                "Remove 'hivemoot-identity' from AGENT_PLUGINS once your "
                "deployer has mounted an identity file.",
                file=sys.stderr, flush=True,
            )
            self._warned = True

    def triggers(self) -> list[Trigger]:
        return []

    def system_prompt(self, config: PluginConfig) -> str:
        # Transitional: the shim keeps contributing the legacy voice /
        # commit-convention content so currently-deployed fleets don't
        # regress their teammate voice mid-rollout.  Security rules
        # are intentionally NOT duplicated here — they come from the
        # engine's root layer regardless of whether this plugin is
        # loaded.
        return load_soul_prompt()

    def on_job_started(self, job: Job, config: PluginConfig) -> None:
        pass

    def on_job_finished(
        self, job: Job, result: AgentResult, config: PluginConfig
    ) -> None:
        pass


def create_plugin() -> Plugin:
    return HivemootIdentityPlugin()  # type: ignore[return-value]
