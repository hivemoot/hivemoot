"""Tests for the hivemoot-github plugin."""

import os
import subprocess
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins.interfaces import PluginConfig
from hivemoot_agent.plugins_builtin.hivemoot_github import HivemootGitHubPlugin
from hivemoot_agent.plugins_builtin.hivemoot_github.role_loader import (
    RoleLoadError,
    build_role_prompt_block,
    load_role_prompt_block,
)


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


def test_validate_requires_github_before_plugin():
    plugin = HivemootGitHubPlugin()
    config = PluginConfig(
        name="hivemoot-github",
        settings={
            "AGENT_PLUGINS": "hivemoot-identity,hivemoot-github,github",
            "GITHUB_REPOS": "acme/api",
        },
    )

    with patch(
        "hivemoot_agent.plugins_builtin.hivemoot_github.shutil.which",
        return_value="/usr/bin/hivemoot",
    ):
        errors = plugin.validate(config)

    assert any("github before hivemoot-github" in error for error in errors)


def test_validate_requires_hivemoot_identity_in_stack():
    plugin = HivemootGitHubPlugin()
    config = PluginConfig(
        name="hivemoot-github",
        settings={
            "AGENT_PLUGINS": "github,hivemoot-github",
            "GITHUB_REPOS": "acme/api",
        },
    )

    with patch(
        "hivemoot_agent.plugins_builtin.hivemoot_github.shutil.which",
        return_value="/usr/bin/hivemoot",
    ):
        errors = plugin.validate(config)

    assert any(
        "requires AGENT_PLUGINS to include hivemoot-identity" in error
        for error in errors
    )


def test_validate_requires_hivemoot_identity_before_plugin():
    plugin = HivemootGitHubPlugin()
    config = PluginConfig(
        name="hivemoot-github",
        settings={
            "AGENT_PLUGINS": "github,hivemoot-github,hivemoot-identity",
            "GITHUB_REPOS": "acme/api",
        },
    )

    with patch(
        "hivemoot_agent.plugins_builtin.hivemoot_github.shutil.which",
        return_value="/usr/bin/hivemoot",
    ):
        errors = plugin.validate(config)

    assert any(
        "hivemoot-identity before hivemoot-github" in error for error in errors
    )


def test_validate_requires_target_repo_for_multi_repo_config():
    plugin = HivemootGitHubPlugin()
    config = PluginConfig(
        name="hivemoot-github",
        settings={
            "AGENT_PLUGINS": "hivemoot-identity,github,hivemoot-github",
            "GITHUB_REPOS": "acme/api,acme/web",
        },
    )

    with patch(
        "hivemoot_agent.plugins_builtin.hivemoot_github.shutil.which",
        return_value="/usr/bin/hivemoot",
    ):
        errors = plugin.validate(config)

    assert any("requires TARGET_REPO" in error for error in errors)


def test_validate_rejects_target_repo_outside_github_repos():
    plugin = HivemootGitHubPlugin()
    config = PluginConfig(
        name="hivemoot-github",
        settings={
            "AGENT_PLUGINS": "hivemoot-identity,github,hivemoot-github",
            "GITHUB_REPOS": "acme/api",
            "TARGET_REPO": "other/repo",
        },
    )

    with patch(
        "hivemoot_agent.plugins_builtin.hivemoot_github.shutil.which",
        return_value="/usr/bin/hivemoot",
    ):
        errors = plugin.validate(config)

    assert any("must match one of the repositories" in error for error in errors)


def test_setup_and_system_prompt_use_role_context():
    plugin = HivemootGitHubPlugin()
    with tempfile.TemporaryDirectory(prefix="hm-hivemoot-gh-") as tmpdir:
        repo_path = os.path.join(tmpdir, "acme", "api")
        os.makedirs(repo_path)

        config = PluginConfig(
            name="hivemoot-github",
            settings={
                "AGENT_PLUGINS": "hivemoot-identity,github,hivemoot-github",
                "GITHUB_REPOS": "acme/api",
                "GITHUB_WORKSPACE": tmpdir,
                "GITHUB_CLONE_DEPTH": "7",
                "AGENT_ID": "worker",
            },
        )

        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot_github.load_role_prompt_block",
            return_value="Your role on this project is: worker",
        ):
            plugin.setup(config)

        prompt = plugin.system_prompt(config)

    assert "Deliver at least one complete, useful contribution" in prompt
    # Soul guardrails now live in the hivemoot-identity plugin — the
    # hivemoot-github prompt no longer embeds them.
    assert "## Security Guardrails (Non-Overridable)" not in prompt
    assert "Your role on this project is: worker" in prompt
    assert "Hivemoot buzz role: worker" in prompt
    assert "Treat `acme/api` as the active Hivemoot governance target" in prompt
    assert "Shallow clone (depth 7)" in prompt
    assert "git fetch --unshallow" in prompt
    assert repo_path in prompt


def test_setup_continues_when_role_lookup_fails():
    plugin = HivemootGitHubPlugin()
    with tempfile.TemporaryDirectory(prefix="hm-hivemoot-gh-") as tmpdir:
        os.makedirs(os.path.join(tmpdir, "acme", "api"))
        config = PluginConfig(
            name="hivemoot-github",
            settings={
                "AGENT_PLUGINS": "hivemoot-identity,github,hivemoot-github",
                "GITHUB_REPOS": "acme/api",
                "GITHUB_WORKSPACE": tmpdir,
                "AGENT_ID": "worker",
            },
        )

        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot_github.load_role_prompt_block",
            side_effect=RoleLoadError("no role"),
        ):
            plugin.setup(config)

        prompt = plugin.system_prompt(config)

    assert "Hivemoot buzz role: worker" in prompt
    assert "no role" not in prompt


def test_system_prompt_uses_workspace_root_when_github_workspace_empty():
    plugin = HivemootGitHubPlugin()
    config = PluginConfig(
        name="hivemoot-github",
        settings={
            "AGENT_PLUGINS": "hivemoot-identity,github,hivemoot-github",
            "GITHUB_REPOS": "acme/api",
            "GITHUB_WORKSPACE": "",
            "WORKSPACE_ROOT": "/workspace/repo",
            "AGENT_ID": "worker",
        },
    )

    prompt = plugin.system_prompt(config)

    assert "/workspace/repo/acme/api" in prompt


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
