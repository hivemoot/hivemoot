"""Tests for the cron expression parser and next_fire semantics.

Correctness here is non-negotiable — a silently-wrong schedule is
worse than a broken one, so the coverage is dense around parse-time
validation + a battery of "known next fire" fixtures.
"""

from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.cron.expression import (
    CronExpression,
    CronParseError,
    EveryDuration,
    parse_expression,
)


def utc(*args) -> datetime:
    return datetime(*args, tzinfo=timezone.utc)


# ── @every ────────────────────────────────────────────────────────


class EveryDurationTests(unittest.TestCase):
    def test_parse_hours(self) -> None:
        e = parse_expression("@every 1h")
        self.assertIsInstance(e, EveryDuration)
        self.assertEqual(e.seconds, 3600)

    def test_parse_minutes_seconds_days(self) -> None:
        self.assertEqual(parse_expression("@every 30m").seconds, 1800)
        self.assertEqual(parse_expression("@every 45s").seconds, 45)
        self.assertEqual(parse_expression("@every 2d").seconds, 172800)

    def test_next_fire_pure_duration(self) -> None:
        e = parse_expression("@every 1h")
        self.assertEqual(
            e.next_fire(utc(2026, 4, 18, 12, 0)),
            utc(2026, 4, 18, 13, 0),
        )
        # 30 minutes past the hour → +1h (not aligned to hour boundary).
        self.assertEqual(
            e.next_fire(utc(2026, 4, 18, 12, 30, 15)),
            utc(2026, 4, 18, 13, 30, 15),
        )

    def test_rejects_missing_unit(self) -> None:
        with self.assertRaises(CronParseError):
            parse_expression("@every 1")

    def test_rejects_bad_unit(self) -> None:
        with self.assertRaises(CronParseError):
            parse_expression("@every 1w")

    def test_rejects_non_integer(self) -> None:
        with self.assertRaises(CronParseError):
            parse_expression("@every 1.5h")

    def test_rejects_zero(self) -> None:
        with self.assertRaises(CronParseError):
            parse_expression("@every 0s")

    def test_rejects_empty_duration(self) -> None:
        with self.assertRaises(CronParseError):
            parse_expression("@every  ")


# ── 5-field parse + reject ────────────────────────────────────────


class FieldParseTests(unittest.TestCase):
    def test_wildcard_everywhere(self) -> None:
        e = parse_expression("* * * * *")
        self.assertIsInstance(e, CronExpression)
        # Every minute is a match → next fire is exactly 1 minute later.
        self.assertEqual(
            e.next_fire(utc(2026, 4, 18, 12, 30)),
            utc(2026, 4, 18, 12, 31),
        )

    def test_list(self) -> None:
        e = parse_expression("5,15,25 * * * *")
        self.assertEqual(
            e.next_fire(utc(2026, 4, 18, 12, 10)),
            utc(2026, 4, 18, 12, 15),
        )

    def test_range(self) -> None:
        e = parse_expression("0 9-17 * * *")
        # Outside business hours → jumps to next 9am.
        self.assertEqual(
            e.next_fire(utc(2026, 4, 18, 20, 0)),
            utc(2026, 4, 19, 9, 0),
        )

    def test_step_on_wildcard(self) -> None:
        e = parse_expression("*/15 * * * *")
        self.assertEqual(
            e.next_fire(utc(2026, 4, 18, 12, 7)),
            utc(2026, 4, 18, 12, 15),
        )

    def test_step_on_range(self) -> None:
        e = parse_expression("0 9-17/4 * * *")   # 9, 13, 17
        self.assertEqual(
            e.next_fire(utc(2026, 4, 18, 10, 0)),
            utc(2026, 4, 18, 13, 0),
        )

    def test_bare_value_with_step_expands_to_range(self) -> None:
        # POSIX-ish shorthand: "5/10" means "5, 15, 25, ..." in minute.
        e = parse_expression("5/10 * * * *")
        self.assertEqual(
            e.next_fire(utc(2026, 4, 18, 12, 0)),
            utc(2026, 4, 18, 12, 5),
        )
        self.assertEqual(
            e.next_fire(utc(2026, 4, 18, 12, 5)),
            utc(2026, 4, 18, 12, 15),
        )

    def test_dow_sunday_accepts_0_and_7(self) -> None:
        e_zero = parse_expression("0 9 * * 0")
        e_seven = parse_expression("0 9 * * 7")
        # From Saturday: both must pick Sunday 9am.
        sat = utc(2026, 4, 18, 0, 0)
        self.assertEqual(e_zero.next_fire(sat), e_seven.next_fire(sat))
        self.assertEqual(
            e_zero.next_fire(sat), utc(2026, 4, 19, 9, 0),
        )

    def test_rejects_wrong_field_count(self) -> None:
        with self.assertRaises(CronParseError):
            parse_expression("* * * *")
        with self.assertRaises(CronParseError):
            parse_expression("* * * * * *")

    def test_rejects_out_of_range_values(self) -> None:
        with self.assertRaises(CronParseError):
            parse_expression("60 * * * *")
        with self.assertRaises(CronParseError):
            parse_expression("* 24 * * *")
        with self.assertRaises(CronParseError):
            parse_expression("* * 32 * *")
        with self.assertRaises(CronParseError):
            parse_expression("* * * 13 *")
        with self.assertRaises(CronParseError):
            parse_expression("* * * * 8")

    def test_rejects_reversed_range(self) -> None:
        with self.assertRaises(CronParseError):
            parse_expression("5-1 * * * *")

    def test_rejects_zero_step(self) -> None:
        with self.assertRaises(CronParseError):
            parse_expression("*/0 * * * *")

    def test_rejects_named_shortcuts_until_implemented(self) -> None:
        for shortcut in ("@hourly", "@daily", "@weekly", "@yearly"):
            with self.assertRaises(CronParseError):
                parse_expression(shortcut)

    def test_rejects_empty(self) -> None:
        with self.assertRaises(CronParseError):
            parse_expression("")
        with self.assertRaises(CronParseError):
            parse_expression("   ")


# ── next_fire semantics ───────────────────────────────────────────


class NextFireTests(unittest.TestCase):
    def test_strict_greater_than(self) -> None:
        """Firing once at T must not produce T again."""
        e = parse_expression("0 * * * *")
        hour_boundary = utc(2026, 4, 18, 12, 0)
        self.assertEqual(
            e.next_fire(hour_boundary),
            utc(2026, 4, 18, 13, 0),
        )

    def test_requires_utc(self) -> None:
        e = parse_expression("* * * * *")
        with self.assertRaises(ValueError):
            e.next_fire(datetime(2026, 4, 18, 12, 0))  # naive

    def test_leap_year_feb_29(self) -> None:
        e = parse_expression("0 0 29 2 *")
        self.assertEqual(
            e.next_fire(utc(2026, 3, 1)),
            utc(2028, 2, 29, 0, 0),
        )

    def test_dom_and_dow_both_restricted_is_or(self) -> None:
        """POSIX quirk: both DOM and DOW restricted → union semantics."""
        # 1st of month OR every Monday, 9am UTC.
        e = parse_expression("0 9 1 * 1")
        # A Monday that's not the 1st → still fires.
        # April 20 2026 is a Monday.
        self.assertEqual(
            e.next_fire(utc(2026, 4, 20, 8, 0)),
            utc(2026, 4, 20, 9, 0),
        )
        # The 1st of May 2026 is a Friday → still fires via DOM match.
        self.assertEqual(
            e.next_fire(utc(2026, 4, 30, 0, 0)),
            utc(2026, 5, 1, 9, 0),
        )

    def test_dom_restricted_dow_unrestricted_is_and(self) -> None:
        # Without a DOW restriction, "1st of month" applies as-is.
        e = parse_expression("0 9 1 * *")
        self.assertEqual(
            e.next_fire(utc(2026, 4, 30, 0, 0)),
            utc(2026, 5, 1, 9, 0),
        )

    def test_weekday_mapping(self) -> None:
        """DOW 1-5 = Mon-Fri; from Sat must skip to Mon."""
        e = parse_expression("0 9 * * 1-5")
        # 2026-04-18 is a Saturday.
        self.assertEqual(
            e.next_fire(utc(2026, 4, 18, 12, 0)),
            utc(2026, 4, 20, 9, 0),
        )


# ── Integration: parse_expression dispatch ─────────────────────────


class ParseDispatchTests(unittest.TestCase):
    def test_every_vs_cron_classification(self) -> None:
        self.assertIsInstance(parse_expression("@every 1h"), EveryDuration)
        self.assertIsInstance(
            parse_expression("0 * * * *"), CronExpression,
        )

    def test_whitespace_tolerated(self) -> None:
        self.assertIsInstance(parse_expression("  * * * * *  "), CronExpression)


if __name__ == "__main__":
    unittest.main()
