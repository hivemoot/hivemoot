"""GitHub plugin — clone repos, inject context, develop on GitHub."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from hivemoot_agent.plugins.interfaces import (
    AgentResult,
    Job,
    Plugin,
    PluginConfig,
    Trigger,
)
from hivemoot_agent.plugins_builtin.github import ack as ack_module
from hivemoot_agent.plugins_builtin.github import pr_watcher
from hivemoot_agent.plugins_builtin.github.repo_manager import (
    RepoInfo,
    clone_or_sync,
    configure_git_user,
    repo_checkout_path,
    resolve_github_user,
)
from hivemoot_agent.plugins_builtin.github.system_prompt import build_system_prompt
from hivemoot_agent.plugins_builtin.github.trigger import (
    GitHubMentionsTrigger,
    GitHubNewPullRequestsTrigger,
    GitHubReviewRequestsTrigger,
)

if TYPE_CHECKING:
    from hivemoot_agent.plugins_builtin.github.config import GitHubConfig


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


def _read_token(cfg: "GitHubConfig") -> str:
    """Read the GitHub token from the configured token_file, or ''.

    Returns empty string if no token_file is set or the file isn't
    readable — validate() reports the error upstream.  Kept as a tiny
    helper so setup/trigger/ack all resolve the token the same way.
    """
    if cfg.token_file is None:
        return ""
    try:
        return Path(cfg.token_file).read_text().strip()
    except OSError:
        return ""


class GitHubPlugin:
    name = "github"
    version = "0.2.0"
    description = "GitHub repository management and development"

    def __init__(self) -> None:
        self._repos: list[RepoInfo] = []
        self._git_name: str = ""
        self._git_email: str = ""
        self._setup_attempted = False
        # Cached typed config — captured in validate() / setup() so
        # triggers() (which has no config parameter in the Plugin
        # protocol) can read cfg.watch_* flags without reaching into
        # the global registry.
        self._cfg: GitHubConfig | None = None

    def validate(self, config: PluginConfig) -> list[str]:
        from hivemoot_agent.plugins_builtin.github.config import GitHubConfig

        cfg: GitHubConfig | None = config.typed
        if cfg is None:
            return [
                "github plugin requires typed config (plugins.github in "
                "hivemoot.yaml).  Env-var configuration was removed in 0.2.0."
            ]
        self._cfg = cfg

        errors: list[str] = []
        if not cfg.repos:
            errors.append("plugins.github.repos is required (list of owner/repo)")
        if cfg.token_file is None:
            errors.append(
                "plugins.github.token_file is required "
                "(typically `!secret github_token`)"
            )
        elif not Path(cfg.token_file).is_file():
            errors.append(
                f"plugins.github.token_file does not exist: {cfg.token_file}"
            )
        elif not _read_token(cfg):
            errors.append(
                f"plugins.github.token_file is empty: {cfg.token_file}"
            )
        return errors

    def triggers(self) -> list[Trigger]:
        """Return watcher triggers per cfg.watch_* flags.

        validate()/setup() have already stashed ``self._cfg``; we only
        create trigger instances the operator actually enabled, so the
        engine never starts a thread that immediately no-ops.
        """
        cfg = self._cfg
        instances: list[Trigger] = []
        if cfg is None:
            return instances
        if cfg.watch_mentions:
            instances.append(GitHubMentionsTrigger(self))
        if cfg.watch_review_requests:
            instances.append(GitHubReviewRequestsTrigger(self))
        if cfg.watch_new_prs:
            instances.append(GitHubNewPullRequestsTrigger(self))
        return instances

    def setup(self, config: PluginConfig) -> None:
        """Clone all configured repos and authenticate gh CLI."""
        from hivemoot_agent.plugins_builtin.github.config import GitHubConfig

        self._setup_attempted = True
        cfg: GitHubConfig | None = config.typed
        if cfg is None:
            raise RuntimeError(
                "github plugin setup called without typed config"
            )
        self._cfg = cfg

        token = _read_token(cfg)
        workspace = str(cfg.workspace)
        clone_depth = cfg.clone_depth
        repo_names = list(cfg.repos)

        # Resolve git user from token for commit authorship.
        git_name = cfg.git_name
        git_email = cfg.git_email
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
        from hivemoot_agent.plugins_builtin.github.config import GitHubConfig

        cfg: GitHubConfig | None = config.typed or self._cfg
        clone_depth = cfg.clone_depth if cfg else 50
        if self._repos or self._setup_attempted:
            return build_system_prompt(
                self._repos, clone_depth,
                git_user=self._git_name,
            )

        # Fallback: setup() hasn't run yet.  Build from config.
        if cfg is None:
            return build_system_prompt([], clone_depth)
        workspace = str(cfg.workspace)
        placeholder_repos = [
            RepoInfo(
                repo=r,
                path=repo_checkout_path(workspace, r),
                default_branch="main",
            )
            for r in cfg.repos
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
        ack_strategy = str(watch_meta.get("ack_strategy") or "notification")

        if ack_strategy == "notification":
            gh_token = _read_token(config.typed) if config.typed else ""
            ack_module.ack_event(ack_key, state_file, gh_token)
            return
        if ack_strategy == "new_pr":
            pr_watcher.ack_new_pr(ack_key, state_file)
            return

        print(
            f"[{watch_meta.get('trigger', 'github-watch')}] "
            f"unknown ack strategy: {ack_strategy}",
            file=sys.stderr, flush=True,
        )


def create_plugin() -> Plugin:
    return GitHubPlugin()  # type: ignore[return-value]
