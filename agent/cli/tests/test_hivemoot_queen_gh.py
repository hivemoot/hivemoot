"""Tests for local queen GitHub CLI helpers."""

from __future__ import annotations

import os
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.hivemoot.queen import gh


class QueenGhTests(unittest.TestCase):
    def test_list_pull_requests_parses_snapshots_and_filters_env(self) -> None:
        payload = """[
          {
            "number": 42,
            "title": "Fix it",
            "state": "open",
            "draft": false,
            "user": {"login": "builder"},
            "head": {"sha": "abc123"},
            "base": {"ref": "main", "repo": {"default_branch": "main"}}
          }
        ]"""
        with patch.dict(
            os.environ,
            {"PATH": "/usr/bin", "HIVEMOOT_AGENT_TOKEN": "must-not-leak"},
            clear=True,
        ), patch(
            "subprocess.run",
            return_value=subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=payload,
                stderr="",
            ),
        ) as run_mock:
            pulls = gh.list_pull_requests(
                "owner/repo",
                token="ghs_secret",
                state="all",
                timeout_secs=30,
            )

        self.assertEqual(len(pulls), 1)
        self.assertEqual(pulls[0].number, 42)
        self.assertEqual(pulls[0].head_sha, "abc123")
        self.assertTrue(pulls[0].targets_default_branch)
        self.assertEqual(
            run_mock.call_args.args[0],
            [
                "gh",
                "api",
                "repos/owner/repo/pulls?state=all&sort=updated&direction=desc&per_page=100",
            ],
        )
        env = run_mock.call_args.kwargs["env"]
        self.assertEqual(env["GH_TOKEN"], "ghs_secret")
        self.assertNotIn("HIVEMOOT_AGENT_TOKEN", env)

    def test_squash_merge_pins_expected_head_sha_and_limits_env(self) -> None:
        pr = gh.PullRequestRef(owner="owner", repo="repo", number=42)

        with patch.dict(
            os.environ,
            {
                "PATH": "/usr/bin",
                "HIVEMOOT_AGENT_TOKEN": "must-not-leak",
            },
            clear=True,
        ), patch(
            "subprocess.run",
            side_effect=[
                subprocess.CompletedProcess(
                    args=[],
                    returncode=0,
                    stdout="",
                    stderr="",
                ),
                subprocess.CompletedProcess(
                    args=[],
                    returncode=0,
                    stdout="feedface\n",
                    stderr="",
                ),
            ],
        ) as run_mock:
            result = gh.squash_merge_pr(
                pr,
                expected_head_sha="abc123deadbeef",
                token="ghs_secret",
                timeout_secs=30,
            )

        self.assertEqual(result, "feedface")
        merge_call = run_mock.call_args_list[0]
        self.assertEqual(
            merge_call.args[0],
            [
                "gh",
                "pr",
                "merge",
                "42",
                "--repo",
                "owner/repo",
                "--squash",
                "--match-head-commit",
                "abc123deadbeef",
            ],
        )
        env = merge_call.kwargs["env"]
        self.assertEqual(env["GH_TOKEN"], "ghs_secret")
        self.assertEqual(env["GITHUB_TOKEN"], "ghs_secret")
        self.assertEqual(env["PATH"], "/usr/bin")
        self.assertNotIn("HIVEMOOT_AGENT_TOKEN", env)


if __name__ == "__main__":
    unittest.main(verbosity=2)
