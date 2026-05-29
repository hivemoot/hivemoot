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
    RoomSummary,
    SynthesisReadyRoom,
)
from hivemoot_agent.plugins_builtin.hivemoot.queen import gh


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


def _room_summary(
    *,
    room_id: str = "room-1",
    status: str = "awaiting_contributions",
    subject_ref: str = "owner/repo#42",
    opened_at: str = "2026-05-15T00:00:00Z",
    closed_at: str = "",
) -> RoomSummary:
    return RoomSummary(
        room_id=room_id,
        status=status,
        subject_type="pr_review",
        subject_ref=subject_ref,
        manager="queen-a",
        opened_at=opened_at,
        timing_config={"quiet_period_secs": 180},
        closed_at=closed_at,
    )


def _pr_snapshot(
    *,
    number: int = 42,
    state: str = "open",
    head_sha: str = "abc123",
    base_ref: str = "main",
    default_branch: str = "main",
) -> gh.PullRequestSnapshot:
    return gh.PullRequestSnapshot(
        number=number,
        title="Fix it",
        author="builder",
        state=state,
        draft=False,
        head_sha=head_sha,
        base_ref=base_ref,
        default_branch=default_branch,
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


def _claimed_with(participants: dict[str, object]) -> ClaimedSynthesis:
    """A claimed snapshot with caller-supplied participants.

    Simulates the read-then-claim race: the pre-claim participants read looks
    eligible, but the claim returns a different (ineligible) snapshot.
    """
    return ClaimedSynthesis(
        room_id="room-1",
        through_sequence=12,
        claim_ttl_secs=900,
        room={"subject_ref": "owner/repo#42"},
        participants=participants,
        contributions={},
    )


def _ready_events(
    *,
    head_sha: str = "abc123",
    timestamp: str = "2026-05-15T00:00:00Z",
) -> list[dict[str, object]]:
    return [
        {"seq": 1, "timestamp": timestamp, "event_type": "room_opened"},
        {
            "seq": 2,
            "timestamp": timestamp,
            "event_type": "subject_updated",
            "body": {
                "change_kind": "synchronize",
                "head_sha": head_sha,
            },
        },
        {
            "seq": 3,
            "timestamp": timestamp,
            "event_type": "contribution_submitted",
            "actor_role": "guard",
        },
    ]


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
            events_fn=MagicMock(return_value=_ready_events()),
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
            events_fn=MagicMock(return_value=_ready_events()),
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

    def test_skips_when_claim_snapshot_loses_resolved_participant(self) -> None:
        # Read-then-claim race: the pre-claim read is eligible, but by the time
        # the claim lands every participant has withdrawn or timed out, so the
        # claimed snapshot has no resolved participant. Synthesis must not fire.
        claim_fn = MagicMock(
            return_value=_claimed_with(
                {
                    "guard": {"status": "withdrew"},
                    "drone": {"status": "timed_out"},
                }
            )
        )
        get_head_sha = MagicMock(return_value="abc123")
        dispatcher = MagicMock()
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            list_ready_fn=MagicMock(return_value=[_room()]),
            participants_fn=MagicMock(
                return_value={"guard": {"status": "resolved"}}
            ),
            events_fn=MagicMock(return_value=_ready_events()),
            claim_fn=claim_fn,
            mint_token_fn=MagicMock(return_value="ghs_x"),
            get_head_sha_fn=get_head_sha,
            now_fn=lambda: datetime(2026, 5, 15, 0, 2, tzinfo=timezone.utc),
        )
        trigger._tick(dispatcher)
        claim_fn.assert_called_once()
        dispatcher.dispatch.assert_not_called()
        # The synthesis-time freshness gate captures the head before
        # claim, then bails before dispatch when the claimed snapshot
        # is no longer eligible.
        get_head_sha.assert_called_once()

    def test_skips_when_claim_snapshot_has_pending_participant(self) -> None:
        # Read-then-claim race: a participant re-RSVPs to pending between the
        # eligibility read and the claim, so the claimed snapshot is no longer
        # fully resolved. Synthesis must not fire.
        claim_fn = MagicMock(
            return_value=_claimed_with(
                {
                    "guard": {"status": "resolved"},
                    "drone": {"status": "pending"},
                }
            )
        )
        dispatcher = MagicMock()
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            list_ready_fn=MagicMock(return_value=[_room()]),
            participants_fn=MagicMock(
                return_value={"guard": {"status": "resolved"}}
            ),
            events_fn=MagicMock(return_value=_ready_events()),
            claim_fn=claim_fn,
            mint_token_fn=MagicMock(return_value="ghs_x"),
            get_head_sha_fn=MagicMock(return_value="abc123"),
            now_fn=lambda: datetime(2026, 5, 15, 0, 2, tzinfo=timezone.utc),
        )
        trigger._tick(dispatcher)
        claim_fn.assert_called_once()
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
                return_value=_ready_events(timestamp="2026-05-15T00:01:30Z"),
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
            events_fn=MagicMock(return_value=_ready_events()),
            claim_fn=MagicMock(return_value=_claimed()),
            mint_token_fn=MagicMock(return_value="ghs_x"),
            get_head_sha_fn=MagicMock(return_value="abc123"),
            now_fn=lambda: datetime(2026, 5, 15, 0, 2, tzinfo=timezone.utc),
        )
        trigger._tick(dispatcher)
        self.assertEqual(plugin.reserved, 1)
        self.assertEqual(plugin.released, 1)

    def test_synthesis_skips_and_updates_when_head_is_stale(self) -> None:
        append_update = MagicMock(return_value=3)
        claim_fn = MagicMock(return_value=_claimed())
        dispatcher = MagicMock()
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            list_ready_fn=MagicMock(return_value=[_room()]),
            participants_fn=MagicMock(return_value={"guard": {"status": "resolved"}}),
            events_fn=MagicMock(return_value=_ready_events(head_sha="old-head")),
            append_subject_updated_fn=append_update,
            claim_fn=claim_fn,
            mint_token_fn=MagicMock(return_value="ghs_x"),
            get_head_sha_fn=MagicMock(return_value="new-head"),
            now_fn=lambda: datetime(2026, 5, 15, 0, 2, tzinfo=timezone.utc),
        )

        trigger._tick(dispatcher)

        claim_fn.assert_not_called()
        dispatcher.dispatch.assert_not_called()
        append_update.assert_called_once_with(
            "https://api.example",
            "room-1",
            "bearer",
            change_kind="synchronize",
            head_sha="new-head",
            idempotency_key=(
                "local-queen.subject_updated.room-1.synchronize.new-head"
            ),
        )

    def test_synthesis_skips_when_resolved_contribution_predates_head(
        self,
    ) -> None:
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
                return_value=[
                    {
                        "seq": 3,
                        "timestamp": "2026-05-15T00:00:00Z",
                        "event_type": "contribution_submitted",
                        "actor_role": "guard",
                    },
                    {
                        "seq": 4,
                        "timestamp": "2026-05-15T00:00:10Z",
                        "event_type": "subject_updated",
                        "body": {
                            "change_kind": "synchronize",
                            "head_sha": "new-head",
                        },
                    },
                ],
            ),
            claim_fn=claim_fn,
            mint_token_fn=MagicMock(return_value="ghs_x"),
            get_head_sha_fn=MagicMock(return_value="new-head"),
            now_fn=lambda: datetime(2026, 5, 15, 0, 4, tzinfo=timezone.utc),
        )

        trigger._tick(dispatcher)

        claim_fn.assert_not_called()
        dispatcher.dispatch.assert_not_called()

    def test_synthesis_skips_when_latest_subject_update_closed(self) -> None:
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
                return_value=[
                    *_ready_events(head_sha="old-head"),
                    {
                        "seq": 4,
                        "timestamp": "2026-05-15T00:00:10Z",
                        "event_type": "subject_updated",
                        "body": {"change_kind": "closed"},
                    },
                ],
            ),
            claim_fn=claim_fn,
            mint_token_fn=MagicMock(return_value="ghs_x"),
            get_head_sha_fn=MagicMock(return_value="old-head"),
            now_fn=lambda: datetime(2026, 5, 15, 0, 4, tzinfo=timezone.utc),
        )

        trigger._tick(dispatcher)

        claim_fn.assert_not_called()
        dispatcher.dispatch.assert_not_called()

    def test_synthesis_skips_when_head_changes_during_claim(self) -> None:
        append_update = MagicMock(return_value=3)
        dispatcher = MagicMock()
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            list_ready_fn=MagicMock(return_value=[_room()]),
            participants_fn=MagicMock(return_value={"guard": {"status": "resolved"}}),
            events_fn=MagicMock(return_value=_ready_events(head_sha="old-head")),
            append_subject_updated_fn=append_update,
            claim_fn=MagicMock(return_value=_claimed()),
            mint_token_fn=MagicMock(return_value="ghs_x"),
            get_head_sha_fn=MagicMock(side_effect=["old-head", "new-head"]),
            now_fn=lambda: datetime(2026, 5, 15, 0, 2, tzinfo=timezone.utc),
        )

        trigger._tick(dispatcher)

        dispatcher.dispatch.assert_not_called()
        append_update.assert_called_once_with(
            "https://api.example",
            "room-1",
            "bearer",
            change_kind="synchronize",
            head_sha="new-head",
            idempotency_key=(
                "local-queen.subject_updated.room-1.synchronize.new-head"
            ),
        )

    def test_pr_discovery_creates_missing_review_room(self) -> None:
        dispatcher = MagicMock()
        append_update = MagicMock(return_value=2)
        create_room = MagicMock(
            return_value=type(
                "Created",
                (),
                {
                    "room_id": "created-room",
                    "subject_ref": "owner/repo#42",
                    "status": "awaiting_contributions",
                },
            )()
        )
        list_ready = MagicMock(return_value=[])
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            watched_repos=["owner/repo"],
            list_rooms_fn=MagicMock(return_value=[]),
            create_room_fn=create_room,
            append_subject_updated_fn=append_update,
            list_pull_requests_fn=MagicMock(return_value=[_pr_snapshot()]),
            list_ready_fn=list_ready,
            mint_token_fn=MagicMock(return_value="ghs_x"),
            now_fn=lambda: datetime(2026, 5, 15, 0, 2, tzinfo=timezone.utc),
        )

        trigger._tick(dispatcher)

        create_room.assert_called_once_with(
            "https://api.example",
            "bearer",
            subject_ref="owner/repo#42",
            manager="queen-a",
            quiet_period_secs=180,
            max_age_secs=3600,
            drop_threshold_secs=1200,
        )
        append_update.assert_called_once_with(
            "https://api.example",
            "created-room",
            "bearer",
            change_kind="synchronize",
            head_sha="abc123",
            idempotency_key=(
                "local-queen.subject_updated.created-room.synchronize.abc123"
            ),
        )
        self.assertEqual(trigger._known_pr_heads["owner/repo#42"], "abc123")
        list_ready.assert_called_once()
        dispatcher.dispatch.assert_not_called()

    def test_pr_discovery_creates_new_room_when_existing_room_expired(self) -> None:
        create_room = MagicMock(
            return_value=type(
                "Created",
                (),
                {
                    "room_id": "fresh-room",
                    "subject_ref": "owner/repo#42",
                    "status": "awaiting_contributions",
                },
            )()
        )
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            watched_repos=["owner/repo"],
            list_rooms_fn=MagicMock(
                return_value=[
                    _room_summary(room_id="expired-room", status="expired"),
                ],
            ),
            create_room_fn=create_room,
            list_pull_requests_fn=MagicMock(return_value=[_pr_snapshot()]),
            list_ready_fn=MagicMock(return_value=[]),
            mint_token_fn=MagicMock(return_value="ghs_x"),
            now_fn=lambda: datetime(2026, 5, 15, 0, 2, tzinfo=timezone.utc),
        )

        trigger._tick(MagicMock())

        create_room.assert_called_once()

    def test_pr_discovery_emits_subject_update_on_known_head_change(self) -> None:
        append_update = MagicMock(return_value=3)
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            watched_repos=["owner/repo"],
            list_rooms_fn=MagicMock(return_value=[_room_summary()]),
            append_subject_updated_fn=append_update,
            list_pull_requests_fn=MagicMock(
                return_value=[_pr_snapshot(head_sha="new-head")]
            ),
            list_ready_fn=MagicMock(return_value=[]),
            mint_token_fn=MagicMock(return_value="ghs_x"),
            now_fn=lambda: datetime(2026, 5, 15, 0, 2, tzinfo=timezone.utc),
        )
        trigger._known_pr_heads["owner/repo#42"] = "old-head"

        trigger._tick(MagicMock())

        append_update.assert_called_once_with(
            "https://api.example",
            "room-1",
            "bearer",
            change_kind="synchronize",
            head_sha="new-head",
            idempotency_key=(
                "local-queen.subject_updated.room-1.synchronize.new-head"
            ),
        )

    def test_pr_discovery_emits_head_update_from_room_event_after_restart(
        self,
    ) -> None:
        append_update = MagicMock(return_value=3)
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            watched_repos=["owner/repo"],
            list_rooms_fn=MagicMock(return_value=[_room_summary()]),
            events_fn=MagicMock(
                return_value=[
                    {
                        "seq": 2,
                        "event_type": "subject_updated",
                        "body": {
                            "change_kind": "synchronize",
                            "head_sha": "old-head",
                        },
                    },
                ],
            ),
            append_subject_updated_fn=append_update,
            list_pull_requests_fn=MagicMock(
                return_value=[_pr_snapshot(head_sha="new-head")]
            ),
            list_ready_fn=MagicMock(return_value=[]),
            mint_token_fn=MagicMock(return_value="ghs_x"),
            now_fn=lambda: datetime(2026, 5, 15, 0, 2, tzinfo=timezone.utc),
        )

        trigger._tick(MagicMock())

        append_update.assert_called_once_with(
            "https://api.example",
            "room-1",
            "bearer",
            change_kind="synchronize",
            head_sha="new-head",
            idempotency_key=(
                "local-queen.subject_updated.room-1.synchronize.new-head"
            ),
        )

    def test_pr_discovery_emits_head_update_for_existing_room_without_head(
        self,
    ) -> None:
        append_update = MagicMock(return_value=3)
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            watched_repos=["owner/repo"],
            list_rooms_fn=MagicMock(return_value=[_room_summary()]),
            events_fn=MagicMock(return_value=[]),
            append_subject_updated_fn=append_update,
            list_pull_requests_fn=MagicMock(
                return_value=[_pr_snapshot(head_sha="current-head")]
            ),
            list_ready_fn=MagicMock(return_value=[]),
            mint_token_fn=MagicMock(return_value="ghs_x"),
            now_fn=lambda: datetime(2026, 5, 15, 0, 2, tzinfo=timezone.utc),
        )

        trigger._tick(MagicMock())

        append_update.assert_called_once_with(
            "https://api.example",
            "room-1",
            "bearer",
            change_kind="synchronize",
            head_sha="current-head",
            idempotency_key=(
                "local-queen.subject_updated.room-1.synchronize.current-head"
            ),
        )

    def test_pr_discovery_prefers_active_room_for_duplicate_subject(self) -> None:
        append_update = MagicMock(return_value=3)
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            watched_repos=["owner/repo"],
            list_rooms_fn=MagicMock(
                return_value=[
                    _room_summary(
                        room_id="new-active",
                        status="awaiting_contributions",
                        opened_at="2026-05-15T00:02:00Z",
                    ),
                    _room_summary(
                        room_id="old-closed",
                        status="closed",
                        opened_at="2026-05-15T00:00:00Z",
                        closed_at="2026-05-15T00:01:00Z",
                    ),
                ],
            ),
            append_subject_updated_fn=append_update,
            list_pull_requests_fn=MagicMock(
                return_value=[_pr_snapshot(head_sha="new-head")]
            ),
            list_ready_fn=MagicMock(return_value=[]),
            mint_token_fn=MagicMock(return_value="ghs_x"),
            now_fn=lambda: datetime(2026, 5, 15, 0, 2, tzinfo=timezone.utc),
        )
        trigger._known_pr_heads["owner/repo#42"] = "old-head"

        trigger._tick(MagicMock())

        append_update.assert_called_once_with(
            "https://api.example",
            "new-active",
            "bearer",
            change_kind="synchronize",
            head_sha="new-head",
            idempotency_key=(
                "local-queen.subject_updated.new-active.synchronize.new-head"
            ),
        )

    def test_pr_discovery_emits_closed_update_for_known_open_pr(self) -> None:
        append_update = MagicMock(return_value=4)
        list_pull_requests = MagicMock(
            side_effect=[[], [_pr_snapshot(state="closed", head_sha="old-head")]]
        )
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            watched_repos=["owner/repo"],
            list_rooms_fn=MagicMock(return_value=[_room_summary()]),
            append_subject_updated_fn=append_update,
            list_pull_requests_fn=list_pull_requests,
            list_ready_fn=MagicMock(return_value=[]),
            mint_token_fn=MagicMock(return_value="ghs_x"),
            now_fn=lambda: datetime(2026, 5, 15, 0, 2, tzinfo=timezone.utc),
        )
        trigger._known_pr_states["owner/repo#42"] = "open"

        trigger._tick(MagicMock())

        self.assertEqual(list_pull_requests.call_args_list[0].kwargs["state"], "open")
        self.assertEqual(list_pull_requests.call_args_list[1].kwargs["state"], "closed")
        append_update.assert_called_once_with(
            "https://api.example",
            "room-1",
            "bearer",
            change_kind="closed",
            head_sha=None,
            idempotency_key="local-queen.subject_updated.room-1.closed.no-sha",
        )
        self.assertEqual(trigger._known_pr_states["owner/repo#42"], "closed")

    def test_pr_discovery_emits_closed_update_for_active_room_after_restart(
        self,
    ) -> None:
        append_update = MagicMock(return_value=4)
        list_pull_requests = MagicMock(
            side_effect=[[], [_pr_snapshot(state="closed", head_sha="old-head")]]
        )
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            watched_repos=["owner/repo"],
            list_rooms_fn=MagicMock(return_value=[_room_summary()]),
            append_subject_updated_fn=append_update,
            list_pull_requests_fn=list_pull_requests,
            list_ready_fn=MagicMock(return_value=[]),
            mint_token_fn=MagicMock(return_value="ghs_x"),
            now_fn=lambda: datetime(2026, 5, 15, 0, 2, tzinfo=timezone.utc),
        )

        trigger._tick(MagicMock())

        self.assertEqual(list_pull_requests.call_args_list[0].kwargs["state"], "open")
        self.assertEqual(list_pull_requests.call_args_list[1].kwargs["state"], "closed")
        append_update.assert_called_once_with(
            "https://api.example",
            "room-1",
            "bearer",
            change_kind="closed",
            head_sha=None,
            idempotency_key="local-queen.subject_updated.room-1.closed.no-sha",
        )
        self.assertEqual(trigger._known_pr_states["owner/repo#42"], "closed")

    def test_pr_discovery_respects_interval(self) -> None:
        list_rooms = MagicMock(return_value=[])
        now_values = [
            datetime(2026, 5, 15, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 5, 15, 0, 5, tzinfo=timezone.utc),
        ]
        trigger = LocalQueenSynthesisTrigger(
            SlotPlugin(),
            base_url="https://api.example",
            token_resolver=lambda: "bearer",
            agent_id="queen-a",
            watched_repos=["owner/repo"],
            pr_discovery_interval_secs=900,
            list_rooms_fn=list_rooms,
            list_pull_requests_fn=MagicMock(return_value=[]),
            list_ready_fn=MagicMock(return_value=[]),
            mint_token_fn=MagicMock(return_value="ghs_x"),
            now_fn=lambda: now_values.pop(0),
        )

        trigger._tick(MagicMock())
        trigger._tick(MagicMock())

        list_rooms.assert_called_once()

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
