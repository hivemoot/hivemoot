"""Tests for AGENT_PLUGINS explicit plugin selection in the engine."""

import os
import sys
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.engine import Engine
from hivemoot_agent.plugins import registry
from hivemoot_agent.plugins.interfaces import PluginConfig


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
