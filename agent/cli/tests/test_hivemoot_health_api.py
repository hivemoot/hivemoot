"""Tests for hivemoot.health.api — heartbeat + run_report POSTs.

Validates the payload shape against web/AGENT_HEALTH_CONTRACT.md.
Health is a per-agent signal (one identity = AGENT_ID); the payloads
carry NO ``repo`` dimension:
  * Heartbeat carries exactly agent_id/outcome (+ optional next_run_at).
  * Run reports carry the required core fields plus the optional ones
    only when the caller passed them.
  * Neither payload contains a ``repo`` key.
  * error strings are truncated to 256 chars to satisfy the contract
    max without forcing callers to remember it.
"""

from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.hivemoot.health import api as health_api


class HeartbeatPayloadTests(unittest.TestCase):
    def test_heartbeat_minimal_payload(self) -> None:
        seen = {}

        def fake_post(url, payload, bearer, **_kwargs):
            seen["url"] = url
            seen["payload"] = payload
            seen["bearer"] = bearer
            return 200, None, b""

        with patch("hivemoot_agent.plugins_builtin.hivemoot.health.api.post_json", fake_post):
            ok = health_api.post_heartbeat(
                "https://h/", "tok", agent_id="a",
            )
        self.assertTrue(ok)
        self.assertEqual(seen["url"], "https://h/api/agent-health")
        self.assertEqual(seen["bearer"], "tok")
        self.assertEqual(
            seen["payload"],
            {"agent_id": "a", "outcome": "heartbeat"},
        )
        self.assertNotIn("repo", seen["payload"])

    def test_heartbeat_includes_next_run_at(self) -> None:
        seen = {}

        def fake_post(url, payload, bearer, **_kwargs):
            seen["payload"] = payload
            return 200, None, b""

        with patch("hivemoot_agent.plugins_builtin.hivemoot.health.api.post_json", fake_post):
            health_api.post_heartbeat(
                "https://h/", "tok",
                agent_id="a",
                next_run_at="2026-04-23T00:00:00Z",
            )
        self.assertEqual(
            seen["payload"]["next_run_at"], "2026-04-23T00:00:00Z",
        )
        self.assertNotIn("repo", seen["payload"])

    def test_heartbeat_strips_trailing_slash(self) -> None:
        seen = {}

        def fake_post(url, payload, bearer, **_kwargs):
            seen["url"] = url
            return 200, None, b""

        with patch("hivemoot_agent.plugins_builtin.hivemoot.health.api.post_json", fake_post):
            health_api.post_heartbeat(
                "https://h//", "tok", agent_id="a",
            )
        self.assertEqual(seen["url"], "https://h/api/agent-health")

    def test_non_200_returns_false(self) -> None:
        def fake_post(url, payload, bearer, **_kwargs):
            return 500, None, b""

        with patch("hivemoot_agent.plugins_builtin.hivemoot.health.api.post_json", fake_post):
            ok = health_api.post_heartbeat(
                "https://h/", "tok", agent_id="a",
            )
        self.assertFalse(ok)


class RunReportPayloadTests(unittest.TestCase):
    def test_minimal_run_report(self) -> None:
        seen = {}

        def fake_post(url, payload, bearer, **_kwargs):
            seen["payload"] = payload
            return 200, None, b""

        with patch("hivemoot_agent.plugins_builtin.hivemoot.health.api.post_json", fake_post):
            health_api.post_run_report(
                "https://h/", "tok",
                agent_id="builder",
                run_id="r-1", outcome="success",
                duration_secs=42, consecutive_failures=0,
            )
        self.assertEqual(
            seen["payload"],
            {
                "agent_id": "builder",
                "run_id": "r-1",
                "outcome": "success",
                "duration_secs": 42,
                "consecutive_failures": 0,
            },
        )
        self.assertNotIn("repo", seen["payload"])

    def test_run_report_optional_fields_included_when_set(self) -> None:
        seen = {}

        def fake_post(url, payload, bearer, **_kwargs):
            seen["payload"] = payload
            return 200, None, b""

        with patch("hivemoot_agent.plugins_builtin.hivemoot.health.api.post_json", fake_post):
            health_api.post_run_report(
                "https://h/", "tok",
                agent_id="a",
                run_id="r-1", outcome="failure",
                duration_secs=10, consecutive_failures=2,
                exit_code=1, error="boom", trigger="task",
                next_run_at="2026-04-23T01:00:00Z",
            )
        self.assertEqual(seen["payload"]["exit_code"], 1)
        self.assertEqual(seen["payload"]["error"], "boom")
        self.assertEqual(seen["payload"]["trigger"], "task")
        self.assertEqual(
            seen["payload"]["next_run_at"], "2026-04-23T01:00:00Z",
        )
        self.assertNotIn("repo", seen["payload"])

    def test_run_report_optional_fields_omitted_when_blank(self) -> None:
        seen = {}

        def fake_post(url, payload, bearer, **_kwargs):
            seen["payload"] = payload
            return 200, None, b""

        with patch("hivemoot_agent.plugins_builtin.hivemoot.health.api.post_json", fake_post):
            health_api.post_run_report(
                "https://h/", "tok",
                agent_id="a",
                run_id="r-1", outcome="success",
                duration_secs=1, consecutive_failures=0,
            )
        self.assertNotIn("error", seen["payload"])
        self.assertNotIn("trigger", seen["payload"])
        self.assertNotIn("next_run_at", seen["payload"])
        self.assertNotIn("repo", seen["payload"])

    def test_run_report_error_truncated_to_256(self) -> None:
        seen = {}

        def fake_post(url, payload, bearer, **_kwargs):
            seen["payload"] = payload
            return 200, None, b""

        big = "x" * 1000
        with patch("hivemoot_agent.plugins_builtin.hivemoot.health.api.post_json", fake_post):
            health_api.post_run_report(
                "https://h/", "tok",
                agent_id="a",
                run_id="r-1", outcome="failure",
                duration_secs=1, consecutive_failures=1,
                error=big,
            )
        self.assertEqual(len(seen["payload"]["error"]), 256)


if __name__ == "__main__":
    unittest.main(verbosity=2)
