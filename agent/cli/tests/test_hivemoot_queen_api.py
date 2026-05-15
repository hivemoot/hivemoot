"""Tests for the local queen API client."""

from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.hivemoot.queen import api as q_api


class QueenApiTests(unittest.TestCase):
    def test_list_synthesis_ready_rooms_parses_room_core(self) -> None:
        with patch.object(
            q_api,
            "get_json",
            return_value=(
                200,
                {
                    "rooms": [
                        {
                            "roomId": "room-1",
                            "status": "awaiting_contributions",
                            "subject_type": "pr_review",
                            "subject_ref": "owner/repo#42",
                            "manager": "bot-queen",
                            "opened_at": "2026-05-15T00:00:00Z",
                            "timing_config": {"quiet_period_secs": 60},
                        },
                    ],
                    "count": 1,
                },
                b"",
            ),
        ) as get_mock:
            rooms = q_api.list_synthesis_ready_rooms(
                "https://api.example", "bearer", limit=7,
            )
        get_mock.assert_called_once_with(
            "https://api.example/api/rooms/synthesis-ready?limit=7",
            "bearer",
            timeout=10,
        )
        self.assertEqual(len(rooms), 1)
        self.assertEqual(rooms[0].room_id, "room-1")
        self.assertEqual(rooms[0].subject_ref, "owner/repo#42")
        self.assertEqual(rooms[0].timing_config["quiet_period_secs"], 60)

    def test_claim_synthesis_maps_conflict(self) -> None:
        with patch.object(
            q_api,
            "post_json",
            return_value=(
                409,
                {"code": "claim_already_held"},
                b'{"code":"claim_already_held"}',
            ),
        ):
            with self.assertRaises(q_api.QueenAPIConflictError) as ctx:
                q_api.claim_synthesis(
                    "https://api.example",
                    "room-1",
                    "bearer",
                    queen_runner="runner",
                    claim_ttl_secs=900,
                )
        self.assertEqual(ctx.exception.code, "claim_already_held")

    def test_resolve_action_payload_and_result(self) -> None:
        with patch.object(
            q_api,
            "post_json",
            return_value=(
                200,
                {
                    "permittedAction": "comment",
                    "clampedVerdict": "APPROVE",
                    "downgradeReason": None,
                    "reviewedHeadSha": "abc",
                    "currentHeadSha": "abc",
                    "floorOverridden": False,
                    "auditId": "123-0",
                },
                b"",
            ),
        ) as post_mock:
            result = q_api.resolve_action(
                "https://api.example",
                "room-1",
                "bearer",
                queen_runner="runner",
                verdict="APPROVE",
                reasoning="ok",
                recommended_action="comment",
                reviewed_head_sha="abc",
                sealed_through_sequence=12,
            )

        args = post_mock.call_args[0]
        self.assertEqual(
            args[0],
            "https://api.example/api/rooms/room-1/resolve-action",
        )
        self.assertEqual(args[1]["queenRunner"], "runner")
        self.assertEqual(args[1]["derivedVerdict"]["verdict"], "APPROVE")
        self.assertEqual(args[1]["sealedThroughSequence"], 12)
        self.assertEqual(result.audit_id, "123-0")
        self.assertEqual(result.permitted_action, "comment")

    def test_seal_decision_sends_comment_url(self) -> None:
        with patch.object(
            q_api,
            "post_json",
            return_value=(
                200,
                {
                    "finalState": "closed",
                    "closedSequence": 13,
                    "auditId": "123-0",
                },
                b"",
            ),
        ) as post_mock:
            result = q_api.seal_decision(
                "https://api.example",
                "room-1",
                "bearer",
                queen_runner="runner",
                audit_id="123-0",
                sealed_through_sequence=12,
                decision={
                    "synthesized_at": "2026-05-15T00:00:00Z",
                    "synthesis_runner": "runner",
                    "content": "ok",
                    "sequence_closed": 12,
                },
                comment_url="https://github.com/o/r/pull/1#issuecomment-2",
            )
        body = post_mock.call_args[0][1]
        self.assertEqual(body["finalState"], "closed")
        self.assertEqual(body["commentUrl"], "https://github.com/o/r/pull/1#issuecomment-2")
        self.assertEqual(result.closed_sequence, 13)


if __name__ == "__main__":
    unittest.main(verbosity=2)
