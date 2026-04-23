"""Tests for cli/hivemoot_agent/worker.py — container entrypoint.

Each test runs in an isolated env (relevant vars cleared in setUp,
restored in tearDown) so ordering is irrelevant and the developer's
shell env can't pollute results.

cmd_worker normally hands off to Engine().oneshot() at the end; the
HappyPath tests patch that so we observe the prep work without
spinning up a real engine.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from typing import Any
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent import worker as worker_cli


# Env keys the worker module reads or writes.  Cleared in setUp so
# each test starts from a known baseline.
_RELEVANT_ENV = (
    "HOME",
    "AGENT_PLUGINS",
    "AGENT_PROVIDER",
    "AGENT_TRIGGER",
    "DOCKER_PROVIDER",
    "TARGET_REPO",
    "GITHUB_REPOS",
    "GITHUB_TOKEN",
    "GITHUB_TOKEN_FILE",
    "GH_TOKEN",
    "AGENT_GITHUB_TOKEN",
    "AGENT_GITHUB_TOKEN_FILE",
    "AGENT_TOKEN",
    "AGENT_TOKEN_FILE",
    "AGENT_GITHUB_TOKEN_01",
    "AGENT_GITHUB_TOKEN_01_FILE",
    "GITHUB_CLONE_DEPTH",
    "GIT_CLONE_DEPTH",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "OPENAI_API_KEY_FILE",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_API_KEY_FILE",
    "GEMINI_API_KEY",
    "GEMINI_API_KEY_FILE",
    "GOOGLE_API_KEY",
    "GOOGLE_API_KEY_FILE",
    "OPENROUTER_API_KEY",
    "OPENROUTER_API_KEY_FILE",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE",
    "KILOCODE_TOKEN",
    "KILOCODE_TOKEN_FILE",
    "ZAI_API_KEY",
    "ZAI_API_KEY_FILE",
)


class _EnvIsolated(unittest.TestCase):
    """Base class: snapshot+clear the env keys in _RELEVANT_ENV, restore on teardown."""

    def setUp(self) -> None:
        self._saved = {k: os.environ.pop(k, None) for k in _RELEVANT_ENV}

    def tearDown(self) -> None:
        # Drop anything tests added; restore originals.
        for k in _RELEVANT_ENV:
            os.environ.pop(k, None)
        for k, v in self._saved.items():
            if v is not None:
                os.environ[k] = v


def _make_args() -> argparse.Namespace:
    return argparse.Namespace()


class SecretResolutionTests(_EnvIsolated):
    def test_returns_empty_when_neither_set(self) -> None:
        self.assertEqual(worker_cli._resolve_secret_value("OPENAI_API_KEY"), "")

    def test_returns_bare_value(self) -> None:
        os.environ["OPENAI_API_KEY"] = "sk-abc"
        self.assertEqual(
            worker_cli._resolve_secret_value("OPENAI_API_KEY"), "sk-abc",
        )

    def test_reads_file_value(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "key")
            with open(path, "w") as f:
                f.write("sk-xyz\n")
            os.environ["OPENAI_API_KEY_FILE"] = path
            self.assertEqual(
                worker_cli._resolve_secret_value("OPENAI_API_KEY"), "sk-xyz",
            )

    def test_strips_internal_crlf_like_shell(self) -> None:
        # Shell used `tr -d '\r\n'` which strips ANY CR/LF, including
        # mid-string ones (not just trailing).  Match that.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "key")
            with open(path, "wb") as f:
                f.write(b"sk-\rab\nc\n")
            os.environ["OPENAI_API_KEY_FILE"] = path
            self.assertEqual(
                worker_cli._resolve_secret_value("OPENAI_API_KEY"), "sk-abc",
            )

    def test_mutual_exclusion(self) -> None:
        os.environ["OPENAI_API_KEY"] = "sk-bare"
        os.environ["OPENAI_API_KEY_FILE"] = "/some/path"
        with self.assertRaises(RuntimeError) as ctx:
            worker_cli._resolve_secret_value("OPENAI_API_KEY")
        self.assertIn("not both", str(ctx.exception))

    def test_missing_file_raises(self) -> None:
        os.environ["OPENAI_API_KEY_FILE"] = "/definitely/not/here"
        with self.assertRaises(RuntimeError) as ctx:
            worker_cli._resolve_secret_value("OPENAI_API_KEY")
        self.assertIn("file does not exist", str(ctx.exception))


class LoadProviderSecretsTests(_EnvIsolated):
    def test_promotes_each_file_to_bare(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "anthropic")
            with open(path, "w") as f:
                f.write("sk-ant-abc")
            os.environ["ANTHROPIC_API_KEY_FILE"] = path
            worker_cli._load_provider_secrets()
        self.assertEqual(os.environ.get("ANTHROPIC_API_KEY"), "sk-ant-abc")
        self.assertNotIn("ANTHROPIC_API_KEY_FILE", os.environ)

    def test_skips_unset(self) -> None:
        # No secrets configured → no env mutation, no exception.
        worker_cli._load_provider_secrets()
        for var in worker_cli._PROVIDER_SECRETS:
            self.assertNotIn(var, os.environ)

    def test_propagates_mutual_exclusion_failure(self) -> None:
        os.environ["GEMINI_API_KEY"] = "x"
        os.environ["GEMINI_API_KEY_FILE"] = "/y"
        with self.assertRaises(RuntimeError):
            worker_cli._load_provider_secrets()


class ClaudeBootstrapTests(_EnvIsolated):
    def test_noop_without_token(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["HOME"] = tmp
            worker_cli._bootstrap_claude_credentials()
            self.assertFalse(os.path.exists(os.path.join(tmp, ".claude")))
            self.assertFalse(os.path.exists(os.path.join(tmp, ".claude.json")))

    def test_writes_credentials_and_onboarding(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["HOME"] = tmp
            os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = "tok-xyz"
            worker_cli._bootstrap_claude_credentials()

            creds_path = os.path.join(tmp, ".claude", ".credentials.json")
            self.assertTrue(os.path.exists(creds_path))
            with open(creds_path) as f:
                creds = json.load(f)
            self.assertEqual(
                creds,
                {
                    "claudeAiOauth": {
                        "accessToken": "tok-xyz",
                        "expiresAt": worker_cli._CLAUDE_OAUTH_EXPIRES_AT_MS,
                    },
                },
            )

            onboarding_path = os.path.join(tmp, ".claude.json")
            with open(onboarding_path) as f:
                self.assertEqual(
                    f.read().strip(), '{"hasCompletedOnboarding":true}',
                )

    def test_files_are_mode_600(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["HOME"] = tmp
            os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = "tok"
            worker_cli._bootstrap_claude_credentials()
            for rel in (".claude/.credentials.json", ".claude.json"):
                mode = stat.S_IMODE(os.lstat(os.path.join(tmp, rel)).st_mode)
                self.assertEqual(mode, 0o600, f"{rel} has mode {oct(mode)}")

    def test_token_with_special_chars_round_trips(self) -> None:
        # Quotes and backslashes have to make it through the JSON encoding;
        # this is the regression case the deleted shell test enforced.
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["HOME"] = tmp
            os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = 'tok"en\\slash'
            worker_cli._bootstrap_claude_credentials()
            with open(os.path.join(tmp, ".claude", ".credentials.json")) as f:
                self.assertEqual(
                    f.read(),
                    '{"claudeAiOauth":{"accessToken":"tok\\"en\\\\slash","expiresAt":4102444800000}}',
                )


class ProviderMismatchTests(_EnvIsolated):
    def test_docker_all_passes_through(self) -> None:
        os.environ["DOCKER_PROVIDER"] = "all"
        os.environ["AGENT_PROVIDER"] = "claude"
        # Should not call sys.exit.
        worker_cli._check_provider_match()

    def test_docker_unset_passes_through(self) -> None:
        # Default is "all".
        os.environ["AGENT_PROVIDER"] = "claude"
        worker_cli._check_provider_match()

    def test_match_passes(self) -> None:
        os.environ["DOCKER_PROVIDER"] = "claude"
        os.environ["AGENT_PROVIDER"] = "claude"
        worker_cli._check_provider_match()

    def test_mismatch_fails_with_actionable_messages(self) -> None:
        os.environ["DOCKER_PROVIDER"] = "codex"
        os.environ["AGENT_PROVIDER"] = "claude"
        captured = io.StringIO()
        with patch("sys.stderr", captured):
            with self.assertRaises(SystemExit) as ctx:
                worker_cli._check_provider_match()
        self.assertEqual(ctx.exception.code, 1)
        out = captured.getvalue()
        self.assertIn(
            "Provider mismatch: image built for 'codex' but AGENT_PROVIDER='claude'.",
            out,
        )
        self.assertIn(
            "Use baked provider: set AGENT_PROVIDER=codex in .env", out,
        )
        self.assertIn(
            "Switch providers:   PROVIDER=claude docker compose build hivemoot-agent",
            out,
        )

    def test_default_agent_provider_is_claude(self) -> None:
        # AGENT_PROVIDER unset → defaults to claude → mismatches a
        # non-all DOCKER_PROVIDER.
        os.environ["DOCKER_PROVIDER"] = "codex"
        with patch("sys.stderr", io.StringIO()):
            with self.assertRaises(SystemExit):
                worker_cli._check_provider_match()


class GitHubTokenBridgingTests(_EnvIsolated):
    def test_explicit_github_token_wins(self) -> None:
        os.environ["GITHUB_TOKEN"] = "explicit"
        os.environ["AGENT_TOKEN"] = "fallback"
        worker_cli._bridge_github_token()
        self.assertEqual(os.environ["GITHUB_TOKEN"], "explicit")
        self.assertNotIn("GITHUB_TOKEN_FILE", os.environ)

    def test_explicit_github_token_file_wins(self) -> None:
        os.environ["GITHUB_TOKEN_FILE"] = "/explicit"
        os.environ["AGENT_TOKEN"] = "fallback"
        worker_cli._bridge_github_token()
        self.assertEqual(os.environ["GITHUB_TOKEN_FILE"], "/explicit")
        self.assertNotIn("GITHUB_TOKEN", os.environ)

    def test_gh_token_falls_back(self) -> None:
        os.environ["GH_TOKEN"] = "gh-x"
        worker_cli._bridge_github_token()
        self.assertEqual(os.environ["GITHUB_TOKEN"], "gh-x")

    def test_agent_github_token_file_falls_back(self) -> None:
        os.environ["AGENT_GITHUB_TOKEN_FILE"] = "/agent/file"
        worker_cli._bridge_github_token()
        self.assertEqual(os.environ["GITHUB_TOKEN_FILE"], "/agent/file")

    def test_agent_github_token_falls_back(self) -> None:
        os.environ["AGENT_GITHUB_TOKEN"] = "agent-x"
        worker_cli._bridge_github_token()
        self.assertEqual(os.environ["GITHUB_TOKEN"], "agent-x")

    def test_agent_token_file_falls_back(self) -> None:
        os.environ["AGENT_TOKEN_FILE"] = "/at/file"
        worker_cli._bridge_github_token()
        self.assertEqual(os.environ["GITHUB_TOKEN_FILE"], "/at/file")

    def test_agent_token_falls_back(self) -> None:
        os.environ["AGENT_TOKEN"] = "at-x"
        worker_cli._bridge_github_token()
        self.assertEqual(os.environ["GITHUB_TOKEN"], "at-x")

    def test_agent_github_token_01_file_falls_back(self) -> None:
        os.environ["AGENT_GITHUB_TOKEN_01_FILE"] = "/01/file"
        worker_cli._bridge_github_token()
        self.assertEqual(os.environ["GITHUB_TOKEN_FILE"], "/01/file")

    def test_agent_github_token_01_falls_back(self) -> None:
        os.environ["AGENT_GITHUB_TOKEN_01"] = "01-x"
        worker_cli._bridge_github_token()
        self.assertEqual(os.environ["GITHUB_TOKEN"], "01-x")

    def test_chain_priority_gh_over_agent_github(self) -> None:
        os.environ["GH_TOKEN"] = "gh-wins"
        os.environ["AGENT_GITHUB_TOKEN"] = "loses"
        os.environ["AGENT_TOKEN"] = "also-loses"
        worker_cli._bridge_github_token()
        self.assertEqual(os.environ["GITHUB_TOKEN"], "gh-wins")

    def test_chain_priority_agent_github_over_agent_token(self) -> None:
        os.environ["AGENT_GITHUB_TOKEN"] = "agh-wins"
        os.environ["AGENT_TOKEN"] = "at-loses"
        worker_cli._bridge_github_token()
        self.assertEqual(os.environ["GITHUB_TOKEN"], "agh-wins")

    def test_no_sources_leaves_env_clean(self) -> None:
        worker_cli._bridge_github_token()
        self.assertNotIn("GITHUB_TOKEN", os.environ)
        self.assertNotIn("GITHUB_TOKEN_FILE", os.environ)


class TargetRepoValidationTests(_EnvIsolated):
    def test_valid_repos_pass(self) -> None:
        for repo in ("owner/repo", "Owner/Repo-name", "a/b", "h-1/r_2.x"):
            with self.subTest(repo=repo):
                worker_cli._validate_target_repo(repo)

    def test_empty_rejected(self) -> None:
        with patch("sys.stderr", io.StringIO()):
            with self.assertRaises(SystemExit):
                worker_cli._validate_target_repo("")

    def test_no_slash_rejected(self) -> None:
        with patch("sys.stderr", io.StringIO()):
            with self.assertRaises(SystemExit):
                worker_cli._validate_target_repo("owner")

    def test_dot_segments_rejected(self) -> None:
        for repo in ("owner/.", "owner/.."):
            with self.subTest(repo=repo):
                with patch("sys.stderr", io.StringIO()):
                    with self.assertRaises(SystemExit):
                        worker_cli._validate_target_repo(repo)

    def test_invalid_chars_rejected(self) -> None:
        for repo in ("owner/repo space", "owner/../etc", "owner/r;m"):
            with self.subTest(repo=repo):
                with patch("sys.stderr", io.StringIO()):
                    with self.assertRaises(SystemExit):
                        worker_cli._validate_target_repo(repo)


class PrepareDispatchTests(_EnvIsolated):
    def test_missing_agent_plugins_fails(self) -> None:
        with patch("sys.stderr", io.StringIO()) as captured:
            with self.assertRaises(SystemExit) as ctx:
                worker_cli._prepare_plugin_engine_dispatch()
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("AGENT_PLUGINS is required", captured.getvalue())

    def test_target_repo_propagates_to_github_repos(self) -> None:
        os.environ["AGENT_PLUGINS"] = "github"
        os.environ["TARGET_REPO"] = "owner/repo"
        worker_cli._prepare_plugin_engine_dispatch()
        self.assertEqual(os.environ["GITHUB_REPOS"], "owner/repo")

    def test_existing_github_repos_not_overwritten(self) -> None:
        os.environ["AGENT_PLUGINS"] = "github"
        os.environ["TARGET_REPO"] = "owner/repo"
        os.environ["GITHUB_REPOS"] = "other/repo"
        worker_cli._prepare_plugin_engine_dispatch()
        self.assertEqual(os.environ["GITHUB_REPOS"], "other/repo")

    def test_git_clone_depth_legacy_alias(self) -> None:
        os.environ["AGENT_PLUGINS"] = "github"
        os.environ["GIT_CLONE_DEPTH"] = "1"
        worker_cli._prepare_plugin_engine_dispatch()
        self.assertEqual(os.environ["GITHUB_CLONE_DEPTH"], "1")

    def test_invalid_target_repo_rejected(self) -> None:
        os.environ["AGENT_PLUGINS"] = "github"
        os.environ["TARGET_REPO"] = "not-owner-repo"
        with patch("sys.stderr", io.StringIO()):
            with self.assertRaises(SystemExit):
                worker_cli._prepare_plugin_engine_dispatch()


class CmdWorkerTests(_EnvIsolated):
    def test_agent_trigger_rejected(self) -> None:
        os.environ["AGENT_TRIGGER"] = "github-mention"
        os.environ["AGENT_PLUGINS"] = "github"
        os.environ["HOME"] = tempfile.gettempdir()
        captured = io.StringIO()
        with patch("sys.stderr", captured):
            self.assertEqual(worker_cli.cmd_worker(_make_args()), 1)
        out = captured.getvalue()
        self.assertIn("AGENT_TRIGGER is controller-only", out)
        self.assertIn("Use hivemoot-agent run", out)

    def test_missing_plugins_fails(self) -> None:
        os.environ["HOME"] = tempfile.gettempdir()
        captured = io.StringIO()
        with patch("sys.stderr", captured):
            with self.assertRaises(SystemExit) as ctx:
                worker_cli.cmd_worker(_make_args())
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("AGENT_PLUGINS is required", captured.getvalue())

    def test_provider_mismatch_fails_before_engine(self) -> None:
        os.environ["DOCKER_PROVIDER"] = "codex"
        os.environ["AGENT_PROVIDER"] = "claude"
        os.environ["AGENT_PLUGINS"] = "github"
        os.environ["HOME"] = tempfile.gettempdir()
        captured = io.StringIO()
        # Engine.oneshot must NOT be reached.
        with patch("sys.stderr", captured), patch(
            "hivemoot_agent.engine.Engine",
        ) as engine_mock:
            with self.assertRaises(SystemExit) as ctx:
                worker_cli.cmd_worker(_make_args())
        self.assertEqual(ctx.exception.code, 1)
        engine_mock.assert_not_called()

    def test_secret_mutual_exclusion_fails_before_engine(self) -> None:
        os.environ["AGENT_PLUGINS"] = "github"
        os.environ["HOME"] = tempfile.gettempdir()
        os.environ["OPENAI_API_KEY"] = "x"
        os.environ["OPENAI_API_KEY_FILE"] = "/y"
        with patch("sys.stderr", io.StringIO()), patch(
            "hivemoot_agent.engine.Engine",
        ) as engine_mock:
            self.assertEqual(worker_cli.cmd_worker(_make_args()), 1)
        engine_mock.assert_not_called()

    def test_happy_path_calls_engine_oneshot(self) -> None:
        # All prereqs satisfied → engine.oneshot() called once and its
        # exit code propagated.
        os.environ["AGENT_PLUGINS"] = "github"
        os.environ["AGENT_PROVIDER"] = "claude"
        os.environ["DOCKER_PROVIDER"] = "all"
        os.environ["AGENT_TOKEN"] = "ghp-token"
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["HOME"] = tmp
            os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = "claude-oauth"

            with patch("hivemoot_agent.engine.Engine") as engine_cls:
                engine_inst = engine_cls.return_value
                engine_inst.oneshot.return_value = 0
                rc = worker_cli.cmd_worker(_make_args())

            engine_cls.assert_called_once_with()
            engine_inst.oneshot.assert_called_once_with()
            self.assertEqual(rc, 0)

            # Side effects we can verify:
            self.assertEqual(os.environ.get("GITHUB_TOKEN"), "ghp-token")
            self.assertTrue(
                os.path.exists(os.path.join(tmp, ".claude", ".credentials.json"))
            )

    def test_claude_oauth_token_file_seeds_credentials(self) -> None:
        # Regression: the bootstrap step must run AFTER provider secret
        # loading so CLAUDE_CODE_OAUTH_TOKEN_FILE -> bare promotion
        # has happened before _bootstrap_claude_credentials reads the
        # bare env var.  Inverting these steps silently broke the
        # documented `*_FILE` path for managed Claude auth.
        os.environ["AGENT_PLUGINS"] = "github"
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["HOME"] = tmp
            token_path = os.path.join(tmp, "claude-oauth-token")
            with open(token_path, "w") as f:
                f.write("token-from-file")
            os.environ["CLAUDE_CODE_OAUTH_TOKEN_FILE"] = token_path

            with patch("hivemoot_agent.engine.Engine") as engine_cls:
                engine_cls.return_value.oneshot.return_value = 0
                rc = worker_cli.cmd_worker(_make_args())

            self.assertEqual(rc, 0)
            creds_path = os.path.join(tmp, ".claude", ".credentials.json")
            self.assertTrue(
                os.path.exists(creds_path),
                "credentials.json should be seeded from CLAUDE_CODE_OAUTH_TOKEN_FILE",
            )
            with open(creds_path) as f:
                creds = json.load(f)
            self.assertEqual(
                creds["claudeAiOauth"]["accessToken"], "token-from-file",
            )

    def test_engine_exit_code_is_propagated(self) -> None:
        os.environ["AGENT_PLUGINS"] = "github"
        os.environ["HOME"] = tempfile.gettempdir()
        with patch("hivemoot_agent.engine.Engine") as engine_cls:
            engine_cls.return_value.oneshot.return_value = 42
            rc = worker_cli.cmd_worker(_make_args())
        self.assertEqual(rc, 42)


if __name__ == "__main__":
    unittest.main(verbosity=2)
