"""Tests for cli/hivemoot_agent/plugins_builtin/hivemoot/war_rooms/handler.py."""

from __future__ import annotations

import os
import sys
import unittest
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.hivemoot.war_rooms import (
    JOB_KIND_TRIAGE,
    RAW_MD_CLIENT_CAP_BYTES,
    handle_war_room_job_finished,
    is_war_room_job,
    truncate_raw_md,
)
from hivemoot_agent.plugins_builtin.hivemoot.war_rooms import api as wr_api
from hivemoot_agent.plugins.interfaces import AgentResult, Job


# ── Fixtures ──────────────────────────────────────────────────────


@dataclass
class _CallRecord:
    op: str
    kwargs: dict[str, Any] = field(default_factory=dict)


def _job(
    *,
    room_id: str = "01234567-89ab-4cde-9012-3456789abcde",
    sequence: int = 5,
    job_kind: str | None = JOB_KIND_TRIAGE,
    extra_meta: dict[str, Any] | None = None,
) -> Job:
    metadata: dict[str, Any] = {
        "room_id": room_id,
        "current_sequence": sequence,
        "subject_type": "pr_review",
        "subject_ref": "owner/repo#42",
        "manager": "bot-queen",
        "status": "awaiting_contributions",
        "participants": {},
    }
    if job_kind is not None:
        metadata["job_kind"] = job_kind
    if extra_meta:
        metadata.update(extra_meta)
    return Job(
        session_key=f"war-room:{room_id}@{sequence}",
        prompt="ignored in tests",
        metadata=metadata,
    )


def _result(exit_code: int = 0, response: str = "") -> AgentResult:
    return AgentResult(exit_code=exit_code, response=response)


def _present_response() -> str:
    return """\
Investigation notes...

## Triage decision

DECISION: PRESENT
VERDICT: REQUEST_CHANGES
SUMMARY: Found 2 SQL injection blockers.

## Review

The /login handler concatenates user input directly. Use a
parameterized query.
"""


def _withdraw_response(reason: str = "Out of scope.") -> str:
    return f"""\
## Triage decision

DECISION: WITHDRAW
REASON: {reason}
"""


# ── is_war_room_job ───────────────────────────────────────────────


class IsWarRoomJobTests(unittest.TestCase):

    def test_recognizes_triage_job(self) -> None:
        self.assertTrue(is_war_room_job(_job()))

    def test_rejects_job_without_kind_marker(self) -> None:
        self.assertFalse(is_war_room_job(_job(job_kind=None)))

    def test_rejects_job_with_wrong_kind(self) -> None:
        self.assertFalse(
            is_war_room_job(_job(job_kind="some_other_kind"))
        )

    def test_rejects_job_with_empty_room_id(self) -> None:
        self.assertFalse(is_war_room_job(_job(room_id="")))

    def test_rejects_job_with_non_int_sequence(self) -> None:
        # Defensive: metadata could be deserialized weirdly. The
        # discriminator must reject a job that can't safely flow
        # through the handler.
        j = _job()
        j.metadata["current_sequence"] = "5"
        self.assertFalse(is_war_room_job(j))

    def test_rejects_task_jobs_from_sibling_plugin(self) -> None:
        j = Job(
            session_key="task:abc",
            prompt="x",
            metadata={"task_id": "abc", "claim_token": "tk"},
        )
        self.assertFalse(is_war_room_job(j))


# ── handle_war_room_job_finished ──────────────────────────────────


def _patched_apis(record: list[_CallRecord]):
    """Patch wr_api.* to record calls instead of making HTTP."""

    def _present(**kwargs):
        record.append(_CallRecord(op="present", kwargs=kwargs))
        return 6  # landed sequence

    def _contribute(**kwargs):
        record.append(_CallRecord(op="contribute", kwargs=kwargs))
        return 7

    def _withdraw(**kwargs):
        record.append(_CallRecord(op="withdraw", kwargs=kwargs))
        return 6

    return patch.multiple(
        "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api",
        present_to_room=_present,
        submit_contribution=_contribute,
        withdraw_participant=_withdraw,
    )


class HandlePresentPathTests(unittest.TestCase):

    def test_present_path_calls_present_then_contribute(self) -> None:
        record: list[_CallRecord] = []
        with _patched_apis(record):
            decision = handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_present_response(),
            )
        self.assertEqual(decision.kind, "present")
        self.assertEqual(decision.verdict, "REQUEST_CHANGES")
        ops = [r.op for r in record]
        self.assertEqual(ops, ["present", "contribute"])

    def test_contribute_body_carries_verdict_summary_and_raw_md(self) -> None:
        record: list[_CallRecord] = []
        with _patched_apis(record):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_present_response(),
            )
        contribute = next(r for r in record if r.op == "contribute")
        self.assertEqual(
            contribute.kwargs["contribution_body"],
            {
                "verdict": "REQUEST_CHANGES",
                "summary": "Found 2 SQL injection blockers.",
            },
        )
        self.assertIn("/login handler", contribute.kwargs["raw_md"])
        self.assertEqual(
            contribute.kwargs["sequence_observed_by_client"], 5
        )
        self.assertEqual(contribute.kwargs["bearer"], "bearer")
        self.assertEqual(contribute.kwargs["base_url"], "https://api")
        self.assertEqual(
            contribute.kwargs["room_id"],
            "01234567-89ab-4cde-9012-3456789abcde",
        )

    def test_present_failure_still_attempts_contribute(self) -> None:
        # Storage layer enforces ordering server-side, but a benign
        # 409 on /present (already RSVPd at this seq, etc.) should
        # not block /contributions.
        record: list[_CallRecord] = []
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            side_effect=RuntimeError("present returned status 409: race"),
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.submit_contribution",
            side_effect=lambda **k: record.append(_CallRecord("contribute", k)) or 7,
        ):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_present_response(),
            )
        self.assertEqual([r.op for r in record], ["contribute"])

    def test_contribute_failure_swallowed_not_raised(self) -> None:
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            return_value=6,
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.submit_contribution",
            side_effect=RuntimeError("contributions returned status 503"),
        ):
            # Must not raise — handler swallows + logs.
            decision = handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_present_response(),
            )
        # Decision is still parsed correctly.
        self.assertEqual(decision.kind, "present")


class HandleWithdrawPathTests(unittest.TestCase):

    def test_explicit_withdraw_rsvps_first_then_withdraws(self) -> None:
        # Closes #544 builder R1.1: storage requires an existing
        # participant slot before withdrawal — calling /withdraw
        # without prior /present returns 409 participant_not_found
        # and the event never lands. Handler always RSVPs first.
        record: list[_CallRecord] = []
        with _patched_apis(record):
            decision = handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_withdraw_response("Out of scope."),
            )
        self.assertEqual(decision.kind, "withdraw")
        self.assertEqual(decision.reason, "Out of scope.")
        self.assertFalse(decision.parse_error)
        ops = [r.op for r in record]
        self.assertEqual(ops, ["present", "withdraw"])
        present = record[0]
        withdraw = record[1]
        self.assertEqual(present.kwargs["intent_hint"], "Out of scope.")
        self.assertEqual(withdraw.kwargs["reason"], "Out of scope.")
        self.assertEqual(
            withdraw.kwargs["sequence_observed_by_client"], 5
        )

    def test_present_failure_during_withdraw_path_continues_to_withdraw(self) -> None:
        # Mirrors PRESENT path: a 409 on /present (already RSVPd at
        # this seq) shouldn't block /withdraw — storage tolerates
        # the duplicate present and the withdraw still lands.
        record: list[_CallRecord] = []
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            side_effect=RuntimeError("present returned status 409"),
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.withdraw_participant",
            side_effect=lambda **k: record.append(_CallRecord("withdraw", k)) or 7,
        ):
            decision = handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_withdraw_response(),
            )
        self.assertEqual(decision.kind, "withdraw")
        self.assertEqual([r.op for r in record], ["withdraw"])

    def test_unparseable_response_synthesizes_withdraw_with_parse_error_reason(self) -> None:
        # Closes the safety invariant: a stuck/malformed agent
        # response NEVER results in a contribution being silently
        # submitted. Always withdraw (via present + withdraw).
        record: list[_CallRecord] = []
        with _patched_apis(record):
            decision = handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown="just some prose, no triage block",
            )
        self.assertEqual(decision.kind, "withdraw")
        self.assertTrue(decision.parse_error)
        assert decision.reason is not None
        self.assertIn("unparseable_triage_output", decision.reason)
        ops = [r.op for r in record]
        self.assertEqual(ops, ["present", "withdraw"])
        # Withdraw MUST receive the parse-error reason so operators
        # grepping logs can correlate failed worker LLMs with the
        # rooms they couldn't process.
        self.assertIn(
            "unparseable_triage_output",
            record[1].kwargs["reason"],
        )

    def test_withdraw_failure_swallowed_not_raised(self) -> None:
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            return_value=6,
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.withdraw_participant",
            side_effect=RuntimeError("withdraw returned status 503"),
        ):
            decision = handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_withdraw_response(),
            )
        # Still doesn't raise; decision returned for caller introspection.
        self.assertEqual(decision.kind, "withdraw")


class RoomStateRaceTests(unittest.TestCase):
    """Closes the log-noise issue from PR #599 follow-up: when the
    bot's quiet-period gate hasn't quite expired and a fast worker
    reaches /present, the room may have transitioned to `deciding`
    in the race window.  The handler must:
      - Treat `RoomStateRaceError` as a benign no-op (info-level
        log, no on_post_failure callback, no follow-up call).
      - Stop the post sequence at the failed leg — don't try
        /contribute or /withdraw against a room that won't accept
        them.
    """

    def test_present_race_skips_contribute_no_callback(self) -> None:
        """Race on /present (the first leg) must short-circuit the
        whole sequence: no /contribute call, no on_post_failure."""
        contribute_called: list[bool] = []
        callback_invocations: list[tuple] = []

        def _race_present(**_kwargs: Any) -> int:
            raise wr_api.RoomStateRaceError(
                op="present",
                code="status_precondition_failed",
                body_excerpt="room is currently 'deciding'",
            )

        def _contribute(**_kwargs: Any) -> int:
            contribute_called.append(True)
            return 7

        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            side_effect=_race_present,
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.submit_contribution",
            side_effect=_contribute,
        ):
            decision = handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_present_response(),
                on_post_failure=lambda *args: callback_invocations.append(args),
            )

        self.assertEqual(decision.kind, "present")  # parse still works
        self.assertEqual(contribute_called, [], "race must skip /contribute")
        self.assertEqual(callback_invocations, [], "race must NOT fire callback")

    def test_contribute_race_after_successful_present_no_callback(self) -> None:
        """Present succeeded; /contribute hits the race.  Still no
        callback (the room moved on, re-dispatching is pointless —
        it would just race again next tick)."""
        callback_invocations: list[tuple] = []

        def _present(**_kwargs: Any) -> int:
            return 6

        def _race_contribute(**_kwargs: Any) -> int:
            raise wr_api.RoomStateRaceError(
                op="contributions",
                code="status_precondition_failed",
                body_excerpt="room is currently 'deciding'",
            )

        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            side_effect=_present,
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.submit_contribution",
            side_effect=_race_contribute,
        ):
            decision = handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_present_response(),
                on_post_failure=lambda *args: callback_invocations.append(args),
            )

        self.assertEqual(decision.kind, "present")
        self.assertEqual(callback_invocations, [])

    def test_withdraw_path_present_race_skips_withdraw(self) -> None:
        """Same race on the withdraw path: /present (RSVP-then-
        withdraw step 1) hits the race → skip the /withdraw call."""
        withdraw_called: list[bool] = []

        def _race_present(**_kwargs: Any) -> int:
            raise wr_api.RoomStateRaceError(
                op="present",
                code="status_precondition_failed",
                body_excerpt="room is currently 'deciding'",
            )

        def _withdraw(**_kwargs: Any) -> int:
            withdraw_called.append(True)
            return 6

        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            side_effect=_race_present,
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.withdraw_participant",
            side_effect=_withdraw,
        ):
            decision = handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_withdraw_response(),
            )

        self.assertEqual(decision.kind, "withdraw")
        self.assertEqual(withdraw_called, [], "race must skip /withdraw")

    def test_withdraw_race_after_successful_present_no_callback(self) -> None:
        callback_invocations: list[tuple] = []

        def _present(**_kwargs: Any) -> int:
            return 6

        def _race_withdraw(**_kwargs: Any) -> int:
            raise wr_api.RoomStateRaceError(
                op="withdraw",
                code="status_precondition_failed",
                body_excerpt="room is currently 'deciding'",
            )

        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            side_effect=_present,
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.withdraw_participant",
            side_effect=_race_withdraw,
        ):
            decision = handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_withdraw_response(),
                on_post_failure=lambda *args: callback_invocations.append(args),
            )

        self.assertEqual(decision.kind, "withdraw")
        self.assertEqual(callback_invocations, [])


class HandlerSafetyInvariantTests(unittest.TestCase):

    def test_empty_agent_response_withdraws_never_contributes(self) -> None:
        record: list[_CallRecord] = []
        with _patched_apis(record):
            decision = handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown="",
            )
        self.assertEqual([r.op for r in record], ["present", "withdraw"])
        self.assertTrue(decision.parse_error)

    def test_present_with_invalid_verdict_withdraws(self) -> None:
        record: list[_CallRecord] = []
        bogus = """\
## Triage decision

DECISION: PRESENT
VERDICT: SHIP_IT_NOW
SUMMARY: lol
## Review
go
"""
        with _patched_apis(record):
            decision = handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=bogus,
            )
        self.assertEqual([r.op for r in record], ["present", "withdraw"])
        self.assertTrue(decision.parse_error)


class PostFailureCallbackTests(unittest.TestCase):
    """Closes #544 builder R1.2: post-failure callback so F.5 can
    evict the trigger's seen-cache and re-dispatch on the next
    watching tick when the post sequence drops participation."""

    def test_callback_fires_when_both_legs_fail_present_path(self) -> None:
        callback_calls: list[tuple] = []

        def on_failure(room_id, seq, op_kind, exc):
            callback_calls.append((room_id, seq, op_kind, type(exc).__name__))

        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            side_effect=RuntimeError("present 503"),
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.submit_contribution",
            side_effect=RuntimeError("contribute 503"),
        ):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_present_response(),
                on_post_failure=on_failure,
            )
        self.assertEqual(len(callback_calls), 1)
        room_id, seq, op_kind, exc_name = callback_calls[0]
        self.assertEqual(
            room_id, "01234567-89ab-4cde-9012-3456789abcde"
        )
        self.assertEqual(seq, 5)
        self.assertEqual(op_kind, "contribute")
        self.assertEqual(exc_name, "RuntimeError")

    def test_callback_fires_when_both_legs_fail_withdraw_path(self) -> None:
        callback_calls: list[tuple] = []

        def on_failure(room_id, seq, op_kind, exc):
            callback_calls.append((room_id, seq, op_kind, type(exc).__name__))

        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            side_effect=RuntimeError("present 503"),
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.withdraw_participant",
            side_effect=RuntimeError("withdraw 503"),
        ):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_withdraw_response(),
                on_post_failure=on_failure,
            )
        self.assertEqual(len(callback_calls), 1)
        self.assertEqual(callback_calls[0][2], "withdraw")

    def test_callback_NOT_fired_when_only_present_fails_but_contribute_succeeds(
        self,
    ) -> None:
        # Partial success: state DID change (contribute landed), so
        # next /watching tick will naturally de-list the room. No
        # need to evict seen-cache.
        callback_calls: list[tuple] = []
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            side_effect=RuntimeError("present 409"),
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.submit_contribution",
            return_value=7,
        ):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_present_response(),
                on_post_failure=lambda *a: callback_calls.append(a),
            )
        self.assertEqual(callback_calls, [])

    def test_callback_NOT_fired_on_happy_path(self) -> None:
        callback_calls: list[tuple] = []
        record: list[_CallRecord] = []
        with _patched_apis(record):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_present_response(),
                on_post_failure=lambda *a: callback_calls.append(a),
            )
        self.assertEqual(callback_calls, [])

    def test_callback_exception_is_swallowed(self) -> None:
        # A buggy trigger that raises in its callback shouldn't
        # propagate into the engine's job lifecycle.
        def buggy_callback(*args):
            raise ValueError("buggy trigger")

        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            side_effect=RuntimeError("present 503"),
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.submit_contribution",
            side_effect=RuntimeError("contribute 503"),
        ):
            # Must not raise.
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_present_response(),
                on_post_failure=buggy_callback,
            )

    def test_callback_optional_omission_works(self) -> None:
        # Default behavior (no callback): same as before, just no
        # re-dispatch signal on total failure.
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            side_effect=RuntimeError("present 503"),
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.submit_contribution",
            side_effect=RuntimeError("contribute 503"),
        ):
            decision = handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_present_response(),
            )
        # Still completes cleanly; decision is what was parsed.
        self.assertEqual(decision.kind, "present")


class RawMdClientCapTests(unittest.TestCase):
    """Closes #544 builder R2: oversized raw_md from the agent
    must be capped client-side before /contributions, otherwise
    the server returns 400 raw_md_too_large and the next-tick
    re-dispatch loops indefinitely (presentParticipant rewrites
    rsvp_at on each /present, pushing out the watchdog timeout)."""

    def test_under_cap_passes_through_unchanged(self) -> None:
        body = "## Review\n\n" + "small content"
        self.assertEqual(truncate_raw_md(body), body)

    def test_over_cap_truncates_to_under_storage_limit(self) -> None:
        # Storage cap is 32 KiB; client cap is 31 KiB (1 KiB
        # headroom for envelope overhead).
        body = "x" * (RAW_MD_CLIENT_CAP_BYTES + 5_000) + "\nend"
        result = truncate_raw_md(body)
        self.assertLessEqual(len(result.encode("utf-8")), RAW_MD_CLIENT_CAP_BYTES)
        self.assertIn("[truncated by worker", result)

    def test_truncation_cuts_on_newline_boundary(self) -> None:
        # Builds an oversized body where the cut point falls inside
        # a long line; verify the truncation respects the last
        # newline before the cap to avoid splitting fenced code or
        # list items mid-line.
        head = "x" * (RAW_MD_CLIENT_CAP_BYTES - 200)
        body = head + "\n" + "y" * 500
        result = truncate_raw_md(body)
        # Last line should be the truncation marker, not chopped y's.
        last_line = result.rsplit("\n", 1)[-1]
        self.assertTrue(last_line.startswith("_[truncated"))

    def test_handler_truncates_oversized_raw_md_before_contribute(self) -> None:
        # End-to-end: agent produces an oversized review; handler
        # caps it before submit_contribution. Storage 400 path is
        # never triggered.
        oversized_body = "x" * (RAW_MD_CLIENT_CAP_BYTES + 10_000)
        oversized_response = (
            "## Triage decision\n\n"
            "DECISION: PRESENT\n"
            "VERDICT: APPROVE\n"
            "SUMMARY: ok\n\n"
            "## Review\n\n" + oversized_body
        )
        record: list[_CallRecord] = []
        with _patched_apis(record):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=oversized_response,
            )
        contribute = next(r for r in record if r.op == "contribute")
        sent_raw_md = contribute.kwargs["raw_md"]
        self.assertLessEqual(
            len(sent_raw_md.encode("utf-8")),
            RAW_MD_CLIENT_CAP_BYTES,
        )
        self.assertIn("[truncated by worker", sent_raw_md)

    def test_handler_passes_through_under_cap_raw_md(self) -> None:
        record: list[_CallRecord] = []
        with _patched_apis(record):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_present_response(),
            )
        contribute = next(r for r in record if r.op == "contribute")
        # Sample _present_response is small; should not be truncated.
        self.assertNotIn("[truncated by worker", contribute.kwargs["raw_md"])
        self.assertIn("/login handler", contribute.kwargs["raw_md"])


if __name__ == "__main__":
    unittest.main()
