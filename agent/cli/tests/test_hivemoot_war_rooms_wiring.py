"""Tests for the F.5 plugin wiring: triggers() instantiates the
war-room watcher when enabled, and on_job_finished dispatches to
the handler with the trigger's seen-cache eviction wired as the
post-failure callback.

Tests in this file exercise the HivemootPlugin's surface area
specific to war_rooms — config tests live in
test_hivemoot_config.py, handler tests in
test_hivemoot_war_rooms_handler.py, trigger tests in
test_hivemoot_war_rooms_trigger.py.
"""

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
    HivemootWarRoomsConfig,
)
from hivemoot_agent.plugins_builtin.hivemoot.war_rooms import (
    JOB_KIND_TRIAGE,
    WarRoomWatcherTrigger,
)


_TOKEN_FILE = Path("/tmp/.hivemoot-test-token")


def _ensure_token_file() -> Path:
    if not _TOKEN_FILE.exists():
        _TOKEN_FILE.write_text("test-token")
    return _TOKEN_FILE


def _mk_config(
    *,
    war_rooms: HivemootWarRoomsConfig | None = None,
) -> PluginConfig:
    typed = HivemootConfig(
        token_file=_ensure_token_file(),
        war_rooms=war_rooms or HivemootWarRoomsConfig(),
    )
    return PluginConfig(name="hivemoot", settings={}, typed=typed)


def _war_room_job(
    room_id: str = "01234567-89ab-4cde-9012-3456789abcde",
    sequence: int = 5,
) -> Job:
    return Job(
        session_key=f"war-room:{room_id}@{sequence}",
        prompt="ignored in tests",
        metadata={
            "job_kind": JOB_KIND_TRIAGE,
            "room_id": room_id,
            "current_sequence": sequence,
            "subject_type": "pr_review",
            "subject_ref": "owner/repo#42",
            "manager": "bot-queen",
            "status": "awaiting_contributions",
            "participants": {},
        },
    )


def _task_job() -> Job:
    return Job(
        session_key="task:abc",
        prompt="ignored",
        metadata={"task_id": "abc", "claim_token": "tk"},
    )


# ── triggers() wiring ────────────────────────────────────────────


class WarRoomTriggerWiringTests(unittest.TestCase):

    def test_disabled_by_default_no_trigger(self) -> None:
        plugin = HivemootPlugin()
        plugin._cfg = _mk_config().typed
        self.assertEqual(plugin.triggers(), [])
        self.assertIsNone(plugin._war_room_trigger)

    def test_enabled_instantiates_war_room_trigger(self) -> None:
        plugin = HivemootPlugin()
        plugin._cfg = _mk_config(
            war_rooms=HivemootWarRoomsConfig(enabled=True),
        ).typed
        triggers = plugin.triggers()
        self.assertEqual(len(triggers), 1)
        self.assertIsInstance(triggers[0], WarRoomWatcherTrigger)
        # Plugin caches the reference so on_job_finished can wire
        # the post-failure callback to evict_seen_key.
        self.assertIs(plugin._war_room_trigger, triggers[0])

    def test_trigger_constructed_with_config_values(self) -> None:
        plugin = HivemootPlugin()
        plugin._cfg = _mk_config(
            war_rooms=HivemootWarRoomsConfig(
                enabled=True,
                base_url="https://staging.hivemoot.dev",
                poll_interval_secs=30,
                seen_cache_max=500,
            ),
        ).typed
        triggers = plugin.triggers()
        trigger = triggers[0]
        self.assertEqual(trigger._base_url, "https://staging.hivemoot.dev")
        self.assertEqual(trigger._poll_interval_secs, 30)


# ── on_job_finished dispatch ─────────────────────────────────────


class OnJobFinishedDispatchTests(unittest.TestCase):

    def test_war_room_job_dispatched_when_enabled(self) -> None:
        plugin = HivemootPlugin()
        plugin._cfg = _mk_config(
            war_rooms=HivemootWarRoomsConfig(enabled=True),
        ).typed
        plugin.triggers()  # populate _war_room_trigger
        config = _mk_config(
            war_rooms=HivemootWarRoomsConfig(enabled=True),
        )

        with patch.object(
            plugin, "_war_room_on_job_finished"
        ) as bridge_mock:
            plugin.on_job_finished(_war_room_job(), AgentResult(0, ""), config)
        bridge_mock.assert_called_once()

    def test_war_room_job_NOT_dispatched_when_disabled(self) -> None:
        plugin = HivemootPlugin()
        plugin._cfg = _mk_config().typed
        config = _mk_config()

        with patch.object(
            plugin, "_war_room_on_job_finished"
        ) as bridge_mock:
            plugin.on_job_finished(_war_room_job(), AgentResult(0, ""), config)
        bridge_mock.assert_not_called()

    def test_task_job_NOT_routed_to_war_room_handler(self) -> None:
        # Even with war_rooms enabled, a task-shaped Job should NOT
        # invoke the war-room bridge — the discriminator filters by
        # job_kind=war_room_triage.
        plugin = HivemootPlugin()
        plugin._cfg = _mk_config(
            war_rooms=HivemootWarRoomsConfig(enabled=True),
        ).typed
        plugin.triggers()
        config = _mk_config(
            war_rooms=HivemootWarRoomsConfig(enabled=True),
        )

        with patch.object(
            plugin, "_war_room_on_job_finished"
        ) as bridge_mock:
            plugin.on_job_finished(_task_job(), AgentResult(0, ""), config)
        bridge_mock.assert_not_called()

    def test_handler_exception_swallowed_does_not_break_job_lifecycle(
        self,
    ) -> None:
        # If the war-room bridge raises, the engine's job lifecycle
        # must continue cleanly. Mirror the tasks/health pattern.
        plugin = HivemootPlugin()
        plugin._cfg = _mk_config(
            war_rooms=HivemootWarRoomsConfig(enabled=True),
        ).typed
        plugin.triggers()
        config = _mk_config(
            war_rooms=HivemootWarRoomsConfig(enabled=True),
        )

        with patch.object(
            plugin,
            "_war_room_on_job_finished",
            side_effect=RuntimeError("bridge boom"),
        ):
            # Must not raise.
            plugin.on_job_finished(_war_room_job(), AgentResult(0, ""), config)


# ── Trigger evict_seen_key (handler ↔ trigger feedback channel) ──


class EvictSeenKeyTests(unittest.TestCase):

    def test_evict_seen_key_removes_existing_entry(self) -> None:
        trigger = WarRoomWatcherTrigger(
            base_url="https://x", token_resolver=lambda: "tk"
        )
        # Manually seed the seen-cache to simulate a dispatch.
        trigger._seen.add("room-1@5")
        self.assertIn("room-1@5", trigger._seen._cache)
        trigger.evict_seen_key("room-1", 5)
        self.assertNotIn("room-1@5", trigger._seen._cache)

    def test_evict_seen_key_idempotent_on_missing_entry(self) -> None:
        # Eviction of a never-seen key must not raise.
        trigger = WarRoomWatcherTrigger(
            base_url="https://x", token_resolver=lambda: "tk"
        )
        trigger.evict_seen_key("never-dispatched", 0)


if __name__ == "__main__":
    unittest.main()
