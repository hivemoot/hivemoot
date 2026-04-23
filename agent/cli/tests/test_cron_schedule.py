"""Tests for CRON_SCHEDULES_JSON parsing and Schedule validation."""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.cron.schedule import (
    Schedule,
    ScheduleConfigError,
    parse_schedules,
)


def _cfg(entries: list[dict]) -> str:
    return json.dumps(entries)


class ParseSchedulesTests(unittest.TestCase):
    def test_empty_string_yields_empty_list(self) -> None:
        self.assertEqual(parse_schedules(""), [])
        self.assertEqual(parse_schedules("   "), [])

    def test_single_schedule_round_trip(self) -> None:
        raw = _cfg([{
            "name": "autonomous",
            "schedule": "@every 1h",
            "prompt": "do things",
        }])
        [s] = parse_schedules(raw)
        self.assertEqual(s.name, "autonomous")
        self.assertEqual(s.prompt, "do things")
        self.assertEqual(s.jitter_secs, 0)
        self.assertFalse(s.resume)
        self.assertEqual(s.session_key, "")

    def test_resume_true_sets_session_key(self) -> None:
        raw = _cfg([{
            "name": "weekly",
            "schedule": "0 9 * * 1",
            "prompt": "weekly summary",
            "resume": True,
        }])
        [s] = parse_schedules(raw)
        self.assertTrue(s.resume)
        self.assertEqual(s.session_key, "cron:weekly")

    def test_jitter_secs_honoured(self) -> None:
        raw = _cfg([{
            "name": "a", "schedule": "@every 1h",
            "prompt": "p", "jitter_secs": 300,
        }])
        [s] = parse_schedules(raw)
        self.assertEqual(s.jitter_secs, 300)

    def test_multiple_entries(self) -> None:
        raw = _cfg([
            {"name": "a", "schedule": "@every 1h", "prompt": "p1"},
            {"name": "b", "schedule": "0 0 * * *", "prompt": "p2"},
        ])
        ss = parse_schedules(raw)
        self.assertEqual([s.name for s in ss], ["a", "b"])


class ValidationTests(unittest.TestCase):
    def test_not_a_list_rejected(self) -> None:
        with self.assertRaises(ScheduleConfigError):
            parse_schedules('{"name":"a"}')

    def test_invalid_json_rejected(self) -> None:
        with self.assertRaises(ScheduleConfigError):
            parse_schedules('not json')

    def test_entry_not_object_rejected(self) -> None:
        with self.assertRaises(ScheduleConfigError):
            parse_schedules('["just a string"]')

    def test_missing_name_rejected(self) -> None:
        raw = _cfg([{"schedule": "@every 1h", "prompt": "p"}])
        with self.assertRaises(ScheduleConfigError):
            parse_schedules(raw)

    def test_bad_name_charset_rejected(self) -> None:
        raw = _cfg([{
            "name": "bad name!", "schedule": "@every 1h", "prompt": "p",
        }])
        with self.assertRaises(ScheduleConfigError):
            parse_schedules(raw)

    def test_duplicate_names_rejected(self) -> None:
        raw = _cfg([
            {"name": "a", "schedule": "@every 1h", "prompt": "p1"},
            {"name": "a", "schedule": "0 0 * * *", "prompt": "p2"},
        ])
        with self.assertRaises(ScheduleConfigError):
            parse_schedules(raw)

    def test_missing_prompt_rejected(self) -> None:
        raw = _cfg([{"name": "a", "schedule": "@every 1h"}])
        with self.assertRaises(ScheduleConfigError):
            parse_schedules(raw)

    def test_empty_prompt_rejected(self) -> None:
        raw = _cfg([{"name": "a", "schedule": "@every 1h", "prompt": "  "}])
        with self.assertRaises(ScheduleConfigError):
            parse_schedules(raw)

    def test_invalid_cron_expression_rejected(self) -> None:
        raw = _cfg([{"name": "a", "schedule": "not cron", "prompt": "p"}])
        with self.assertRaises(ScheduleConfigError) as ctx:
            parse_schedules(raw)
        # Error message should identify the schedule by name so ops
        # can find the bad entry fast.
        self.assertIn("a", str(ctx.exception))

    def test_negative_jitter_rejected(self) -> None:
        raw = _cfg([{
            "name": "a", "schedule": "@every 1h", "prompt": "p",
            "jitter_secs": -1,
        }])
        with self.assertRaises(ScheduleConfigError):
            parse_schedules(raw)

    def test_non_bool_resume_rejected(self) -> None:
        raw = _cfg([{
            "name": "a", "schedule": "@every 1h", "prompt": "p",
            "resume": "yes",
        }])
        with self.assertRaises(ScheduleConfigError):
            parse_schedules(raw)

    def test_bool_jitter_rejected(self) -> None:
        """Python's bool-is-int quirk must not silently accept
        ``{"jitter_secs": true}`` as jitter=1."""
        for value in (True, False):
            raw = _cfg([{
                "name": "a", "schedule": "@every 1h", "prompt": "p",
                "jitter_secs": value,
            }])
            with self.assertRaises(ScheduleConfigError) as ctx:
                parse_schedules(raw)
            self.assertIn("jitter_secs", str(ctx.exception))

    def test_unreachable_expression_rejected(self) -> None:
        """Grammar-valid but semantically impossible schedules must fail
        validation at startup, not at first fire attempt."""
        # Feb 31 doesn't exist in any calendar year.
        raw = _cfg([{
            "name": "impossible", "schedule": "0 0 31 2 *", "prompt": "p",
        }])
        with self.assertRaises(ScheduleConfigError) as ctx:
            parse_schedules(raw)
        self.assertIn("unreachable", str(ctx.exception))
        self.assertIn("impossible", str(ctx.exception))

    def test_unreachable_leap_year_feb_30(self) -> None:
        """Another impossible one that passes grammar but never fires."""
        raw = _cfg([{
            "name": "x", "schedule": "0 0 30 2 *", "prompt": "p",
        }])
        with self.assertRaises(ScheduleConfigError):
            parse_schedules(raw)

    def test_leap_year_feb_29_is_reachable(self) -> None:
        """Feb 29 IS reachable (every 4 years); must not be rejected."""
        raw = _cfg([{
            "name": "leap", "schedule": "0 0 29 2 *", "prompt": "p",
        }])
        [s] = parse_schedules(raw)
        self.assertEqual(s.name, "leap")


if __name__ == "__main__":
    unittest.main()
