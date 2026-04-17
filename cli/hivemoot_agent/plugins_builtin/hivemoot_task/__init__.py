"""Hivemoot delegated-task plugin.

Runs a single claimed task from the Hivemoot backend. The task lifecycle
(claim, heartbeat, completion, failure reporting) is controller-owned on
the host; this plugin only shapes the worker-side system prompt so the
agent stays within the delegated task's scope.
"""

from __future__ import annotations

import os

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
from hivemoot_agent.plugins_builtin.hivemoot_task.system_prompt import build_system_prompt


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
                "when hivemoot-task is enabled.",
            )
        return target_repo, ""

    if len(repos) == 1:
        return repos[0], ""
    if not repos:
        return (
            "",
            "hivemoot-task requires GITHUB_REPOS from the github plugin.",
        )
    return (
        "",
        "hivemoot-task requires TARGET_REPO when GITHUB_REPOS contains "
        "multiple repositories.",
    )


def _resolve_workspace_root(config: PluginConfig) -> str:
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


class HivemootTaskPlugin:
    name = "hivemoot-task"
    version = "0.1.0"
    description = "Hivemoot delegated-task execution workflow"

    def __init__(self) -> None:
        self._target_repo: str = ""
        self._repo_path: str = ""

    def validate(self, config: PluginConfig) -> list[str]:
        errors: list[str] = []

        requested = _parse_requested_plugins(config.get("AGENT_PLUGINS", ""))
        if "github" not in requested:
            errors.append(
                "hivemoot-task requires AGENT_PLUGINS to include github."
            )
        elif requested.index("github") > requested.index(self.name):
            errors.append(
                "AGENT_PLUGINS must list github before hivemoot-task so "
                "repository setup runs first."
            )

        target_repo, target_error = _resolve_target_repo(config)
        if target_error:
            errors.append(target_error)
        elif not target_repo:
            errors.append(
                "hivemoot-task could not determine the target repository."
            )

        return errors

    def setup(self, config: PluginConfig) -> None:
        target_repo, error = _resolve_target_repo(config)
        if error:
            raise RuntimeError(error)

        self._target_repo = target_repo
        self._repo_path = _resolve_repo_path(config, target_repo)
        if not self._repo_path or not os.path.isdir(self._repo_path):
            raise RuntimeError(
                "hivemoot-task expected the github plugin to clone "
                f"{target_repo} at {self._repo_path or '(unknown path)'}"
            )

    def triggers(self) -> list[Trigger]:
        return []

    def system_prompt(self, config: PluginConfig) -> str:
        target_repo = self._target_repo
        if not target_repo:
            target_repo, _ = _resolve_target_repo(config)
        repo_path = self._repo_path or _resolve_repo_path(config, target_repo)
        return build_system_prompt(
            target_repo=target_repo,
            repo_path=repo_path,
        )

    def on_job_started(self, job: Job, config: PluginConfig) -> None:
        pass

    def on_job_finished(
        self, job: Job, result: AgentResult, config: PluginConfig
    ) -> None:
        pass


def create_plugin() -> Plugin:
    return HivemootTaskPlugin()  # type: ignore[return-value]
