"""Tests for hivemoot_task result extraction and auth-error detection."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.hivemoot_task import (
    auth_errors,
    result_extractor,
)


def _write_lines(path: str, events: list[dict]) -> None:
    with open(path, "w") as f:
        for ev in events:
            f.write(json.dumps(ev) + "\n")


class CodexResultTests(unittest.TestCase):
    def test_picks_last_agent_message(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "codex.log")
            _write_lines(log, [
                {"type": "item.completed",
                 "item": {"type": "agent_message", "text": "first"}},
                {"type": "turn.completed"},
                {"type": "item.completed",
                 "item": {"type": "agent_message", "text": "final answer"}},
            ])
            self.assertEqual(
                result_extractor.extract_codex_result(log), "final answer",
            )

    def test_sidecar_wins_over_log(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "codex.log")
            _write_lines(log, [
                {"type": "item.completed",
                 "item": {"type": "agent_message", "text": "from log"}},
            ])
            sidecar = os.path.join(tmp, "answer.md")
            with open(sidecar, "w") as f:
                f.write("from sidecar")
            self.assertEqual(
                result_extractor.extract_codex_result(log, sidecar_path=sidecar),
                "from sidecar",
            )

    def test_empty_sidecar_falls_back_to_log(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "codex.log")
            _write_lines(log, [
                {"type": "item.completed",
                 "item": {"type": "agent_message", "text": "from log"}},
            ])
            sidecar = os.path.join(tmp, "answer.md")
            open(sidecar, "w").close()  # zero bytes
            self.assertEqual(
                result_extractor.extract_codex_result(log, sidecar_path=sidecar),
                "from log",
            )

    def test_no_agent_message_returns_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "codex.log")
            _write_lines(log, [
                {"type": "turn.completed"},
                {"type": "item.completed", "item": {"type": "tool_call"}},
            ])
            self.assertEqual(result_extractor.extract_codex_result(log), "")

    def test_missing_log_returns_empty(self) -> None:
        self.assertEqual(
            result_extractor.extract_codex_result("/no/such/file"), "",
        )

    def test_skips_non_json_lines(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "codex.log")
            with open(log, "w") as f:
                f.write("plain stderr line\n")
                f.write(json.dumps({
                    "type": "item.completed",
                    "item": {"type": "agent_message", "text": "ok"},
                }) + "\n")
                f.write("garbage\n")
            self.assertEqual(result_extractor.extract_codex_result(log), "ok")


class ClaudeResultTests(unittest.TestCase):
    def test_picks_result_event(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "claude.log")
            _write_lines(log, [
                {"type": "system", "subtype": "init"},
                {"type": "result", "result": "the answer"},
            ])
            self.assertEqual(
                result_extractor.extract_claude_result(log), "the answer",
            )

    def test_no_result_returns_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "claude.log")
            _write_lines(log, [{"type": "system"}])
            self.assertEqual(result_extractor.extract_claude_result(log), "")


class ProviderDispatchTests(unittest.TestCase):
    def test_codex_dispatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "x.log")
            _write_lines(log, [
                {"type": "item.completed",
                 "item": {"type": "agent_message", "text": "x"}},
            ])
            self.assertEqual(
                result_extractor.extract_result("codex", log), "x",
            )

    def test_claude_dispatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "x.log")
            _write_lines(log, [{"type": "result", "result": "y"}])
            self.assertEqual(
                result_extractor.extract_result("claude", log), "y",
            )

    def test_gemini_text_passthrough(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "x.log")
            with open(log, "w") as f:
                f.write("plain output\n")
            self.assertEqual(
                result_extractor.extract_result("gemini", log),
                "plain output\n",
            )


class CodexAuthErrorTests(unittest.TestCase):
    def test_explicit_code(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "log")
            _write_lines(log, [
                {"type": "error", "code": "refresh_token_reused"},
            ])
            self.assertEqual(
                auth_errors.detect_codex_auth_error(log),
                "refresh_token_reused",
            )

    def test_message_promoted_to_auth_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "log")
            _write_lines(log, [
                {"type": "turn.failed",
                 "error": {"message": "Unauthorized request"}},
            ])
            self.assertEqual(
                auth_errors.detect_codex_auth_error(log), "auth_error",
            )

    def test_non_auth_message_returns_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "log")
            _write_lines(log, [
                {"type": "error", "message": "rate limit exceeded"},
            ])
            self.assertEqual(auth_errors.detect_codex_auth_error(log), "")

    def test_string_error_field_does_not_crash(self) -> None:
        # P1 regression: codex sometimes emits {"type":"error","error":"..."}
        # with a STRING error.  Old code did `.get("code")` on that
        # string and raised AttributeError, taking down on_job_finished
        # without posting a fail.  Defensive parse must keep going and
        # detect the auth-class message inside the string.
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "log")
            _write_lines(log, [
                {"type": "error", "error": "Unauthorized request from codex"},
            ])
            self.assertEqual(
                auth_errors.detect_codex_auth_error(log), "auth_error",
            )

    def test_string_error_without_auth_keyword_returns_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "log")
            _write_lines(log, [
                {"type": "error", "error": "rate limit exceeded"},
            ])
            self.assertEqual(auth_errors.detect_codex_auth_error(log), "")

    def test_first_match_wins(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "log")
            _write_lines(log, [
                {"type": "error", "code": "invalid_api_key"},
                {"type": "error", "code": "token_expired"},
            ])
            self.assertEqual(
                auth_errors.detect_codex_auth_error(log), "invalid_api_key",
            )

    def test_missing_log_returns_empty(self) -> None:
        self.assertEqual(
            auth_errors.detect_codex_auth_error("/no/such/file"), "",
        )

    def test_non_error_types_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "log")
            _write_lines(log, [
                {"type": "result", "code": "invalid_api_key"},
            ])
            self.assertEqual(auth_errors.detect_codex_auth_error(log), "")

    def test_auth_prefixed_code_promoted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "log")
            _write_lines(log, [
                {"type": "error", "code": "auth_session_revoked"},
            ])
            self.assertEqual(
                auth_errors.detect_codex_auth_error(log),
                "auth_session_revoked",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
