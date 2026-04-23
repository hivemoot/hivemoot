"""Minimal cron expression parser — stdlib only.

Supports the 5-field standard form ``minute hour day-of-month month
day-of-week`` with:

    *           wildcard
    a,b,c       lists
    a-b         ranges
    a-b/N       stepped ranges
    */N         stepped wildcards
    a/N         shorthand for ``a-<max>/N``

Day-of-week accepts 0 or 7 for Sunday (POSIX parity).

Plus one non-standard shorthand popular in job schedulers:

    @every Nunit    where unit is s/m/h/d

``@every`` is evaluated as pure elapsed-time duration (not wall-clock),
which is the right semantics when you want "fire N seconds after the
last fire" without caring about clock alignment.  Standard cron
expressions evaluate against UTC wall-clock minutes so we never have
to reason about DST — the module-level contract is "all times are
UTC, period."

Not supported (intentionally, v1): named aliases (@hourly, @daily…),
``L`` / ``W`` / ``#`` modifiers, seconds-field 6-field form, timezone
overrides.  Add them when a concrete use case asks; every one of
those is a footgun without a serious test battery.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable


class CronParseError(ValueError):
    """Raised when a cron expression cannot be parsed."""


# ── @every Nunit shorthand ─────────────────────────────────────────


_EVERY_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


@dataclass(frozen=True)
class EveryDuration:
    """Fire exactly ``seconds`` after the previous fire.

    Deliberately *not* aligned to wall-clock boundaries — two separate
    fleets with the same ``@every 1h`` schedule started 15 minutes
    apart will keep firing 15 minutes apart.  That's the intended
    behaviour: distribution across a fleet is a feature, not a bug.
    """

    seconds: int

    def next_fire(self, after: datetime) -> datetime:
        _require_utc(after)
        return after + timedelta(seconds=self.seconds)


def _parse_every(expr: str) -> EveryDuration:
    """Parse ``@every 1h`` / ``@every 30m`` / ``@every 900s``."""
    body = expr[len("@every"):].strip()
    if not body:
        raise CronParseError(
            f"@every requires a duration (e.g. '@every 1h'): {expr!r}"
        )
    unit = body[-1]
    if unit not in _EVERY_UNITS:
        raise CronParseError(
            f"@every unit must be one of s/m/h/d: {expr!r}"
        )
    try:
        value = int(body[:-1])
    except ValueError as exc:
        raise CronParseError(
            f"@every value must be an integer: {expr!r}"
        ) from exc
    if value <= 0:
        raise CronParseError(
            f"@every value must be positive: {expr!r}"
        )
    return EveryDuration(seconds=value * _EVERY_UNITS[unit])


# ── Standard 5-field cron ──────────────────────────────────────────


@dataclass(frozen=True)
class _Field:
    """One cron field — the set of integers it matches.

    Immutable frozenset so the expression is hashable / safely shared
    across threads.  The parser does the once-off work of expanding
    ``*``, ``a,b``, ``a-b``, ``a-b/N`` into an explicit set.
    """

    values: frozenset[int]

    def matches(self, value: int) -> bool:
        return value in self.values


def _parse_field(spec: str, low: int, high: int) -> _Field:
    """Parse one cron field within the ``[low, high]`` inclusive range.

    ``spec`` is whatever the user put between spaces; ``low``/``high``
    bound the field-specific valid integers (minute=0-59, hour=0-23,
    etc.).  Returns the set of integers the field matches.  Raises
    ``CronParseError`` with a specific message on any deviation.
    """
    if not spec:
        raise CronParseError("empty field")

    values: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            raise CronParseError(f"empty comma-separated piece in {spec!r}")
        values.update(_parse_piece(part, low, high))
    return _Field(values=frozenset(values))


def _parse_piece(piece: str, low: int, high: int) -> Iterable[int]:
    """Parse one ``*`` / ``a`` / ``a-b`` / ``a-b/N`` / ``*/N`` piece."""
    step = 1
    base = piece
    if "/" in piece:
        base, step_str = piece.split("/", 1)
        try:
            step = int(step_str)
        except ValueError as exc:
            raise CronParseError(
                f"step value is not an integer: {piece!r}"
            ) from exc
        if step <= 0:
            raise CronParseError(f"step must be positive: {piece!r}")

    if base == "*":
        start, end = low, high
    elif "-" in base:
        a, b = base.split("-", 1)
        try:
            start, end = int(a), int(b)
        except ValueError as exc:
            raise CronParseError(
                f"range endpoints must be integers: {piece!r}"
            ) from exc
        if start > end:
            raise CronParseError(
                f"range start exceeds end: {piece!r}"
            )
    else:
        try:
            start = int(base)
        except ValueError as exc:
            raise CronParseError(
                f"value is not an integer: {piece!r}"
            ) from exc
        # A bare integer with a step (``5/10``) is a shorthand for
        # ``5-<high>/10`` — widely supported by crontab implementations.
        end = high if step > 1 else start

    if start < low or end > high:
        raise CronParseError(
            f"value out of range [{low}, {high}]: {piece!r}"
        )

    return range(start, end + 1, step)


@dataclass(frozen=True)
class CronExpression:
    """Parsed standard 5-field cron expression, UTC-only.

    Parsing is strict: any deviation from the supported grammar raises
    ``CronParseError`` at parse time, never at fire time.  Once parsed,
    ``next_fire()`` is pure — same input always yields same output.
    """

    minute: _Field
    hour: _Field
    day_of_month: _Field
    month: _Field
    day_of_week: _Field  # 0 == Sunday; we normalise 7 → 0 at parse time
    raw: str

    @classmethod
    def parse(cls, expr: str) -> "CronExpression":
        parts = expr.split()
        if len(parts) != 5:
            raise CronParseError(
                f"cron expression must have exactly 5 fields, "
                f"got {len(parts)}: {expr!r}"
            )
        minute = _parse_field(parts[0], 0, 59)
        hour = _parse_field(parts[1], 0, 23)
        day_of_month = _parse_field(parts[2], 1, 31)
        month = _parse_field(parts[3], 1, 12)
        dow_raw = _parse_field(parts[4], 0, 7)
        # POSIX allows 0 or 7 for Sunday; Python's weekday() returns
        # 0=Monday, 6=Sunday — we translate later.  Here we just fold
        # 7 into 0 so the set is canonical.
        dow_values = {v % 7 for v in dow_raw.values}
        dow = _Field(values=frozenset(dow_values))
        return cls(
            minute=minute, hour=hour, day_of_month=day_of_month,
            month=month, day_of_week=dow, raw=expr,
        )

    def next_fire(self, after: datetime) -> datetime:
        """Return the smallest UTC datetime > ``after`` that matches.

        Crucially *strictly greater than* — firing once at time T must
        not fire again at T.  Rolls through minutes looking for a
        match; month-day + weekday uses the POSIX "OR" semantics when
        both fields are restricted.

        The minute-by-minute search is O(1-year worst case) in the
        pathological case (e.g. ``0 0 29 2 *`` fires once every ~4
        years).  In practice typical schedules land within the first
        few candidates.  The upper bound of 4 years is enough to
        guarantee termination even for ``0 0 29 2 *``.
        """
        _require_utc(after)
        # Start one minute after `after`, zeroed to the minute boundary
        # so we don't try sub-minute precision (cron doesn't have it).
        candidate = (after + timedelta(minutes=1)).replace(
            second=0, microsecond=0,
        )
        # Upper bound search by ~4 years to cover leap-year-only
        # schedules.  ~2.1M minutes.  We should never get close.
        for _ in range(4 * 366 * 24 * 60):
            if self._matches(candidate):
                return candidate
            candidate = candidate + timedelta(minutes=1)
        raise CronParseError(
            f"no fire time found within 4 years for {self.raw!r}; "
            "expression may be impossible"
        )

    def _matches(self, dt: datetime) -> bool:
        if not self.month.matches(dt.month):
            return False
        if not self.hour.matches(dt.hour):
            return False
        if not self.minute.matches(dt.minute):
            return False
        # POSIX cron quirk: when *both* day-of-month and day-of-week
        # are restricted (neither is the full set), the fire condition
        # is an OR — either field matching is enough.  When one of
        # them is unrestricted, normal AND applies.  Pin this here so
        # users writing ``0 0 1 * 1`` get both "1st of month" and
        # "every Monday" as the surface behaviour, matching vixie/GNU.
        dom_match = self.day_of_month.matches(dt.day)
        # weekday(): Mon=0..Sun=6; cron DOW: Sun=0..Sat=6.  Translate.
        cron_dow = (dt.weekday() + 1) % 7
        dow_match = self.day_of_week.matches(cron_dow)

        dom_restricted = self.day_of_month.values != frozenset(range(1, 32))
        dow_restricted = self.day_of_week.values != frozenset(range(0, 7))

        if dom_restricted and dow_restricted:
            return dom_match or dow_match
        return dom_match and dow_match


# ── Public parse() front door ──────────────────────────────────────


def _require_utc(dt: datetime) -> None:
    """All next_fire math assumes UTC-aware datetimes.

    Accepting a naive datetime would silently produce wrong answers
    under DST locales, so we fail closed instead.
    """
    if dt.tzinfo is None or dt.tzinfo.utcoffset(dt) != timedelta(0):
        raise ValueError(
            "cron.next_fire requires a UTC-aware datetime "
            f"(got tzinfo={dt.tzinfo!r})"
        )


Expression = CronExpression | EveryDuration


def parse_expression(expr: str) -> Expression:
    """Top-level parse.  Returns an object with a ``next_fire(after)`` method."""
    expr = expr.strip()
    if not expr:
        raise CronParseError("empty cron expression")
    if expr.startswith("@every"):
        return _parse_every(expr)
    if expr.startswith("@"):
        raise CronParseError(
            f"named shortcuts (@hourly, @daily, ...) are not supported in v1; "
            f"use the 5-field form: {expr!r}"
        )
    return CronExpression.parse(expr)


def now_utc() -> datetime:
    """Single entry point for current time — makes mocking trivial in tests."""
    return datetime.now(timezone.utc)
