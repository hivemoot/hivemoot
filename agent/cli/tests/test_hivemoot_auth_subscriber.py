"""Tests for ``HivemootGithubAuthSubscriber``.

Validates the new always-on contract (PR #490 R2 — addresses the
watch-trigger blocker):

- ``start()`` mints synchronously and starts a background refresh
  thread; idempotent on second call.
- ``stop()`` joins the refresh thread; safe to call multiple times.
- ``on_active`` is a no-op when the current token is fresh; refreshes
  proactively when within the lead-time window.
- ``on_idle`` is a NO-OP (env stays populated for between-jobs trigger
  polls — drone watch services need this).
- ``on_active`` without prior ``start()`` force-mints (defensive).
- Failure during initial ``start()`` propagates so plugin setup
  fails fast.
- Refresh loop logs + retries on apiarist errors instead of dying.
- Both env vars (``GH_TOKEN`` and ``GITHUB_TOKEN``) get the same
  token value.
- Construction validates required arguments + new positive-number
  refresh params.

Uses a fake apiarist client (no real socket) — wire path is covered
by ``tests.test_apiarist_client``.
"""

from __future__ import annotations

import os
import sys
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
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


def _fake_token(
    token_str: str = "ghs_fake_xyz",
    *,
    expires_in_secs: int = 3600,
) -> MintedToken:
    """Build a MintedToken expiring N seconds from NOW (tz-aware UTC)."""
    return MintedToken(
        token=token_str,
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=expires_in_secs),
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
        self._subscribers: list[HivemootGithubAuthSubscriber] = []

    def tearDown(self) -> None:
        # Stop any subscribers we started so refresh threads don't leak
        # into subsequent tests.
        for sub in self._subscribers:
            try:
                sub.stop()
            except Exception:
                pass
        _clear_token_env()

    def _make_subscriber(
        self,
        client: MagicMock,
        **kwargs,
    ) -> HivemootGithubAuthSubscriber:
        defaults = {"service": "drone-zai", "repo": "hivemoot/colony"}
        defaults.update(kwargs)
        # Use a very long refresh lead time so tests don't race the
        # background thread unless they explicitly want to.
        defaults.setdefault("refresh_lead_time_secs", 60)
        sub = HivemootGithubAuthSubscriber(client, **defaults)
        self._subscribers.append(sub)
        return sub


# ── start() / stop() ──────────────────────────────────────────────


class StartTest(_SubscriberTestBase):
    def test_start_mints_synchronously_and_sets_env(self) -> None:
        client = MagicMock()
        token = _fake_token("ghs_initial")
        client.mint_token.return_value = token

        sub = self._make_subscriber(client)
        sub.start()

        # Synchronous initial mint — env populated by the time start
        # returns, before any background refresh fires.
        client.mint_token.assert_called_once_with(
            service="drone-zai",
            repo="hivemoot/colony",
            agent_id=None,
        )
        self.assertEqual(os.environ["GH_TOKEN"], "ghs_initial")
        self.assertEqual(os.environ["GITHUB_TOKEN"], "ghs_initial")
        self.assertEqual(os.environ["GH_TOKEN"], os.environ["GITHUB_TOKEN"])
        self.assertIs(sub.current_token, token)
        self.assertTrue(sub.is_started)

    def test_start_is_idempotent(self) -> None:
        client = MagicMock()
        client.mint_token.return_value = _fake_token()

        sub = self._make_subscriber(client)
        sub.start()
        sub.start()  # second call must NOT re-mint
        sub.start()  # third call ditto

        client.mint_token.assert_called_once()

    def test_start_failure_propagates_for_fail_closed_setup(self) -> None:
        client = MagicMock()
        client.mint_token.side_effect = ApiaristTransportError("daemon down")

        sub = self._make_subscriber(client)
        with self.assertRaises(ApiaristTransportError):
            sub.start()

        # Env not set on failure; subscriber not marked started so
        # plugin setup_lifecycle bubbles the error and container exits.
        self.assertNotIn("GH_TOKEN", os.environ)
        self.assertNotIn("GITHUB_TOKEN", os.environ)
        self.assertFalse(sub.is_started)


class StopTest(_SubscriberTestBase):
    def test_stop_joins_refresh_thread(self) -> None:
        client = MagicMock()
        client.mint_token.return_value = _fake_token()

        sub = self._make_subscriber(client)
        sub.start()
        # Refresh thread is started — should be alive briefly.
        self.assertTrue(sub._refresh_thread is not None)
        sub.stop()
        # After stop the thread reference is cleared.
        self.assertIsNone(sub._refresh_thread)

    def test_stop_safe_before_start(self) -> None:
        sub = self._make_subscriber(MagicMock())
        # Must NOT raise even though we never started.
        sub.stop()

    def test_stop_idempotent(self) -> None:
        client = MagicMock()
        client.mint_token.return_value = _fake_token()
        sub = self._make_subscriber(client)
        sub.start()
        sub.stop()
        sub.stop()  # safe second call


# ── on_active behavior ────────────────────────────────────────────


class OnActiveAfterStartTest(_SubscriberTestBase):
    def test_on_active_fresh_token_is_no_op(self) -> None:
        """Refresh thread keeps token fresh — on_active is mostly no-op."""
        client = MagicMock()
        # Long-expiring token — far outside the 60s lead-time window.
        client.mint_token.return_value = _fake_token(
            "ghs_fresh", expires_in_secs=3600,
        )

        sub = self._make_subscriber(client, refresh_lead_time_secs=60)
        sub.start()
        client.mint_token.reset_mock()

        sub.on_active()
        client.mint_token.assert_not_called()

    def test_on_active_near_expiry_refreshes(self) -> None:
        """Inside the lead-time window — proactively refresh."""
        client = MagicMock()
        # Token expiring in 30s, lead-time is 60s → on_active refreshes.
        client.mint_token.side_effect = [
            _fake_token("ghs_near_expiry", expires_in_secs=30),
            _fake_token("ghs_refreshed", expires_in_secs=3600),
        ]

        sub = self._make_subscriber(client, refresh_lead_time_secs=60)
        sub.start()
        sub.stop()  # quiet the refresh thread so it doesn't race
        self.assertEqual(os.environ["GH_TOKEN"], "ghs_near_expiry")

        sub.on_active()
        self.assertEqual(os.environ["GH_TOKEN"], "ghs_refreshed")

    def test_on_active_without_prior_start_force_mints(self) -> None:
        """Defensive — if start() wasn't called, on_active mints anyway."""
        client = MagicMock()
        client.mint_token.return_value = _fake_token("ghs_force")

        sub = self._make_subscriber(client)
        # No start() call.
        sub.on_active()

        client.mint_token.assert_called_once()
        self.assertEqual(os.environ["GH_TOKEN"], "ghs_force")


# ── on_idle behavior ──────────────────────────────────────────────


class OnIdleTest(_SubscriberTestBase):
    def test_on_idle_does_not_clear_env(self) -> None:
        """Always-on contract: env stays so trigger threads can poll."""
        client = MagicMock()
        client.mint_token.return_value = _fake_token("ghs_persistent")

        sub = self._make_subscriber(client)
        sub.start()
        sub.stop()  # silence refresh thread

        self.assertEqual(os.environ["GH_TOKEN"], "ghs_persistent")
        sub.on_idle()
        # Env STILL populated — different from the original V1 design.
        self.assertEqual(os.environ["GH_TOKEN"], "ghs_persistent")
        self.assertEqual(os.environ["GITHUB_TOKEN"], "ghs_persistent")
        # current_token also retained for diagnostics.
        self.assertIsNotNone(sub.current_token)

    def test_on_idle_safe_before_start(self) -> None:
        sub = self._make_subscriber(MagicMock())
        sub.on_idle()  # must NOT raise
        self.assertIsNone(sub.current_token)


# ── Refresh loop behavior ─────────────────────────────────────────


class RefreshLoopTest(_SubscriberTestBase):
    def test_refresh_loop_re_mints_when_token_nears_expiry(self) -> None:
        """Background thread re-mints periodically.

        Test-style: short-expiring token forces the thread to re-mint
        almost immediately. We poll for the second call to land.
        """
        client = MagicMock()
        # First mint expires ~1s after now, refresh lead 1s → thread
        # sleeps for max(1s, 0s) = 1s then re-mints.
        client.mint_token.side_effect = [
            _fake_token("ghs_v1", expires_in_secs=2),
            _fake_token("ghs_v2", expires_in_secs=3600),
            _fake_token("ghs_v3", expires_in_secs=3600),
        ]

        sub = self._make_subscriber(client, refresh_lead_time_secs=1)
        sub.start()
        # Wait up to 5s for the second mint to land.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if client.mint_token.call_count >= 2:
                break
            time.sleep(0.05)
        sub.stop()

        self.assertGreaterEqual(
            client.mint_token.call_count, 2,
            "refresh thread should have re-minted the near-expiry token",
        )
        self.assertEqual(os.environ["GH_TOKEN"], "ghs_v2")

    def test_refresh_loop_logs_and_retries_on_apiarist_error(self) -> None:
        """A transient apiarist error must NOT kill the refresh loop."""
        client = MagicMock()
        # First mint succeeds (initial), second mint fails (refresh
        # attempt), third mint succeeds.
        client.mint_token.side_effect = [
            _fake_token("ghs_v1", expires_in_secs=2),
            ApiaristTransportError("transient"),
            _fake_token("ghs_v2", expires_in_secs=3600),
        ]

        sub = self._make_subscriber(
            client,
            refresh_lead_time_secs=1,
            refresh_backoff_on_error_secs=0.5,
        )
        sub.start()
        # Wait for both the failure and the recovery to occur.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if client.mint_token.call_count >= 3:
                break
            time.sleep(0.05)
        sub.stop()

        self.assertGreaterEqual(
            client.mint_token.call_count, 3,
            "refresh loop should retry after transient error",
        )
        # Final env value is the recovered token.
        self.assertEqual(os.environ["GH_TOKEN"], "ghs_v2")


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

    def test_non_positive_refresh_lead_time_rejected(self) -> None:
        with self.assertRaises(ValueError):
            HivemootGithubAuthSubscriber(
                MagicMock(), service="svc", repo="owner/repo",
                refresh_lead_time_secs=0,
            )
        with self.assertRaises(ValueError):
            HivemootGithubAuthSubscriber(
                MagicMock(), service="svc", repo="owner/repo",
                refresh_lead_time_secs=-5,
            )

    def test_non_positive_refresh_backoff_rejected(self) -> None:
        with self.assertRaises(ValueError):
            HivemootGithubAuthSubscriber(
                MagicMock(), service="svc", repo="owner/repo",
                refresh_backoff_on_error_secs=0,
            )


# ── Diagnostic property exposure ──────────────────────────────────


class DiagnosticPropertyTest(_SubscriberTestBase):
    def test_repo_and_service_exposed(self) -> None:
        sub = self._make_subscriber(
            MagicMock(),
            service="hivemoot-zai",
            repo="hivemoot/colony",
        )
        self.assertEqual(sub.repo, "hivemoot/colony")
        self.assertEqual(sub.service, "hivemoot-zai")
        self.assertIsNone(sub.current_token)
        self.assertFalse(sub.is_started)


if __name__ == "__main__":
    unittest.main()
