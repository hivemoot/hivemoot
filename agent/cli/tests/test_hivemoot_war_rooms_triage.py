"""Tests for cli/hivemoot_agent/plugins_builtin/hivemoot/war_rooms/triage.py.

These tests cover the post-simplification contract where:
  - `build_triage_prompt(room)` produces a generic prompt with room
    metadata + participants but NO required output format.
  - `parse_triage_response(text)` is an identity-style wrapper:
    non-empty text → present decision with `body=text`, verdict /
    summary always None (the queen LLM derives the verdict).
    Empty / whitespace-only text → withdraw with
    `reason="empty_response"` and `parse_error=True`.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.hivemoot.war_rooms import (
    WatchingRoom,
    build_triage_prompt,
    parse_triage_response,
)


def _room(
    room_id: str = "01234567-89ab-4cde-9012-3456789abcde",
    sequence: int = 5,
    status: str = "awaiting_contributions",
    subject_type: str = "pr_review",
    subject_ref: str = "hivemoot/hivemoot#42",
    manager: str = "bot-queen",
    participants: dict | None = None,
) -> WatchingRoom:
    return WatchingRoom(
        room_id=room_id,
        status=status,
        subject_type=subject_type,
        subject_ref=subject_ref,
        manager=manager,
        opened_at="2026-04-28T20:00:00Z",
        current_sequence=sequence,
        participants=participants or {},
    )


class BuildTriagePromptTests(unittest.TestCase):

    def test_includes_room_identification(self) -> None:
        prompt = build_triage_prompt(_room())
        self.assertIn("01234567-89ab-4cde-9012-3456789abcde", prompt)
        self.assertIn("pr_review", prompt)
        self.assertIn("hivemoot/hivemoot#42", prompt)
        self.assertIn("Sequence (at dispatch):** 5", prompt)

    def test_lists_other_participants_sorted(self) -> None:
        prompt = build_triage_prompt(
            _room(
                participants={
                    "guard": {"status": "resolved"},
                    "builder": {"status": "pending"},
                    "drone": {"status": "withdrew"},
                }
            )
        )
        self.assertIn("Other participants in this room", prompt)
        builder_idx = prompt.index("**builder**")
        drone_idx = prompt.index("**drone**")
        guard_idx = prompt.index("**guard**")
        self.assertLess(builder_idx, drone_idx)
        self.assertLess(drone_idx, guard_idx)
        self.assertIn("`pending`", prompt)
        self.assertIn("`resolved`", prompt)

    def test_marks_room_as_early_when_no_participants(self) -> None:
        prompt = build_triage_prompt(_room(participants={}))
        self.assertIn("you're early", prompt)

    def test_includes_subject_type_in_opening_line(self) -> None:
        prompt = build_triage_prompt(_room(subject_type="general", subject_ref="Plan the release"))
        self.assertIn("general", prompt)
        self.assertIn("Plan the release", prompt)

    def test_does_NOT_require_structured_output_format(self) -> None:
        # Closes the agent-simplification: the prompt should NOT push
        # the LLM to emit a `DECISION:` / `VERDICT:` block. The queen
        # LLM derives the verdict via forced structured tool-call
        # output instead.
        prompt = build_triage_prompt(_room())
        self.assertNotIn("DECISION: PRESENT", prompt)
        self.assertNotIn("DECISION: WITHDRAW", prompt)
        self.assertNotIn("VERDICT:", prompt)
        # And no rigid output-format spec.
        self.assertNotIn("Output format (MUST follow exactly)", prompt)

    def test_does_NOT_impose_tool_call_budget(self) -> None:
        # The "budget yourself ~3-5 tool calls" hint pushed agents
        # toward early withdrawals on rooms whose subjects didn't fit
        # PR-flavored tooling. Removed.
        prompt = build_triage_prompt(_room())
        self.assertNotIn("budget yourself", prompt)
        self.assertNotIn("3-5 tool", prompt)


class ParseTriageResponseTests(unittest.TestCase):

    def test_non_empty_response_becomes_present_with_full_body(self) -> None:
        # Identity wrapper: whatever the agent emits is the
        # contribution payload verbatim. Verdict / summary are None
        # — the queen synthesizer derives the verdict.
        response = "## Review\n\nLooks fine to me. Ship it."
        decision = parse_triage_response(response)
        self.assertEqual(decision.kind, "present")
        self.assertEqual(decision.body, response)
        self.assertIsNone(decision.verdict)
        self.assertIsNone(decision.summary)
        self.assertFalse(decision.parse_error)

    def test_present_when_response_is_long_freeform_markdown(self) -> None:
        response = (
            "I investigated the diff. The auth handler at `web/src/server/`\n"
            "looks correct. No SQL injection paths visible. Build CI green.\n\n"
            "Recommendation: ship.\n"
        )
        decision = parse_triage_response(response)
        self.assertEqual(decision.kind, "present")
        self.assertEqual(decision.body, response)

    def test_present_passes_through_legacy_structured_block_verbatim(self) -> None:
        # Even if an agent's role prompt still produces the old-style
        # DECISION/VERDICT scaffold, the parser doesn't extract — it
        # passes the whole thing as raw_md. The queen's LLM derives
        # the structured verdict on its own.
        response = (
            "## Triage decision\n\n"
            "DECISION: PRESENT\n"
            "VERDICT: APPROVE\n"
            "SUMMARY: ship\n\n"
            "## Review\n\nlgtm\n"
        )
        decision = parse_triage_response(response)
        self.assertEqual(decision.kind, "present")
        self.assertEqual(decision.body, response)
        self.assertIsNone(decision.verdict)
        self.assertIsNone(decision.summary)

    def test_empty_string_becomes_withdraw_empty_response(self) -> None:
        decision = parse_triage_response("")
        self.assertEqual(decision.kind, "withdraw")
        self.assertEqual(decision.reason, "empty_response")
        self.assertTrue(decision.parse_error)

    def test_whitespace_only_becomes_withdraw_empty_response(self) -> None:
        decision = parse_triage_response("   \n\n\t  \n")
        self.assertEqual(decision.kind, "withdraw")
        self.assertEqual(decision.reason, "empty_response")
        self.assertTrue(decision.parse_error)

    def test_none_input_becomes_withdraw_empty_response(self) -> None:
        # Defensive: result.markdown extraction can sometimes return
        # None on engine timeouts.
        decision = parse_triage_response(None)  # type: ignore[arg-type]
        self.assertEqual(decision.kind, "withdraw")
        self.assertEqual(decision.reason, "empty_response")
        self.assertTrue(decision.parse_error)


if __name__ == "__main__":
    unittest.main()
