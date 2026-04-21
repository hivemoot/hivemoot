"""Hivemoot GitHub workflow plugin."""

from __future__ import annotations

import os
import shutil
import sys
from typing import TYPE_CHECKING

from hivemoot_agent.plugins.interfaces import (
    AgentResult,
    Job,
    Plugin,
    PluginConfig,
    Trigger,
)
from hivemoot_agent.plugins_builtin.github.repo_manager import (
    repo_checkout_path,
)
from hivemoot_agent.plugins_builtin.hivemoot_github.role_loader import (
    RoleLoadError,
    load_role_prompt_block,
)
from hivemoot_agent.plugins_builtin.hivemoot_github.system_prompt import build_system_prompt

if TYPE_CHECKING:
    from hivemoot_agent.plugins_builtin.github.config import GitHubConfig
    from hivemoot_agent.plugins_builtin.hivemoot_github.config import (
        HivemootGithubConfig,
    )


def _github_typed() -> "GitHubConfig | None":
    """Look up the github plugin's typed config from the registry.

    Returns None when the github plugin isn't configured yet (e.g.
    validate() running before _resolve_plugins reaches us).  Callers
    must handle None by emitting an error rather than crashing.
    """
    from hivemoot_agent.plugins import registry as _registry
    cfg = _registry.config_for("github")
    return cfg.typed if cfg is not None else None


def _resolve_target_repo() -> str:
    """First repo from the github plugin's typed config, or ''.

    No separate TARGET_REPO knob — github 0.2.0 (hivemoot-agent#596)
    standardized on ``repos[0]`` as the canonical primary, and we
    follow that.
    """
    cfg = _github_typed()
    if cfg is None or not cfg.repos:
        return ""
    return cfg.repos[0]


def _resolve_role_name(cfg: "HivemootGithubConfig") -> str:
    """Role name override, falling back to AGENT_ID env.

    Matches the historical HIVEMOOT_BUZZ_ROLE behaviour: deployers
    typically run one role per container, so AGENT_ID is the right
    default.  An explicit ``role_name`` in YAML wins for fleets that
    want a role distinct from the agent identity.
    """
    if cfg.role_name:
        return cfg.role_name
    return (os.environ.get("AGENT_ID", "") or "").strip()


def _resolve_repo_path(cfg: "HivemootGithubConfig", target_repo: str) -> str:
    if not target_repo:
        return ""
    return repo_checkout_path(str(cfg.workspace), target_repo)


class HivemootGitHubPlugin:
    name = "hivemoot-github"
    version = "0.2.0"
    description = "Hivemoot-specific GitHub contribution workflow"

    def __init__(self) -> None:
        self._target_repo: str = ""
        self._repo_path: str = ""
        self._role_name: str = ""
        self._role_prompt_block: str = ""
        # Cached typed config — captured in validate()/setup() so
        # system_prompt() doesn't need to re-read from the registry.
        self._cfg: HivemootGithubConfig | None = None

    def validate(self, config: PluginConfig) -> list[str]:
        from hivemoot_agent.plugins_builtin.hivemoot_github.config import (
            HivemootGithubConfig,
        )

        errors: list[str] = []

        cfg: HivemootGithubConfig | None = config.typed
        if cfg is None:
            return [
                "hivemoot-github plugin requires typed config (plugins."
                "hivemoot-github in hivemoot.yaml).  Env-var configuration "
                "was removed in 0.2.0."
            ]
        self._cfg = cfg

        # Under ADR-003 the YAML order is the activation order.  The
        # engine calls configure() then validate() per plugin in YAML
        # iteration order, so when our validate runs the registry's
        # ``configured_names()`` lists every plugin already configured
        # (and therefore set up before us).  We need ``github`` in that
        # list — both for "did the operator activate it at all" and
        # "did they put it before us".
        from hivemoot_agent.plugins import registry as _registry
        already_configured = _registry.configured_names()
        if "github" not in already_configured:
            errors.append(
                "hivemoot-github requires the github plugin to be activated "
                "AND listed BEFORE hivemoot-github in plugins: of "
                "hivemoot.yaml so repos are cloned before this plugin's "
                "setup runs.  Currently configured before us: "
                f"{already_configured or '(none)'}."
            )
            return errors

        # github IS configured — check it has a repo for us to act on.
        target_repo = _resolve_target_repo()
        if not target_repo:
            errors.append(
                "hivemoot-github could not determine the target repository "
                "from the github plugin's typed config (plugins.github.repos "
                "is empty)."
            )

        if shutil.which("hivemoot") is None:
            errors.append("hivemoot-github requires the hivemoot CLI in PATH.")

        return errors

    def setup(self, config: PluginConfig) -> None:
        from hivemoot_agent.plugins_builtin.hivemoot_github.config import (
            HivemootGithubConfig,
        )

        cfg: HivemootGithubConfig | None = config.typed
        if cfg is None:
            raise RuntimeError(
                "hivemoot-github setup called without typed config"
            )
        self._cfg = cfg

        target_repo = _resolve_target_repo()
        if not target_repo:
            raise RuntimeError(
                "hivemoot-github could not determine target repository "
                "from the github plugin's typed config."
            )

        self._target_repo = target_repo
        self._repo_path = _resolve_repo_path(cfg, target_repo)
        if not self._repo_path or not os.path.isdir(self._repo_path):
            raise RuntimeError(
                "hivemoot-github expected the github plugin to clone "
                f"{target_repo} at {self._repo_path or '(unknown path)'}"
            )

        self._role_name = _resolve_role_name(cfg)
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
        from hivemoot_agent.plugins_builtin.hivemoot_github.config import (
            HivemootGithubConfig,
        )

        cfg: HivemootGithubConfig | None = config.typed or self._cfg
        if cfg is None:
            # validate() rejected; engine wouldn't have reached here.
            return ""

        target_repo = self._target_repo or _resolve_target_repo()
        role_name = self._role_name or _resolve_role_name(cfg)
        repo_path = self._repo_path or _resolve_repo_path(cfg, target_repo)
        return build_system_prompt(
            target_repo=target_repo,
            repo_path=repo_path,
            clone_depth=cfg.clone_depth,
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
