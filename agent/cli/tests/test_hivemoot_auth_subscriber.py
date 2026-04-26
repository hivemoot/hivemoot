"""Tests for ``HivemootGithubAuthSubscriber``.

Validates the subscriber's lifecycle contract:

- ``on_active`` calls ``client.mint_token`` with correct args, sets
  both ``GH_TOKEN`` and ``GITHUB_TOKEN``, caches the result.
- ``on_active`` failure (apiarist down, error envelope) propagates
  the exception and does NOT touch env (fail-closed).
- ``on_idle`` clears both env vars and resets cached state.
- ``on_idle`` is safe to call without a prior ``on_active``.
- Both env vars get the SAME token value (no split-brain).
- Construction validates required arguments.

Uses a fake apiarist client (no real socket) — the wire path is
covered by ``tests.test_apiarist_client``.
"""

from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.apiarist_client import (
    ApiaristRemoteError,
    ApiaristTransportError,
    MintedToken,
    Repository,
)
from hivemoot_agent.plugins_builtin.hivemoot.auth_subscriber import (
    HivemootGithubAuthSubscriber,
)


def _fake_token(token_str: str = "ghs_fake_xyz") -> MintedToken:
    return MintedToken(
        token=token_str,
        expires_at=datetime(2026, 4, 25, 23, 59, 59, tzinfo=timezone.utc),
        installation_id="11111",
        permissions={"contents": "read"},
        repositories=[Repository(full_name="hivemoot/colony", id=1)],
    )


def _clear_token_env() -> None:
    for var in ("GH_TOKEN", "GITHUB_TOKEN"):
        os.environ.pop(var, None)


class _SubscriberTestBase(unittest.TestCase):
    """Common setUp/tearDown to keep env vars clean across tests."""

    def setUp(self) -> None:
        _clear_token_env()

    def tearDown(self) -> None:
        _clear_token_env()


# ── on_active happy path ──────────────────────────────────────────


class OnActiveSuccessTest(_SubscriberTestBase):
    def test_mints_with_correct_args_and_sets_both_env_vars(self) -> None:
        client = MagicMock()
        token = _fake_token("ghs_active_token")
        client.mint_token.return_value = token

        sub = HivemootGithubAuthSubscriber(
            client,
            service="drone-zai",
            repo="hivemoot/colony",
            agent_id="drone",
        )
        sub.on_active()

        client.mint_token.assert_called_once_with(
            service="drone-zai",
            repo="hivemoot/colony",
            agent_id="drone",
        )
        self.assertEqual(os.environ["GH_TOKEN"], "ghs_active_token")
        self.assertEqual(os.environ["GITHUB_TOKEN"], "ghs_active_token")
        # Both env vars get the SAME token (no split-brain).
        self.assertEqual(os.environ["GH_TOKEN"], os.environ["GITHUB_TOKEN"])
        self.assertIs(sub.current_token, token)

    def test_omits_agent_id_when_none(self) -> None:
        client = MagicMock()
        client.mint_token.return_value = _fake_token()

        sub = HivemootGithubAuthSubscriber(
            client, service="svc", repo="owner/repo",
        )
        sub.on_active()

        client.mint_token.assert_called_once_with(
            service="svc", repo="owner/repo", agent_id=None,
        )

    def test_repeated_on_active_re_mints(self) -> None:
        """Each on_active is a fresh mint — no caching across cycles."""
        client = MagicMock()
        client.mint_token.side_effect = [
            _fake_token("ghs_first"),
            _fake_token("ghs_second"),
        ]

        sub = HivemootGithubAuthSubscriber(
            client, service="svc", repo="owner/repo",
        )
        sub.on_active()
        self.assertEqual(os.environ["GH_TOKEN"], "ghs_first")
        sub.on_idle()
        sub.on_active()
        self.assertEqual(os.environ["GH_TOKEN"], "ghs_second")

        self.assertEqual(client.mint_token.call_count, 2)


# ── on_active failure paths ───────────────────────────────────────


class OnActiveFailureTest(_SubscriberTestBase):
    """Failure during mint must NOT leave stale env (fail-closed)."""

    def test_transport_error_propagates_without_setting_env(self) -> None:
        client = MagicMock()
        client.mint_token.side_effect = ApiaristTransportError("connect refused")

        sub = HivemootGithubAuthSubscriber(
            client, service="svc", repo="owner/repo",
        )
        with self.assertRaises(ApiaristTransportError):
            sub.on_active()

        self.assertNotIn("GH_TOKEN", os.environ)
        self.assertNotIn("GITHUB_TOKEN", os.environ)
        self.assertIsNone(sub.current_token)

    def test_remote_error_propagates_without_setting_env(self) -> None:
        client = MagicMock()
        client.mint_token.side_effect = ApiaristRemoteError(
            code="BACKEND_FORBIDDEN",
            message="repo not in token policy",
        )

        sub = HivemootGithubAuthSubscriber(
            client, service="svc", repo="not/allowed",
        )
        with self.assertRaises(ApiaristRemoteError) as ctx:
            sub.on_active()

        self.assertEqual(ctx.exception.code, "BACKEND_FORBIDDEN")
        self.assertNotIn("GH_TOKEN", os.environ)
        self.assertNotIn("GITHUB_TOKEN", os.environ)

    def test_mid_cycle_failure_preserves_prior_env(self) -> None:
        """A failed on_active after a previous successful cycle must not
        clear env that the previous cycle's on_idle owns clearing."""
        client = MagicMock()
        client.mint_token.side_effect = [
            _fake_token("ghs_first"),
            ApiaristTransportError("daemon restarted"),
        ]

        sub = HivemootGithubAuthSubscriber(
            client, service="svc", repo="owner/repo",
        )
        sub.on_active()  # success — env set
        sub.on_idle()    # env cleared
        # Now the second cycle fails. Env should remain CLEARED (not
        # overwritten with prior value) since on_active never reached
        # the env-set step.
        with self.assertRaises(ApiaristTransportError):
            sub.on_active()
        self.assertNotIn("GH_TOKEN", os.environ)
        self.assertNotIn("GITHUB_TOKEN", os.environ)


# ── on_idle paths ─────────────────────────────────────────────────


class OnIdleTest(_SubscriberTestBase):
    def test_clears_both_env_vars_after_active(self) -> None:
        client = MagicMock()
        client.mint_token.return_value = _fake_token()

        sub = HivemootGithubAuthSubscriber(
            client, service="svc", repo="owner/repo",
        )
        sub.on_active()
        self.assertIn("GH_TOKEN", os.environ)
        self.assertIn("GITHUB_TOKEN", os.environ)

        sub.on_idle()
        self.assertNotIn("GH_TOKEN", os.environ)
        self.assertNotIn("GITHUB_TOKEN", os.environ)
        self.assertIsNone(sub.current_token)

    def test_idle_without_prior_active_is_safe(self) -> None:
        """Defensive — an early on_idle (lifecycle bug or rollback path)
        must not raise even though there's no token to clear."""
        client = MagicMock()
        sub = HivemootGithubAuthSubscriber(
            client, service="svc", repo="owner/repo",
        )
        # Should NOT raise.
        sub.on_idle()
        self.assertIsNone(sub.current_token)
        self.assertNotIn("GH_TOKEN", os.environ)
        self.assertNotIn("GITHUB_TOKEN", os.environ)

    def test_idle_does_not_touch_unrelated_env_vars(self) -> None:
        client = MagicMock()
        client.mint_token.return_value = _fake_token()

        os.environ["UNRELATED_VAR"] = "preserve me"
        try:
            sub = HivemootGithubAuthSubscriber(
                client, service="svc", repo="owner/repo",
            )
            sub.on_active()
            sub.on_idle()
            self.assertEqual(os.environ["UNRELATED_VAR"], "preserve me")
        finally:
            os.environ.pop("UNRELATED_VAR", None)


# ── Construction validation ───────────────────────────────────────


class ConstructionValidationTest(unittest.TestCase):
    def test_missing_client_rejected(self) -> None:
        with self.assertRaises(ValueError):
            HivemootGithubAuthSubscriber(
                None,  # type: ignore[arg-type]
                service="svc",
                repo="owner/repo",
            )

    def test_empty_service_rejected(self) -> None:
        with self.assertRaises(ValueError):
            HivemootGithubAuthSubscriber(
                MagicMock(), service="", repo="owner/repo",
            )

    def test_empty_repo_rejected(self) -> None:
        with self.assertRaises(ValueError):
            HivemootGithubAuthSubscriber(
                MagicMock(), service="svc", repo="",
            )


# ── Diagnostic property exposure ──────────────────────────────────


class DiagnosticPropertyTest(_SubscriberTestBase):
    def test_repo_and_service_exposed_after_construction(self) -> None:
        sub = HivemootGithubAuthSubscriber(
            MagicMock(),
            service="hivemoot-zai",
            repo="hivemoot/colony",
        )
        self.assertEqual(sub.repo, "hivemoot/colony")
        self.assertEqual(sub.service, "hivemoot-zai")
        self.assertIsNone(sub.current_token)


if __name__ == "__main__":
    unittest.main()
