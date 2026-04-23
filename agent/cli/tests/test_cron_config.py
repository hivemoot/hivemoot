"""Tests for CronConfig / ScheduleEntry validators.

The validators are the load-time safety net for cron schedules —
grammar errors, unreachable expressions, and name uniqueness are all
meant to fail at engine startup so an operator doesn't discover
problems hours later when a schedule silently doesn't fire.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.cron.config import (
    CronConfig,
    ScheduleEntry,
)


class ScheduleEntryValidationTests(unittest.TestCase):

    def test_valid_expression_accepted(self):
        entry = ScheduleEntry(
            name="hourly",
            schedule="0 * * * *",
            prompt="run",
        )
        self.assertEqual(entry.schedule, "0 * * * *")

    def test_every_shorthand_accepted(self):
        entry = ScheduleEntry(
            name="poll",
            schedule="@every 30m",
            prompt="run",
        )
        self.assertEqual(entry.schedule, "@every 30m")

    def test_grammar_error_rejected(self):
        with self.assertRaises(Exception) as ctx:
            ScheduleEntry(
                name="bad",
                schedule="not a cron expression",
                prompt="run",
            )
        self.assertIn("invalid cron expression", str(ctx.exception))

    def test_feb_31_unreachable_rejected(self):
        """Regression for T7: ``0 0 31 2 *`` is grammatically valid but
        can never fire (February never has 31 days).  The 4-year
        next_fire search exhausts and raises CronParseError, which
        the schema validator re-wraps as ValueError.  This test
        pins that so next_fire can't silently loop or return a
        far-future date without anyone noticing."""
        with self.assertRaises(Exception) as ctx:
            ScheduleEntry(
                name="impossible",
                schedule="0 0 31 2 *",
                prompt="run",
            )
        self.assertIn("invalid cron expression", str(ctx.exception))

    def test_invalid_name_rejected(self):
        with self.assertRaises(Exception) as ctx:
            ScheduleEntry(
                name="bad name with spaces",
                schedule="0 * * * *",
                prompt="run",
            )
        self.assertIn("[A-Za-z0-9_-]+", str(ctx.exception))

    def test_negative_jitter_rejected(self):
        with self.assertRaises(Exception):
            ScheduleEntry(
                name="x",
                schedule="0 * * * *",
                prompt="run",
                jitter_secs=-1,
            )


class CronConfigValidationTests(unittest.TestCase):

    def test_empty_schedules_allowed(self):
        """Listing the plugin without scheduling anything is explicitly OK."""
        cfg = CronConfig(schedules=[])
        self.assertEqual(cfg.schedules, [])

    def test_duplicate_names_rejected(self):
        with self.assertRaises(Exception) as ctx:
            CronConfig(schedules=[
                {"name": "twin", "schedule": "0 * * * *", "prompt": "a"},
                {"name": "twin", "schedule": "0 * * * *", "prompt": "b"},
            ])
        self.assertIn("duplicate schedule name", str(ctx.exception))

    def test_unknown_fields_rejected(self):
        """``extra = 'forbid'`` catches config typos (``prompts`` vs
        ``prompt``) at load time."""
        with self.assertRaises(Exception):
            CronConfig(
                schedules=[],
                typo_field="oops",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
