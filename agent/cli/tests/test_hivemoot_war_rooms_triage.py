"""Tests for cli/hivemoot_agent/plugins_builtin/hivemoot/war_rooms/triage.py."""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.hivemoot.war_rooms import (
    WatchingRoom,
    build_triage_prompt,
    parse_triage_response,
    TRIAGE_OUTPUT_INSTRUCTIONS,
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
        # Sorted alphabetically.
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

    def test_appends_output_instructions_block(self) -> None:
        prompt = build_triage_prompt(_room())
        self.assertIn(TRIAGE_OUTPUT_INSTRUCTIONS, prompt)

    def test_output_spec_lists_both_decisions(self) -> None:
        # Spec must mention PRESENT and WITHDRAW so the LLM knows
        # both are valid.
        self.assertIn("DECISION: PRESENT", TRIAGE_OUTPUT_INSTRUCTIONS)
        self.assertIn("DECISION: WITHDRAW", TRIAGE_OUTPUT_INSTRUCTIONS)

    def test_output_spec_enumerates_all_four_verdicts(self) -> None:
        for v in ("APPROVE", "COMMENT", "CONCERNS", "REQUEST_CHANGES"):
            self.assertIn(v, TRIAGE_OUTPUT_INSTRUCTIONS)


class ParseTriageResponseTests(unittest.TestCase):

    def test_parses_present_with_all_fields(self) -> None:
        response = """\
Some preamble.

## Triage decision

DECISION: PRESENT
VERDICT: REQUEST_CHANGES
SUMMARY: Found 2 SQL injection blockers in auth flow.

## Review

The /login handler at line 42 concatenates user input directly
into the SQL query. Use a parameterized query instead.
"""
        decision = parse_triage_response(response)
        self.assertEqual(decision.kind, "present")
        self.assertEqual(decision.verdict, "REQUEST_CHANGES")
        self.assertEqual(
            decision.summary,
            "Found 2 SQL injection blockers in auth flow.",
        )
        assert decision.body is not None
        self.assertIn("/login handler at line 42", decision.body)
        self.assertFalse(decision.parse_error)

    def test_parses_withdraw_with_reason(self) -> None:
        response = """\
## Triage decision

DECISION: WITHDRAW
REASON: Out of scope for guard role — docs-only PR.
"""
        decision = parse_triage_response(response)
        self.assertEqual(decision.kind, "withdraw")
        self.assertEqual(
            decision.reason, "Out of scope for guard role — docs-only PR."
        )
        self.assertFalse(decision.parse_error)

    def test_parses_withdraw_without_reason(self) -> None:
        response = """\
## Triage decision

DECISION: WITHDRAW
"""
        decision = parse_triage_response(response)
        self.assertEqual(decision.kind, "withdraw")
        self.assertIsNone(decision.reason)
        self.assertFalse(decision.parse_error)

    def test_uses_last_triage_block_when_multiple(self) -> None:
        # Agent might think out loud and include earlier "## Triage
        # decision" mentions in prose. Parser must use the LAST one.
        response = """\
## Triage decision

(Thinking out loud about what triage decisions look like...)

## Triage decision

DECISION: PRESENT
VERDICT: APPROVE
SUMMARY: Looks clean.

## Review

LGTM.
"""
        decision = parse_triage_response(response)
        self.assertEqual(decision.kind, "present")
        self.assertEqual(decision.verdict, "APPROVE")

    # Failure modes — all synthesize WITHDRAW with parse_error=True.

    def test_empty_response_synthesizes_withdraw_parse_error(self) -> None:
        d = parse_triage_response("")
        self.assertEqual(d.kind, "withdraw")
        self.assertTrue(d.parse_error)
        assert d.reason is not None
        self.assertIn("empty_response", d.reason)

    def test_whitespace_only_response_synthesizes_withdraw_parse_error(self) -> None:
        d = parse_triage_response("  \n\n   \t  \n")
        self.assertEqual(d.kind, "withdraw")
        self.assertTrue(d.parse_error)

    def test_no_triage_heading_synthesizes_withdraw(self) -> None:
        d = parse_triage_response("Just some prose. No structured block.")
        self.assertTrue(d.parse_error)
        assert d.reason is not None
        self.assertIn("no_triage_heading", d.reason)

    def test_no_decision_marker_synthesizes_withdraw(self) -> None:
        d = parse_triage_response("## Triage decision\n\nVERDICT: APPROVE\n")
        self.assertTrue(d.parse_error)
        assert d.reason is not None
        self.assertIn("no_decision_marker", d.reason)

    def test_invalid_decision_value_synthesizes_withdraw(self) -> None:
        d = parse_triage_response(
            "## Triage decision\n\nDECISION: MERGE_NOW\n"
        )
        self.assertTrue(d.parse_error)
        assert d.reason is not None
        self.assertIn("invalid_decision", d.reason)
        self.assertIn("MERGE_NOW", d.reason)

    def test_present_without_verdict_synthesizes_withdraw(self) -> None:
        d = parse_triage_response(
            "## Triage decision\n\nDECISION: PRESENT\nSUMMARY: x\n"
        )
        self.assertTrue(d.parse_error)
        assert d.reason is not None
        self.assertIn("missing_verdict", d.reason)

    def test_present_with_invalid_verdict_synthesizes_withdraw(self) -> None:
        d = parse_triage_response(
            "## Triage decision\n\nDECISION: PRESENT\nVERDICT: APPROVE_PLUS\nSUMMARY: x\n"
        )
        self.assertTrue(d.parse_error)
        assert d.reason is not None
        self.assertIn("invalid_verdict", d.reason)

    def test_present_without_summary_synthesizes_withdraw(self) -> None:
        d = parse_triage_response(
            "## Triage decision\n\nDECISION: PRESENT\nVERDICT: APPROVE\n"
        )
        self.assertTrue(d.parse_error)
        assert d.reason is not None
        self.assertIn("missing_summary", d.reason)

    def test_present_with_empty_summary_synthesizes_withdraw(self) -> None:
        d = parse_triage_response(
            "## Triage decision\n\nDECISION: PRESENT\nVERDICT: APPROVE\nSUMMARY:    \n"
        )
        self.assertTrue(d.parse_error)
        assert d.reason is not None
        self.assertIn("empty_summary", d.reason)

    def test_long_summary_truncates_under_500_chars(self) -> None:
        long_sum = "x" * 1000
        d = parse_triage_response(
            f"## Triage decision\n\nDECISION: PRESENT\nVERDICT: APPROVE\nSUMMARY: {long_sum}\n"
        )
        self.assertEqual(d.kind, "present")
        assert d.summary is not None
        # Truncated body + ellipsis must fit under the server-side
        # 500-char cap to land cleanly via /contributions.
        self.assertLessEqual(len(d.summary), 500)
        self.assertTrue(d.summary.endswith("…"))

    def test_present_without_review_section_uses_empty_body(self) -> None:
        # The review body is optional in the parser (defensive); the
        # contribution will land with empty raw_md.
        d = parse_triage_response(
            "## Triage decision\n\nDECISION: PRESENT\nVERDICT: COMMENT\nSUMMARY: noted\n"
        )
        self.assertEqual(d.kind, "present")
        self.assertEqual(d.body, "")

    def test_handles_extra_whitespace_around_markers(self) -> None:
        response = """\
## Triage decision

DECISION:    PRESENT
VERDICT:    APPROVE
SUMMARY:     trimmed.

## Review

ok.
"""
        d = parse_triage_response(response)
        self.assertEqual(d.kind, "present")
        self.assertEqual(d.verdict, "APPROVE")
        self.assertEqual(d.summary, "trimmed.")

    def test_review_heading_case_insensitive(self) -> None:
        response = """\
## Triage decision

DECISION: PRESENT
VERDICT: APPROVE
SUMMARY: ok

## review

body
"""
        d = parse_triage_response(response)
        assert d.body is not None
        self.assertIn("body", d.body)


class LenientMatchersTests(unittest.TestCase):
    """Cases observed in the wild from non-strict-following models
    (zai/glm-5.1, etc.).  The canonical instructions in
    ``TRIAGE_OUTPUT_INSTRUCTIONS`` still ask for the strict form, so
    most models produce it; the relaxed regex just rescues edge cases
    so the agent's verdict isn't lost."""

    def test_lowercase_decision_and_verdict(self) -> None:
        response = """\
## Triage decision

decision: present
verdict: approve
summary: lowercase keys + values still parse
"""
        d = parse_triage_response(response)
        self.assertEqual(d.kind, "present")
        self.assertEqual(d.verdict, "APPROVE")
        self.assertEqual(d.summary, "lowercase keys + values still parse")

    def test_mixed_case_decision(self) -> None:
        response = """\
## Triage decision

Decision: Present
Verdict: Concerns
Summary: title case keys + values
"""
        d = parse_triage_response(response)
        self.assertEqual(d.kind, "present")
        self.assertEqual(d.verdict, "CONCERNS")

    def test_markdown_bold_emphasis_around_keys(self) -> None:
        response = """\
## Triage decision

**DECISION:** PRESENT
**VERDICT:** REQUEST_CHANGES
**SUMMARY:** keys wrapped in markdown bold
"""
        d = parse_triage_response(response)
        self.assertEqual(d.kind, "present")
        self.assertEqual(d.verdict, "REQUEST_CHANGES")
        self.assertEqual(d.summary, "keys wrapped in markdown bold")

    def test_blockquote_prefix_on_keys(self) -> None:
        response = """\
## Triage decision

> DECISION: PRESENT
> VERDICT: COMMENT
> SUMMARY: blockquote prefix lines
"""
        d = parse_triage_response(response)
        self.assertEqual(d.kind, "present")
        self.assertEqual(d.verdict, "COMMENT")

    def test_list_bullet_prefix_on_keys(self) -> None:
        response = """\
## Triage decision

- DECISION: WITHDRAW
- REASON: bulleted list under the heading
"""
        d = parse_triage_response(response)
        self.assertEqual(d.kind, "withdraw")
        self.assertEqual(d.reason, "bulleted list under the heading")

    def test_no_heading_but_decision_marker_present(self) -> None:
        # Model emitted DECISION + VERDICT bare, without the
        # `## Triage decision` heading.  Earlier the parser would
        # synthesize a `no_triage_heading` withdraw and the verdict
        # would be lost; now it falls back to scanning the whole
        # document.  zai/glm-5.1 has been observed to skip the
        # heading when its response is mid-truncation.
        response = """\
After investigating the diff and reading the test fixtures, here's my call.

DECISION: PRESENT
VERDICT: APPROVE
SUMMARY: docs-only change, accurate against the linked sections
"""
        d = parse_triage_response(response)
        self.assertEqual(d.kind, "present")
        self.assertEqual(d.verdict, "APPROVE")
        self.assertEqual(
            d.summary,
            "docs-only change, accurate against the linked sections",
        )
        self.assertFalse(d.parse_error)

    def test_no_heading_no_decision_marker_anywhere(self) -> None:
        # Pure prose — no DECISION marker anywhere; should still
        # withdraw cleanly with the `no_triage_heading` reason
        # (preserves the original signal so operators grep for it).
        d = parse_triage_response(
            "Just some thinking-out-loud prose with no markers at all.",
        )
        self.assertTrue(d.parse_error)
        assert d.reason is not None
        self.assertIn("no_triage_heading", d.reason)

    def test_heading_present_but_no_decision_marker(self) -> None:
        # Heading exists but no DECISION line — different failure
        # class than the no-heading case.
        d = parse_triage_response("## Triage decision\n\nVERDICT: APPROVE\n")
        self.assertTrue(d.parse_error)
        assert d.reason is not None
        self.assertIn("no_decision_marker", d.reason)


class PromptBudgetGuidanceTests(unittest.TestCase):
    """The prompt should warn the agent that mid-investigation
    truncation is unacceptable — at minimum a clean WITHDRAW with a
    brief reason is required.  Without this, models that hit a
    response budget often stop mid-tool-call and produce nothing
    parseable."""

    def test_prompt_mentions_required_triage_block(self) -> None:
        prompt = build_triage_prompt(_room())
        self.assertIn("REQUIRED", prompt)

    def test_prompt_warns_about_truncation(self) -> None:
        prompt = build_triage_prompt(_room())
        self.assertIn("truncat", prompt.lower())

    def test_prompt_suggests_a_tool_call_budget(self) -> None:
        prompt = build_triage_prompt(_room())
        # Number not pinned; just verify there's some explicit budget
        # guidance so models that meander through tool calls are
        # nudged to bound their investigation.
        self.assertTrue(
            any(
                hint in prompt.lower()
                for hint in ("3-5 tool", "budget", "efficiently")
            ),
            f"prompt missing budget guidance: {prompt[-500:]}",
        )


if __name__ == "__main__":
    unittest.main()
