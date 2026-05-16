"""Tests for local queen wiring in the consolidated hivemoot plugin."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins.interfaces import AgentResult, Job, PluginConfig
from hivemoot_agent.plugins_builtin.hivemoot import HivemootPlugin
from hivemoot_agent.plugins_builtin.hivemoot.config import (
    HivemootConfig,
    HivemootQueenConfig,
)
from hivemoot_agent.plugins_builtin.hivemoot.queen import (
    JOB_KIND_SYNTHESIS,
    LocalQueenSynthesisTrigger,
)


_TOKEN_FILE = Path("/tmp/.hivemoot-queen-test-token")


def _ensure_token_file() -> Path:
    if not _TOKEN_FILE.exists():
        _TOKEN_FILE.write_text("test-token")
    return _TOKEN_FILE


def _mk_config(*, queen: HivemootQueenConfig | None = None) -> PluginConfig:
    typed = HivemootConfig(
        token_file=_ensure_token_file(),
        queen=queen or HivemootQueenConfig(),
    )
    return PluginConfig(name="hivemoot", settings={}, typed=typed)


def _queen_job() -> Job:
    return Job(
        session_key="queen:room-1@12",
        prompt="ignored",
        metadata={
            "job_kind": JOB_KIND_SYNTHESIS,
            "room_id": "room-1",
            "subject_ref": "owner/repo#42",
            "sealed_through_sequence": 12,
            "queen_runner": "queen-a",
            "reviewed_head_sha": "abc123",
        },
    )


class QueenTriggerWiringTests(unittest.TestCase):
    def setUp(self) -> None:
        self._old_agent_id = os.environ.get("AGENT_ID")
        os.environ["AGENT_ID"] = "queen-a"

    def tearDown(self) -> None:
        if self._old_agent_id is None:
            os.environ.pop("AGENT_ID", None)
        else:
            os.environ["AGENT_ID"] = self._old_agent_id

    def test_disabled_by_default_no_trigger(self) -> None:
        plugin = HivemootPlugin()
        plugin._cfg = _mk_config().typed
        self.assertEqual(plugin.triggers(), [])
        self.assertIsNone(plugin._queen_trigger)

    def test_enabled_instantiates_queen_trigger(self) -> None:
        plugin = HivemootPlugin()
        plugin._cfg = _mk_config(
            queen=HivemootQueenConfig(enabled=True),
        ).typed
        triggers = plugin.triggers()
        self.assertEqual(len(triggers), 1)
        self.assertIsInstance(triggers[0], LocalQueenSynthesisTrigger)
        self.assertIs(plugin._queen_trigger, triggers[0])

    def test_trigger_constructed_with_config_values(self) -> None:
        plugin = HivemootPlugin()
        plugin._cfg = _mk_config(
            queen=HivemootQueenConfig(
                enabled=True,
                base_url="https://staging.example",
                poll_interval_secs=30,
                synthesis_ready_limit=5,
                enable_squash_merge=True,
                merge_report_queue_file="/tmp/queen-reports.json",
            ),
        ).typed
        trigger = plugin.triggers()[0]
        self.assertEqual(trigger._base_url, "https://staging.example")
        self.assertEqual(trigger._poll_interval_secs, 30)
        self.assertEqual(trigger._ready_limit, 5)
        self.assertTrue(trigger._enable_squash_merge)
        self.assertEqual(
            trigger._merge_report_queue_file,
            "/tmp/queen-reports.json",
        )

    def test_validate_accepts_squash_merge_flag(self) -> None:
        plugin = HivemootPlugin()
        config = _mk_config(
            queen=HivemootQueenConfig(
                enabled=True,
                enable_squash_merge=True,
            ),
        )
        errors = plugin.validate(config)
        self.assertEqual(errors, [])


class QueenOnFinishedWiringTests(unittest.TestCase):
    def setUp(self) -> None:
        self._old_agent_id = os.environ.get("AGENT_ID")
        os.environ["AGENT_ID"] = "queen-a"

    def tearDown(self) -> None:
        if self._old_agent_id is None:
            os.environ.pop("AGENT_ID", None)
        else:
            os.environ["AGENT_ID"] = self._old_agent_id

    def test_queen_job_dispatched_when_enabled(self) -> None:
        plugin = HivemootPlugin()
        plugin._cfg = _mk_config(
            queen=HivemootQueenConfig(enabled=True),
        ).typed
        config = _mk_config(
            queen=HivemootQueenConfig(enabled=True),
        )

        with patch.object(plugin, "_queen_on_job_finished") as bridge_mock:
            plugin.on_job_finished(_queen_job(), AgentResult(0, ""), config)
        bridge_mock.assert_called_once()

    def test_queen_job_not_dispatched_when_disabled(self) -> None:
        plugin = HivemootPlugin()
        plugin._cfg = _mk_config().typed
        with patch.object(plugin, "_queen_on_job_finished") as bridge_mock:
            plugin.on_job_finished(_queen_job(), AgentResult(0, ""), _mk_config())
        bridge_mock.assert_not_called()

    def test_queen_slot_released_when_bridge_raises(self) -> None:
        plugin = HivemootPlugin()
        plugin._cfg = _mk_config(
            queen=HivemootQueenConfig(enabled=True),
        ).typed
        plugin.reserve_queen_slot()
        self.assertFalse(plugin._queen_inflight.is_set())
        config = _mk_config(
            queen=HivemootQueenConfig(enabled=True),
        )
        with patch.object(
            plugin,
            "_queen_on_job_finished",
            side_effect=RuntimeError("boom"),
        ):
            plugin.on_job_finished(_queen_job(), AgentResult(0, ""), config)
        self.assertTrue(plugin._queen_inflight.is_set())

    def test_completion_uses_claimed_queen_identity_after_env_change(self) -> None:
        plugin = HivemootPlugin()
        plugin._cfg = _mk_config(
            queen=HivemootQueenConfig(enabled=True),
        ).typed
        config = _mk_config(
            queen=HivemootQueenConfig(enabled=True),
        )
        os.environ.pop("AGENT_ID", None)

        with (
            patch(
                "hivemoot_agent.plugins_builtin.hivemoot.auth.resolve_agent_token",
                return_value="bearer",
            ),
            patch(
                "hivemoot_agent.plugins_builtin.hivemoot.tasks.result_extractor.extract_result",
                return_value=(
                    '{"verdict":"APPROVE","recommended_action":"comment"}'
                ),
            ),
            patch(
                "hivemoot_agent.plugins_builtin.hivemoot.queen.handle_queen_job_finished",
            ) as finished,
        ):
            plugin._queen_on_job_finished(
                _queen_job(),
                AgentResult(0, ""),
                config,
            )

        self.assertEqual(finished.call_args.kwargs["queen_runner"], "queen-a")
        self.assertEqual(finished.call_args.kwargs["agent_id"], "queen-a")


if __name__ == "__main__":
    unittest.main(verbosity=2)
