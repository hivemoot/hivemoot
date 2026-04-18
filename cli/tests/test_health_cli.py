"""Tests for cli/hivemoot_agent/health.py — host-side heartbeat CLI.

Patches the no-redirect opener at the `health` module level to avoid
real network calls.  Best-effort exit semantics are exercised so a
regression that turns operational errors into non-zero exits would
break the controller's `|| true` swallowing.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from typing import Any
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent import health as health_cli


def _make_args(**kwargs: Any) -> argparse.Namespace:
    defaults = {
        "agent": "forager",
        "repo": "owner/repo",
        "token_file": "",
        "next_run_at": "",
    }
    defaults.update(kwargs)
    return argparse.Namespace(**defaults)


def _fake_response(status: int = 200) -> Any:
    """Mock object returned by a patched opener.open context manager."""
    cm = MagicMock()
    cm.__enter__.return_value.status = status
    cm.__exit__.return_value = False
    return cm


class PayloadTests(unittest.TestCase):
    def test_minimal_payload(self) -> None:
        payload = health_cli._build_payload("forager", "owner/repo", "")
        self.assertEqual(payload, {
            "agent_id": "forager",
            "repo": "owner/repo",
            "outcome": "heartbeat",
        })

    def test_payload_with_next_run_at(self) -> None:
        payload = health_cli._build_payload(
            "guard", "hivemoot/bot", "2026-04-17T12:00:00Z",
        )
        self.assertEqual(payload, {
            "agent_id": "guard",
            "repo": "hivemoot/bot",
            "outcome": "heartbeat",
            "next_run_at": "2026-04-17T12:00:00Z",
        })

    def test_payload_omits_empty_next_run_at(self) -> None:
        payload = health_cli._build_payload("a", "o/r", "")
        self.assertNotIn("next_run_at", payload)


class TokenResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        # Clear env vars that _resolve_token consults so per-test
        # behavior is independent of the developer's shell.
        self._prev = {
            k: os.environ.pop(k, None)
            for k in ("HIVEMOOT_AGENT_TOKEN_FILE", "HIVEMOOT_AGENT_TOKEN")
        }

    def tearDown(self) -> None:
        for k, v in self._prev.items():
            if v is not None:
                os.environ[k] = v

    def test_empty_token_file_returns_empty(self) -> None:
        self.assertEqual(health_cli._resolve_token(""), "")

    def test_missing_token_file_returns_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(
                health_cli._resolve_token(os.path.join(tmp, "nope")), "",
            )

    def test_reads_token_and_strips_whitespace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "token")
            with open(path, "w") as f:
                f.write("ghp_secret123\n")
            self.assertEqual(health_cli._resolve_token(path), "ghp_secret123")

    def test_falls_back_to_env_token_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_path = os.path.join(tmp, "env-token")
            with open(env_path, "w") as f:
                f.write("env_token_value")
            os.environ["HIVEMOOT_AGENT_TOKEN_FILE"] = env_path
            self.assertEqual(
                health_cli._resolve_token(""), "env_token_value",
            )

    def test_falls_back_to_raw_env_token(self) -> None:
        os.environ["HIVEMOOT_AGENT_TOKEN"] = "raw_secret"
        self.assertEqual(health_cli._resolve_token(""), "raw_secret")

    def test_explicit_token_file_wins_over_env(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            explicit = os.path.join(tmp, "explicit")
            with open(explicit, "w") as f:
                f.write("explicit_token")
            env_path = os.path.join(tmp, "env-token")
            with open(env_path, "w") as f:
                f.write("env_token")
            os.environ["HIVEMOOT_AGENT_TOKEN_FILE"] = env_path
            os.environ["HIVEMOOT_AGENT_TOKEN"] = "raw"
            self.assertEqual(
                health_cli._resolve_token(explicit), "explicit_token",
            )

    def test_missing_explicit_path_falls_through_to_env(self) -> None:
        # Documents the intentional divergence from shell send_heartbeat:
        # shell would send the literal path string as a bearer token;
        # Python skips it and tries the next source.
        os.environ["HIVEMOOT_AGENT_TOKEN"] = "fallback_token"
        self.assertEqual(
            health_cli._resolve_token("/definitely/does/not/exist"),
            "fallback_token",
        )

    def test_unreadable_token_file_falls_through_to_env(self) -> None:
        if os.geteuid() == 0:
            self.skipTest("root bypasses file permission checks")
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "unreadable")
            with open(path, "w") as f:
                f.write("nope")
            os.chmod(path, 0o000)
            try:
                os.environ["HIVEMOOT_AGENT_TOKEN"] = "fallback"
                self.assertEqual(
                    health_cli._resolve_token(path), "fallback",
                )
            finally:
                os.chmod(path, 0o600)


class HeartbeatTests(unittest.TestCase):
    """End-to-end exercises of cmd_heartbeat using a patched opener."""

    def _run_with_responses(
        self,
        api_responses: list[Any],
        env: dict[str, str] | None = None,
        args_overrides: dict[str, Any] | None = None,
    ) -> tuple[int, list[Any], io.StringIO]:
        """Invoke cmd_heartbeat with a fake opener and capture stdout.

        api_responses: list of response objects (from _fake_response()) or
        Exception instances to raise.  Returns (exit_code, captured_request_objs,
        stdout_stringio).
        """
        responses = iter(api_responses)
        captured_reqs: list[Any] = []
        captured_kwargs: list[dict] = []

        def fake_open(req, *args, **kwargs):
            captured_reqs.append(req)
            captured_kwargs.append(kwargs)
            try:
                nxt = next(responses)
            except StopIteration:
                raise urllib.error.URLError("test exhausted responses")
            if isinstance(nxt, Exception):
                raise nxt
            return nxt

        captured_stdout = io.StringIO()
        env_patch = patch.dict(os.environ, env or {}, clear=False)

        with env_patch, patch.object(
            health_cli._NO_REDIRECT_OPENER, "open", fake_open,
        ), patch("sys.stdout", captured_stdout):
            args = _make_args(**(args_overrides or {}))
            exit_code = health_cli.cmd_heartbeat(args)

        return exit_code, captured_reqs, captured_stdout

    # ── Disabled / no-op paths ─────────────────────────────────────

    def test_no_url_is_silent_noop(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("HEALTH_REPORT_URL", None)
            args = _make_args()
            self.assertEqual(health_cli.cmd_heartbeat(args), 0)

    def test_invalid_url_scheme_does_not_send(self) -> None:
        exit_code, reqs, _ = self._run_with_responses(
            [_fake_response(200)],
            env={"HEALTH_REPORT_URL": "ftp://oops"},
        )
        self.assertEqual(exit_code, 0)
        self.assertEqual(reqs, [])

    # ── Happy path ─────────────────────────────────────────────────

    def test_posts_minimal_payload(self) -> None:
        exit_code, reqs, _ = self._run_with_responses(
            [_fake_response(200)],
            env={"HEALTH_REPORT_URL": "https://api.example.com/health"},
            args_overrides={"agent": "builder", "repo": "hivemoot/sandbox"},
        )

        self.assertEqual(exit_code, 0)
        self.assertEqual(len(reqs), 1)
        req = reqs[0]
        self.assertEqual(req.full_url, "https://api.example.com/health")
        self.assertEqual(req.get_method(), "POST")
        headers = dict(req.header_items())
        self.assertEqual(headers.get("Content-type"), "application/json")
        self.assertNotIn("Authorization", headers)
        body = json.loads(req.data)
        self.assertEqual(body, {
            "agent_id": "builder",
            "repo": "hivemoot/sandbox",
            "outcome": "heartbeat",
        })

    def test_http_url_accepted(self) -> None:
        # Coverage for the http:// branch of the scheme guard.
        exit_code, reqs, _ = self._run_with_responses(
            [_fake_response(200)],
            env={"HEALTH_REPORT_URL": "http://localhost:8080/h"},
        )
        self.assertEqual(exit_code, 0)
        self.assertEqual(len(reqs), 1)
        self.assertEqual(reqs[0].full_url, "http://localhost:8080/h")

    def test_includes_bearer_token_from_explicit_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            token_path = os.path.join(tmp, "token")
            with open(token_path, "w") as f:
                f.write("ghp_xyz\n")
            exit_code, reqs, _ = self._run_with_responses(
                [_fake_response(200)],
                env={"HEALTH_REPORT_URL": "https://api.example.com/h"},
                args_overrides={"token_file": token_path},
            )
        self.assertEqual(exit_code, 0)
        headers = dict(reqs[0].header_items())
        self.assertEqual(headers.get("Authorization"), "Bearer ghp_xyz")

    def test_bearer_resolved_from_env_token_file(self) -> None:
        # PRODUCTION PATH: the controller invokes the CLI without
        # --token-file and relies on HIVEMOOT_AGENT_TOKEN_FILE env.
        # A regression here would silently strip auth in production.
        with tempfile.TemporaryDirectory() as tmp:
            env_path = os.path.join(tmp, "env-token")
            with open(env_path, "w") as f:
                f.write("env_token_xyz")
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("HIVEMOOT_AGENT_TOKEN", None)
                os.environ["HIVEMOOT_AGENT_TOKEN_FILE"] = env_path
                exit_code, reqs, _ = self._run_with_responses(
                    [_fake_response(200)],
                    env={"HEALTH_REPORT_URL": "https://api.example.com/h"},
                )
        self.assertEqual(exit_code, 0)
        headers = dict(reqs[0].header_items())
        self.assertEqual(headers.get("Authorization"), "Bearer env_token_xyz")

    def test_bearer_resolved_from_env_raw_token(self) -> None:
        # Second production path: only HIVEMOOT_AGENT_TOKEN is set
        # (no file).  Auth must still be sent.
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("HIVEMOOT_AGENT_TOKEN_FILE", None)
            os.environ["HIVEMOOT_AGENT_TOKEN"] = "raw_token_abc"
            exit_code, reqs, _ = self._run_with_responses(
                [_fake_response(200)],
                env={"HEALTH_REPORT_URL": "https://api.example.com/h"},
            )
        self.assertEqual(exit_code, 0)
        headers = dict(reqs[0].header_items())
        self.assertEqual(headers.get("Authorization"), "Bearer raw_token_abc")

    def test_includes_next_run_at_in_body(self) -> None:
        exit_code, reqs, _ = self._run_with_responses(
            [_fake_response(200)],
            env={"HEALTH_REPORT_URL": "https://api.example.com/h"},
            args_overrides={"next_run_at": "2026-04-17T13:00:00Z"},
        )
        self.assertEqual(exit_code, 0)
        body = json.loads(reqs[0].data)
        self.assertEqual(body["next_run_at"], "2026-04-17T13:00:00Z")

    # ── Failure paths (all best-effort: exit 0) ────────────────────

    def test_oversize_payload_does_not_send(self) -> None:
        with patch.object(health_cli, "MAX_PAYLOAD_BYTES", 10):
            exit_code, reqs, _ = self._run_with_responses(
                [_fake_response(200)],
                env={"HEALTH_REPORT_URL": "https://api.example.com/h"},
            )
        self.assertEqual(exit_code, 0)
        self.assertEqual(reqs, [])

    def test_http_error_swallowed_returns_zero(self) -> None:
        err = urllib.error.HTTPError(
            "https://api.example.com/h", 401, "Unauthorized",
            hdrs=None, fp=io.BytesIO(b""),
        )
        exit_code, _, _ = self._run_with_responses(
            [err],
            env={"HEALTH_REPORT_URL": "https://api.example.com/h"},
        )
        self.assertEqual(exit_code, 0)

    def test_network_error_swallowed_returns_zero(self) -> None:
        exit_code, _, _ = self._run_with_responses(
            [urllib.error.URLError("connection refused")],
            env={"HEALTH_REPORT_URL": "https://api.example.com/h"},
        )
        self.assertEqual(exit_code, 0)

    def test_unexpected_status_swallowed_returns_zero(self) -> None:
        exit_code, _, _ = self._run_with_responses(
            [_fake_response(204)],
            env={"HEALTH_REPORT_URL": "https://api.example.com/h"},
        )
        self.assertEqual(exit_code, 0)

    def test_redirect_is_blocked_to_protect_authorization(self) -> None:
        # SEC1: urllib's default HTTPRedirectHandler forwards Authorization
        # to the redirect target.  We install _NoRedirectHandler to refuse
        # 3xx; verify it raises HTTPError (which cmd_heartbeat then logs
        # and swallows to exit 0).
        with tempfile.TemporaryDirectory() as tmp:
            token_path = os.path.join(tmp, "token")
            with open(token_path, "w") as f:
                f.write("SECRET")
            req = MagicMock()
            req.full_url = "https://api.example.com/h"
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                health_cli._NoRedirectHandler().http_error_302(
                    req, fp=io.BytesIO(b""), code=302,
                    msg="Found", headers={"Location": "https://attacker.example/"},
                )
            self.assertEqual(ctx.exception.code, 302)
            self.assertIn("Authorization", str(ctx.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
