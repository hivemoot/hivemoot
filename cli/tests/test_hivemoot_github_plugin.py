"""Tests for the hivemoot-github plugin."""

import os
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins.interfaces import PluginConfig
from hivemoot_agent.plugins_builtin.github.config import GitHubConfig
from hivemoot_agent.plugins_builtin.hivemoot_github import HivemootGitHubPlugin
from hivemoot_agent.plugins_builtin.hivemoot_github.config import (
    HivemootGithubConfig,
)
from hivemoot_agent.plugins_builtin.hivemoot_github.role_loader import (
    RoleLoadError,
    build_role_prompt_block,
    load_role_prompt_block,
)


def _stage_github(repos: list[str], workspace: str = "/workspace") -> None:
    """Register a configured `github` plugin in the registry so
    hivemoot-github's validate() / setup() can read repos[0] from it.
    Tests should pair this with the snapshot/restore pattern below."""
    from hivemoot_agent.plugins import registry
    from pathlib import Path as _Path
    typed = GitHubConfig(repos=repos, workspace=_Path(workspace))
    registry._configs["github"] = PluginConfig(
        name="github", settings={}, typed=typed,
    )


def _mk_hivemoot_github_config(
    *,
    role_name: str = "",
    clone_depth: int = 50,
    workspace: str = "/workspace",
) -> PluginConfig:
    typed = HivemootGithubConfig(
        role_name=role_name,
        clone_depth=clone_depth,
        workspace=Path(workspace),
    )
    return PluginConfig(name="hivemoot-github", settings={}, typed=typed)


def test_build_role_prompt_block_formats_onboarding():
    result = build_role_prompt_block(
        {
            "onboarding": "Review open candidate PRs first.",
            "role": {
                "name": "worker",
                "description": "Ships changes",
                "instructions": "Keep PRs small.\n",
            },
        }
    )

    assert "Team onboarding:" in result
    assert "Review open candidate PRs first." in result
    assert "Your role on this project is: worker" in result
    assert "Role instructions: Keep PRs small." in result


def test_load_role_prompt_block_parses_cli_json():
    cli_result = subprocess.CompletedProcess(
        args=["hivemoot"],
        returncode=0,
        stdout=(
            '{"role":{"name":"worker","description":"Ships changes",'
            '"instructions":"Keep PRs small."},"onboarding":"Start with triage."}'
        ),
        stderr="",
    )

    with patch("subprocess.run", return_value=cli_result):
        result = load_role_prompt_block("worker", "acme/api")

    assert "Start with triage." in result
    assert "Your role on this project is: worker" in result


def test_validate_requires_github_to_be_configured_first():
    """Under ADR-003 the registry's configured_names() — populated as
    the engine iterates YAML plugins in order — is the source of truth
    for ordering.  hivemoot-github passes only when ``github`` is
    already in that list."""
    from hivemoot_agent.plugins import registry

    plugin = HivemootGitHubPlugin()
    config = _mk_hivemoot_github_config()

    saved_configs = dict(registry._configs)
    registry._configs.clear()
    try:
        # Case 1: github not yet configured → fail.
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot_github.shutil.which",
            return_value="/usr/bin/hivemoot",
        ):
            errors = plugin.validate(config)
        assert any(
            "github plugin to be activated AND listed BEFORE" in error
            for error in errors
        )

        # Case 2: github configured before us with a repo → pass.
        _stage_github(["acme/api"])
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot_github.shutil.which",
            return_value="/usr/bin/hivemoot",
        ):
            errors = plugin.validate(config)
        assert not any(
            "github plugin to be activated AND listed BEFORE" in error
            for error in errors
        )
    finally:
        registry._configs.clear()
        registry._configs.update(saved_configs)


def test_validate_picks_first_repo_when_multiple_configured():
    """Multi-repo github configs are accepted — repos[0] is canonical."""
    from hivemoot_agent.plugins import registry

    plugin = HivemootGitHubPlugin()
    config = _mk_hivemoot_github_config()

    saved_configs = dict(registry._configs)
    registry._configs.clear()
    try:
        _stage_github(["acme/api", "acme/web"])
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot_github.shutil.which",
            return_value="/usr/bin/hivemoot",
        ):
            errors = plugin.validate(config)
        assert errors == []
    finally:
        registry._configs.clear()
        registry._configs.update(saved_configs)


def test_setup_and_system_prompt_use_role_context():
    from hivemoot_agent.plugins import registry

    plugin = HivemootGitHubPlugin()
    saved_configs = dict(registry._configs)
    registry._configs.clear()
    try:
        with tempfile.TemporaryDirectory(prefix="hm-hivemoot-gh-") as tmpdir:
            repo_path = os.path.join(tmpdir, "acme", "api")
            os.makedirs(repo_path)
            _stage_github(["acme/api"], workspace=tmpdir)
            config = _mk_hivemoot_github_config(
                role_name="worker",
                clone_depth=7,
                workspace=tmpdir,
            )

            with patch(
                "hivemoot_agent.plugins_builtin.hivemoot_github.load_role_prompt_block",
                return_value="Your role on this project is: worker",
            ):
                plugin.setup(config)

            prompt = plugin.system_prompt(config)

        assert "Deliver at least one complete, useful contribution" in prompt
        # Security guardrails live in the engine's always-applied <root>
        # layer; the hivemoot-github prompt no longer embeds them.
        assert "## Security Guardrails (Non-Overridable)" not in prompt
        assert "Your role on this project is: worker" in prompt
        assert "Hivemoot buzz role: worker" in prompt
        assert "Treat `acme/api` as the active Hivemoot governance target" in prompt
        assert "Shallow clone (depth 7)" in prompt
        assert "git fetch --unshallow" in prompt
        assert repo_path in prompt
    finally:
        registry._configs.clear()
        registry._configs.update(saved_configs)


def test_setup_continues_when_role_lookup_fails():
    from hivemoot_agent.plugins import registry

    plugin = HivemootGitHubPlugin()
    saved_configs = dict(registry._configs)
    registry._configs.clear()
    try:
        with tempfile.TemporaryDirectory(prefix="hm-hivemoot-gh-") as tmpdir:
            os.makedirs(os.path.join(tmpdir, "acme", "api"))
            _stage_github(["acme/api"], workspace=tmpdir)
            config = _mk_hivemoot_github_config(
                role_name="worker", workspace=tmpdir,
            )

            with patch(
                "hivemoot_agent.plugins_builtin.hivemoot_github.load_role_prompt_block",
                side_effect=RoleLoadError("no role"),
            ):
                plugin.setup(config)

            prompt = plugin.system_prompt(config)

        assert "Hivemoot buzz role: worker" in prompt
        assert "no role" not in prompt
    finally:
        registry._configs.clear()
        registry._configs.update(saved_configs)


def test_system_prompt_uses_configured_workspace():
    """Workspace path comes from the typed schema; no legacy fallback."""
    from hivemoot_agent.plugins import registry

    plugin = HivemootGitHubPlugin()
    saved_configs = dict(registry._configs)
    registry._configs.clear()
    try:
        _stage_github(["acme/api"], workspace="/workspace/repo")
        config = _mk_hivemoot_github_config(
            role_name="worker", workspace="/workspace/repo",
        )

        prompt = plugin.system_prompt(config)

        assert "/workspace/repo/acme/api" in prompt
    finally:
        registry._configs.clear()
        registry._configs.update(saved_configs)


def test_plugin_package_contains_hivemoot_skill_pack():
    plugin_dir = os.path.join(
        os.path.dirname(__file__),
        "..",
        "hivemoot_agent",
        "plugins_builtin",
        "hivemoot_github",
        "skills",
    )

    assert os.path.isdir(plugin_dir)
    assert os.path.isfile(os.path.join(plugin_dir, "code-reviewer", "SKILL.md"))


if __name__ == "__main__":
    import inspect

    passed = 0
    failed = 0
    for name, func in sorted(
        inspect.getmembers(sys.modules[__name__], inspect.isfunction)
    ):
        if not name.startswith("test_"):
            continue
        try:
            func()
            print(f"  \u2713 {name}")
            passed += 1
        except Exception as e:
            print(f"  \u2717 {name}: {e}")
            failed += 1

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
