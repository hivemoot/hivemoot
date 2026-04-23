"""Tests for dual-source plugin discovery (built-in + external).

Built-in plugins ship inside the runtime package; external plugins
are mounted by the deployer at ``/opt/hivemoot-agent/plugins/`` (in
production) or anywhere else for tests via the ``external_dir``
override.  Built-ins always win on name collision so a deployer
can't shadow runtime behaviour.
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins import PluginRegistry


_EXTERNAL_PLUGIN_INIT = """
class _Plugin:
    name = {name!r}
    version = "0.1.0"
    description = "external test plugin"

    def validate(self, config): return []
    def setup(self, config): pass
    def triggers(self): return []
    def system_prompt(self, config): return ""
    def on_job_started(self, job, config): pass
    def on_job_finished(self, job, result, config): pass


def create_plugin():
    return _Plugin()
"""


def _make_external_plugin(parent: Path, dirname: str, plugin_name: str) -> Path:
    plugin_dir = parent / dirname
    plugin_dir.mkdir()
    (plugin_dir / "__init__.py").write_text(
        _EXTERNAL_PLUGIN_INIT.format(name=plugin_name)
    )
    return plugin_dir


@contextmanager
def _capture_stderr():
    buf = io.StringIO()
    with patch("sys.stderr", buf):
        yield buf


class DualSourceDiscoveryTests(unittest.TestCase):
    def test_external_plugin_is_discovered_alongside_builtins(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hm-ext-") as tmp:
            ext_root = Path(tmp)
            _make_external_plugin(ext_root, "apiary_demo", "apiary-demo")

            reg = PluginRegistry()
            reg.discover(external_dir=ext_root)

            names = sorted(reg.all().keys())
            # Built-ins still load.
            self.assertIn("github", names)
            self.assertIn("hivemoot", names)
            # External plugin loaded too.
            self.assertIn("apiary-demo", names)

    def test_external_source_is_tagged(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hm-ext-") as tmp:
            ext_root = Path(tmp)
            _make_external_plugin(ext_root, "apiary_demo", "apiary-demo")

            reg = PluginRegistry()
            reg.discover(external_dir=ext_root)

            self.assertEqual(reg.source_of("apiary-demo"), "external")
            self.assertEqual(reg.source_of("github"), "builtin")

    def test_builtin_wins_on_name_collision(self) -> None:
        """A custom plugin with the same name as a built-in must NOT
        replace the built-in — that would let a deployer silently
        shadow runtime behaviour.  The custom one is rejected with a
        warning instead."""
        with tempfile.TemporaryDirectory(prefix="hm-ext-") as tmp:
            ext_root = Path(tmp)
            _make_external_plugin(ext_root, "github_clone", "github")

            reg = PluginRegistry()
            with _capture_stderr() as err:
                reg.discover(external_dir=ext_root)

            self.assertEqual(reg.source_of("github"), "builtin")
            self.assertIn("shadows a built-in", err.getvalue())
            self.assertIn("github", err.getvalue())

    def test_missing_external_dir_is_ignored(self) -> None:
        """Production deployments without a custom plugins dir must
        still load built-ins cleanly."""
        reg = PluginRegistry()
        with _capture_stderr() as err:
            reg.discover(external_dir=Path("/nonexistent/path/abc123"))

        # Built-ins still load.
        self.assertIn("github", reg.all())
        # No noise about missing dir.
        self.assertEqual(err.getvalue(), "")

    def test_external_plugin_with_no_create_plugin_is_silently_skipped(
        self,
    ) -> None:
        """A directory with __init__.py but no create_plugin() is not a
        plugin (it might be a helper package); skip without erroring."""
        with tempfile.TemporaryDirectory(prefix="hm-ext-") as tmp:
            ext_root = Path(tmp)
            stub = ext_root / "not_a_plugin"
            stub.mkdir()
            (stub / "__init__.py").write_text("# helpers, not a plugin\n")

            reg = PluginRegistry()
            with _capture_stderr() as err:
                reg.discover(external_dir=ext_root)

            self.assertNotIn("not_a_plugin", reg.all())
            self.assertEqual(err.getvalue(), "")

    def test_external_plugin_load_failure_is_isolated(self) -> None:
        """A broken external plugin must not stop discovery — other
        external plugins and all built-ins must still load."""
        with tempfile.TemporaryDirectory(prefix="hm-ext-") as tmp:
            ext_root = Path(tmp)
            broken = ext_root / "broken"
            broken.mkdir()
            (broken / "__init__.py").write_text("raise RuntimeError('boom')\n")
            _make_external_plugin(ext_root, "good_one", "apiary-good")

            reg = PluginRegistry()
            with _capture_stderr() as err:
                reg.discover(external_dir=ext_root)

            self.assertIn("apiary-good", reg.all())
            self.assertIn("github", reg.all())  # built-ins unaffected
            self.assertIn("broken", err.getvalue())
            self.assertIn("boom", err.getvalue())

    def test_dirs_starting_with_underscore_are_skipped(self) -> None:
        """Convention: __pycache__, _scratch, etc. are not plugins."""
        with tempfile.TemporaryDirectory(prefix="hm-ext-") as tmp:
            ext_root = Path(tmp)
            (ext_root / "__pycache__").mkdir()
            (ext_root / "__pycache__" / "__init__.py").write_text(
                _EXTERNAL_PLUGIN_INIT.format(name="should-not-load")
            )

            reg = PluginRegistry()
            reg.discover(external_dir=ext_root)

            self.assertNotIn("should-not-load", reg.all())


class RegistryConfigForTests(unittest.TestCase):
    """config_for() fails closed; config_for_or_none() is the test path.

    Pins the CLAUDE.md fail-closed invariant: a migrated plugin
    accessing ``config.typed.<field>`` on an unconfigured plugin would
    AttributeError deep in the plugin.  Better to fail loudly at the
    registry with a clear "never called configure()" message.
    """

    def test_config_for_raises_on_unconfigured_plugin(self) -> None:
        reg = PluginRegistry()
        with self.assertRaises(KeyError) as ctx:
            reg.config_for("definitely-not-configured")
        self.assertIn("configure()", str(ctx.exception))

    def test_config_for_or_none_returns_none_on_unconfigured(self) -> None:
        reg = PluginRegistry()
        self.assertIsNone(reg.config_for_or_none("definitely-not-configured"))

    def test_config_for_returns_configured_value(self) -> None:
        from hivemoot_agent.plugins.interfaces import PluginConfig
        reg = PluginRegistry()
        stub = PluginConfig(name="test", settings={"X": "1"})
        reg.configure("test", stub)
        self.assertIs(reg.config_for("test"), stub)


if __name__ == "__main__":
    unittest.main()
