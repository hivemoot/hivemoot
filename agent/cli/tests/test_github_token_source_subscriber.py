"""Tests for the github plugin's ``token_source: subscriber`` mode.

Validates:

- ``token_source: subscriber`` makes ``token_file`` optional in
  validate() (no error when absent).
- ``token_source: file`` (default) keeps the existing token_file
  required check.
- setup() with ``token_source: subscriber`` does NOT call
  resolve_github_user / configure_git_auth / clone_or_sync —
  those are deferred to the subscriber.
- setup_lifecycle() registers a ``GithubAuthDependentSubscriber``
  when token_source: subscriber and is a no-op otherwise.
- The subscriber's on_active reads ``GH_TOKEN`` from env and runs
  the full auth-required setup.
- The subscriber's on_active raises a clear error when env is empty
  (upstream subscriber didn't fire).
- The subscriber's on_idle is a no-op (workspace persistence + env
  ownership stays with upstream).
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.lifecycle import ContainerLifecycle
from hivemoot_agent.plugins.interfaces import PluginConfig
from hivemoot_agent.plugins_builtin.github import GitHubPlugin
from hivemoot_agent.plugins_builtin.github.auth_subscriber import (
    GithubAuthDependentSubscriber,
)
from hivemoot_agent.plugins_builtin.github.config import GitHubConfig
from hivemoot_agent.plugins_builtin.github.repo_manager import RepoInfo


def _mk_config(
    *,
    token_source: str = "file",
    token_file: Path | None = None,
    repos: list[str] | None = None,
    workspace: str = "/workspace",
) -> PluginConfig:
    typed = GitHubConfig(
        repos=repos if repos is not None else ["acme/repo"],
        token_source=token_source,
        token_file=token_file,
        workspace=Path(workspace),
    )
    return PluginConfig(name="github", typed=typed)


def _clear_token_env() -> None:
    for var in ("GH_TOKEN", "GITHUB_TOKEN"):
        os.environ.pop(var, None)


class _EnvIsolatedTest(unittest.TestCase):
    def setUp(self) -> None:
        _clear_token_env()

    def tearDown(self) -> None:
        _clear_token_env()


# ── validate() ────────────────────────────────────────────────────


class ValidateTest(unittest.TestCase):
    def test_subscriber_mode_does_not_require_token_file(self) -> None:
        plugin = GitHubPlugin()
        cfg = _mk_config(token_source="subscriber", token_file=None)
        self.assertEqual(plugin.validate(cfg), [])

    def test_file_mode_still_requires_token_file(self) -> None:
        plugin = GitHubPlugin()
        cfg = _mk_config(token_source="file", token_file=None)
        errors = plugin.validate(cfg)
        self.assertTrue(any("token_file" in e for e in errors))

    def test_subscriber_mode_still_requires_repos(self) -> None:
        plugin = GitHubPlugin()
        cfg = _mk_config(token_source="subscriber", repos=[])
        errors = plugin.validate(cfg)
        self.assertTrue(any("repos" in e for e in errors))

    def test_invalid_token_source_rejected_by_pydantic(self) -> None:
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            GitHubConfig(repos=["a/b"], token_source="bogus")  # type: ignore[arg-type]


# ── setup() in subscriber mode ────────────────────────────────────


class SetupSubscriberModeTest(unittest.TestCase):
    """setup() must not touch the network/disk under subscriber mode."""

    def test_setup_subscriber_mode_skips_auth_required_steps(self) -> None:
        plugin = GitHubPlugin()
        cfg = _mk_config(token_source="subscriber", token_file=None)

        with patch(
            "hivemoot_agent.plugins_builtin.github._configure_git_auth",
        ) as mock_auth, patch(
            "hivemoot_agent.plugins_builtin.github._validate_repo_access",
        ) as mock_validate, patch(
            "hivemoot_agent.plugins_builtin.github.clone_or_sync",
        ) as mock_clone, patch(
            "hivemoot_agent.plugins_builtin.github.resolve_github_user",
        ) as mock_resolve:
            plugin.setup(cfg)

        mock_auth.assert_not_called()
        mock_validate.assert_not_called()
        mock_clone.assert_not_called()
        mock_resolve.assert_not_called()

        # But auth-free defaults still set so system_prompt has something.
        self.assertEqual(plugin._git_name, "hivemoot-agent")
        self.assertEqual(
            plugin._git_email, "hivemoot-agent@users.noreply.github.com",
        )
        self.assertEqual(plugin._repos, [])

    def test_setup_subscriber_mode_does_not_set_env(self) -> None:
        """Env is owned by the upstream subscriber — github must not
        write GH_TOKEN at setup() time."""
        _clear_token_env()
        try:
            plugin = GitHubPlugin()
            cfg = _mk_config(token_source="subscriber", token_file=None)

            with patch(
                "hivemoot_agent.plugins_builtin.github._configure_git_auth",
            ), patch(
                "hivemoot_agent.plugins_builtin.github._validate_repo_access",
            ), patch(
                "hivemoot_agent.plugins_builtin.github.clone_or_sync",
            ):
                plugin.setup(cfg)

            self.assertNotIn("GH_TOKEN", os.environ)
            self.assertNotIn("GITHUB_TOKEN", os.environ)
        finally:
            _clear_token_env()


# ── setup_lifecycle() ─────────────────────────────────────────────


class SetupLifecycleTest(unittest.TestCase):
    def test_subscriber_mode_registers_auth_subscriber(self) -> None:
        plugin = GitHubPlugin()
        lifecycle = ContainerLifecycle()
        cfg = _mk_config(token_source="subscriber", token_file=None)

        plugin.setup_lifecycle(lifecycle, cfg)

        self.assertEqual(lifecycle.subscriber_count, 1)
        self.assertIsInstance(
            plugin._auth_subscriber, GithubAuthDependentSubscriber,
        )

    def test_file_mode_does_not_register(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            token_file = Path(tmp) / "tok"
            token_file.write_text("ghp_x")
            plugin = GitHubPlugin()
            lifecycle = ContainerLifecycle()
            cfg = _mk_config(token_source="file", token_file=token_file)

            plugin.setup_lifecycle(lifecycle, cfg)

            self.assertEqual(lifecycle.subscriber_count, 0)
            self.assertIsNone(plugin._auth_subscriber)


# ── GithubAuthDependentSubscriber ─────────────────────────────────


class AuthSubscriberOnActiveTest(_EnvIsolatedTest):
    def test_on_active_reads_env_and_runs_auth_required_setup(self) -> None:
        plugin = GitHubPlugin()
        cfg_typed = GitHubConfig(
            repos=["acme/repo"],
            token_source="subscriber",
            workspace=Path("/workspace"),
        )
        sub = GithubAuthDependentSubscriber(plugin, cfg_typed)

        os.environ["GH_TOKEN"] = "ghs_live_token"

        with patch.object(plugin, "_auth_required_setup") as mock_inner:
            sub.on_active()

        mock_inner.assert_called_once_with(cfg_typed, "ghs_live_token")

    def test_on_active_falls_back_to_github_token_env(self) -> None:
        plugin = GitHubPlugin()
        cfg_typed = GitHubConfig(
            repos=["acme/repo"], token_source="subscriber",
        )
        sub = GithubAuthDependentSubscriber(plugin, cfg_typed)

        # Only GITHUB_TOKEN set, GH_TOKEN missing.
        os.environ["GITHUB_TOKEN"] = "ghs_only_github"

        with patch.object(plugin, "_auth_required_setup") as mock_inner:
            sub.on_active()

        mock_inner.assert_called_once_with(cfg_typed, "ghs_only_github")

    def test_on_active_raises_when_no_env_set(self) -> None:
        """Fail-closed when upstream subscriber didn't fire."""
        plugin = GitHubPlugin()
        cfg_typed = GitHubConfig(
            repos=["acme/repo"], token_source="subscriber",
        )
        sub = GithubAuthDependentSubscriber(plugin, cfg_typed)

        with self.assertRaises(RuntimeError) as ctx:
            sub.on_active()
        msg = str(ctx.exception)
        self.assertIn("GH_TOKEN", msg)
        self.assertIn("registration order", msg)

    def test_on_active_propagates_inner_setup_errors(self) -> None:
        """A failure in clone/validate must bubble out so the lifecycle
        module rolls back and the job retries."""
        plugin = GitHubPlugin()
        cfg_typed = GitHubConfig(
            repos=["acme/repo"], token_source="subscriber",
        )
        sub = GithubAuthDependentSubscriber(plugin, cfg_typed)
        os.environ["GH_TOKEN"] = "ghs_x"

        with patch.object(
            plugin, "_auth_required_setup",
            side_effect=RuntimeError("clone failed"),
        ):
            with self.assertRaises(RuntimeError) as ctx:
                sub.on_active()
        self.assertIn("clone failed", str(ctx.exception))


class AuthSubscriberOnIdleTest(_EnvIsolatedTest):
    def test_on_idle_does_not_clear_env(self) -> None:
        """Env is owned by the upstream subscriber to clear."""
        os.environ["GH_TOKEN"] = "ghs_x"
        os.environ["GITHUB_TOKEN"] = "ghs_x"

        plugin = GitHubPlugin()
        cfg_typed = GitHubConfig(
            repos=["acme/repo"], token_source="subscriber",
        )
        sub = GithubAuthDependentSubscriber(plugin, cfg_typed)

        sub.on_idle()

        # Env is intact — github subscriber's on_idle is a no-op.
        self.assertEqual(os.environ["GH_TOKEN"], "ghs_x")
        self.assertEqual(os.environ["GITHUB_TOKEN"], "ghs_x")

    def test_on_idle_does_not_clear_repos(self) -> None:
        """Workspace persistence: cloned state survives idle so the
        next on_active fetches incrementally."""
        plugin = GitHubPlugin()
        cfg_typed = GitHubConfig(
            repos=["acme/repo"], token_source="subscriber",
        )
        sub = GithubAuthDependentSubscriber(plugin, cfg_typed)

        # Pretend a prior on_active populated _repos.
        plugin._repos = [
            RepoInfo(repo="acme/repo", path="/workspace/acme/repo",
                     default_branch="main"),
        ]

        sub.on_idle()
        self.assertEqual(len(plugin._repos), 1)


class AuthSubscriberConstructionTest(unittest.TestCase):
    def test_missing_plugin_rejected(self) -> None:
        with self.assertRaises(ValueError):
            GithubAuthDependentSubscriber(
                None,  # type: ignore[arg-type]
                GitHubConfig(repos=["a/b"], token_source="subscriber"),
            )

    def test_missing_cfg_rejected(self) -> None:
        with self.assertRaises(ValueError):
            GithubAuthDependentSubscriber(
                GitHubPlugin(),
                None,  # type: ignore[arg-type]
            )


# ── End-to-end: hivemoot → github subscriber ordering ─────────────


class EndToEndOrderingTest(_EnvIsolatedTest):
    """Simulates the full chain: hivemoot subscriber sets env, then
    github subscriber reads it. Validates the load-bearing
    registration order."""

    def test_upstream_subscriber_sets_env_and_github_reads_it(self) -> None:
        from hivemoot_agent.apiarist_client import MintedToken, Repository
        from datetime import datetime, timezone
        from hivemoot_agent.plugins_builtin.hivemoot.auth_subscriber import (
            HivemootGithubAuthSubscriber,
        )

        # Fake apiarist client that returns a known token.
        client = MagicMock()
        client.mint_token.return_value = MintedToken(
            token="ghs_fresh_brokered",
            expires_at=datetime(2026, 4, 25, 23, 59, 59, tzinfo=timezone.utc),
            installation_id="42",
            permissions={},
            repositories=[Repository("acme/repo", 1)],
        )
        upstream = HivemootGithubAuthSubscriber(
            client, service="svc", repo="acme/repo",
        )

        plugin = GitHubPlugin()
        cfg_typed = GitHubConfig(
            repos=["acme/repo"], token_source="subscriber",
        )
        github_sub = GithubAuthDependentSubscriber(plugin, cfg_typed)

        lifecycle = ContainerLifecycle()
        lifecycle.subscribe(upstream)   # registered first
        lifecycle.subscribe(github_sub)  # registered second

        captured_token: dict[str, str] = {}

        def capture(cfg, token):
            captured_token["value"] = token

        with patch.object(plugin, "_auth_required_setup", side_effect=capture):
            lifecycle.on_job_starting()

        self.assertEqual(captured_token["value"], "ghs_fresh_brokered")
        # And idle order: hivemoot's on_idle clears env.
        lifecycle.on_job_finished()
        self.assertNotIn("GH_TOKEN", os.environ)
        self.assertNotIn("GITHUB_TOKEN", os.environ)


if __name__ == "__main__":
    unittest.main(verbosity=2)
