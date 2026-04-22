"""Tests for the new-PR watcher state and gh API wrapper."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.github import pr_watcher


class PollNewPullRequestsTests(unittest.TestCase):
    def _completed(
        self, stdout: str = "[]", returncode: int = 0, stderr: str = ""
    ) -> MagicMock:
        cp = MagicMock()
        cp.stdout = stdout
        cp.stderr = stderr
        cp.returncode = returncode
        return cp

    def test_first_poll_bootstraps_without_emitting_or_querying(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hm-pr-watch-") as tmpdir:
            state_file = os.path.join(tmpdir, "new-prs.json")
            with patch(
                "hivemoot_agent.plugins_builtin.github.pr_watcher.subprocess.run"
            ) as run:
                events = pr_watcher.poll_new_prs_once(
                    repo="owner/repo",
                    state_file=state_file,
                    gh_token="tok",
                )
            with open(state_file, encoding="utf-8") as fh:
                state = json.load(fh)

        self.assertEqual(events, [])
        run.assert_not_called()
        self.assertTrue(state["bootstrapped_at"])
        self.assertEqual(state["acked_numbers"], [])

    def test_command_shape(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hm-pr-watch-") as tmpdir:
            state_file = os.path.join(tmpdir, "new-prs.json")
            with open(state_file, "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "bootstrapped_at": "2026-04-19T00:00:00Z",
                        "acked_numbers": [],
                    },
                    fh,
                )
            with patch(
                "hivemoot_agent.plugins_builtin.github.pr_watcher.subprocess.run"
            ) as run:
                run.return_value = self._completed()
                pr_watcher.poll_new_prs_once(
                    repo="owner/repo",
                    state_file=state_file,
                    gh_token="abc",
                    authors=["hivemoot"],
                )

        cmd = run.call_args.args[0]
        self.assertEqual(cmd[:2], ["gh", "api"])
        self.assertIn("repos/owner/repo/pulls", cmd[2])
        env = run.call_args.kwargs["env"]
        self.assertEqual(env["GH_TOKEN"], "abc")
        self.assertEqual(env["GITHUB_TOKEN"], "abc")

    def test_filters_author_bootstrap_and_acked_prs(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hm-pr-watch-") as tmpdir:
            state_file = os.path.join(tmpdir, "new-prs.json")
            with open(state_file, "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "bootstrapped_at": "2026-04-19T12:00:00Z",
                        "acked_numbers": ["11"],
                    },
                    fh,
                )
            stdout = json.dumps(
                [
                    {
                        "number": 13,
                        "title": "Newest match",
                        "html_url": "https://x/pr/13",
                        "created_at": "2026-04-19T12:03:00Z",
                        "user": {"login": "hivemoot"},
                    },
                    {
                        "number": 12,
                        "title": "Wrong author",
                        "html_url": "https://x/pr/12",
                        "created_at": "2026-04-19T12:02:00Z",
                        "user": {"login": "alice"},
                    },
                    {
                        "number": 11,
                        "title": "Already acked",
                        "html_url": "https://x/pr/11",
                        "created_at": "2026-04-19T12:01:00Z",
                        "user": {"login": "hivemoot"},
                    },
                    {
                        "number": 10,
                        "title": "Before bootstrap",
                        "html_url": "https://x/pr/10",
                        "created_at": "2026-04-19T11:59:59Z",
                        "user": {"login": "hivemoot"},
                    },
                    {
                        "number": 14,
                        "title": "Oldest new match",
                        "html_url": "https://x/pr/14",
                        "created_at": "2026-04-19T12:00:30Z",
                        "user": {"login": "HIVEMOOT"},
                    },
                    {
                        "number": 15,
                        "title": "Draft match",
                        "html_url": "https://x/pr/15",
                        "created_at": "2026-04-19T12:04:00Z",
                        "user": {"login": "hivemoot"},
                        "draft": True,
                    },
                ]
            )
            with patch(
                "hivemoot_agent.plugins_builtin.github.pr_watcher.subprocess.run"
            ) as run:
                run.return_value = self._completed(stdout=stdout)
                events = pr_watcher.poll_new_prs_once(
                    repo="owner/repo",
                    state_file=state_file,
                    gh_token="tok",
                    authors=["hivemoot"],
                )

        self.assertEqual([event.number for event in events], ["14", "13"])

    def test_ack_new_pr_persists_state(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hm-pr-watch-") as tmpdir:
            state_file = os.path.join(tmpdir, "new-prs.json")
            with open(state_file, "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "bootstrapped_at": "2026-04-19T00:00:00Z",
                        "acked_numbers": ["1"],
                    },
                    fh,
                )

            ok = pr_watcher.ack_new_pr("2", state_file)

            with open(state_file, encoding="utf-8") as fh:
                state = json.load(fh)

        self.assertTrue(ok)
        self.assertEqual(state["acked_numbers"], ["1", "2"])

    def test_nonzero_exit_raises_runtime_error(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hm-pr-watch-") as tmpdir:
            state_file = os.path.join(tmpdir, "new-prs.json")
            with open(state_file, "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "bootstrapped_at": "2026-04-19T00:00:00Z",
                        "acked_numbers": [],
                    },
                    fh,
                )
            with patch(
                "hivemoot_agent.plugins_builtin.github.pr_watcher.subprocess.run"
            ) as run:
                run.return_value = self._completed(returncode=1, stderr="boom")
                with self.assertRaises(RuntimeError) as ctx:
                    pr_watcher.poll_new_prs_once(
                        repo="owner/repo",
                        state_file=state_file,
                        gh_token="tok",
                    )
        self.assertIn("boom", str(ctx.exception))

    def test_missing_binary_raises_runtime_error(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hm-pr-watch-") as tmpdir:
            state_file = os.path.join(tmpdir, "new-prs.json")
            with open(state_file, "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "bootstrapped_at": "2026-04-19T00:00:00Z",
                        "acked_numbers": [],
                    },
                    fh,
                )
            with patch(
                "hivemoot_agent.plugins_builtin.github.pr_watcher.subprocess.run",
                side_effect=FileNotFoundError(),
            ):
                with self.assertRaises(RuntimeError) as ctx:
                    pr_watcher.poll_new_prs_once(
                        repo="owner/repo",
                        state_file=state_file,
                        gh_token="tok",
                    )
        self.assertIn("not found", str(ctx.exception))

    def test_missing_args_validate_eagerly(self) -> None:
        with self.assertRaises(ValueError):
            pr_watcher.poll_new_prs_once(
                repo="",
                state_file="/state.json",
                gh_token="tok",
            )
        with self.assertRaises(ValueError):
            pr_watcher.poll_new_prs_once(
                repo="owner/repo",
                state_file="",
                gh_token="tok",
            )
        with self.assertRaises(ValueError):
            pr_watcher.poll_new_prs_once(
                repo="owner/repo",
                state_file="/state.json",
                gh_token="",
            )

    def test_timeout_raises_runtime_error(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hm-pr-watch-") as tmpdir:
            state_file = os.path.join(tmpdir, "new-prs.json")
            with open(state_file, "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "bootstrapped_at": "2026-04-19T00:00:00Z",
                        "acked_numbers": [],
                    },
                    fh,
                )
            with patch(
                "hivemoot_agent.plugins_builtin.github.pr_watcher.subprocess.run",
                side_effect=subprocess.TimeoutExpired(cmd="x", timeout=1),
            ):
                with self.assertRaises(RuntimeError):
                    pr_watcher.poll_new_prs_once(
                        repo="owner/repo",
                        state_file=state_file,
                        gh_token="tok",
                    )


if __name__ == "__main__":
    unittest.main()
