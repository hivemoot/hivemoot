"""Tests for the hivemoot-identity no-op compatibility alias.

The plugin is a stub kept for one release so stale
``AGENT_PLUGINS=hivemoot-identity,...`` configs don't fail startup
with ``requested plugin 'hivemoot-identity' not found``.  Its only
observable behaviour is a one-time deprecation warning at setup time;
it contributes nothing to the merged system prompt, has no triggers,
and has no lifecycle effects.
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


def _cfg() -> PluginConfig:
    return PluginConfig(name="hivemoot-identity", settings={})


class NoopShimTests(unittest.TestCase):
    def test_validate_accepts_any_config(self) -> None:
        self.assertEqual(HivemootIdentityPlugin().validate(_cfg()), [])

    def test_no_triggers(self) -> None:
        self.assertEqual(HivemootIdentityPlugin().triggers(), [])

    def test_system_prompt_is_empty(self) -> None:
        """No content contribution — root + AGENT_IDENTITY_FILE cover
        what this plugin used to carry.  Emitting anything here would
        duplicate the root's security rules in the merged prompt."""
        self.assertEqual(
            HivemootIdentityPlugin().system_prompt(_cfg()),
            "",
        )

    def test_setup_emits_deprecation_warning_once(self) -> None:
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
        # Second call must NOT add another warning — one per process.
        self.assertEqual(total, first)


if __name__ == "__main__":
    unittest.main()
