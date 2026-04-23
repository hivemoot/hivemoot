"""Tests for the github watcher subprocess wrapper.

We don't exercise the real ``hivemoot`` binary here — the tests mock
``subprocess.run`` so the parsing, error mapping, and command shape can
be verified deterministically without depending on the Go binary.
"""

from __future__ import annotations

import os
import subprocess
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.github import watcher


class ParseEventsTests(unittest.TestCase):
    def test_parses_well_formed_lines(self) -> None:
        stdout = (
            '{"threadId":"t1","number":42,"title":"hi","author":"alice",'
            '"url":"https://x/1","timestamp":"2026-04-17T00:00:00Z"}\n'
            '{"threadId":"t2","number":43,"title":"yo","author":"bob",'
            '"url":"https://x/2","timestamp":"2026-04-17T00:00:01Z"}\n'
        )
        events = watcher.parse_events(stdout)
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0].thread_id, "t1")
        self.assertEqual(events[0].number, "42")
        self.assertEqual(events[1].author, "bob")

    def test_skips_blank_lines(self) -> None:
        events = watcher.parse_events(
            '\n\n{"threadId":"t1","number":1,"timestamp":"x"}\n\n',
        )
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].thread_id, "t1")

    def test_tolerates_malformed_json(self) -> None:
        # A single bad line should not silence the rest of the batch.
        stdout = (
            "this-is-not-json\n"
            '{"threadId":"t2","number":2,"timestamp":"y"}\n'
        )
        events = watcher.parse_events(stdout)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].thread_id, "t2")

    def test_default_unknown_author(self) -> None:
        events = watcher.parse_events(
            '{"threadId":"t","number":1,"timestamp":"x"}\n',
        )
        self.assertEqual(events[0].author, "unknown")

    def test_ack_key_combines_thread_and_timestamp(self) -> None:
        events = watcher.parse_events(
            '{"threadId":"t-1","number":1,"timestamp":"2026-04-17"}\n',
        )
        self.assertEqual(events[0].ack_key, "t-1:2026-04-17")

    def test_ack_key_empty_when_missing_pieces(self) -> None:
        events = watcher.parse_events(
            '{"threadId":"t-1","number":1}\n',
        )
        self.assertEqual(events[0].ack_key, "")

    def test_display_number_falls_back(self) -> None:
        events = watcher.parse_events(
            '{"threadId":"t","timestamp":"x"}\n',
        )
        self.assertEqual(events[0].display_number, "?")


class PollOnceTests(unittest.TestCase):
    def _completed(self, stdout: str = "", returncode: int = 0,
                   stderr: str = "") -> MagicMock:
        cp = MagicMock()
        cp.stdout = stdout
        cp.stderr = stderr
        cp.returncode = returncode
        return cp

    def test_command_shape(self) -> None:
        with patch(
            "hivemoot_agent.plugins_builtin.github.watcher.subprocess.run"
        ) as run:
            run.return_value = self._completed()
            watcher.poll_once(
                repo="owner/repo",
                state_file="/state.json",
                interval_secs=60,
                gh_token="abc",
            )
        cmd = run.call_args.args[0]
        self.assertIn("hivemoot", cmd[0])
        self.assertIn("--repo", cmd)
        self.assertIn("owner/repo", cmd)
        self.assertIn("--state-file", cmd)
        self.assertIn("/state.json", cmd)
        self.assertIn("--once", cmd)
        env = run.call_args.kwargs["env"]
        self.assertEqual(env["GH_TOKEN"], "abc")

    def test_reasons_are_passed_through(self) -> None:
        with patch(
            "hivemoot_agent.plugins_builtin.github.watcher.subprocess.run"
        ) as run:
            run.return_value = self._completed()
            watcher.poll_once(
                repo="owner/repo",
                state_file="/s.json",
                interval_secs=30,
                gh_token="t",
                reasons=["review_requested"],
            )
        cmd = run.call_args.args[0]
        self.assertIn("--reasons", cmd)
        idx = cmd.index("--reasons")
        self.assertEqual(cmd[idx + 1], "review_requested")

    def test_nonzero_exit_raises_runtime_error(self) -> None:
        with patch(
            "hivemoot_agent.plugins_builtin.github.watcher.subprocess.run"
        ) as run:
            run.return_value = self._completed(
                returncode=2, stderr="boom",
            )
            with self.assertRaises(RuntimeError) as ctx:
                watcher.poll_once(
                    repo="o/r", state_file="/s",
                    interval_secs=60, gh_token="t",
                )
        self.assertIn("boom", str(ctx.exception))

    def test_missing_binary_raises_runtime_error(self) -> None:
        with patch(
            "hivemoot_agent.plugins_builtin.github.watcher.subprocess.run",
            side_effect=FileNotFoundError(),
        ):
            with self.assertRaises(RuntimeError) as ctx:
                watcher.poll_once(
                    repo="o/r", state_file="/s",
                    interval_secs=60, gh_token="t",
                )
        self.assertIn("not found", str(ctx.exception))

    def test_timeout_raises_runtime_error(self) -> None:
        with patch(
            "hivemoot_agent.plugins_builtin.github.watcher.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="x", timeout=1),
        ):
            with self.assertRaises(RuntimeError):
                watcher.poll_once(
                    repo="o/r", state_file="/s",
                    interval_secs=60, gh_token="t",
                )

    def test_returns_parsed_events(self) -> None:
        stdout = '{"threadId":"t","number":7,"timestamp":"x"}\n'
        with patch(
            "hivemoot_agent.plugins_builtin.github.watcher.subprocess.run"
        ) as run:
            run.return_value = self._completed(stdout=stdout)
            events = watcher.poll_once(
                repo="o/r", state_file="/s",
                interval_secs=60, gh_token="t",
            )
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].number, "7")

    def test_missing_args_validate_eagerly(self) -> None:
        with self.assertRaises(ValueError):
            watcher.poll_once(
                repo="", state_file="/s", interval_secs=60, gh_token="t",
            )
        with self.assertRaises(ValueError):
            watcher.poll_once(
                repo="o/r", state_file="", interval_secs=60, gh_token="t",
            )
        with self.assertRaises(ValueError):
            watcher.poll_once(
                repo="o/r", state_file="/s", interval_secs=60, gh_token="",
            )


if __name__ == "__main__":
    unittest.main()
