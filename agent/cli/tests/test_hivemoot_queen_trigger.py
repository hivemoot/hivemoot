"""Tests for the local queen synthesis trigger."""

from __future__ import annotations

import os
import sys
import threading
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.hivemoot.queen import (
    ClaimedSynthesis,
    LocalQueenSynthesisTrigger,
    SynthesisReadyRoom,
)


class SlotPlugin:
    def __init__(self) -> None:
        self.event = threading.Event()
        self.event.set()
        self.reserved = 0
        self.released = 0

    def wait_queen_slot(self, stop_event, timeout=1.0):
        del stop_event, timeout
        return self.event.is_set()

    def reserve_queen_slot(self):
        self.reserved += 1
        self.event.clear()

    def release_queen_slot(self):
        self.released += 1
        self.event.set()


def _room() -> SynthesisReadyRoom:
    return SynthesisReadyRoom(
        room_id="room-1",
        status="awaiting_contributions",
        subject_type="pr_review",
        subject_ref="owner/repo#42",
        manager="bot-queen",
        opened_at="2026-05-15T00:00:00Z",
        timing_config={"quiet_period_secs": 60},
    )


def _claimed() -> ClaimedSynthesis:
    return ClaimedSynthesis(
        room_id="room-1",
        through_sequence=12,
        claim_ttl_secs=900,
        room={"subject_ref": "owner/repo#42"},
        participants={"guard": {"status": "resolved"}},
        contributions={"guard": {"raw_md": "lgtm"}},
    )


class LocalQueenTriggerTests(unittest.TestCase):
    def test_dispatches_claimed_ready_room_with_head_sha(self) -> None:
        plugin = SlotPlugin()
        dispatcher = MagicMock()
        dispatcher.dispatch.return_value = True

        trigger = LocalQueenSynthesisTrigger(
            plugin,
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            runner_id="queen-a",
            agent_id="queen-a",
            list_ready_fn=MagicMock(return_value=[_room()]),
            participants_fn=MagicMock(return_value={"guard": {"status": "resolved"}}),
            events_fn=MagicMock(
                return_value=[{"timestamp": "2026-05-15T00:00:00Z"}],
            ),
            claim_fn=MagicMock(return_value=_claimed()),
            mint_token_fn=MagicMock(return_value="ghs_x"),
            get_head_sha_fn=MagicMock(return_value="abc123"),
            now_fn=lambda: datetime(2026, 5, 15, 0, 2, tzinfo=timezone.utc),
        )

        trigger._tick(dispatcher)

        dispatcher.dispatch.assert_called_once()
        job = dispatcher.dispatch.call_args[0][0]
        self.assertEqual(job.session_key, "queen:room-1@12")
        self.assertEqual(job.metadata["job_kind"], "queen_synthesis")
        self.assertEqual(job.metadata["reviewed_head_sha"], "abc123")
        self.assertEqual(job.metadata["coalesce_key"], "queen:room-1")
        self.assertIn("comment-close only", job.prompt)
        self.assertEqual(plugin.reserved, 1)
        self.assertEqual(plugin.released, 0)

    def test_skips_pending_participant_before_claim(self) -> None:
        claim_fn = MagicMock(return_value=_claimed())
        dispatcher = MagicMock()
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            runner_id="queen-a",
            agent_id="queen-a",
            list_ready_fn=MagicMock(return_value=[_room()]),
            participants_fn=MagicMock(return_value={"guard": {"status": "pending"}}),
            events_fn=MagicMock(
                return_value=[{"timestamp": "2026-05-15T00:00:00Z"}],
            ),
            claim_fn=claim_fn,
            mint_token_fn=MagicMock(return_value="ghs_x"),
            get_head_sha_fn=MagicMock(return_value="abc123"),
            now_fn=lambda: datetime(2026, 5, 15, 0, 2, tzinfo=timezone.utc),
        )
        trigger._tick(dispatcher)
        claim_fn.assert_not_called()
        dispatcher.dispatch.assert_not_called()

    def test_skips_room_until_quiet_period_elapsed(self) -> None:
        claim_fn = MagicMock(return_value=_claimed())
        dispatcher = MagicMock()
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            runner_id="queen-a",
            agent_id="queen-a",
            list_ready_fn=MagicMock(return_value=[_room()]),
            participants_fn=MagicMock(return_value={"guard": {"status": "resolved"}}),
            events_fn=MagicMock(
                return_value=[{"timestamp": "2026-05-15T00:01:30Z"}],
            ),
            claim_fn=claim_fn,
            mint_token_fn=MagicMock(return_value="ghs_x"),
            get_head_sha_fn=MagicMock(return_value="abc123"),
            now_fn=lambda: datetime(2026, 5, 15, 0, 2, tzinfo=timezone.utc),
        )
        trigger._tick(dispatcher)
        claim_fn.assert_not_called()
        dispatcher.dispatch.assert_not_called()

    def test_dispatch_refusal_releases_slot(self) -> None:
        plugin = SlotPlugin()
        dispatcher = MagicMock()
        dispatcher.dispatch.return_value = False
        trigger = LocalQueenSynthesisTrigger(
            plugin,
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            runner_id="queen-a",
            agent_id="queen-a",
            list_ready_fn=MagicMock(return_value=[_room()]),
            participants_fn=MagicMock(return_value={"guard": {"status": "resolved"}}),
            events_fn=MagicMock(
                return_value=[{"timestamp": "2026-05-15T00:00:00Z"}],
            ),
            claim_fn=MagicMock(return_value=_claimed()),
            mint_token_fn=MagicMock(return_value="ghs_x"),
            get_head_sha_fn=MagicMock(return_value="abc123"),
            now_fn=lambda: datetime(2026, 5, 15, 0, 2, tzinfo=timezone.utc),
        )
        trigger._tick(dispatcher)
        self.assertEqual(plugin.reserved, 1)
        self.assertEqual(plugin.released, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
