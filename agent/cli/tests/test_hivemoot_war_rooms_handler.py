"""Tests for cli/hivemoot_agent/plugins_builtin/hivemoot/war_rooms/handler.py.

Post-simplification contract:
  - Every non-empty agent response → present + contribute. Body is
    `{}`; the agent's full markdown output goes verbatim into
    `raw_md` (truncated client-side at 31 KiB).
  - Empty / whitespace-only agent response → present + withdraw with
    reason ``empty_response`` and ``parse_error=True``. The handler
    still RSVPs first because the storage layer requires a
    participant slot before /withdraw.
  - The handler swallows API failures and logs to stderr; never
    raises.
"""

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


def _free_form_review() -> str:
    """Sample agent output — free-form markdown, no rigid scaffold."""
    return (
        "Investigated the auth handler at web/src/server/auth.ts.\n\n"
        "Found two SQL-injection blockers — `/login` concatenates user "
        "input directly into the query string. Suggest parameterized "
        "queries throughout.\n\n"
        "Otherwise the diff looks fine; tests cover the happy path."
    )


# ── is_war_room_job ───────────────────────────────────────────────


class IsWarRoomJobTests(unittest.TestCase):

    def test_recognizes_triage_job(self) -> None:
        self.assertTrue(is_war_room_job(_job()))

    def test_rejects_job_without_kind_marker(self) -> None:
        self.assertFalse(is_war_room_job(_job(job_kind=None)))

    def test_rejects_job_with_wrong_kind(self) -> None:
        self.assertFalse(is_war_room_job(_job(job_kind="some_other_kind")))

    def test_rejects_job_with_empty_room_id(self) -> None:
        self.assertFalse(is_war_room_job(_job(room_id="")))

    def test_rejects_job_with_non_int_sequence(self) -> None:
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
        return 6

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

    def test_non_empty_response_calls_present_then_contribute(self) -> None:
        record: list[_CallRecord] = []
        with _patched_apis(record):
            decision = handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_free_form_review(),
            )
        self.assertEqual(decision.kind, "present")
        self.assertIsNone(decision.verdict)
        self.assertIsNone(decision.summary)
        self.assertEqual([r.op for r in record], ["present", "contribute"])

    def test_contribution_body_is_empty_with_full_raw_md(self) -> None:
        # Closes the agent-simplification: the body field on the
        # contribution is `{}` — the queen synthesizer's LLM derives
        # the verdict from `raw_md` via forced structured tool-call
        # output.
        review = _free_form_review()
        record: list[_CallRecord] = []
        with _patched_apis(record):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=review,
            )
        contribute = next(r for r in record if r.op == "contribute")
        self.assertEqual(contribute.kwargs["contribution_body"], {})
        self.assertEqual(contribute.kwargs["raw_md"], review)
        self.assertEqual(contribute.kwargs["sequence_observed_by_client"], 5)
        self.assertEqual(contribute.kwargs["bearer"], "bearer")
        self.assertEqual(contribute.kwargs["base_url"], "https://api")
        self.assertEqual(
            contribute.kwargs["room_id"],
            "01234567-89ab-4cde-9012-3456789abcde",
        )

    def test_present_failure_still_attempts_contribute(self) -> None:
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
                extracted_markdown=_free_form_review(),
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
            decision = handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_free_form_review(),
            )
        self.assertEqual(decision.kind, "present")


class HandleEmptyResponseTests(unittest.TestCase):
    """Withdraw is reserved for the case where the engine produced
    no usable output at all — it's the only way the handler synthesizes
    a withdraw post-simplification."""

    def test_empty_response_rsvps_then_withdraws(self) -> None:
        record: list[_CallRecord] = []
        with _patched_apis(record):
            decision = handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown="",
            )
        self.assertEqual(decision.kind, "withdraw")
        self.assertEqual(decision.reason, "empty_response")
        self.assertTrue(decision.parse_error)
        self.assertEqual([r.op for r in record], ["present", "withdraw"])
        self.assertEqual(record[1].kwargs["reason"], "empty_response")

    def test_whitespace_only_response_rsvps_then_withdraws(self) -> None:
        record: list[_CallRecord] = []
        with _patched_apis(record):
            decision = handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown="   \n\n\t  ",
            )
        self.assertEqual(decision.kind, "withdraw")
        self.assertTrue(decision.parse_error)
        self.assertEqual([r.op for r in record], ["present", "withdraw"])

    def test_empty_present_failure_still_attempts_withdraw(self) -> None:
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
                extracted_markdown="",
            )
        self.assertEqual(decision.kind, "withdraw")
        self.assertEqual([r.op for r in record], ["withdraw"])

    def test_empty_withdraw_failure_swallowed_not_raised(self) -> None:
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
                extracted_markdown="",
            )
        self.assertEqual(decision.kind, "withdraw")


class RoomStateRaceTests(unittest.TestCase):
    """When the room transitions to deciding/closed mid-triage, the
    `RoomStateRaceError` from /present or /contribute / /withdraw is
    treated as a benign race: skip the rest, no callback, INFO log
    instead of WARN/ERROR."""

    def test_present_race_skips_contribute_no_callback(self) -> None:
        callbacks: list[tuple] = []
        record: list[_CallRecord] = []
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            side_effect=wr_api.RoomStateRaceError(op="present", code="status_precondition_failed", body_excerpt="room moved"),
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.submit_contribution",
            side_effect=lambda **k: record.append(_CallRecord("contribute", k)) or 7,
        ):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_free_form_review(),
                on_post_failure=lambda *args: callbacks.append(args),
            )
        self.assertEqual(record, [])
        self.assertEqual(callbacks, [])

    def test_contribute_race_after_successful_present_no_callback(self) -> None:
        callbacks: list[tuple] = []
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            return_value=6,
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.submit_contribution",
            side_effect=wr_api.RoomStateRaceError(op="present", code="status_precondition_failed", body_excerpt="closed during synthesis"),
        ):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_free_form_review(),
                on_post_failure=lambda *args: callbacks.append(args),
            )
        self.assertEqual(callbacks, [])

    def test_empty_present_race_skips_withdraw(self) -> None:
        # The only withdraw-flow trigger is an empty agent response.
        # If /present races on that path, we skip /withdraw too.
        callbacks: list[tuple] = []
        record: list[_CallRecord] = []
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            side_effect=wr_api.RoomStateRaceError(op="present", code="status_precondition_failed", body_excerpt="room moved"),
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.withdraw_participant",
            side_effect=lambda **k: record.append(_CallRecord("withdraw", k)) or 7,
        ):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown="",
                on_post_failure=lambda *args: callbacks.append(args),
            )
        self.assertEqual(record, [])
        self.assertEqual(callbacks, [])

    def test_empty_withdraw_race_after_successful_present_no_callback(self) -> None:
        callbacks: list[tuple] = []
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            return_value=6,
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.withdraw_participant",
            side_effect=wr_api.RoomStateRaceError(op="present", code="status_precondition_failed", body_excerpt="closed during synthesis"),
        ):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown="",
                on_post_failure=lambda *args: callbacks.append(args),
            )
        self.assertEqual(callbacks, [])


class PostFailureCallbackTests(unittest.TestCase):

    def test_callback_fires_when_both_legs_fail_present_path(self) -> None:
        callbacks: list[tuple] = []
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            side_effect=RuntimeError("present transient"),
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.submit_contribution",
            side_effect=RuntimeError("contribute transient"),
        ):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_free_form_review(),
                on_post_failure=lambda *args: callbacks.append(args),
            )
        self.assertEqual(len(callbacks), 1)
        room_id, sequence, op_kind, exc = callbacks[0]
        self.assertEqual(room_id, "01234567-89ab-4cde-9012-3456789abcde")
        self.assertEqual(sequence, 5)
        self.assertEqual(op_kind, "contribute")

    def test_callback_fires_when_both_legs_fail_empty_path(self) -> None:
        callbacks: list[tuple] = []
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            side_effect=RuntimeError("present transient"),
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.withdraw_participant",
            side_effect=RuntimeError("withdraw transient"),
        ):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown="",
                on_post_failure=lambda *args: callbacks.append(args),
            )
        self.assertEqual(len(callbacks), 1)
        _, _, op_kind, _ = callbacks[0]
        self.assertEqual(op_kind, "withdraw")

    def test_callback_NOT_fired_when_only_present_fails_but_contribute_succeeds(
        self,
    ) -> None:
        callbacks: list[tuple] = []
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            side_effect=RuntimeError("present transient"),
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.submit_contribution",
            return_value=7,
        ):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_free_form_review(),
                on_post_failure=lambda *args: callbacks.append(args),
            )
        self.assertEqual(callbacks, [])

    def test_callback_NOT_fired_on_happy_path(self) -> None:
        callbacks: list[tuple] = []
        with _patched_apis([]):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_free_form_review(),
                on_post_failure=lambda *args: callbacks.append(args),
            )
        self.assertEqual(callbacks, [])

    def test_callback_exception_is_swallowed(self) -> None:
        # A buggy callback can't propagate into the engine's job
        # lifecycle.
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.present_to_room",
            side_effect=RuntimeError("present transient"),
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler.wr_api.submit_contribution",
            side_effect=RuntimeError("contribute transient"),
        ):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_free_form_review(),
                on_post_failure=lambda *args: (_ for _ in ()).throw(
                    RuntimeError("callback bug")
                ),
            )
        # No raise.

    def test_callback_optional_omission_works(self) -> None:
        # Defensive: handler invoked without the kwarg should still
        # route through both legs.
        record: list[_CallRecord] = []
        with _patched_apis(record):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=_free_form_review(),
            )
        self.assertEqual([r.op for r in record], ["present", "contribute"])


class RawMdClientCapTests(unittest.TestCase):

    def test_under_cap_passes_through_unchanged(self) -> None:
        text = "x" * 100
        self.assertEqual(truncate_raw_md(text), text)

    def test_over_cap_truncates_to_under_storage_limit(self) -> None:
        text = "x" * (RAW_MD_CLIENT_CAP_BYTES + 1000)
        out = truncate_raw_md(text)
        encoded_len = len(out.encode("utf-8"))
        self.assertLessEqual(encoded_len, RAW_MD_CLIENT_CAP_BYTES)
        self.assertIn("truncated by worker", out)

    def test_truncation_cuts_on_newline_boundary(self) -> None:
        # Invariant: truncation cuts at a newline boundary so a code
        # block / list item doesn't get split mid-line. The function
        # strips the trailing newline and the marker brings its own
        # `\n\n` prefix; the visible signal is that the pre-marker
        # chunk ends on a complete repeating unit.
        chunk = "abcdefgh\n" * 5000  # > cap
        out = truncate_raw_md(chunk)
        marker = "\n\n_[truncated by worker — agent produced an oversized review]_"
        before_marker = out[: out.rfind(marker)]
        self.assertTrue(before_marker.endswith("abcdefgh"))

    def test_handler_truncates_oversized_raw_md_before_contribute(self) -> None:
        big = "x" * (RAW_MD_CLIENT_CAP_BYTES + 5000)
        record: list[_CallRecord] = []
        with _patched_apis(record):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=big,
            )
        contribute = next(r for r in record if r.op == "contribute")
        sent = contribute.kwargs["raw_md"]
        self.assertLessEqual(len(sent.encode("utf-8")), RAW_MD_CLIENT_CAP_BYTES)
        self.assertIn("truncated by worker", sent)

    def test_handler_passes_through_under_cap_raw_md(self) -> None:
        small = _free_form_review()
        record: list[_CallRecord] = []
        with _patched_apis(record):
            handle_war_room_job_finished(
                _job(),
                _result(),
                base_url="https://api",
                bearer="bearer",
                extracted_markdown=small,
            )
        contribute = next(r for r in record if r.op == "contribute")
        self.assertEqual(contribute.kwargs["raw_md"], small)


if __name__ == "__main__":
    unittest.main()
