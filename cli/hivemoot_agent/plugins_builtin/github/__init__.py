"""GitHub plugin — clone repos, inject context, develop on GitHub."""

from __future__ import annotations

import os
import subprocess
import sys
from typing import Any

from hivemoot_agent.plugins.interfaces import (
    AgentResult,
    Job,
    Plugin,
    PluginConfig,
    Trigger,
)
from hivemoot_agent.plugins_builtin.github import ack as ack_module
from hivemoot_agent.plugins_builtin.github.repo_manager import (
    RepoInfo,
    clone_or_sync,
    configure_git_user,
    parse_repos,
    repo_checkout_path,
    resolve_github_user,
)
from hivemoot_agent.plugins_builtin.github.system_prompt import build_system_prompt
from hivemoot_agent.plugins_builtin.github.trigger import (
    GitHubMentionsTrigger,
    GitHubReviewRequestsTrigger,
)


def _configure_git_auth() -> None:
    """Configure git HTTPS auth through the authenticated gh CLI."""
    try:
        result = subprocess.run(
            ["gh", "auth", "setup-git"],
            capture_output=True,
            text=True,
            timeout=30,
            env=dict(os.environ),
        )
    except FileNotFoundError as exc:
        raise RuntimeError("gh CLI is not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("gh auth setup-git timed out") from exc

    if result.returncode == 0:
        return

    detail = (result.stderr or result.stdout).strip()
    if not detail:
        detail = "gh auth setup-git exited without an error message"
    raise RuntimeError(detail)


def _validate_repo_access(repo: str, token: str) -> None:
    """Fail fast when the configured token cannot access a repo."""
    try:
        result = subprocess.run(
            ["gh", "api", f"repos/{repo}", "--jq", ".full_name"],
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ, "GH_TOKEN": token, "GITHUB_TOKEN": token},
        )
    except FileNotFoundError as exc:
        raise RuntimeError("gh CLI is not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"Timed out validating access to {repo}") from exc

    if result.returncode == 0:
        return

    detail = (result.stderr or result.stdout).strip()
    if not detail:
        detail = f"token cannot access {repo}"
    raise RuntimeError(f"Failed to validate access for {repo}: {detail}")


def _resolve_workspace_root(config: PluginConfig) -> str:
    """Honor WORKSPACE_ROOT when GITHUB_WORKSPACE is unset or empty."""
    return (
        config.get("GITHUB_WORKSPACE", "")
        or config.get("WORKSPACE_ROOT", "/workspace")
        or "/workspace"
    )


def _bool_env(value: str) -> bool:
    """Same truthy semantics the shell triggers used for ``WATCH_*=1``."""
    return value.strip() in {"1", "true", "TRUE", "True", "yes", "on"}


def _resolve_gh_token_for_ack(config: PluginConfig) -> str:
    return (
        config.get("GITHUB_TOKEN", "")
        or os.environ.get("GITHUB_TOKEN", "")
        or os.environ.get("GH_TOKEN", "")
        or ""
    )


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
        # Env-gated so a fleet that only wants oneshot/dispatch behaviour
        # can omit the watchers.  Defaults are off to preserve the
        # opt-in semantics the shell controller had with WATCH_*=0.
        config_env = dict(os.environ)
        instances: list[Trigger] = []
        if _bool_env(config_env.get("GITHUB_WATCH_MENTIONS", "0")):
            instances.append(GitHubMentionsTrigger(self))
        if _bool_env(config_env.get("GITHUB_WATCH_REVIEW_REQUESTS", "0")):
            instances.append(GitHubReviewRequestsTrigger(self))
        return instances

    def setup(self, config: PluginConfig) -> None:
        """Clone all configured repos and authenticate gh CLI."""
        self._setup_attempted = True
        token = config.get("GITHUB_TOKEN", "")
        repos_raw = config.get("GITHUB_REPOS", "")
        workspace = _resolve_workspace_root(config)
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

        try:
            _configure_git_auth()
        except RuntimeError as exc:
            raise RuntimeError(
                f"Failed to configure git credential helper: {exc}"
            ) from exc

        for repo in repo_names:
            _validate_repo_access(repo, token)

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
        workspace = _resolve_workspace_root(config)
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
        # Watch triggers tag their jobs with ack metadata; everything
        # else (oneshot, hivemoot-task) leaves it absent.
        watch_meta = job.metadata.get("github_watch") if job.metadata else None
        if not isinstance(watch_meta, dict):
            return

        # On agent failure we deliberately skip the ack — the shell
        # controller's same path: the next watch poll re-emits the event
        # and we retry.  Silently acking a failed run would lose the
        # notification and the work it represented.
        if result.exit_code != 0:
            print(
                f"[{watch_meta.get('trigger', 'github-watch')}] "
                f"agent failed (exit={result.exit_code}); skipping ack",
                file=sys.stderr, flush=True,
            )
            return

        ack_key = str(watch_meta.get("ack_key") or "")
        state_file = str(watch_meta.get("state_file") or "")
        gh_token = _resolve_gh_token_for_ack(config)
        ack_module.ack_event(ack_key, state_file, gh_token)


def create_plugin() -> Plugin:
    return GitHubPlugin()  # type: ignore[return-value]
