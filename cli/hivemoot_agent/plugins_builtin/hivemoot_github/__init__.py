"""Hivemoot GitHub workflow plugin."""

from __future__ import annotations

import os
import shutil
import sys

from hivemoot_agent.plugins.interfaces import (
    AgentResult,
    Job,
    Plugin,
    PluginConfig,
    Trigger,
)
from hivemoot_agent.plugins_builtin.github.repo_manager import (
    parse_repos,
    repo_checkout_path,
)
from hivemoot_agent.plugins_builtin.hivemoot_github.role_loader import (
    RoleLoadError,
    load_role_prompt_block,
)
from hivemoot_agent.plugins_builtin.hivemoot_github.system_prompt import build_system_prompt


def _parse_requested_plugins(raw: str) -> list[str]:
    return [entry.strip() for entry in raw.split(",") if entry.strip()]


def _resolve_target_repo(config: PluginConfig) -> tuple[str, str]:
    target_repo = (config.get("TARGET_REPO", "") or "").strip()
    repos_raw = config.get("GITHUB_REPOS", "") or ""
    try:
        repos = parse_repos(repos_raw)
    except ValueError as exc:
        return "", str(exc)

    if target_repo:
        try:
            parsed_target = parse_repos(target_repo)
        except ValueError as exc:
            return "", str(exc)
        target_repo = parsed_target[0]
        if repos and target_repo not in repos:
            return (
                "",
                "TARGET_REPO must match one of the repositories in GITHUB_REPOS "
                "when hivemoot-github is enabled.",
            )
        return target_repo, ""

    if len(repos) == 1:
        return repos[0], ""
    if not repos:
        return (
            "",
            "hivemoot-github requires GITHUB_REPOS from the github plugin.",
        )
    return (
        "",
        "hivemoot-github requires TARGET_REPO when GITHUB_REPOS contains "
        "multiple repositories.",
    )


def _resolve_role_name(config: PluginConfig) -> str:
    for key in ("HIVEMOOT_BUZZ_ROLE", "AGENT_ID", "AGENT_ID_01"):
        value = (config.get(key, "") or "").strip()
        if value:
            return value
    return ""


def _resolve_workspace_root(config: PluginConfig) -> str:
    """Honor WORKSPACE_ROOT when GITHUB_WORKSPACE is unset or empty."""
    return (
        config.get("GITHUB_WORKSPACE", "")
        or config.get("WORKSPACE_ROOT", "/workspace")
        or "/workspace"
    )


def _resolve_repo_path(config: PluginConfig, target_repo: str) -> str:
    workspace = _resolve_workspace_root(config)
    if not target_repo:
        return ""
    return repo_checkout_path(workspace, target_repo)


class HivemootGitHubPlugin:
    name = "hivemoot-github"
    version = "0.1.0"
    description = "Hivemoot-specific GitHub contribution workflow"

    def __init__(self) -> None:
        self._target_repo: str = ""
        self._repo_path: str = ""
        self._role_name: str = ""
        self._role_prompt_block: str = ""

    def validate(self, config: PluginConfig) -> list[str]:
        errors: list[str] = []

        requested = _parse_requested_plugins(config.get("AGENT_PLUGINS", ""))
        if "github" not in requested:
            errors.append(
                "hivemoot-github requires AGENT_PLUGINS to include github."
            )
        elif requested.index("github") > requested.index(self.name):
            errors.append(
                "AGENT_PLUGINS must list github before hivemoot-github so "
                "repository setup runs first."
            )

        target_repo, target_error = _resolve_target_repo(config)
        if target_error:
            errors.append(target_error)
        elif not target_repo:
            errors.append("hivemoot-github could not determine the target repository.")

        if shutil.which("hivemoot") is None:
            errors.append("hivemoot-github requires the hivemoot CLI in PATH.")

        return errors

    def setup(self, config: PluginConfig) -> None:
        target_repo, error = _resolve_target_repo(config)
        if error:
            raise RuntimeError(error)

        self._target_repo = target_repo
        self._repo_path = _resolve_repo_path(config, target_repo)
        if not self._repo_path or not os.path.isdir(self._repo_path):
            raise RuntimeError(
                "hivemoot-github expected the github plugin to clone "
                f"{target_repo} at {self._repo_path or '(unknown path)'}"
            )

        self._role_name = _resolve_role_name(config)
        self._role_prompt_block = ""
        if not self._role_name:
            return

        try:
            self._role_prompt_block = load_role_prompt_block(
                self._role_name, target_repo
            )
        except RoleLoadError as exc:
            print(
                "[hivemoot-github] warning: failed to resolve role "
                f"{self._role_name} for {target_repo}: {exc}",
                file=sys.stderr,
                flush=True,
            )

    def triggers(self) -> list[Trigger]:
        return []

    def system_prompt(self, config: PluginConfig) -> str:
        target_repo = self._target_repo
        if not target_repo:
            target_repo, _ = _resolve_target_repo(config)

        role_name = self._role_name or _resolve_role_name(config)
        repo_path = self._repo_path or _resolve_repo_path(config, target_repo)
        try:
            clone_depth = int(
                config.get(
                    "GITHUB_CLONE_DEPTH",
                    config.get("GIT_CLONE_DEPTH", "50"),
                )
                or "50"
            )
        except ValueError:
            clone_depth = 50
        return build_system_prompt(
            target_repo=target_repo,
            repo_path=repo_path,
            clone_depth=clone_depth,
            role_name=role_name,
            role_prompt_block=self._role_prompt_block,
        )

    def on_job_started(self, job: Job, config: PluginConfig) -> None:
        pass

    def on_job_finished(
        self, job: Job, result: AgentResult, config: PluginConfig
    ) -> None:
        pass


def create_plugin() -> Plugin:
    return HivemootGitHubPlugin()  # type: ignore[return-value]
