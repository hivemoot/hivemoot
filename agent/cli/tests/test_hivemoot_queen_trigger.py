"""Tests for the local queen synthesis trigger."""

from __future__ import annotations

import os
import sys
import threading
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.hivemoot.queen import (
    ClaimedSynthesis,
    ConfirmMergeResult,
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


def _pending_room() -> SynthesisReadyRoom:
    return SynthesisReadyRoom(
        room_id="room-2",
        status="decided_pending_action",
        subject_type="pr_review",
        subject_ref="owner/repo#43",
        manager="bot-queen",
        opened_at="2026-05-15T00:00:00Z",
        timing_config={},
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

    def test_dispatch_prompt_allows_squash_merge_when_enabled(self) -> None:
        plugin = SlotPlugin()
        dispatcher = MagicMock()
        dispatcher.dispatch.return_value = True

        trigger = LocalQueenSynthesisTrigger(
            plugin,
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            enable_squash_merge=True,
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

        job = dispatcher.dispatch.call_args[0][0]
        self.assertIn('"recommended_action": "squash-merge"', job.prompt)
        self.assertNotIn("comment-close only", job.prompt)

    def test_skips_pending_participant_before_claim(self) -> None:
        claim_fn = MagicMock(return_value=_claimed())
        dispatcher = MagicMock()
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
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

    def test_skips_room_with_no_participants_before_claim(self) -> None:
        claim_fn = MagicMock(return_value=_claimed())
        dispatcher = MagicMock()
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            list_ready_fn=MagicMock(return_value=[_room()]),
            participants_fn=MagicMock(return_value={}),
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

    def test_skips_room_without_resolved_participant_before_claim(self) -> None:
        claim_fn = MagicMock(return_value=_claimed())
        dispatcher = MagicMock()
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            list_ready_fn=MagicMock(return_value=[_room()]),
            participants_fn=MagicMock(
                return_value={
                    "guard": {"status": "withdrew"},
                    "drone": {"status": "timed_out"},
                }
            ),
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

    def test_confirmed_pending_merge_runs_squash_and_reports_success(self) -> None:
        dispatcher = MagicMock()
        list_ready = MagicMock(return_value=[_room()])
        report = MagicMock()
        confirm = MagicMock(
            return_value=ConfirmMergeResult(
                decision_outcome="merge_approved",
                decision_outcome_reason=None,
                github_merge_status="pending",
                merge_attempt_id="queen-a:room-2:abc123deadbe",
                closed_sequence=9,
            ),
        )
        squash_merge = MagicMock(return_value="feedface")
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            enable_squash_merge=True,
            list_ready_fn=list_ready,
            list_pending_fn=MagicMock(return_value=[_pending_room()]),
            confirm_merge_fn=confirm,
            report_merge_result_fn=report,
            mint_token_fn=MagicMock(return_value="ghs_x"),
            get_head_sha_fn=MagicMock(return_value="abc123deadbeef"),
            squash_merge_fn=squash_merge,
        )

        trigger._tick(dispatcher)

        dispatcher.dispatch.assert_not_called()
        list_ready.assert_not_called()
        confirm.assert_called_once_with(
            "https://api.example",
            "room-2",
            "bearer",
            queen_runner="queen-a",
            merge_attempt_id="queen-a:room-2:abc123deadbe",
            current_head_sha="abc123deadbeef",
        )
        squash_merge.assert_called_once()
        squash_pr = squash_merge.call_args.args[0]
        self.assertEqual(squash_pr.full_repo, "owner/repo")
        self.assertEqual(squash_pr.number, 43)
        self.assertEqual(
            squash_merge.call_args.kwargs["expected_head_sha"],
            "abc123deadbeef",
        )
        self.assertEqual(squash_merge.call_args.kwargs["token"], "ghs_x")
        self.assertEqual(squash_merge.call_args.kwargs["timeout_secs"], 30)
        report.assert_called_once_with(
            "https://api.example",
            "room-2",
            "bearer",
            queen_runner="queen-a",
            merge_attempt_id="queen-a:room-2:abc123deadbe",
            github_merge_status="succeeded",
            merge_commit_oid="feedface",
        )

    def test_successful_merge_report_failure_is_persisted_and_retried(self) -> None:
        dispatcher = MagicMock()
        report = MagicMock(side_effect=[RuntimeError("api down"), None])

        with tempfile.TemporaryDirectory() as tmpdir:
            queue_file = os.path.join(tmpdir, "merge-reports.json")
            trigger = LocalQueenSynthesisTrigger(
                SlotPlugin(),
                base_url="https://api.example",
                token_resolver=lambda: "bearer",
                agent_id="queen-a",
                enable_squash_merge=True,
                merge_report_queue_file=queue_file,
                list_ready_fn=MagicMock(return_value=[_room()]),
                list_pending_fn=MagicMock(return_value=[_pending_room()]),
                confirm_merge_fn=MagicMock(
                    return_value=ConfirmMergeResult(
                        decision_outcome="merge_approved",
                        decision_outcome_reason=None,
                        github_merge_status="pending",
                        merge_attempt_id="queen-a:room-2:abc123deadbe",
                        closed_sequence=9,
                    ),
                ),
                report_merge_result_fn=report,
                mint_token_fn=MagicMock(return_value="ghs_x"),
                get_head_sha_fn=MagicMock(return_value="abc123deadbeef"),
                squash_merge_fn=MagicMock(return_value="feedface"),
            )

            trigger._tick(dispatcher)
            self.assertTrue(os.path.exists(queue_file))

            retry_trigger = LocalQueenSynthesisTrigger(
                SlotPlugin(),
                base_url="https://api.example",
                token_resolver=lambda: "bearer",
                agent_id="queen-a",
                enable_squash_merge=True,
                merge_report_queue_file=queue_file,
                list_ready_fn=MagicMock(return_value=[]),
                list_pending_fn=MagicMock(return_value=[]),
                report_merge_result_fn=report,
            )

            retry_trigger._tick(dispatcher)

        self.assertEqual(report.call_count, 2)
        self.assertEqual(
            report.call_args.kwargs["merge_attempt_id"],
            "queen-a:room-2:abc123deadbe",
        )
        self.assertEqual(report.call_args.kwargs["merge_commit_oid"], "feedface")

    def test_dirty_success_report_queue_blocks_second_merge_attempt(self) -> None:
        dispatcher = MagicMock()
        report = MagicMock(
            side_effect=[RuntimeError("api down"), RuntimeError("still down")]
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            queue_file = os.path.join(tmpdir, "merge-reports.json")
            first_squash = MagicMock(return_value="feedface")
            trigger = LocalQueenSynthesisTrigger(
                SlotPlugin(),
                base_url="https://api.example",
                token_resolver=lambda: "bearer",
                agent_id="queen-a",
                enable_squash_merge=True,
                merge_report_queue_file=queue_file,
                list_ready_fn=MagicMock(return_value=[_room()]),
                list_pending_fn=MagicMock(return_value=[_pending_room()]),
                confirm_merge_fn=MagicMock(
                    return_value=ConfirmMergeResult(
                        decision_outcome="merge_approved",
                        decision_outcome_reason=None,
                        github_merge_status="pending",
                        merge_attempt_id="queen-a:room-2:abc123deadbe",
                        closed_sequence=9,
                    ),
                ),
                report_merge_result_fn=report,
                mint_token_fn=MagicMock(return_value="ghs_x"),
                get_head_sha_fn=MagicMock(return_value="abc123deadbeef"),
                squash_merge_fn=first_squash,
            )

            trigger._tick(dispatcher)
            first_squash.assert_called_once()

            list_pending = MagicMock(return_value=[_pending_room()])
            confirm = MagicMock()
            second_squash = MagicMock()
            retry_trigger = LocalQueenSynthesisTrigger(
                SlotPlugin(),
                base_url="https://api.example",
                token_resolver=lambda: "bearer",
                agent_id="queen-a",
                enable_squash_merge=True,
                merge_report_queue_file=queue_file,
                list_ready_fn=MagicMock(return_value=[_room()]),
                list_pending_fn=list_pending,
                confirm_merge_fn=confirm,
                report_merge_result_fn=report,
                squash_merge_fn=second_squash,
            )

            retry_trigger._tick(dispatcher)

        self.assertEqual(report.call_count, 2)
        list_pending.assert_not_called()
        confirm.assert_not_called()
        second_squash.assert_not_called()

    def test_pending_merge_downgrade_does_not_run_gh_merge(self) -> None:
        squash_merge = MagicMock()
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            enable_squash_merge=True,
            list_ready_fn=MagicMock(return_value=[_room()]),
            list_pending_fn=MagicMock(return_value=[_pending_room()]),
            confirm_merge_fn=MagicMock(
                return_value=ConfirmMergeResult(
                    decision_outcome="merge_downgraded",
                    decision_outcome_reason="head_sha_drift",
                    github_merge_status=None,
                    merge_attempt_id="queen-a:room-2:abc123",
                    closed_sequence=9,
                ),
            ),
            mint_token_fn=MagicMock(return_value="ghs_x"),
            get_head_sha_fn=MagicMock(return_value="abc123deadbeef"),
            squash_merge_fn=squash_merge,
        )

        trigger._tick(MagicMock())

        squash_merge.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
