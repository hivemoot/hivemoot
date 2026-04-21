"""Pydantic config schema for the hivemoot-task plugin.

Migrated from the env-driven (alias-shim) contract.  The plugin's
inputs split into:

  * Backend wiring (claim URL, execute base, bearer token file) —
    typed here.  Empty claim_url disables the polling trigger
    (legitimate for one-shot mode where the engine receives a job
    via another mechanism).
  * Heartbeat cadence — typed here, default 45s.
  * Workspace path — typed here, used to stage codex sidecar output.
  * AGENT_PROVIDER / AGENT_LAST_RUN_LOG — engine-level cross-cutting
    state, NOT plugin config.  Read from settings (env) by the
    plugin without YAML representation.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field

from hivemoot_agent.config import StrictPluginConfig


class HivemootTaskConfig(StrictPluginConfig):
    """Hivemoot-task plugin config — backend wiring + cadence."""

    claim_url: str = Field(
        default="",
        description=(
            "Backend URL the trigger polls to claim work, typically "
            "https://www.hivemoot.dev/api/tasks/claim.  Empty disables "
            "the polling trigger (the plugin still ships its system "
            "prompt for one-shot dispatch)."
        ),
    )
    execute_base_url: str = Field(
        default="",
        description=(
            "Backend base URL for posting per-task progress / heartbeat "
            "/ outcome (complete | fail | timeout).  Required when "
            "claim_url is set."
        ),
    )
    token_file: Path | None = Field(
        default=None,
        description=(
            "File containing the executor bearer token used to "
            "authenticate progress / outcome posts.  Required when "
            "execute_base_url is set."
        ),
    )
    heartbeat_interval_secs: int = Field(
        default=45,
        ge=0,
        description=(
            "Seconds between heartbeat posts during long-running "
            "tasks.  0 disables the heartbeat thread; the dashboard "
            "then sees no liveness signal until on_job_finished."
        ),
    )
    poll_interval_secs: int = Field(
        default=10,
        ge=1,
        description=(
            "Seconds between claim polls when no task is available.  "
            "Floored at 1 to prevent tight-looping; default 10s "
            "matches the shell controller's TASK_POLL_INTERVAL_SECS."
        ),
    )
    workspace: Path = Field(
        default=Path("/workspace"),
        description=(
            "Workspace root for transient per-task artifacts (codex "
            "sidecar output, etc.).  Must be writable by the agent "
            "user."
        ),
    )
