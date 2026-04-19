"""Tests for the hivemoot-task plugin.

Post-decoupling: the plugin does not require ``github``, has no
``TARGET_REPO`` / ``GITHUB_REPOS`` dependency, and its system prompt
is repo-agnostic.  The tests here pin those contracts explicitly so
a future regression that re-introduces coupling fails loudly.
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins.interfaces import PluginConfig
from hivemoot_agent.plugins_builtin.hivemoot_task import HivemootTaskPlugin


# ── validate() — decoupled from github ────────────────────────────


def test_validate_empty_config_ok():
    """A plugin loaded without any backend wiring must validate cleanly.
    Fleet templates list the plugin by default and only configure
    AGENT_TASK_* on services that should actually run tasks."""
    plugin = HivemootTaskPlugin()
    errors = plugin.validate(PluginConfig(name="hivemoot-task", settings={}))
    assert errors == []


def test_validate_task_only_fleet_ok():
    """AGENT_PLUGINS=hivemoot-task (no github, no identity, no repos)
    must be a valid configuration for a pure task worker."""
    plugin = HivemootTaskPlugin()
    config = PluginConfig(
        name="hivemoot-task",
        settings={
            "AGENT_PLUGINS": "hivemoot-task",
            "AGENT_TASK_CLAIM_URL": "https://api.example/api/tasks/claim",
            "AGENT_TASK_EXECUTE_BASE_URL": "https://api.example/api/tasks",
            "HIVEMOOT_AGENT_TOKEN": "tok",
        },
    )
    errors = plugin.validate(config)
    assert errors == []


def test_validate_does_not_require_github():
    """Regression: older versions required AGENT_PLUGINS to include
    github and TARGET_REPO/GITHUB_REPOS to be set.  The decoupled
    version MUST NOT complain about any of those being absent."""
    plugin = HivemootTaskPlugin()
    config = PluginConfig(
        name="hivemoot-task",
        settings={
            "AGENT_PLUGINS": "hivemoot-task",
            "AGENT_TASK_CLAIM_URL": "https://api.example/api/tasks/claim",
            "AGENT_TASK_EXECUTE_BASE_URL": "https://api.example/api/tasks",
            "HIVEMOOT_AGENT_TOKEN": "tok",
        },
    )
    errors = plugin.validate(config)
    assert errors == [], (
        f"plugin must not require github or repos; got errors: {errors}"
    )


def test_validate_ignores_multi_repo_github_config():
    """If the fleet happens to configure multiple repos (for github
    plugin's sake), hivemoot-task must not care about that."""
    plugin = HivemootTaskPlugin()
    config = PluginConfig(
        name="hivemoot-task",
        settings={
            "AGENT_PLUGINS": "github,hivemoot-task",
            "GITHUB_REPOS": "acme/api,acme/web,acme/mobile",
        },
    )
    errors = plugin.validate(config)
    # No TARGET_REPO complaint, no "requires a single repo" complaint,
    # nothing.  The plugin is indifferent to GITHUB_REPOS cardinality.
    assert errors == []


def test_validate_checks_trigger_config_when_claim_url_set():
    """When backend wiring is partial, errors should surface at
    validate time from the trigger's own config check."""
    plugin = HivemootTaskPlugin()
    config = PluginConfig(
        name="hivemoot-task",
        settings={
            "AGENT_TASK_CLAIM_URL": "https://api.example/api/tasks/claim",
            # Missing AGENT_TASK_EXECUTE_BASE_URL and HIVEMOOT_AGENT_TOKEN.
        },
    )
    errors = plugin.validate(config)
    assert errors, "trigger-side validation must fire when claim URL is set"


# ── setup() — no repo work ────────────────────────────────────────


def test_setup_is_noop():
    """setup() is a no-op: no repo cloning to verify, no state to set up."""
    plugin = HivemootTaskPlugin()
    # With or without GITHUB_* config — either way, no error.
    for settings in [
        {},
        {"GITHUB_REPOS": "acme/api"},
        {"GITHUB_REPOS": "acme/api,acme/web"},
    ]:
        plugin.setup(PluginConfig(name="hivemoot-task", settings=settings))


def test_setup_never_raises_on_missing_repo():
    """Regression: the old setup() verified a cloned-repo path and
    raised if absent.  The decoupled version does no such check."""
    plugin = HivemootTaskPlugin()
    with tempfile.TemporaryDirectory(prefix="hm-task-nope-") as tmpdir:
        config = PluginConfig(
            name="hivemoot-task",
            settings={
                "GITHUB_REPOS": "acme/api",
                "GITHUB_WORKSPACE": tmpdir,  # nothing cloned inside
            },
        )
        plugin.setup(config)  # must not raise


# ── system_prompt() — repo-agnostic ────────────────────────────────


def test_system_prompt_has_task_operating_mode():
    plugin = HivemootTaskPlugin()
    prompt = plugin.system_prompt(PluginConfig(name="hivemoot-task", settings={}))
    assert "executing a specific delegated task" in prompt
    assert "Do not perform autonomous work beyond the task scope" in prompt


def test_system_prompt_has_no_repo_context():
    """Regression: the old prompt baked in 'Target repository for this
    task: `owner/repo`' and the local repo path.  Post-decoupling, the
    system prompt must not reference any specific repo — repo scope
    (if any) lives in the per-task Job.prompt body that the trigger
    renders."""
    plugin = HivemootTaskPlugin()
    config = PluginConfig(
        name="hivemoot-task",
        settings={
            "GITHUB_REPOS": "acme/api",
            "TARGET_REPO": "acme/api",
            "GITHUB_WORKSPACE": "/workspace",
        },
    )
    prompt = plugin.system_prompt(config)

    assert "acme/api" not in prompt, (
        "system prompt must not embed a specific repo"
    )
    assert "Target repository" not in prompt
    assert "Local repository path" not in prompt


def test_system_prompt_omits_soul_guardrails():
    """Security guardrails live in the engine's always-applied <root>
    layer; the hivemoot-task prompt must not duplicate them."""
    plugin = HivemootTaskPlugin()
    prompt = plugin.system_prompt(PluginConfig(name="hivemoot-task", settings={}))
    assert "## Security Guardrails (Non-Overridable)" not in prompt


def test_system_prompt_does_not_include_autonomous_mission():
    """The autonomous/hivemoot-github prompt uses these phrases;
    task mode must not."""
    plugin = HivemootTaskPlugin()
    prompt = plugin.system_prompt(PluginConfig(name="hivemoot-task", settings={}))
    assert "Deliver at least one complete, useful contribution" not in prompt
    assert "Triage notifications" not in prompt


# ── triggers() and skills ─────────────────────────────────────────


def test_triggers_empty_without_claim_url():
    plugin = HivemootTaskPlugin()
    # Ensure AGENT_TASK_CLAIM_URL is not in env for this test.
    saved = os.environ.pop("AGENT_TASK_CLAIM_URL", None)
    try:
        assert plugin.triggers() == []
    finally:
        if saved is not None:
            os.environ["AGENT_TASK_CLAIM_URL"] = saved


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
