"""Pydantic config schema for the github plugin."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field

from hivemoot_agent.config import StrictPluginConfig


class GitHubConfig(StrictPluginConfig):
    """GitHub plugin config."""

    repos: list[str] = Field(
        default_factory=list,
        description=(
            "Repositories to clone / watch, each as ``owner/repo``.  "
            "Empty list = plugin does no repo work (unusual; fleet "
            "usually configures at least one).  When single-target "
            "plugin logic needs to pick one (e.g. the watch trigger "
            "polls a single repo) it uses ``repos[0]`` — the first "
            "entry IS the canonical 'primary'."
        ),
    )
    token_source: Literal["file", "subscriber"] = Field(
        default="file",
        description=(
            "Where the GitHub token comes from at runtime:\n"
            "- ``file`` (default): read once at setup() from "
            "``token_file``.  Existing long-lived-PAT path.\n"
            "- ``subscriber``: read from ``GH_TOKEN`` / ``GITHUB_TOKEN`` "
            "env on every job, populated by another plugin's lifecycle "
            "subscriber (e.g. apiarist via the hivemoot plugin's "
            "auth subscriber).  When set to ``subscriber``, the github "
            "plugin's setup() does NOT run its auth-required steps "
            "(clone, validate access, configure git user) — those move "
            "into a github-owned subscriber that fires on every "
            "IDLE→ACTIVE boundary AFTER the upstream subscriber has "
            "populated env (registration order is load-bearing; list "
            "the upstream plugin BEFORE github in plugins:)."
        ),
    )
    token_file: Path | None = Field(
        default=None,
        description=(
            "Path to file containing the GitHub token.  Deployer writes "
            "`!secret github_token` in hivemoot.yaml.  Required when "
            "``token_source`` is ``file`` (default); ignored when "
            "``token_source`` is ``subscriber``."
        ),
    )
    workspace: Path = Field(
        default=Path("/workspace"),
        description="Root directory for repo checkouts inside the container.",
    )
    clone_depth: int = Field(
        default=50,
        ge=0,
        description="git clone --depth (0 = full history).",
    )
    git_name: str = Field(
        default="",
        description="git user.name for commits (empty = don't configure).",
    )
    git_email: str = Field(
        default="",
        description="git user.email for commits.",
    )
    watch_mentions: bool = Field(
        default=False,
        description="Enable @-mention polling trigger.",
    )
    watch_review_requests: bool = Field(
        default=False,
        description="Enable review-request polling trigger.",
    )
    watch_new_prs: bool = Field(
        default=False,
        description=(
            "Enable new-PR polling trigger.  Unlike the notification-backed "
            "mention/review watches, this trigger polls the REST `/pulls` "
            "endpoint and keeps local state so a fresh deployment does not "
            "replay the existing open-PR backlog."
        ),
    )
    watch_new_prs_authors: list[str] = Field(
        default_factory=list,
        description=(
            "Allowlist of GitHub login logins for ``watch_new_prs``.  "
            "Empty means 'any author'.  Matched case-insensitively."
        ),
    )
    watch_poll_interval_secs: int = Field(
        default=300,
        ge=30,
        description="Seconds between watch polls.",
    )
    watch_state_dir: Path | None = Field(
        default=None,
        description=(
            "Where the watcher persists state across restarts.  "
            "Defaults to ${agent_memory_dir}/.github-watch when unset."
        ),
    )
    agent_memory_dir: Path | None = Field(
        default=None,
        description=(
            "Memory dir — referenced by the watcher for state_dir "
            "fallback.  Usually shared across plugins; the engine "
            "sets this cross-plugin in a later phase."
        ),
    )

