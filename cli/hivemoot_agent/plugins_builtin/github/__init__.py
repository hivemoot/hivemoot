"""GitHub plugin — clone repos, inject context, develop on GitHub."""

from __future__ import annotations

import os
import sys
from typing import Any

from hivemoot_agent.plugins.interfaces import (
    AgentResult,
    Job,
    Plugin,
    PluginConfig,
    Trigger,
)
from hivemoot_agent.plugins_builtin.github.repo_manager import (
    RepoInfo,
    clone_or_sync,
    configure_git_user,
    parse_repos,
    repo_checkout_path,
    resolve_github_user,
)
from hivemoot_agent.plugins_builtin.github.system_prompt import build_system_prompt


class GitHubPlugin:
    name = "github"
    version = "0.1.0"
    description = "GitHub repository management and development"

    def __init__(self) -> None:
        self._repos: list[RepoInfo] = []
        self._git_name: str = ""
        self._git_email: str = ""
        self._setup_attempted = False

    def validate(self, config: PluginConfig) -> list[str]:
        errors: list[str] = []

        # Token — either inline or via file.
        token = config.get("GITHUB_TOKEN", "")
        if not token:
            errors.append(
                "GITHUB_TOKEN is required "
                "(or GITHUB_TOKEN_FILE for file-based secrets)"
            )

        # Repos list.
        repos_raw = config.get("GITHUB_REPOS", "")
        if not repos_raw:
            errors.append(
                "GITHUB_REPOS is required "
                "(comma-separated owner/repo list)"
            )
        else:
            try:
                repos = parse_repos(repos_raw)
                if not repos:
                    errors.append("GITHUB_REPOS is empty")
            except ValueError as exc:
                errors.append(str(exc))

        return errors

    def triggers(self) -> list[Trigger]:
        # No triggers — GitHub plugin runs via oneshot mode.
        return []

    def setup(self, config: PluginConfig) -> None:
        """Clone all configured repos and authenticate gh CLI."""
        self._setup_attempted = True
        token = config.get("GITHUB_TOKEN", "")
        repos_raw = config.get("GITHUB_REPOS", "")
        workspace = config.get(
            "GITHUB_WORKSPACE",
            config.get("WORKSPACE_ROOT", "/workspace"),
        )
        clone_depth = int(config.get("GITHUB_CLONE_DEPTH", "50"))

        try:
            repo_names = parse_repos(repos_raw)
        except ValueError as exc:
            print(f"[github] invalid repos config: {exc}", file=sys.stderr)
            return

        # Resolve git user from token for commit authorship.
        git_name = config.get("GITHUB_GIT_NAME", "")
        git_email = config.get("GITHUB_GIT_EMAIL", "")
        if not git_name:
            login, email = resolve_github_user(token)
            if login:
                git_name = login
                git_email = email
        if not git_name:
            git_name = "hivemoot-agent"
            git_email = "hivemoot-agent@users.noreply.github.com"

        # Set GH_TOKEN so the agent's gh CLI calls are authenticated.
        os.environ["GH_TOKEN"] = token
        os.environ["GITHUB_TOKEN"] = token

        # Clone/sync each repo.
        cloned: list[RepoInfo] = []
        failures: list[str] = []
        for repo in repo_names:
            try:
                info = clone_or_sync(repo, workspace, token, clone_depth)
                configure_git_user(info.path, git_name, git_email)
                cloned.append(info)
                print(
                    f"[github] ready: {info.repo} → {info.path} "
                    f"(branch={info.default_branch})",
                    file=sys.stderr, flush=True,
                )
            except RuntimeError as exc:
                failures.append(f"{repo}: {exc}")
                print(
                    f"[github] clone failed: {repo}: {exc}",
                    file=sys.stderr, flush=True,
                )

        self._repos = cloned
        self._git_name = git_name
        self._git_email = git_email
        if failures:
            raise RuntimeError("; ".join(failures))

    def system_prompt(self, config: PluginConfig) -> str:
        clone_depth = int(config.get("GITHUB_CLONE_DEPTH", "50"))
        if self._repos or self._setup_attempted:
            return build_system_prompt(
                self._repos, clone_depth,
                git_user=self._git_name,
            )

        # Fallback: setup() hasn't run yet. Build from config.
        repos_raw = config.get("GITHUB_REPOS", "")
        workspace = config.get(
            "GITHUB_WORKSPACE",
            config.get("WORKSPACE_ROOT", "/workspace"),
        )
        try:
            repo_names = parse_repos(repos_raw)
        except ValueError:
            repo_names = []

        placeholder_repos = [
            RepoInfo(
                repo=r,
                path=repo_checkout_path(workspace, r),
                default_branch="main",
            )
            for r in repo_names
        ]
        return build_system_prompt(placeholder_repos, clone_depth)

    def on_job_started(self, job: Job, config: PluginConfig) -> None:
        pass

    def on_job_finished(
        self, job: Job, result: AgentResult, config: PluginConfig
    ) -> None:
        pass


def create_plugin() -> Plugin:
    return GitHubPlugin()  # type: ignore[return-value]
