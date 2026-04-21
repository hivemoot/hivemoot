"""Pydantic config schema for the hivemoot-github plugin.

Migrated from the env-driven (alias-shim) contract.  The plugin's
inputs split cleanly into two buckets:

  * Plugin-specific knobs (clone_depth shown in the system prompt,
    workspace where the github plugin clones) — typed here.
  * The repo to act on — derived at runtime from the github plugin's
    typed config (registry.config_for("github").typed.repos[0]).  No
    schema field for it; that would let the operator configure the
    two plugins inconsistently.

The role name (used to load per-agent governance instructions) falls
back to AGENT_ID env when ``role_name`` is unset, matching how the
shell controller wired HIVEMOOT_BUZZ_ROLE.  Operators can override
in YAML for fleets that want a role distinct from the agent identity.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field

from hivemoot_agent.config import StrictPluginConfig


class HivemootGithubConfig(StrictPluginConfig):
    """Hivemoot-github plugin config."""

    role_name: str = Field(
        default="",
        description=(
            "Override for the buzz role used to load per-role governance "
            "instructions.  Empty = derive from AGENT_ID env var "
            "(matches the historical HIVEMOOT_BUZZ_ROLE behaviour)."
        ),
    )
    clone_depth: int = Field(
        default=50,
        ge=0,
        description=(
            "Surface clone depth in the system prompt so agents know "
            "when to ``git fetch --unshallow``.  This is informational "
            "only; the github plugin owns the actual clone."
        ),
    )
    workspace: Path = Field(
        default=Path("/workspace"),
        description=(
            "Workspace root where the github plugin clones repos.  "
            "Must match plugins.github.workspace; the plugin checks "
            "the resulting repo path exists at setup time."
        ),
    )
