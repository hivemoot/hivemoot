"""Pydantic config schema for the consolidated ``hivemoot`` plugin.

One plugin, six features (health / tasks / github_workflows /
apiarist / war_rooms / queen), each toggled independently.  The
shared inputs (bearer token, base URL)
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
        queen:
          enabled: false
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

    Disabled by default. When enabled, the hivemoot plugin builds a
    :class:`HivemootGithubAuthSubscriber`, calls its ``start()`` (which
    does an initial synchronous mint AND launches a background
    refresh thread), and registers it with the engine's container
    lifecycle (apiarist DESIGN.md §12.3, Phase L'):

    - **At setup**: initial mint populates ``GH_TOKEN`` +
      ``GITHUB_TOKEN`` env so trigger threads (which spin up next)
      see a valid token on their first poll.
    - **Background refresh thread**: re-mints when within the
      configured lead-time window of expiry (default 5 min), keeping
      env populated for the container lifetime.
    - **on_active** (IDLE→ACTIVE): proactively refreshes if expiring
      soon; otherwise no-op (refresh thread handles it).
    - **on_idle** (ACTIVE→IDLE): NO-OP. Env stays populated between
      jobs because watch-driven services (drone with watch_mentions
      etc.) need a valid token to poll between jobs — clearing on
      idle would deadlock those services (no events → no jobs → no
      on_active to repopulate).

    The "always-on env" model trades one defense-in-depth layer
    (env-clear-on-idle) for trigger viability between jobs. The
    short-TTL guarantee (apiarist policy + GitHub App 1h cap) is
    preserved by the refresh thread.

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
            "after that is a validation error.\n\n"
            "**Multi-repo caveat**: this field scopes the minted token "
            "to a SINGLE repo. ``plugins.github.repos`` accepts a list, "
            "but the github plugin's auth subscriber will run "
            "``_validate_repo_access`` and ``clone_or_sync`` for EVERY "
            "entry against the token scoped here — non-matching repos "
            "will fail at first IDLE→ACTIVE with a confusing 403/404. "
            "V1 deploys (drone) are single-repo; multi-repo subscriber-"
            "mode services need either an apiarist policy that grants "
            "access to all configured github.repos, or a follow-up "
            "design that mints per-repo on demand."
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


class HivemootWarRoomsConfig(StrictPluginConfig):
    """War-room watcher — polls /api/rooms/watching and dispatches
    one Job per visible room (F.2 trigger). Job handler (F.3) parses
    the agent's structured response and calls /present + /contribute
    or /present + /withdraw against the war-room API.

    Off by default so the plugin ships idempotently; fleet YAML
    must opt in. End-to-end PR review flow (queen ↔ workers)
    requires this enabled on every reviewer agent.
    """

    enabled: bool = Field(
        default=False,
        description=(
            "Enable the war-room watcher trigger + on_job_finished "
            "handler. Off by default; fleet YAML opts each reviewer "
            "role in."
        ),
    )
    base_url: str = Field(
        default="https://www.hivemoot.dev",
        description=(
            "Base URL for the war-room API. Polls go to "
            "``{base_url}/api/rooms/watching``; lifecycle posts to "
            "``{base_url}/api/rooms/{id}/{present,contributions,withdraw}``. "
            "Override for staging environments."
        ),
    )
    poll_interval_secs: int = Field(
        default=60,
        ge=5,
        description=(
            "Seconds between /watching polls. Default 60s matches the "
            "watchdog's tick cadence — rooms surfaced this poll get "
            "dispatched within one queen-tick window. Floor of 5s "
            "prevents tight-looping; raise to 120-300s on high-room-"
            "count fleets to reduce backend load."
        ),
    )
    seen_cache_max: int = Field(
        default=1000,
        ge=10,
        description=(
            "Max (roomId, sequence) entries the trigger remembers to "
            "deduplicate within a session. LRU-evicted past this cap. "
            "1000 covers ~weeks of room activity at typical Hive scale."
        ),
    )
    heartbeat_interval_secs: int = Field(
        default=45,
        ge=0,
        description=(
            "Seconds between per-room heartbeat posts (PR A endpoint). "
            "Pure liveness — no payload. 0 disables the heartbeat "
            "thread (rooms then auto-close on max-age once review "
            "exceeds the watchdog window). 45s matches the tasks "
            "default and the queen-tick cadence."
        ),
    )


class HivemootQueenConfig(StrictPluginConfig):
    """Local queen runner — owns PR review-room lifecycle in local mode.

    Disabled by default. When an installation's ``queen_mode`` is set
    to ``local``, one hive runner should enable this block with
    ``watched_repos`` so it creates PR review rooms, watches those
    rooms, and posts/seals decisions without the cloud bot owning the
    PR war-room path.
    """

    enabled: bool = Field(
        default=False,
        description=(
            "Enable the local queen synthesis trigger + on_job_finished "
            "handler. Off by default; fleet YAML opts one runner in."
        ),
    )
    base_url: str = Field(
        default="https://www.hivemoot.dev",
        description=(
            "Base URL for the local-queen API endpoints. The runner "
            "polls /api/rooms/synthesis-ready and posts resolve/seal "
            "requests under this base."
        ),
    )
    poll_interval_secs: int = Field(
        default=60,
        ge=5,
        description=(
            "Seconds between local queen synthesis polls. Default 60s "
            "matches the cloud queen tick cadence; floor prevents "
            "tight-looping during backend failures."
        ),
    )
    synthesis_ready_limit: int = Field(
        default=10,
        ge=1,
        le=50,
        description=(
            "Max rooms fetched from /synthesis-ready per poll. The "
            "trigger claims at most one room per tick/run."
        ),
    )
    claim_ttl_secs: int = Field(
        default=900,
        ge=60,
        le=900,
        description=(
            "TTL requested for /claim-synthesis. Must stay within the "
            "server's 15 minute seal-decision audit window."
        ),
    )
    fallback_quiet_period_secs: int = Field(
        default=60,
        ge=0,
        description=(
            "Quiet period used when a room core lacks timing_config."
        ),
    )
    gh_timeout_secs: int = Field(
        default=30,
        ge=1,
        description="Timeout for individual gh CLI calls.",
    )
    enable_squash_merge: bool = Field(
        default=False,
        description=(
            "When true, the local queen may seal squash-merge intents, "
            "poll decided-pending rooms, call confirm-merge, run "
            "``gh pr merge --squash``, and report the GitHub outcome. "
            "Keep false until the web confirm/report endpoints are deployed."
        ),
    )
    watched_repos: list[str] = Field(
        default_factory=list,
        description=(
            "owner/name repositories whose open PRs the local queen "
            "periodically discovers. Required for queen_mode=local to "
            "create PR review rooms without cloud webhook ownership."
        ),
    )
    pr_discovery_enabled: bool = Field(
        default=True,
        description=(
            "Enable periodic PR discovery for watched_repos. Leave true "
            "in local queen mode; set false only for synthesis-only tests."
        ),
    )
    pr_discovery_interval_secs: int = Field(
        default=900,
        ge=60,
        description=(
            "Seconds between local queen PR sweeps. The sweep is a "
            "polling backstop for webhook/listener gaps and creates "
            "missing PR review rooms idempotently."
        ),
    )
    pr_discovery_room_limit: int = Field(
        default=200,
        ge=1,
        le=1000,
        description="Max rooms fetched from /api/rooms during each PR sweep.",
    )
    pr_discovery_create_limit: int = Field(
        default=20,
        ge=0,
        le=100,
        description="Max missing PR review rooms created in one sweep.",
    )
    pr_room_recent_closed_secs: int = Field(
        default=21600,
        ge=0,
        description=(
            "Cooldown after a closed room before the PR sweep may open "
            "another room for the same PR. 0 disables the cooldown."
        ),
    )
    pr_room_quiet_period_secs: int = Field(
        default=180,
        ge=0,
        description="quiet_period_secs for PR review rooms created locally.",
    )
    pr_room_max_age_secs: int = Field(
        default=3600,
        ge=60,
        description="max_age_secs for PR review rooms created locally.",
    )
    pr_room_drop_threshold_secs: int = Field(
        default=1200,
        ge=0,
        description="drop_threshold_secs for PR review rooms created locally.",
    )
    merge_report_queue_file: Path = Field(
        default=Path("/tmp/hivemoot-queen-merge-reports.json"),
        description=(
            "Local retry queue for successful GitHub merges whose "
            "report-merge-result call failed. Keep this on writable "
            "persistent storage when enable_squash_merge is true."
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
    war_rooms: HivemootWarRoomsConfig = Field(
        default_factory=HivemootWarRoomsConfig,
        description="War-room watcher + per-room triage/contribution handler.",
    )
    queen: HivemootQueenConfig = Field(
        default_factory=HivemootQueenConfig,
        description="Local queen synthesis runner.",
    )
