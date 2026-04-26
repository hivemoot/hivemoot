"""Pydantic config schema for the consolidated ``hivemoot`` plugin.

One plugin, three features (health / tasks / github_workflows), each
toggled independently.  The shared inputs (bearer token, base URL)
live at the top level so operators don't repeat them under every
feature block.

YAML shape:

    plugins:
      hivemoot:
        token_file: !secret hivemoot_agent_token
        health:
          enabled: true
          base_url: https://www.hivemoot.dev
          repo: hivemoot/hivemoot
          heartbeat_interval_secs: 120
        tasks:
          enabled: true
          claim_url: https://www.hivemoot.dev/api/tasks/claim
          execute_base_url: https://www.hivemoot.dev/api/tasks
        github_workflows:
          enabled: true
          role_name: builder
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field

from hivemoot_agent.config import StrictPluginConfig


class HivemootHealthConfig(StrictPluginConfig):
    """Agent-health reporter — heartbeats + per-run reports.

    Contract: ``web/AGENT_HEALTH_CONTRACT.md`` (hivemoot web app).
    The dashboard's Agent Health tab is fed by the data posted here.
    """

    enabled: bool = Field(
        default=False,
        description=(
            "Enable the health reporter.  Off by default so the new "
            "plugin ships idempotently; fleet YAML must opt in."
        ),
    )
    base_url: str = Field(
        default="https://www.hivemoot.dev",
        description=(
            "Base URL for the health API.  Posts go to "
            "``{base_url}/api/agent-health``.  Override for staging "
            "environments."
        ),
    )
    repo: str = Field(
        default="",
        description=(
            "Repo label (``owner/name``) reported with every heartbeat "
            "and run report.  Empty = derive from the github plugin's "
            "``repos[0]`` at validate() time; still empty after that "
            "is a validation error.  Task-dispatch agents that service "
            "many repos should set a synthetic label (e.g. "
            "``hivemoot/attendant``)."
        ),
    )
    heartbeat_interval_secs: int = Field(
        default=120,
        ge=1,
        description=(
            "Seconds between heartbeat posts.  The backend rate-limits "
            "at one per agent+repo per 60s; keep this >= 60 to avoid "
            "wasted 429s."
        ),
    )
    post_run_reports: bool = Field(
        default=True,
        description=(
            "Post a run report from on_job_finished for every job the "
            "plugin observes.  Disable only for fleets that never want "
            "per-run visibility on the dashboard."
        ),
    )


class HivemootTasksConfig(StrictPluginConfig):
    """Hivemoot delegated-task workflow — claim, run, report.

    Inputs:
      * Backend wiring (claim URL, execute base) — required when enabled.
      * Bearer token — resolved from the plugin's shared ``token_file``
        (fall back to ``HIVEMOOT_AGENT_TOKEN_FILE`` / ``HIVEMOOT_AGENT_TOKEN``).
      * Heartbeat / poll cadence.
      * Workspace path — used to stage codex sidecar output.
    """

    enabled: bool = Field(
        default=False,
        description=(
            "Enable the task-claim trigger + per-job progress reporter."
        ),
    )
    claim_url: str = Field(
        default="",
        description=(
            "Backend URL the trigger polls to claim work, typically "
            "``https://www.hivemoot.dev/api/tasks/claim``.  Required "
            "when ``enabled`` is true."
        ),
    )
    execute_base_url: str = Field(
        default="",
        description=(
            "Backend base URL for posting per-task progress / "
            "heartbeat / outcome (complete | fail | timeout).  "
            "Required when ``enabled`` is true."
        ),
    )
    poll_interval_secs: int = Field(
        default=10,
        ge=1,
        description=(
            "Seconds between claim polls when no task is available.  "
            "Floored at 1 to prevent tight-looping."
        ),
    )
    heartbeat_interval_secs: int = Field(
        default=45,
        ge=0,
        description=(
            "Seconds between per-task heartbeat posts.  0 disables the "
            "heartbeat thread; the dashboard then sees no liveness "
            "signal until on_job_finished."
        ),
    )
    workspace: Path = Field(
        default=Path("/workspace"),
        description=(
            "Workspace root for transient per-task artifacts (codex "
            "sidecar output, etc.).  Must be writable by the agent user."
        ),
    )


class HivemootGithubWorkflowsConfig(StrictPluginConfig):
    """Hivemoot-specific GitHub contribution workflow.

    Autonomous contribution operating mode + buzz role loading +
    skill bundle.  Co-loads with the ``github`` plugin — reads its
    typed config (``repos[0]``, ``workspace``) for the active repo.
    """

    enabled: bool = Field(
        default=False,
        description=(
            "Enable the GitHub workflow system prompt + skills.  "
            "Requires the ``github`` plugin to be activated BEFORE "
            "``hivemoot`` in the YAML so repos are cloned by the "
            "time this plugin's setup runs."
        ),
    )
    role_name: str = Field(
        default="",
        description=(
            "Override for the buzz role used to load per-role "
            "governance instructions.  Empty = derive from ``AGENT_ID`` "
            "env var (matches the historical HIVEMOOT_BUZZ_ROLE "
            "behaviour)."
        ),
    )
    clone_depth: int = Field(
        default=50,
        ge=0,
        description=(
            "Surface clone depth in the system prompt so agents know "
            "when to ``git fetch --unshallow``.  Informational only; "
            "the github plugin owns the actual clone."
        ),
    )
    workspace: Path = Field(
        default=Path("/workspace"),
        description=(
            "Workspace root where the github plugin clones repos.  "
            "Must match ``plugins.github.workspace``; the plugin "
            "checks the resulting repo path exists at setup time."
        ),
    )


class HivemootApiaristConfig(StrictPluginConfig):
    """GitHub installation-token brokering via the apiarist daemon.

    Disabled by default. When enabled, the hivemoot plugin registers a
    :class:`HivemootGithubAuthSubscriber` on the engine's container
    lifecycle (apiarist DESIGN.md §12.3): every IDLE→ACTIVE transition
    mints a fresh ``ghs_*`` token via the apiarist UDS daemon and
    populates ``GH_TOKEN`` + ``GITHUB_TOKEN``; every ACTIVE→IDLE
    transition clears them.

    The github plugin must be configured with
    ``token_source: subscriber`` so its own setup skips reading a
    static token file. Subscriber registration order matters — list
    the hivemoot plugin BEFORE the github plugin in
    ``plugins:`` so the env is populated when the github plugin's
    own clone subscriber fires.
    """

    enabled: bool = Field(
        default=False,
        description=(
            "Enable apiarist token brokering.  Off by default so the "
            "feature ships idempotently; fleet YAML opts in per "
            "container."
        ),
    )
    socket_path: Path = Field(
        default=Path("/run/apiarist.sock"),
        description=(
            "Path to the apiarist Unix-domain socket.  Default matches "
            "the systemd unit's bind path; override when running "
            "apiarist out of a non-standard location (dev / staging)."
        ),
    )
    service: str = Field(
        default="",
        description=(
            "Caller identifier reported to apiarist for audit logging "
            "(typically the systemd service / container name like "
            "``drone-zai``).  Empty = derive from ``AGENT_ID`` env."
        ),
    )
    repo: str = Field(
        default="",
        description=(
            "owner/name of the repo this agent works on.  apiarist's "
            "token policy requires it for per-repo scoping.  Empty = "
            "derive from the github plugin's ``repos[0]``; still empty "
            "after that is a validation error."
        ),
    )
    timeout_seconds: float = Field(
        default=10.0,
        gt=0,
        description=(
            "Per-call timeout for apiarist UDS round trips.  10s "
            "covers the long-tail backend roundtrip; tighten for hot "
            "paths."
        ),
    )


class HivemootConfig(StrictPluginConfig):
    """Top-level typed config for the consolidated hivemoot plugin."""

    token_file: Path | None = Field(
        default=None,
        description=(
            "Shared bearer token file used by the health and tasks "
            "features.  Falls back to ``HIVEMOOT_AGENT_TOKEN_FILE`` "
            "env then ``HIVEMOOT_AGENT_TOKEN`` env raw when unset.  "
            "Typically set to ``!secret hivemoot_agent_token`` in "
            "fleet YAML."
        ),
    )
    health: HivemootHealthConfig = Field(
        default_factory=HivemootHealthConfig,
        description="Agent-health heartbeats + run reports.",
    )
    tasks: HivemootTasksConfig = Field(
        default_factory=HivemootTasksConfig,
        description="Hivemoot delegated-task workflow.",
    )
    github_workflows: HivemootGithubWorkflowsConfig = Field(
        default_factory=HivemootGithubWorkflowsConfig,
        description="Hivemoot-specific GitHub contribution workflow.",
    )
    apiarist: HivemootApiaristConfig = Field(
        default_factory=HivemootApiaristConfig,
        description="GitHub installation-token brokering via apiarist.",
    )
