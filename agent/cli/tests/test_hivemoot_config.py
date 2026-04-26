"""Tests for hivemoot plugin typed config (HivemootConfig)."""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pydantic import ValidationError

from hivemoot_agent.plugins_builtin.hivemoot.config import (
    HivemootApiaristConfig,
    HivemootConfig,
    HivemootGithubWorkflowsConfig,
    HivemootHealthConfig,
    HivemootTasksConfig,
)


class DefaultsTests(unittest.TestCase):
    def test_defaults_are_all_disabled(self) -> None:
        cfg = HivemootConfig()
        self.assertFalse(cfg.health.enabled)
        self.assertFalse(cfg.tasks.enabled)
        self.assertFalse(cfg.github_workflows.enabled)
        self.assertFalse(cfg.apiarist.enabled)

    def test_health_defaults(self) -> None:
        cfg = HivemootHealthConfig()
        self.assertEqual(cfg.base_url, "https://www.hivemoot.dev")
        self.assertEqual(cfg.heartbeat_interval_secs, 120)
        self.assertTrue(cfg.post_run_reports)

    def test_tasks_defaults(self) -> None:
        cfg = HivemootTasksConfig()
        self.assertEqual(cfg.poll_interval_secs, 10)
        self.assertEqual(cfg.heartbeat_interval_secs, 45)

    def test_github_workflows_defaults(self) -> None:
        cfg = HivemootGithubWorkflowsConfig()
        self.assertEqual(cfg.clone_depth, 50)
        self.assertEqual(cfg.role_name, "")

    def test_apiarist_defaults(self) -> None:
        cfg = HivemootApiaristConfig()
        self.assertFalse(cfg.enabled)
        self.assertEqual(str(cfg.socket_path), "/run/apiarist.sock")
        self.assertEqual(cfg.timeout_seconds, 10.0)
        self.assertEqual(cfg.service, "")
        self.assertEqual(cfg.repo, "")


class StrictnessTests(unittest.TestCase):
    """StrictPluginConfig forbids unknown fields — catches operator
    typos at startup instead of silently dropping them."""

    def test_unknown_top_level_field_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            HivemootConfig(definitely_not_a_field=True)

    def test_unknown_nested_field_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            HivemootConfig(health={"enabled": True, "typo": "x"})


class RangeTests(unittest.TestCase):
    def test_heartbeat_interval_must_be_positive(self) -> None:
        with self.assertRaises(ValidationError):
            HivemootHealthConfig(heartbeat_interval_secs=0)

    def test_poll_interval_must_be_positive(self) -> None:
        with self.assertRaises(ValidationError):
            HivemootTasksConfig(poll_interval_secs=0)

    def test_tasks_heartbeat_allows_zero(self) -> None:
        # Documented: 0 disables the per-task heartbeat thread.
        cfg = HivemootTasksConfig(heartbeat_interval_secs=0)
        self.assertEqual(cfg.heartbeat_interval_secs, 0)

    def test_apiarist_timeout_must_be_positive(self) -> None:
        with self.assertRaises(ValidationError):
            HivemootApiaristConfig(timeout_seconds=0)
        with self.assertRaises(ValidationError):
            HivemootApiaristConfig(timeout_seconds=-1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
