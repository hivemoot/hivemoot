"""Tests for the war-rooms RoomLifecycleReporter (PR C of the
JOB_LIFECYCLE_UNIFICATION RFC) and the heartbeat_room_participant
API helper.

What's covered here:
* heartbeat_room_participant — happy path, benign no-op (skipped),
  RoomStateRaceError mapping for status_precondition_failed +
  owner_conflict, generic 5xx → RuntimeError, malformed body.
* RoomLifecycleReporter.on_start — early /present sets _presented;
  RoomStateRaceError leaves it False and logs at info; generic
  failure leaves it False and logs at warn.
* RoomLifecycleReporter.on_heartbeat — guarded by _presented;
  benign skipped → clears _presented; race → clears _presented;
  transient → keeps _presented True (next tick retries).
* on_finish / on_failure — explicit no-ops (handler.py still owns
  the post sequence). Pinned so a future PR migrating those flows
  doesn't silently break the contract.

Also exercises the matcher-disjointness positive coverage that
guard flagged in the PR #614 review: in the multiplexer, the
war-rooms matcher only fires for `job_kind=war_room_triage` jobs.
"""

from __future__ import annotations

import os
import sys
import unittest
from typing import Any
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins.interfaces import AgentResult, Job
from hivemoot_agent.plugins_builtin.hivemoot.war_rooms import api as wr_api
from hivemoot_agent.plugins_builtin.hivemoot.war_rooms.lifecycle import (
    RoomLifecycleReporter,
    build_room_reporter,
    is_war_room_job_for_lifecycle,
)


def _job(**metadata: Any) -> Job:
    md: dict[str, Any] = {
        "job_kind": "war_room_triage",
        "room_id": "room-A",
        "current_sequence": 7,
        "subject_ref": "hivemoot/hivemoot#999",
    }
    md.update(metadata)
    return Job(session_key="war-room:room-A@7", prompt="p", metadata=md)


# ── heartbeat_room_participant ──────────────────────────────────────


class HeartbeatRoomParticipantTests(unittest.TestCase):
    """Pin the wire-shape contract: returns ISO string on apply,
    None on benign no-op, raises RoomStateRaceError on race-409s,
    RuntimeError on anything else."""

    def _patch_post(self, status: int, body: dict[str, Any] | None):
        # `post_json` returns (status, parsed, raw_bytes). Tests want
        # the raw bytes for the 200-len fast-path; fake them out.
        import json
        raw = json.dumps(body or {}).encode("utf-8")
        return patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.api.post_json",
            return_value=(status, body, raw),
        )

    def test_happy_path_returns_iso_timestamp(self):
        with self._patch_post(200, {"rsvpAt": "2026-05-06T03:00:00.000Z"}):
            rsvp = wr_api.heartbeat_room_participant(
                base_url="https://www.hivemoot.dev",
                room_id="room-A",
                bearer="hmt_test",
            )
        self.assertEqual(rsvp, "2026-05-06T03:00:00.000Z")

    def test_skipped_non_pending_returns_none(self):
        # Storage layer's Lua returns null when participant is
        # already withdrew/resolved/timed_out. Route surfaces that
        # as { skipped: "non_pending" }. Caller treats as benign.
        with self._patch_post(200, {"skipped": "non_pending"}):
            rsvp = wr_api.heartbeat_room_participant(
                base_url="https://www.hivemoot.dev",
                room_id="room-A",
                bearer="hmt_test",
            )
        self.assertIsNone(rsvp)

    def test_status_precondition_failed_maps_to_race(self):
        # Room left awaiting_contributions — closed, deciding, etc.
        with self._patch_post(409, {
            "code": "status_precondition_failed",
            "actualStatus": "closed",
        }):
            with self.assertRaises(wr_api.RoomStateRaceError) as ctx:
                wr_api.heartbeat_room_participant(
                    base_url="https://www.hivemoot.dev",
                    room_id="room-A",
                    bearer="hmt_test",
                )
        self.assertEqual(ctx.exception.op, "heartbeat")
        self.assertEqual(ctx.exception.code, "status_precondition_failed")

    def test_owner_conflict_maps_to_race(self):
        # Subscriber-mode collision: a different runner holds the
        # role. heartbeat_room_participant maps this to a race so
        # the lifecycle stops attempting to keep our slot alive
        # (it isn't ours).
        with self._patch_post(409, {
            "code": "owner_conflict",
            "existingAgentId": "drone-runner-host42",
        }):
            with self.assertRaises(wr_api.RoomStateRaceError) as ctx:
                wr_api.heartbeat_room_participant(
                    base_url="https://www.hivemoot.dev",
                    room_id="room-A",
                    bearer="hmt_test",
                )
        self.assertEqual(ctx.exception.code, "owner_conflict")

    def test_500_raises_runtime_error(self):
        # Generic transient — caller logs and retries on next tick.
        with self._patch_post(500, {"message": "kaboom"}):
            with self.assertRaises(RuntimeError) as ctx:
                wr_api.heartbeat_room_participant(
                    base_url="https://www.hivemoot.dev",
                    room_id="room-A",
                    bearer="hmt_test",
                )
        self.assertIn("status 500", str(ctx.exception))

    def test_missing_rsvpAt_raises_runtime_error(self):
        with self._patch_post(200, {"unexpected": "shape"}):
            with self.assertRaises(RuntimeError):
                wr_api.heartbeat_room_participant(
                    base_url="https://www.hivemoot.dev",
                    room_id="room-A",
                    bearer="hmt_test",
                )

    def test_agent_id_flows_into_body(self):
        # Verify the agentId is sent for the first-wins gate.
        captured: dict[str, Any] = {}

        def fake_post_json(url, body, bearer, *, timeout):
            captured["body"] = body
            captured["url"] = url
            return (200, {"rsvpAt": "2026-05-06T03:00:00.000Z"}, b"{}")

        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.api.post_json",
            side_effect=fake_post_json,
        ):
            wr_api.heartbeat_room_participant(
                base_url="https://www.hivemoot.dev",
                room_id="room-A",
                bearer="hmt_test",
                agent_id="drone-runner-host42",
            )
        self.assertEqual(captured["body"], {"agentId": "drone-runner-host42"})
        self.assertTrue(captured["url"].endswith("/api/rooms/room-A/heartbeat"))

    def test_no_agent_id_sends_empty_body(self):
        # Per RFC Q3: heartbeat is payload-free. When agent_id is
        # None, the body is `{}` — server falls back to bearer.name.
        captured: dict[str, Any] = {}

        def fake_post_json(url, body, bearer, *, timeout):
            captured["body"] = body
            return (200, {"rsvpAt": "x"}, b"{}")

        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.api.post_json",
            side_effect=fake_post_json,
        ):
            wr_api.heartbeat_room_participant(
                base_url="https://www.hivemoot.dev",
                room_id="room-A",
                bearer="hmt_test",
            )
        self.assertEqual(captured["body"], {})


# ── RoomLifecycleReporter ──────────────────────────────────────────


class _FakeBearerFactory:
    """Captures call counts so tests can pin the per-tick re-resolution
    invariant. The substrate's tasks heartbeat thread re-resolves
    every tick to support token rotation; the war-rooms reporter
    inherits that contract."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self) -> str:
        self.calls += 1
        return f"hmt_test_call_{self.calls}"


class RoomLifecycleReporterStartTests(unittest.TestCase):

    def test_on_start_calls_present_and_sets_presented(self):
        bearer = _FakeBearerFactory()
        with patch.object(
            wr_api, "present_to_room", return_value=8,
        ) as m:
            r = RoomLifecycleReporter(
                _job(),
                base_url="https://www.hivemoot.dev",
                bearer_factory=bearer,
            )
            r.on_start(_job())
            self.assertTrue(r._presented)
            m.assert_called_once_with(
                base_url="https://www.hivemoot.dev",
                room_id="room-A",
                sequence_observed_by_client=7,
                bearer="hmt_test_call_1",
            )

    def test_on_start_race_keeps_presented_false(self):
        # Room moved on between /watching and dispatch — the small
        # window we're trying to shrink. Stay un-presented; heartbeat
        # is a no-op until the next dispatch refreshes state.
        with patch.object(
            wr_api, "present_to_room",
            side_effect=wr_api.RoomStateRaceError(
                op="present",
                code="status_precondition_failed",
                body_excerpt="closed",
            ),
        ):
            r = RoomLifecycleReporter(
                _job(),
                base_url="x",
                bearer_factory=_FakeBearerFactory(),
            )
            r.on_start(_job())
        self.assertFalse(r._presented)

    def test_on_start_generic_failure_keeps_presented_false(self):
        with patch.object(
            wr_api, "present_to_room",
            side_effect=RuntimeError("network blip"),
        ):
            r = RoomLifecycleReporter(
                _job(),
                base_url="x",
                bearer_factory=_FakeBearerFactory(),
            )
            r.on_start(_job())
        self.assertFalse(r._presented)

    def test_on_start_skips_when_room_id_empty(self):
        # Defensive: a malformed Job with empty room_id should not
        # produce an HTTP call (and certainly should not crash).
        bad_job = Job(
            session_key="x",
            prompt="p",
            metadata={"job_kind": "war_room_triage"},
        )
        with patch.object(wr_api, "present_to_room") as m:
            r = RoomLifecycleReporter(
                bad_job,
                base_url="x",
                bearer_factory=_FakeBearerFactory(),
            )
            r.on_start(bad_job)
        m.assert_not_called()
        self.assertFalse(r._presented)


class RoomLifecycleReporterHeartbeatTests(unittest.TestCase):

    def _build(self, *, presented: bool = True) -> RoomLifecycleReporter:
        r = RoomLifecycleReporter(
            _job(),
            base_url="https://www.hivemoot.dev",
            bearer_factory=_FakeBearerFactory(),
        )
        r._presented = presented
        return r

    def test_heartbeat_no_op_when_not_presented(self):
        # If on_start failed to /present, the slot doesn't exist —
        # heartbeating it would either 404 or 409. Skip the HTTP
        # call entirely; the substrate's loop will keep ticking.
        r = self._build(presented=False)
        with patch.object(wr_api, "heartbeat_room_participant") as m:
            r.on_heartbeat(_job())
        m.assert_not_called()

    def test_heartbeat_happy_path_keeps_presented(self):
        r = self._build(presented=True)
        with patch.object(
            wr_api, "heartbeat_room_participant",
            return_value="2026-05-06T03:00:00.000Z",
        ):
            r.on_heartbeat(_job())
        self.assertTrue(r._presented)

    def test_heartbeat_skipped_clears_presented(self):
        # Slot has gone terminal (withdrew/resolved/timed_out).
        # Stop heartbeating; subsequent ticks are no-op.
        r = self._build(presented=True)
        with patch.object(
            wr_api, "heartbeat_room_participant",
            return_value=None,
        ):
            r.on_heartbeat(_job())
        self.assertFalse(r._presented)

    def test_heartbeat_race_clears_presented(self):
        # Status precondition failed — room is no longer in
        # awaiting_contributions. Lifecycle is over for this Job.
        r = self._build(presented=True)
        with patch.object(
            wr_api, "heartbeat_room_participant",
            side_effect=wr_api.RoomStateRaceError(
                op="heartbeat",
                code="status_precondition_failed",
                body_excerpt="closed",
            ),
        ):
            r.on_heartbeat(_job())
        self.assertFalse(r._presented)

    def test_heartbeat_owner_conflict_clears_presented(self):
        # Subscriber-mode collision: another runner won the gate.
        # Slot isn't ours — stop heartbeating it.
        r = self._build(presented=True)
        with patch.object(
            wr_api, "heartbeat_room_participant",
            side_effect=wr_api.RoomStateRaceError(
                op="heartbeat",
                code="owner_conflict",
                body_excerpt="held by drone-host42",
            ),
        ):
            r.on_heartbeat(_job())
        self.assertFalse(r._presented)

    def test_heartbeat_transient_error_keeps_presented(self):
        # 5xx, network blip, etc. — the slot is still ours; next
        # tick will retry. Don't clear _presented.
        r = self._build(presented=True)
        with patch.object(
            wr_api, "heartbeat_room_participant",
            side_effect=RuntimeError("transient 503"),
        ):
            r.on_heartbeat(_job())
        self.assertTrue(r._presented)

    def test_heartbeat_re_resolves_bearer_per_tick(self):
        # Per the substrate's tasks-heartbeat convention (and
        # explicit RFC reasoning): bearer is re-resolved each call
        # so token rotation takes effect within one interval. The
        # bearer_factory call count proves the reporter calls it
        # fresh each tick rather than caching.
        bearer = _FakeBearerFactory()
        r = RoomLifecycleReporter(
            _job(),
            base_url="x",
            bearer_factory=bearer,
        )
        r._presented = True
        with patch.object(
            wr_api, "heartbeat_room_participant",
            return_value="x",
        ):
            r.on_heartbeat(_job())
            r.on_heartbeat(_job())
            r.on_heartbeat(_job())
        self.assertEqual(bearer.calls, 3)


class RoomLifecycleReporterFinishTests(unittest.TestCase):
    """Pin the explicit no-op contract for on_finish / on_failure.
    handler.py owns /contribute and /withdraw for now; if a future
    PR migrates them, these tests will fail and force a deliberate
    contract update."""

    def test_on_finish_is_noop(self):
        r = RoomLifecycleReporter(
            _job(),
            base_url="x",
            bearer_factory=_FakeBearerFactory(),
        )
        r._presented = True
        with (
            patch.object(wr_api, "submit_contribution") as m1,
            patch.object(wr_api, "withdraw_participant") as m2,
        ):
            r.on_finish(_job(), AgentResult(exit_code=0, response="x"))
        m1.assert_not_called()
        m2.assert_not_called()

    def test_on_failure_is_noop(self):
        r = RoomLifecycleReporter(
            _job(),
            base_url="x",
            bearer_factory=_FakeBearerFactory(),
        )
        r._presented = True
        with patch.object(wr_api, "withdraw_participant") as m:
            r.on_failure(_job(), "agent crashed")
        m.assert_not_called()


# ── Matcher disjointness (guard's PR #614 follow-up request) ───────


class MatcherDisjointnessTests(unittest.TestCase):
    """Positive coverage for the war-rooms matcher across the
    metadata combinations that exist in the system. Guard's PR #614
    review explicitly asked future PRs to ship this — paying it down
    in PR C since the matcher being shipped is `is_war_room_job`."""

    def test_matches_well_formed_war_room_job(self):
        self.assertTrue(is_war_room_job_for_lifecycle(_job()))

    def test_does_not_match_task_job(self):
        # A task job has task_id but lacks the room_id+job_kind
        # combination. Mutual exclusion holds.
        task_job = Job(
            session_key="t",
            prompt="p",
            metadata={"task_id": "t-1", "claim_token": "ct-1"},
        )
        self.assertFalse(is_war_room_job_for_lifecycle(task_job))

    def test_does_not_match_health_job(self):
        # Health jobs have no metadata markers shared with war-rooms.
        health_job = Job(session_key="h", prompt="p", metadata={})
        self.assertFalse(is_war_room_job_for_lifecycle(health_job))

    def test_does_not_match_partial_metadata(self):
        # Partial-marker Jobs (e.g. someone set room_id but not
        # job_kind) are treated as not-ours rather than risking a
        # false-positive dispatch. handler.is_war_room_job pins
        # this; the matcher inherits.
        partial = Job(
            session_key="x",
            prompt="p",
            metadata={"room_id": "room-A", "current_sequence": 3},
        )
        self.assertFalse(is_war_room_job_for_lifecycle(partial))

    def test_does_not_match_wrong_job_kind(self):
        # job_kind is the discriminator string. Anything else (a
        # future "investigation" or "long-running goal" job) is
        # rejected so the matcher stays mutually exclusive.
        wrong_kind = Job(
            session_key="x",
            prompt="p",
            metadata={
                "job_kind": "investigation",
                "room_id": "room-A",
                "current_sequence": 3,
            },
        )
        self.assertFalse(is_war_room_job_for_lifecycle(wrong_kind))


# ── Factory smoke test ─────────────────────────────────────────────


class FactorySmokeTests(unittest.TestCase):

    def test_build_room_reporter_returns_configured_instance(self):
        r = build_room_reporter(
            _job(),
            base_url="https://staging.hivemoot.dev",
            bearer_factory=_FakeBearerFactory(),
            agent_id="drone-host7",
        )
        self.assertIsInstance(r, RoomLifecycleReporter)
        self.assertEqual(r._base_url, "https://staging.hivemoot.dev")
        self.assertEqual(r._room_id, "room-A")
        self.assertEqual(r._current_sequence, 7)
        self.assertEqual(r._agent_id, "drone-host7")


if __name__ == "__main__":
    unittest.main()
