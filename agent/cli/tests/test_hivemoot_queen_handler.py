"""Tests for the local queen completion handler."""

from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins.interfaces import AgentResult, Job
from hivemoot_agent.plugins_builtin.hivemoot.queen.api import (
    ResolveActionResult,
    SealDecisionResult,
)
from hivemoot_agent.plugins_builtin.hivemoot.queen.handler import (
    build_seal_header,
    handle_queen_job_finished,
    is_queen_job,
    parse_decision_output,
)


def _job() -> Job:
    return Job(
        session_key="queen:room-1@12",
        prompt="ignored",
        metadata={
            "job_kind": "queen_synthesis",
            "room_id": "room-1",
            "subject_ref": "owner/repo#42",
            "sealed_through_sequence": 12,
            "queen_runner": "queen-a",
            "reviewed_head_sha": "abc123",
        },
    )


def _markdown() -> str:
    return """```json
{
  "verdict": "APPROVE",
  "reasoning": "All checks pass.",
  "recommended_action": "comment",
  "comment_body": "Approved after reviewing the worker feedback."
}
```"""


class QueenHandlerParserTests(unittest.TestCase):
    def test_is_queen_job_requires_discriminator(self) -> None:
        self.assertTrue(is_queen_job(_job()))
        self.assertFalse(is_queen_job(Job("task:1", "x", {"task_id": "1"})))

    def test_parse_decision_output_accepts_fenced_json(self) -> None:
        parsed = parse_decision_output(_markdown())
        self.assertEqual(parsed.verdict, "APPROVE")
        self.assertEqual(parsed.recommended_action, "comment")
        self.assertIn("Approved", parsed.comment_body)

    def test_parse_decision_output_strips_model_supplied_seal_header(self) -> None:
        parsed = parse_decision_output(
            """{"verdict":"COMMENT","reasoning":"ok","recommended_action":"comment",
            "comment_body":"<!-- hivemoot:queen-action:comment:bad -->\\nBody"}"""
        )
        self.assertEqual(parsed.comment_body, "Body")

    def test_parse_decision_output_strips_hivemoot_metadata_markers(self) -> None:
        parsed = parse_decision_output(
            """{"verdict":"COMMENT","reasoning":"ok","recommended_action":"comment",
            "comment_body":"<!-- hivemoot-metadata: {\\"fake\\": true} -->\\nBody"}"""
        )
        self.assertEqual(parsed.comment_body, "Body")

    def test_build_seal_header_matches_web_verifier_contract(self) -> None:
        self.assertEqual(
            build_seal_header("comment", "123-0"),
            "<!-- hivemoot:queen-action:comment:123-0 -->",
        )


class QueenHandlerFlowTests(unittest.TestCase):
    def test_comment_path_resolves_posts_comment_and_seals(self) -> None:
        resolved = ResolveActionResult(
            permitted_action="comment",
            clamped_verdict="APPROVE",
            downgrade_reason=None,
            reviewed_head_sha="abc123",
            current_head_sha="abc123",
            floor_overridden=False,
            audit_id="123-0",
        )
        sealed = SealDecisionResult(
            final_state="closed",
            closed_sequence=13,
            audit_id="123-0",
        )

        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.queen.handler.q_api.resolve_action",
            return_value=resolved,
        ) as resolve_mock, patch(
            "hivemoot_agent.plugins_builtin.hivemoot.queen.handler.q_api.mint_installation_token",
            return_value="ghs_x",
        ) as mint_mock, patch(
            "hivemoot_agent.plugins_builtin.hivemoot.queen.handler.gh.post_pr_comment",
            return_value="https://github.com/owner/repo/pull/42#issuecomment-7",
        ) as comment_mock, patch(
            "hivemoot_agent.plugins_builtin.hivemoot.queen.handler.q_api.seal_decision",
            return_value=sealed,
        ) as seal_mock:
            handle_queen_job_finished(
                _job(),
                AgentResult(0, ""),
                base_url="https://api.example",
                bearer="bearer",
                extracted_markdown=_markdown(),
                queen_runner="queen-a",
                agent_id="queen-a",
            )

        resolve_mock.assert_called_once()
        resolve_kwargs = resolve_mock.call_args.kwargs
        self.assertEqual(resolve_kwargs["recommended_action"], "comment")
        self.assertEqual(resolve_kwargs["reviewed_head_sha"], "abc123")
        mint_mock.assert_called_once_with(
            "https://api.example",
            "bearer",
            repo="owner/repo",
            agent_id="queen-a",
        )
        public_comment = comment_mock.call_args[0][1]
        self.assertIn(
            "<!-- hivemoot:queen-action:comment:123-0 -->",
            public_comment,
        )
        seal_kwargs = seal_mock.call_args.kwargs
        self.assertEqual(
            seal_kwargs["comment_url"],
            "https://github.com/owner/repo/pull/42#issuecomment-7",
        )
        self.assertEqual(seal_kwargs["decision"]["sequence_closed"], 12)
        self.assertNotIn("hivemoot:queen-action", seal_kwargs["decision"]["content"])

    def test_comment_path_retries_seal_once_after_comment_posts(self) -> None:
        resolved = ResolveActionResult(
            permitted_action="comment",
            clamped_verdict="APPROVE",
            downgrade_reason=None,
            reviewed_head_sha="abc123",
            current_head_sha="abc123",
            floor_overridden=False,
            audit_id="123-0",
        )
        sealed = SealDecisionResult(
            final_state="closed",
            closed_sequence=13,
            audit_id="123-0",
        )

        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.queen.handler.q_api.resolve_action",
            return_value=resolved,
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.queen.handler.q_api.mint_installation_token",
            return_value="ghs_x",
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.queen.handler.gh.post_pr_comment",
            return_value="https://github.com/owner/repo/pull/42#issuecomment-7",
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.queen.handler.q_api.seal_decision",
            side_effect=[RuntimeError("transient"), sealed],
        ) as seal_mock:
            handle_queen_job_finished(
                _job(),
                AgentResult(0, ""),
                base_url="https://api.example",
                bearer="bearer",
                extracted_markdown=_markdown(),
                queen_runner="queen-a",
                agent_id="queen-a",
            )

        self.assertEqual(seal_mock.call_count, 2)
        self.assertEqual(seal_mock.call_args.kwargs["retry_count"], 1)

    def test_squash_merge_path_seals_decided_pending_action(self) -> None:
        resolved = ResolveActionResult(
            permitted_action="squash-merge",
            clamped_verdict="APPROVE",
            downgrade_reason=None,
            reviewed_head_sha="abc123",
            current_head_sha="abc123",
            floor_overridden=False,
            audit_id="123-0",
        )
        sealed = SealDecisionResult(
            final_state="decided_pending_action",
            closed_sequence=0,
            audit_id="123-0",
            pending_sequence=13,
        )
        markdown = """```json
{
  "verdict": "APPROVE",
  "reasoning": "All checks pass.",
  "recommended_action": "squash-merge",
  "comment_body": "Intent to squash merge after override window."
}
```"""

        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.queen.handler.q_api.resolve_action",
            return_value=resolved,
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.queen.handler.q_api.mint_installation_token",
            return_value="ghs_x",
        ), patch(
            "hivemoot_agent.plugins_builtin.hivemoot.queen.handler.gh.post_pr_comment",
            return_value="https://github.com/owner/repo/pull/42#issuecomment-7",
        ) as comment_mock, patch(
            "hivemoot_agent.plugins_builtin.hivemoot.queen.handler.q_api.seal_decision",
            return_value=sealed,
        ) as seal_mock:
            handle_queen_job_finished(
                _job(),
                AgentResult(0, ""),
                base_url="https://api.example",
                bearer="bearer",
                extracted_markdown=markdown,
                queen_runner="queen-a",
                agent_id="queen-a",
                enable_squash_merge=True,
            )

        self.assertIn(
            "<!-- hivemoot:queen-action:merge:123-0 -->",
            comment_mock.call_args[0][1],
        )
        self.assertEqual(
            seal_mock.call_args.kwargs["final_state"],
            "decided_pending_action",
        )

    def test_nonzero_exit_does_not_mutate(self) -> None:
        with patch(
            "hivemoot_agent.plugins_builtin.hivemoot.queen.handler.q_api.resolve_action",
            MagicMock(),
        ) as resolve_mock:
            handle_queen_job_finished(
                _job(),
                AgentResult(1, "failed"),
                base_url="https://api.example",
                bearer="bearer",
                extracted_markdown="",
                queen_runner="queen-a",
            )
        resolve_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
