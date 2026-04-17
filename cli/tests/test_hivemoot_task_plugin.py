"""Tests for the hivemoot-task plugin."""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins.interfaces import PluginConfig
from hivemoot_agent.plugins_builtin.hivemoot_task import HivemootTaskPlugin


def test_validate_requires_github_in_plugins():
    plugin = HivemootTaskPlugin()
    config = PluginConfig(
        name="hivemoot-task",
        settings={
            "AGENT_PLUGINS": "hivemoot-task",
            "GITHUB_REPOS": "acme/api",
        },
    )

    errors = plugin.validate(config)

    assert any("requires AGENT_PLUGINS to include github" in err for err in errors)


def test_validate_requires_github_before_hivemoot_task():
    plugin = HivemootTaskPlugin()
    config = PluginConfig(
        name="hivemoot-task",
        settings={
            "AGENT_PLUGINS": "hivemoot-identity,hivemoot-task,github",
            "GITHUB_REPOS": "acme/api",
        },
    )

    errors = plugin.validate(config)

    assert any("github before hivemoot-task" in err for err in errors)


def test_validate_requires_hivemoot_identity_in_stack():
    plugin = HivemootTaskPlugin()
    config = PluginConfig(
        name="hivemoot-task",
        settings={
            "AGENT_PLUGINS": "github,hivemoot-task",
            "GITHUB_REPOS": "acme/api",
        },
    )

    errors = plugin.validate(config)

    assert any(
        "requires AGENT_PLUGINS to include hivemoot-identity" in err
        for err in errors
    )


def test_validate_requires_hivemoot_identity_before_hivemoot_task():
    plugin = HivemootTaskPlugin()
    config = PluginConfig(
        name="hivemoot-task",
        settings={
            "AGENT_PLUGINS": "github,hivemoot-task,hivemoot-identity",
            "GITHUB_REPOS": "acme/api",
        },
    )

    errors = plugin.validate(config)

    assert any(
        "hivemoot-identity before hivemoot-task" in err for err in errors
    )


def test_validate_requires_target_repo_for_multi_repo_config():
    plugin = HivemootTaskPlugin()
    config = PluginConfig(
        name="hivemoot-task",
        settings={
            "AGENT_PLUGINS": "hivemoot-identity,github,hivemoot-task",
            "GITHUB_REPOS": "acme/api,acme/web",
        },
    )

    errors = plugin.validate(config)

    assert any("requires TARGET_REPO" in err for err in errors)


def test_validate_rejects_target_repo_outside_github_repos():
    plugin = HivemootTaskPlugin()
    config = PluginConfig(
        name="hivemoot-task",
        settings={
            "AGENT_PLUGINS": "hivemoot-identity,github,hivemoot-task",
            "GITHUB_REPOS": "acme/api",
            "TARGET_REPO": "other/repo",
        },
    )

    errors = plugin.validate(config)

    assert any("must match one of the repositories" in err for err in errors)


def test_validate_single_repo_without_target_passes():
    plugin = HivemootTaskPlugin()
    config = PluginConfig(
        name="hivemoot-task",
        settings={
            "AGENT_PLUGINS": "hivemoot-identity,github,hivemoot-task",
            "GITHUB_REPOS": "acme/api",
        },
    )

    errors = plugin.validate(config)

    assert errors == []


def test_setup_requires_cloned_repo_path():
    plugin = HivemootTaskPlugin()
    with tempfile.TemporaryDirectory(prefix="hm-task-missing-") as tmpdir:
        config = PluginConfig(
            name="hivemoot-task",
            settings={
                "AGENT_PLUGINS": "hivemoot-identity,github,hivemoot-task",
                "GITHUB_REPOS": "acme/api",
                "GITHUB_WORKSPACE": tmpdir,
            },
        )
        try:
            plugin.setup(config)
            raised = False
        except RuntimeError as exc:
            raised = True
            message = str(exc)
        assert raised, "setup should fail when github plugin has not cloned the repo"
        assert "expected the github plugin to clone" in message


def test_system_prompt_has_task_operating_mode_and_soul():
    plugin = HivemootTaskPlugin()
    with tempfile.TemporaryDirectory(prefix="hm-task-") as tmpdir:
        repo_path = os.path.join(tmpdir, "acme", "api")
        os.makedirs(repo_path)

        config = PluginConfig(
            name="hivemoot-task",
            settings={
                "AGENT_PLUGINS": "hivemoot-identity,github,hivemoot-task",
                "GITHUB_REPOS": "acme/api",
                "GITHUB_WORKSPACE": tmpdir,
            },
        )

        plugin.setup(config)
        prompt = plugin.system_prompt(config)

    # Soul guardrails now live in the hivemoot-identity plugin — the
    # hivemoot-task prompt no longer embeds them.
    assert "## Security Guardrails (Non-Overridable)" not in prompt
    assert "executing a specific delegated task" in prompt
    assert "Do not perform autonomous work beyond the task scope" in prompt
    assert "Target repository for this task: `acme/api`." in prompt
    assert repo_path in prompt


def test_system_prompt_does_not_include_autonomous_mission():
    plugin = HivemootTaskPlugin()
    config = PluginConfig(
        name="hivemoot-task",
        settings={
            "AGENT_PLUGINS": "hivemoot-identity,github,hivemoot-task",
            "GITHUB_REPOS": "acme/api",
        },
    )

    prompt = plugin.system_prompt(config)

    # The autonomous/hivemoot-github prompt uses these phrases; task mode must not.
    assert "Deliver at least one complete, useful contribution" not in prompt
    assert "Triage notifications" not in prompt


def test_system_prompt_uses_workspace_root_when_github_workspace_empty():
    plugin = HivemootTaskPlugin()
    config = PluginConfig(
        name="hivemoot-task",
        settings={
            "AGENT_PLUGINS": "hivemoot-identity,github,hivemoot-task",
            "GITHUB_REPOS": "acme/api",
            "GITHUB_WORKSPACE": "",
            "WORKSPACE_ROOT": "/workspace/repo",
        },
    )

    prompt = plugin.system_prompt(config)

    assert "/workspace/repo/acme/api" in prompt


def test_plugin_has_no_triggers():
    plugin = HivemootTaskPlugin()
    assert plugin.triggers() == []


def test_plugin_package_contains_hivemoot_skill_pack():
    plugin_dir = os.path.join(
        os.path.dirname(__file__),
        "..",
        "hivemoot_agent",
        "plugins_builtin",
        "hivemoot_task",
        "skills",
    )

    assert os.path.isdir(plugin_dir)
    # Skill files are shared with hivemoot-github (symlinks) so the agent
    # gets the same skill pack in task mode.
    for skill in (
        "code-reviewer",
        "dep-auditor",
        "pr-hygiene",
        "security-reviewer",
        "test-advocate",
    ):
        assert os.path.isfile(os.path.join(plugin_dir, skill, "SKILL.md")), skill


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
