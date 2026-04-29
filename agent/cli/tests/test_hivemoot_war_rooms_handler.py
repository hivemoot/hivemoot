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
    handle_war_room_job_finished,
    is_war_room_job,
)
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

    def test_explicit_withdraw_calls_api_with_reason(self) -> None:
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
        self.assertEqual(ops, ["withdraw"])
        withdraw = record[0]
        self.assertEqual(withdraw.kwargs["reason"], "Out of scope.")
        self.assertEqual(
            withdraw.kwargs["sequence_observed_by_client"], 5
        )

    def test_unparseable_response_synthesizes_withdraw_with_parse_error_reason(self) -> None:
        # Closes the safety invariant: a stuck/malformed agent
        # response NEVER results in a contribution being silently
        # submitted. Always withdraw.
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
        self.assertEqual(ops, ["withdraw"])
        # The withdraw API MUST receive the parse-error reason so
        # operators grepping logs can correlate failed worker LLMs
        # with the rooms they couldn't process.
        self.assertIn(
            "unparseable_triage_output",
            record[0].kwargs["reason"],
        )

    def test_withdraw_failure_swallowed_not_raised(self) -> None:
        with patch(
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
        self.assertEqual([r.op for r in record], ["withdraw"])
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
        self.assertEqual([r.op for r in record], ["withdraw"])
        self.assertTrue(decision.parse_error)


if __name__ == "__main__":
    unittest.main()
