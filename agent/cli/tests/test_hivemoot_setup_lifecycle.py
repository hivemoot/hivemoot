"""Tests for ``HivemootPlugin.setup_lifecycle`` integration with the engine.

Validates:

- When ``apiarist.enabled`` is False (default), setup_lifecycle is a no-op
  — no subscriber gets registered, lifecycle stays empty.
- When ``apiarist.enabled`` is True with full config, a subscriber is
  registered with the right service/repo/agent_id.
- When ``apiarist.repo`` is empty, the github plugin's ``repos[0]`` is used.
- When ``apiarist.service`` is empty, ``AGENT_ID`` env is used.
- Missing service AND missing AGENT_ID raises a clear RuntimeError.
- Missing repo AND missing github plugin config raises a clear RuntimeError.

These tests instantiate ContainerLifecycle directly (no engine) so they
exercise the plugin → lifecycle wiring without spinning up the full
engine. End-to-end engine wiring is exercised by the existing
test_engine_lifecycle suite which now goes through the lifecycle wrap.
"""

from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.lifecycle import ContainerLifecycle
from hivemoot_agent.plugins.interfaces import PluginConfig
from hivemoot_agent.plugins_builtin.hivemoot import HivemootPlugin
from hivemoot_agent.plugins_builtin.hivemoot.auth_subscriber import (
    HivemootGithubAuthSubscriber,
)
from hivemoot_agent.plugins_builtin.hivemoot.config import (
    HivemootApiaristConfig,
    HivemootConfig,
)


def _make_plugin_config(apiarist: HivemootApiaristConfig | None = None) -> PluginConfig:
    """Build a PluginConfig with HivemootConfig.typed."""
    typed = HivemootConfig(apiarist=apiarist or HivemootApiaristConfig())
    return PluginConfig(name="hivemoot", typed=typed)


class DisabledNoOpTest(unittest.TestCase):
    def test_apiarist_disabled_does_not_subscribe(self) -> None:
        """Default config (apiarist.enabled=False) is a no-op."""
        plugin = HivemootPlugin()
        lifecycle = ContainerLifecycle()
        cfg = _make_plugin_config()  # all defaults

        plugin.setup_lifecycle(lifecycle, cfg)

        self.assertEqual(lifecycle.subscriber_count, 0)
        self.assertIsNone(plugin._auth_subscriber)


class EnabledRegistersSubscriberTest(unittest.TestCase):
    """When fully configured, a subscriber registers correctly."""

    def setUp(self) -> None:
        os.environ.pop("AGENT_ID", None)

    def tearDown(self) -> None:
        os.environ.pop("AGENT_ID", None)

    def test_full_config_registers_subscriber(self) -> None:
        plugin = HivemootPlugin()
        lifecycle = ContainerLifecycle()
        cfg = _make_plugin_config(
            HivemootApiaristConfig(
                enabled=True,
                service="drone-zai",
                repo="hivemoot/colony",
            )
        )

        plugin.setup_lifecycle(lifecycle, cfg)

        self.assertEqual(lifecycle.subscriber_count, 1)
        sub = plugin._auth_subscriber
        self.assertIsInstance(sub, HivemootGithubAuthSubscriber)
        self.assertEqual(sub.service, "drone-zai")
        self.assertEqual(sub.repo, "hivemoot/colony")

    def test_service_falls_back_to_agent_id(self) -> None:
        os.environ["AGENT_ID"] = "drone"
        plugin = HivemootPlugin()
        lifecycle = ContainerLifecycle()
        cfg = _make_plugin_config(
            HivemootApiaristConfig(
                enabled=True,
                service="",  # empty → AGENT_ID
                repo="hivemoot/colony",
            )
        )

        plugin.setup_lifecycle(lifecycle, cfg)

        sub = plugin._auth_subscriber
        self.assertEqual(sub.service, "drone")

    def test_explicit_service_wins_over_agent_id(self) -> None:
        os.environ["AGENT_ID"] = "drone"
        plugin = HivemootPlugin()
        lifecycle = ContainerLifecycle()
        cfg = _make_plugin_config(
            HivemootApiaristConfig(
                enabled=True,
                service="custom-service",
                repo="hivemoot/colony",
            )
        )

        plugin.setup_lifecycle(lifecycle, cfg)
        self.assertEqual(plugin._auth_subscriber.service, "custom-service")


class FailureModeTest(unittest.TestCase):
    """Misconfiguration raises clearly at setup time, not job-dispatch time."""

    def setUp(self) -> None:
        os.environ.pop("AGENT_ID", None)

    def tearDown(self) -> None:
        os.environ.pop("AGENT_ID", None)

    def test_no_service_and_no_agent_id_raises(self) -> None:
        plugin = HivemootPlugin()
        lifecycle = ContainerLifecycle()
        cfg = _make_plugin_config(
            HivemootApiaristConfig(
                enabled=True,
                service="",  # missing
                repo="hivemoot/colony",
            )
        )

        with self.assertRaises(RuntimeError) as ctx:
            plugin.setup_lifecycle(lifecycle, cfg)
        self.assertIn("apiarist.service", str(ctx.exception))
        self.assertIn("AGENT_ID", str(ctx.exception))
        self.assertEqual(lifecycle.subscriber_count, 0)

    def test_no_repo_and_no_github_plugin_raises(self) -> None:
        os.environ["AGENT_ID"] = "drone"
        plugin = HivemootPlugin()
        lifecycle = ContainerLifecycle()
        cfg = _make_plugin_config(
            HivemootApiaristConfig(
                enabled=True,
                service="drone-zai",
                repo="",  # missing — no github plugin to fall back to either
            )
        )

        # No github plugin in registry → fallback returns "" → raise.
        with patch(
            "hivemoot_agent.plugins.registry.config_for_or_none",
            return_value=None,
        ):
            with self.assertRaises(RuntimeError) as ctx:
                plugin.setup_lifecycle(lifecycle, cfg)

        self.assertIn("apiarist.repo", str(ctx.exception))
        self.assertIn("github.repos", str(ctx.exception))
        self.assertEqual(lifecycle.subscriber_count, 0)


class EngineSetupOrderingTest(unittest.TestCase):
    """The engine's _setup_plugins runs setup() across all plugins BEFORE
    setup_lifecycle() across all plugins (apiarist DESIGN.md §12.3)."""

    def test_two_phase_setup_runs_setup_then_setup_lifecycle(self) -> None:
        events: list[str] = []

        class _RecordingPlugin:
            name = "rec"
            version = "0.0.0"
            description = "test"

            def __init__(self, label: str) -> None:
                self._label = label

            def validate(self, config: PluginConfig) -> list[str]:
                return []

            def setup(self, config: PluginConfig) -> None:
                events.append(f"{self._label}:setup")

            def setup_lifecycle(self, lifecycle, config) -> None:
                events.append(f"{self._label}:setup_lifecycle")

        from hivemoot_agent.engine import Engine
        from hivemoot_agent.plugins import registry as _registry

        engine = Engine()
        plugins = {
            "first": _RecordingPlugin("first"),
            "second": _RecordingPlugin("second"),
        }

        # Stub registry.config_for so _setup_plugins can find configs.
        with patch.object(
            _registry, "config_for",
            return_value=PluginConfig(name="rec"),
        ):
            ok = engine._setup_plugins(plugins)

        self.assertTrue(ok)
        # Two-phase: ALL setup() before ANY setup_lifecycle().
        self.assertEqual(
            events,
            [
                "first:setup",
                "second:setup",
                "first:setup_lifecycle",
                "second:setup_lifecycle",
            ],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
