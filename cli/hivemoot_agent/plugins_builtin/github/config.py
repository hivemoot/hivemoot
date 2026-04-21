"""Pydantic config schema for the github plugin."""

from __future__ import annotations

from pathlib import Path

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
    token_file: Path | None = Field(
        default=None,
        description=(
            "Path to file containing the GitHub token.  Deployer writes "
            "`!secret github_token` in hivemoot.yaml."
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

