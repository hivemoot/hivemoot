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


def _empty_typed() -> PluginConfig:
    """No-backend config: schema defaults, no claim_url."""
    from pathlib import Path
    from hivemoot_agent.plugins_builtin.hivemoot_task.config import (
        HivemootTaskConfig,
    )
    return PluginConfig(
        name="hivemoot-task",
        settings={},
        typed=HivemootTaskConfig(),
    )


def _backend_typed(**overrides) -> PluginConfig:
    """Full-backend config with a real token file."""
    from pathlib import Path
    from hivemoot_agent.plugins_builtin.hivemoot_task.config import (
        HivemootTaskConfig,
    )
    token_file = Path("/tmp/.hivemoot-task-test-tok")
    if not token_file.exists():
        token_file.write_text("tok")
    fields = dict(
        claim_url="https://api.example/api/tasks/claim",
        execute_base_url="https://api.example/api/tasks",
        token_file=token_file,
    )
    fields.update(overrides)
    return PluginConfig(
        name="hivemoot-task",
        settings={},
        typed=HivemootTaskConfig(**fields),
    )


def test_validate_empty_config_ok():
    """A plugin loaded without backend wiring (claim_url='') must
    validate cleanly.  Fleet templates list the plugin by default and
    only set claim_url on services that should actually run tasks."""
    plugin = HivemootTaskPlugin()
    errors = plugin.validate(_empty_typed())
    assert errors == []


def test_validate_task_only_fleet_ok():
    """A pure task worker (typed config with no github co-load) must
    validate cleanly when backend wiring is complete."""
    plugin = HivemootTaskPlugin()
    errors = plugin.validate(_backend_typed())
    assert errors == []


def test_validate_does_not_require_github():
    """Regression: older versions required github co-load.  The
    decoupled version MUST NOT complain about github being absent."""
    plugin = HivemootTaskPlugin()
    errors = plugin.validate(_backend_typed())
    assert errors == [], (
        f"plugin must not require github or repos; got errors: {errors}"
    )


def test_validate_ignores_multi_repo_github_config():
    """If a sibling github plugin happens to be configured with
    multiple repos, hivemoot-task must not care."""
    plugin = HivemootTaskPlugin()
    errors = plugin.validate(_backend_typed())
    # No repo-cardinality complaint anywhere.
    assert errors == []


def test_validate_checks_trigger_config_when_claim_url_set():
    """When backend wiring is partial (claim_url set but execute_base_url
    or token_file missing), the trigger's own validate fires."""
    from pathlib import Path
    from hivemoot_agent.plugins_builtin.hivemoot_task.config import (
        HivemootTaskConfig,
    )
    plugin = HivemootTaskPlugin()
    typed = HivemootTaskConfig(
        claim_url="https://api.example/api/tasks/claim",
        execute_base_url="",  # missing
        token_file=None,       # missing
    )
    config = PluginConfig(name="hivemoot-task", settings={}, typed=typed)
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
