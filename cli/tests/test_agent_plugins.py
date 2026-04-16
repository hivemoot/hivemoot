"""Tests for AGENT_PLUGINS explicit plugin selection in the engine."""

import importlib
import os
import shutil
import sys
import tempfile
import uuid
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.engine import Engine
from hivemoot_agent.plugins import registry
from hivemoot_agent.plugins.interfaces import PluginConfig
from hivemoot_agent.providers import claude, codex


class _PromptOnlyProvider:
    native_skill_backend = ""


class _FakePlugin:
    """Minimal plugin for testing."""

    def __init__(
        self,
        name: str,
        valid: bool = True,
        setup_error: str = "",
    ):
        self.name = name
        self.version = "0.0.1"
        self.description = f"fake {name}"
        self._valid = valid
        self._setup_error = setup_error

    def validate(self, config: PluginConfig) -> list[str]:
        return [] if self._valid else ["missing something"]

    def setup(self, config: PluginConfig) -> None:
        if self._setup_error:
            raise RuntimeError(self._setup_error)

    def triggers(self) -> list:
        return []

    def system_prompt(self, config: PluginConfig) -> str:
        return f"System prompt for {self.name}"

    def on_job_started(self, job, config):
        pass

    def on_job_finished(self, job, result, config):
        pass


def _setup_registry(*plugins):
    """Replace global registry state with test plugins."""
    registry._plugins.clear()
    registry._configs.clear()
    for p in plugins:
        registry.register(p)


def _write_file(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)


def _load_temp_plugin(
    package_name: str,
    module_name: str,
    class_name: str,
    files: dict[str, str],
) -> tuple[str, object]:
    tmpdir = tempfile.mkdtemp(prefix="hm-skill-plugin-")
    for relpath, content in files.items():
        _write_file(os.path.join(tmpdir, relpath), content)

    sys.path.insert(0, tmpdir)
    importlib.invalidate_caches()
    module = importlib.import_module(module_name)
    plugin = getattr(module, class_name)()
    return tmpdir, plugin


def _cleanup_temp_plugin(tmpdir: str, package_name: str) -> None:
    try:
        sys.path.remove(tmpdir)
    except ValueError:
        pass
    for name in list(sys.modules):
        if name == package_name or name.startswith(f"{package_name}."):
            sys.modules.pop(name, None)
    importlib.invalidate_caches()
    shutil.rmtree(tmpdir, ignore_errors=True)


# ── AGENT_PLUGINS selection tests ────────────────────────────────


def test_explicit_plugin_found():
    _setup_registry(_FakePlugin("alpha"), _FakePlugin("beta"))
    engine = Engine()

    with patch.dict(os.environ, {"AGENT_PLUGINS": "alpha"}, clear=False):
        result = engine._resolve_plugins()

    assert result is not None
    assert "alpha" in result
    assert "beta" not in result


def test_explicit_multiple_plugins():
    _setup_registry(_FakePlugin("alpha"), _FakePlugin("beta"))
    engine = Engine()

    with patch.dict(os.environ, {"AGENT_PLUGINS": "alpha,beta"}, clear=False):
        result = engine._resolve_plugins()

    assert result is not None
    assert "alpha" in result
    assert "beta" in result


def test_explicit_plugin_not_found():
    _setup_registry(_FakePlugin("alpha"))
    engine = Engine()

    with patch.dict(os.environ, {"AGENT_PLUGINS": "missing"}, clear=False):
        result = engine._resolve_plugins()

    assert result is None


def test_explicit_plugin_invalid_config():
    _setup_registry(_FakePlugin("broken", valid=False))
    engine = Engine()

    with patch.dict(os.environ, {"AGENT_PLUGINS": "broken"}, clear=False):
        result = engine._resolve_plugins()

    assert result is None


def test_explicit_one_valid_one_invalid():
    """When AGENT_PLUGINS lists a plugin that fails validation,
    the whole resolution fails (hard error)."""
    _setup_registry(
        _FakePlugin("good"),
        _FakePlugin("bad", valid=False),
    )
    engine = Engine()

    with patch.dict(os.environ, {"AGENT_PLUGINS": "good,bad"}, clear=False):
        result = engine._resolve_plugins()

    assert result is None


def test_explicit_whitespace_handling():
    _setup_registry(_FakePlugin("alpha"), _FakePlugin("beta"))
    engine = Engine()

    with patch.dict(os.environ, {"AGENT_PLUGINS": " alpha , beta "}, clear=False):
        result = engine._resolve_plugins()

    assert result is not None
    assert "alpha" in result
    assert "beta" in result


# ── Auto-discover fallback tests ─────────────────────────────────


def test_autodiscover_skips_invalid():
    """Without AGENT_PLUGINS, invalid plugins are skipped (not fatal)."""
    _setup_registry(
        _FakePlugin("good"),
        _FakePlugin("bad", valid=False),
    )
    engine = Engine()

    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("AGENT_PLUGINS", None)
        result = engine._resolve_plugins()

    assert result is not None
    assert "good" in result
    assert "bad" not in result


def test_autodiscover_none_valid():
    _setup_registry(_FakePlugin("bad", valid=False))
    engine = Engine()

    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("AGENT_PLUGINS", None)
        result = engine._resolve_plugins()

    assert result is None


def test_build_skills_plugin_dir_flat_package_layout():
    package_name = f"skillpkg_flat_{uuid.uuid4().hex}"
    tmpdir, plugin = _load_temp_plugin(
        package_name=package_name,
        module_name=package_name,
        class_name="FlatPlugin",
        files={
            f"{package_name}/__init__.py": (
                "class FlatPlugin:\n"
                "    name = 'flat'\n"
                "    version = '0.0.1'\n"
            ),
            f"{package_name}/skills/alpha/SKILL.md": "# Alpha\n",
        },
    )

    skills_dir = ""
    try:
        engine = Engine()
        engine._plugins = {"flat": plugin}
        skills_dir = engine._build_skills_plugin_dir()
        assert skills_dir
        assert os.path.isfile(
            os.path.join(skills_dir, "skills", "alpha", "SKILL.md")
        )
    finally:
        if skills_dir:
            shutil.rmtree(skills_dir, ignore_errors=True)
        _cleanup_temp_plugin(tmpdir, package_name)


def test_build_skills_plugin_dir_nested_package_layout():
    package_name = f"skillpkg_nested_{uuid.uuid4().hex}"
    tmpdir, plugin = _load_temp_plugin(
        package_name=package_name,
        module_name=f"{package_name}.core.impl",
        class_name="NestedPlugin",
        files={
            f"{package_name}/__init__.py": "",
            f"{package_name}/core/__init__.py": "",
            f"{package_name}/core/impl.py": (
                "class NestedPlugin:\n"
                "    name = 'nested'\n"
                "    version = '0.0.1'\n"
            ),
            f"{package_name}/skills/beta/SKILL.md": "# Beta\n",
        },
    )

    skills_dir = ""
    try:
        engine = Engine()
        engine._plugins = {"nested": plugin}
        skills_dir = engine._build_skills_plugin_dir()
        assert skills_dir
        assert os.path.isfile(
            os.path.join(skills_dir, "skills", "beta", "SKILL.md")
        )
    finally:
        if skills_dir:
            shutil.rmtree(skills_dir, ignore_errors=True)
        _cleanup_temp_plugin(tmpdir, package_name)


def test_resolve_skill_runtime_stages_workspace_agents_skills_for_codex():
    package_name = f"skillruntime_codex_{uuid.uuid4().hex}"
    tmpdir, plugin = _load_temp_plugin(
        package_name=package_name,
        module_name=package_name,
        class_name="CodexSkillPlugin",
        files={
            f"{package_name}/__init__.py": (
                "class CodexSkillPlugin:\n"
                "    name = 'codex-skillpack'\n"
                "    version = '0.0.1'\n"
            ),
            f"{package_name}/skills/security-reviewer/SKILL.md": (
                "---\n"
                "name: security-reviewer\n"
                "---\n"
                "## Security Reviewer\n"
                "Look for secrets.\n"
            ),
            f"{package_name}/skills/security-reviewer/reference.md": "# Checklist\n",
        },
    )

    workspace = tempfile.mkdtemp(prefix="hm-skill-workspace-")
    runtime = None
    original_cwd = os.getcwd()
    try:
        os.chdir(workspace)
        engine = Engine()
        engine._plugins = {"codex-skillpack": plugin}
        config = PluginConfig(
            name="oneshot",
            settings={"AGENT_SKILLS": "security-reviewer"},
        )

        runtime = engine._resolve_skill_runtime(
            config, "codex", codex,
        )

        skill_link = Path(workspace) / ".agents" / "skills" / "security-reviewer"
        assert runtime is not None
        assert runtime.prompt_skills == ""
        assert runtime.plugin_dir == ""
        assert skill_link.is_symlink()
        assert (skill_link / "SKILL.md").is_file()
        assert (skill_link / "reference.md").is_file()
        assert '"selected":["security-reviewer"]' in runtime.scope_json
    finally:
        if runtime is not None:
            engine._cleanup_skill_runtime(runtime)
        os.chdir(original_cwd)
        shutil.rmtree(workspace, ignore_errors=True)
        _cleanup_temp_plugin(tmpdir, package_name)


def test_resolve_skill_runtime_rolls_back_workspace_state_on_collision():
    package_name = f"skillruntime_collision_{uuid.uuid4().hex}"
    tmpdir, plugin = _load_temp_plugin(
        package_name=package_name,
        module_name=package_name,
        class_name="CollisionSkillPlugin",
        files={
            f"{package_name}/__init__.py": (
                "class CollisionSkillPlugin:\n"
                "    name = 'collision-skillpack'\n"
                "    version = '0.0.1'\n"
            ),
            f"{package_name}/skills/alpha/SKILL.md": "# Alpha\n",
            f"{package_name}/skills/beta/SKILL.md": "# Beta\n",
        },
    )

    workspace = tempfile.mkdtemp(prefix="hm-skill-collision-")
    original_cwd = os.getcwd()
    try:
        os.chdir(workspace)
        existing = Path(workspace) / ".agents" / "skills" / "beta"
        existing.mkdir(parents=True)

        engine = Engine()
        engine._plugins = {"collision-skillpack": plugin}
        config = PluginConfig(
            name="oneshot",
            settings={"AGENT_SKILLS": "alpha,beta"},
        )

        try:
            engine._resolve_skill_runtime(config, "codex", codex)
            assert False, "Expected workspace skill collision"
        except ValueError as exc:
            assert "workspace skill collision" in str(exc)

        assert not (Path(workspace) / ".agents" / "skills" / "alpha").exists()
        assert not (Path(workspace) / ".agents" / ".hivemoot-skill-locks").exists()
    finally:
        os.chdir(original_cwd)
        shutil.rmtree(workspace, ignore_errors=True)
        _cleanup_temp_plugin(tmpdir, package_name)


def test_resolve_skill_runtime_uses_native_plugin_dir_for_claude():
    package_name = f"skillruntime_claude_{uuid.uuid4().hex}"
    tmpdir, plugin = _load_temp_plugin(
        package_name=package_name,
        module_name=package_name,
        class_name="ClaudeSkillPlugin",
        files={
            f"{package_name}/__init__.py": (
                "class ClaudeSkillPlugin:\n"
                "    name = 'claude-skillpack'\n"
                "    version = '0.0.1'\n"
            ),
            f"{package_name}/skills/security-reviewer/SKILL.md": "# Security Reviewer\n",
            f"{package_name}/skills/security-reviewer/scripts/check.sh": "#!/usr/bin/env bash\n",
            f"{package_name}/skills/test-advocate/SKILL.md": "# Test Advocate\n",
        },
    )

    runtime = None
    try:
        engine = Engine()
        engine._plugins = {"claude-skillpack": plugin}
        config = PluginConfig(
            name="oneshot",
            settings={
                "AGENT_SKILLS": "security-reviewer",
                "AGENT_AVAILABLE_SKILLS": "test-advocate",
            },
        )

        runtime = engine._resolve_skill_runtime(
            config, "claude", claude,
        )

        assert runtime is not None
        assert runtime.prompt_skills == ""
        assert runtime.plugin_dir
        assert os.path.isfile(
            os.path.join(runtime.plugin_dir, "skills", "security-reviewer", "SKILL.md")
        )
        assert os.path.isfile(
            os.path.join(runtime.plugin_dir, "skills", "test-advocate", "SKILL.md")
        )
        assert os.path.isfile(
            os.path.join(
                runtime.plugin_dir,
                "skills",
                "security-reviewer",
                "scripts",
                "check.sh",
            )
        )
    finally:
        if runtime is not None:
            engine._cleanup_skill_runtime(runtime)
        _cleanup_temp_plugin(tmpdir, package_name)


def test_resolve_skill_runtime_renders_prompt_skills_for_prompt_only_provider():
    package_name = f"skillruntime_prompt_{uuid.uuid4().hex}"
    tmpdir, plugin = _load_temp_plugin(
        package_name=package_name,
        module_name=package_name,
        class_name="PromptSkillPlugin",
        files={
            f"{package_name}/__init__.py": (
                "class PromptSkillPlugin:\n"
                "    name = 'prompt-skillpack'\n"
                "    version = '0.0.1'\n"
            ),
            f"{package_name}/skills/security-reviewer/SKILL.md": (
                "---\n"
                "name: security-reviewer\n"
                "---\n"
                "## Security Reviewer\n"
                "Look for secrets.\n"
            ),
        },
    )

    try:
        engine = Engine()
        engine._plugins = {"prompt-skillpack": plugin}
        config = PluginConfig(
            name="oneshot",
            settings={"AGENT_SKILLS": "security-reviewer"},
        )

        runtime = engine._resolve_skill_runtime(
            config, "prompt-only", _PromptOnlyProvider(),
        )

        assert runtime.plugin_dir == ""
        assert "<skills>" in runtime.prompt_skills
        assert '<skill name="security-reviewer">' in runtime.prompt_skills
        assert "## Security Reviewer" in runtime.prompt_skills
        assert "name: security-reviewer" not in runtime.prompt_skills
    finally:
        _cleanup_temp_plugin(tmpdir, package_name)


# ── Oneshot with AGENT_PLUGINS ───────────────────────────────────


def test_oneshot_with_plugins():
    """Oneshot uses plugin system prompt when AGENT_PLUGINS is set."""
    _setup_registry(_FakePlugin("alpha"))

    mock_proc = MagicMock()
    mock_proc.returncode = 0
    mock_proc.stdout = '{"type":"result","result":"done"}\n'
    mock_proc.stderr = ""

    env = {
        "AGENT_PLUGINS": "alpha",
        "AGENT_PROVIDER": "claude",
    }

    with patch("subprocess.run", return_value=mock_proc) as mock_run:
        with patch.dict(os.environ, env, clear=False):
            engine = Engine()
            code = engine.oneshot(prompt="Do something")

    assert code == 0
    # Verify the system prompt came from the plugin.
    cmd = mock_run.call_args[0][0]
    assert "System prompt for alpha" in " ".join(cmd)


def test_oneshot_plugin_not_found_exits():
    _setup_registry()
    env = {
        "AGENT_PLUGINS": "nonexistent",
        "AGENT_PROVIDER": "claude",
    }

    with patch.dict(os.environ, env, clear=False):
        engine = Engine()
        code = engine.oneshot(prompt="Do something")

    assert code == 1


def test_oneshot_plugin_setup_failure_exits():
    _setup_registry(_FakePlugin("alpha", setup_error="clone failed"))
    env = {
        "AGENT_PLUGINS": "alpha",
        "AGENT_PROVIDER": "claude",
    }

    with patch("subprocess.run") as mock_run:
        with patch.dict(os.environ, env, clear=False):
            engine = Engine()
            code = engine.oneshot(prompt="Do something")

    assert code == 1
    mock_run.assert_not_called()


def test_oneshot_without_plugins():
    """Oneshot without AGENT_PLUGINS uses default system prompt."""
    mock_proc = MagicMock()
    mock_proc.returncode = 0
    mock_proc.stdout = '{"type":"result","result":"done"}\n'
    mock_proc.stderr = ""

    with patch("subprocess.run", return_value=mock_proc) as mock_run:
        with patch.dict(os.environ, {"AGENT_PROVIDER": "claude"}, clear=False):
            os.environ.pop("AGENT_PLUGINS", None)
            engine = Engine()
            code = engine.oneshot(prompt="Do something")

    assert code == 0
    cmd = mock_run.call_args[0][0]
    assert "autonomous AI agent" in " ".join(cmd)


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
