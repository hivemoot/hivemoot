"""Tests for the hivemoot heartbeat trigger."""

from __future__ import annotations

import io
import os
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins.interfaces import PluginConfig
from hivemoot_agent.plugins_builtin.hivemoot.config import (
    HivemootConfig,
    HivemootHealthConfig,
)
from hivemoot_agent.plugins_builtin.hivemoot.health import api as health_api
from hivemoot_agent.plugins_builtin.hivemoot.health.trigger import (
    HealthHeartbeatTrigger,
)


_TOK_FILE = Path("/tmp/.hivemoot-health-test-token")


def _ensure_token_file() -> Path:
    if not _TOK_FILE.exists():
        _TOK_FILE.write_text("tok")
    return _TOK_FILE


def _mk_config(interval: int = 1) -> PluginConfig:
    return PluginConfig(
        name="hivemoot",
        settings={},
        typed=HivemootConfig(
            token_file=_ensure_token_file(),
            health=HivemootHealthConfig(
                enabled=True,
                base_url="https://h/",
                heartbeat_interval_secs=interval,
            ),
        ),
    )


def _mk_plugin() -> MagicMock:
    """Stand-in plugin that exposes the methods the trigger reaches."""
    plugin = MagicMock()
    plugin.resolved_agent_id.return_value = "builder"
    return plugin


class StartTests(unittest.TestCase):
    def test_idle_when_health_disabled(self) -> None:
        trig = HealthHeartbeatTrigger(_mk_plugin())
        disabled = PluginConfig(
            name="hivemoot",
            settings={},
            typed=HivemootConfig(
                token_file=_ensure_token_file(),
                health=HivemootHealthConfig(enabled=False),
            ),
        )
        with patch.object(health_api, "post_heartbeat") as hb:
            trig.start(disabled, MagicMock())
        hb.assert_not_called()

    def test_fires_initial_heartbeat_then_loops(self) -> None:
        trig = HealthHeartbeatTrigger(_mk_plugin())

        calls = {"n": 0}

        def fake_hb(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] >= 2:
                trig.stop()
            return True

        with patch.object(health_api, "post_heartbeat", fake_hb), \
                patch("sys.stderr", io.StringIO()):
            trig.start(_mk_config(interval=1), MagicMock())

        # One immediate + at least one periodic tick.
        self.assertGreaterEqual(calls["n"], 2)

    def test_idle_when_agent_id_missing(self) -> None:
        # Health is per-agent: AGENT_ID is the only identity dimension.
        # Missing it leaves the trigger idle (no repo dimension exists).
        plugin = MagicMock()
        plugin.resolved_agent_id.return_value = ""
        trig = HealthHeartbeatTrigger(plugin)

        with patch.object(health_api, "post_heartbeat") as hb, \
                patch("sys.stderr", io.StringIO()):
            trig.start(_mk_config(), MagicMock())

        hb.assert_not_called()

    def test_heartbeat_error_does_not_break_loop(self) -> None:
        trig = HealthHeartbeatTrigger(_mk_plugin())

        calls = {"n": 0}

        def flaky(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("boom")
            trig.stop()
            return True

        with patch.object(health_api, "post_heartbeat", flaky), \
                patch("sys.stderr", io.StringIO()):
            trig.start(_mk_config(interval=1), MagicMock())

        self.assertGreaterEqual(calls["n"], 2)

    def test_skips_initial_tick_when_stop_is_already_set(self) -> None:
        """Shutdown wedged between start() and the first tick must
        not spend an extra POST on the way out.  ``start()`` calls
        ``_stop_event.clear()`` up front (belt-and-braces against
        trigger re-use), so we can't test this by pre-setting the
        real event — replace it with a mock that reports ``is_set``
        True regardless, and whose ``wait`` also returns True so
        the post-clear loop exits immediately."""
        trig = HealthHeartbeatTrigger(_mk_plugin())
        trig._stop_event = MagicMock()
        trig._stop_event.is_set.return_value = True
        trig._stop_event.wait.return_value = True

        with patch.object(health_api, "post_heartbeat") as hb, \
                patch("sys.stderr", io.StringIO()):
            trig.start(_mk_config(), MagicMock())

        hb.assert_not_called()

    def test_bearer_is_refreshed_per_tick(self) -> None:
        """Regression: token rotation must take effect inside the
        heartbeat loop.  Rotate the file contents mid-loop and
        confirm the second tick picks up the new value rather
        than reusing the bearer cached at start()."""
        trig = HealthHeartbeatTrigger(_mk_plugin())

        tok_file = _TOK_FILE
        tok_file.write_text("tok-v1")

        seen_bearers: list[str] = []

        def capture(*_a, **kw):
            seen_bearers.append(_a[1])  # (base_url, bearer, ...)
            if len(seen_bearers) == 1:
                # Rotate the token file between the initial tick and
                # the next interval tick.
                tok_file.write_text("tok-v2")
            if len(seen_bearers) >= 2:
                trig.stop()
            return True

        with patch.object(health_api, "post_heartbeat", capture), \
                patch("sys.stderr", io.StringIO()):
            trig.start(_mk_config(interval=1), MagicMock())

        self.assertGreaterEqual(len(seen_bearers), 2)
        self.assertEqual(seen_bearers[0], "tok-v1")
        self.assertEqual(seen_bearers[1], "tok-v2")


if __name__ == "__main__":
    unittest.main(verbosity=2)
