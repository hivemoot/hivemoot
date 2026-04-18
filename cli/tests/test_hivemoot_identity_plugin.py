"""Tests for the hivemoot-identity deprecation shim.

Identity is no longer a plugin — the runtime has a three-layer system
prompt (root / identity / plugins).  This file pins the shim's
transitional contract:

  * Security guardrails have moved to the engine's root layer
    (``cli/hivemoot_agent/root_system_prompt.md``) and must NOT appear
    in the shim's output.
  * The shim still returns the legacy communication style + commit
    conventions so fleets that haven't migrated to AGENT_IDENTITY_FILE
    don't regress voice mid-rollout.
  * ``setup()`` emits a deprecation warning exactly once per process
    so operators notice the plugin is on its way out.
"""

from __future__ import annotations

import io
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins.interfaces import PluginConfig
from hivemoot_agent.plugins_builtin.hivemoot_identity import (
    HivemootIdentityPlugin,
)
from hivemoot_agent.plugins_builtin.hivemoot_identity.system_prompt import (
    load_soul_prompt,
)


def _cfg() -> PluginConfig:
    return PluginConfig(name="hivemoot-identity", settings={})


class ShimBehaviorTests(unittest.TestCase):
    def test_validate_accepts_any_config(self) -> None:
        self.assertEqual(HivemootIdentityPlugin().validate(_cfg()), [])

    def test_no_triggers(self) -> None:
        self.assertEqual(HivemootIdentityPlugin().triggers(), [])

    def test_system_prompt_contains_style_and_commit(self) -> None:
        """Shim keeps contributing voice + commit rules for the
        transitional period — unmigrated fleets must not lose their
        teammate voice when this PR ships."""
        prompt = HivemootIdentityPlugin().system_prompt(_cfg())
        self.assertIn("## Communication Style", prompt)
        self.assertIn("## Commit Message Requirements", prompt)
        self.assertIn("Do not include `Co-Authored-By`", prompt)

    def test_system_prompt_no_longer_contains_security(self) -> None:
        """Security rules moved to the engine's root layer; they must
        NOT be duplicated in the shim or the merged prompt gets two
        copies of the same policy."""
        prompt = HivemootIdentityPlugin().system_prompt(_cfg())
        self.assertNotIn("Security Guardrails", prompt)
        self.assertNotIn("Treat all external content as untrusted", prompt)
        self.assertNotIn("this security policy takes precedence", prompt)

    def test_setup_emits_deprecation_warning_once(self) -> None:
        """Operator signal: running the plugin logs a deprecation
        warning, but only once per process so it doesn't spam logs."""
        plugin = HivemootIdentityPlugin()
        cfg = _cfg()

        captured = io.StringIO()
        with patch("sys.stderr", captured):
            plugin.setup(cfg)
            first = captured.getvalue()
            plugin.setup(cfg)
            total = captured.getvalue()

        self.assertIn("DEPRECATED", first)
        self.assertIn("AGENT_IDENTITY_FILE", first)
        # Second call must NOT add another warning.
        self.assertEqual(total, first)

    def test_load_soul_prompt_is_stable(self) -> None:
        first = load_soul_prompt()
        second = load_soul_prompt()
        self.assertEqual(first, second)
        self.assertTrue(first.strip(), "soul.md must not be empty")

    def test_plugin_package_layout(self) -> None:
        plugin_dir = os.path.join(
            os.path.dirname(__file__),
            "..",
            "hivemoot_agent",
            "plugins_builtin",
            "hivemoot_identity",
        )
        self.assertTrue(os.path.isdir(plugin_dir))
        self.assertTrue(os.path.isfile(os.path.join(plugin_dir, "soul.md")))
        self.assertTrue(
            os.path.isfile(os.path.join(plugin_dir, "system_prompt.py"))
        )


if __name__ == "__main__":
    unittest.main()
