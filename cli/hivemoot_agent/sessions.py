"""Persistent session store — TSV-backed, thread-safe, with resume policy.

Mirrors the bash worker's tool-session-map.tsv format so both runtimes
can share session state when needed.  Adds day-boundary reset support
inspired by Hermes' session_reset.at_hour pattern.

TSV format (one record per line):
    session_key<TAB>session_id<TAB>created_epoch<TAB>last_used_epoch
"""

from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


@dataclass
class SessionRecord:
    """A persisted session entry."""

    session_key: str
    session_id: str
    created_epoch: int
    last_used_epoch: int


class SessionStore:
    """Thread-safe, TSV-backed session store with resume policy."""

    def __init__(
        self,
        map_file: str,
        resume_enabled: bool = True,
        max_idle_hours: int = 12,
        max_age_hours: int = 24,
        reset_at_hour: int | None = None,
    ) -> None:
        self.map_file = map_file
        self.resume_enabled = resume_enabled
        self.max_idle_hours = max_idle_hours
        self.max_age_hours = max_age_hours
        self.reset_at_hour = reset_at_hour
        self._records: dict[str, SessionRecord] = {}
        self._lock = threading.Lock()

    def load(self) -> None:
        """Read the TSV file into memory.  Missing file is fine."""
        with self._lock:
            self._records = self._read_tsv()

    def lookup(self, session_key: str) -> tuple[str, SessionRecord | None]:
        """Check resume policy and return (session_id, record) or ("", None).

        Returns the session_id to resume and the prior record (so the
        caller can preserve created_epoch on save).  Returns ("", None)
        when there is no valid session to resume.
        """
        if not self.resume_enabled or not session_key:
            return ("", None)

        with self._lock:
            record = self._records.get(session_key)

        if record is None:
            return ("", None)

        now = int(time.time())
        if not self.should_resume(record, now):
            return ("", None)

        return (record.session_id, record)

    def save(
        self,
        session_key: str,
        session_id: str,
        was_resume: bool,
        prior_record: SessionRecord | None,
    ) -> None:
        """Persist a session record after a successful agent run.

        When resuming an existing session, preserves the original
        created_epoch.  Otherwise sets created_epoch to now.
        """
        now = int(time.time())

        if was_resume and prior_record is not None:
            created = prior_record.created_epoch
        else:
            created = now

        record = SessionRecord(
            session_key=session_key,
            session_id=session_id,
            created_epoch=created,
            last_used_epoch=now,
        )

        with self._lock:
            self._records[session_key] = record
            self._write_tsv(self._records)

    # Minimum idle time (seconds) before a day-boundary reset can fire.
    # Without this, a user chatting at 3:50 AM who sends another message
    # at 4:05 AM would lose their entire conversation just because the
    # clock crossed the reset hour.  The grace window ensures active
    # conversations flow through the boundary naturally — the reset
    # only kicks in once the session has been idle long enough that the
    # user clearly stepped away.
    DAY_BOUNDARY_MIN_IDLE_SECS = 3600  # 1 hour

    def should_resume(self, record: SessionRecord, now: int) -> bool:
        """Evaluate idle + age + day-boundary policy.

        Idle and age limits are hard: exceed either and the session expires.

        The day boundary is softer: it only fires when the session is
        ALSO idle for at least DAY_BOUNDARY_MIN_IDLE_SECS.  This prevents
        active late-night conversations from being cut off at the reset
        hour (e.g., chatting at 3 AM, boundary at 4 AM, message at 4:05).
        """
        idle_secs = now - record.last_used_epoch
        age_secs = now - record.created_epoch

        # Guard against clock skew.
        if idle_secs < 0 or age_secs < 0:
            return False

        if idle_secs > self.max_idle_hours * 3600:
            return False

        if age_secs > self.max_age_hours * 3600:
            return False

        # Day boundary check — only fires when the conversation has gone
        # quiet.  An active conversation (idle < 1h) is never killed by
        # the day boundary alone.
        boundary = self._last_reset_boundary(now)
        if (
            boundary is not None
            and record.created_epoch < boundary
            and idle_secs >= self.DAY_BOUNDARY_MIN_IDLE_SECS
        ):
            return False

        return True

    # ── Internal ───────────────────────────────────────────────────

    def _last_reset_boundary(self, now: int) -> int | None:
        """Compute the most recent reset_at_hour as a Unix epoch.

        Uses the system's local timezone (honoring TZ env var).
        Returns None when reset_at_hour is not configured.
        """
        if self.reset_at_hour is None:
            return None

        # Get current local time.
        local_now = datetime.fromtimestamp(now)
        today_boundary = local_now.replace(
            hour=self.reset_at_hour, minute=0, second=0, microsecond=0,
        )

        if local_now >= today_boundary:
            # The boundary already passed today.
            boundary_dt = today_boundary
        else:
            # Haven't reached today's boundary yet — use yesterday's.
            from datetime import timedelta
            boundary_dt = today_boundary - timedelta(days=1)

        return int(boundary_dt.timestamp())

    def _read_tsv(self) -> dict[str, SessionRecord]:
        """Parse the TSV session map file."""
        records: dict[str, SessionRecord] = {}

        if not os.path.isfile(self.map_file):
            return records

        try:
            with open(self.map_file) as f:
                for line in f:
                    line = line.rstrip("\n")
                    if not line:
                        continue
                    parts = line.split("\t")
                    if len(parts) != 4:
                        print(
                            f"[sessions] skipping malformed line: {line!r}",
                            file=sys.stderr,
                        )
                        continue
                    key, sid, created, last_used = parts
                    try:
                        records[key] = SessionRecord(
                            session_key=key,
                            session_id=sid,
                            created_epoch=int(created),
                            last_used_epoch=int(last_used),
                        )
                    except ValueError:
                        print(
                            f"[sessions] skipping line with bad epoch: {line!r}",
                            file=sys.stderr,
                        )
        except OSError as exc:
            print(
                f"[sessions] failed to read {self.map_file}: {exc}",
                file=sys.stderr,
            )

        return records

    def _write_tsv(self, records: dict[str, SessionRecord]) -> None:
        """Atomic write: temp file + os.replace."""
        map_dir = os.path.dirname(self.map_file)
        os.makedirs(map_dir, exist_ok=True)

        fd, tmp_path = tempfile.mkstemp(
            suffix=".tmp", prefix="session-map-", dir=map_dir,
        )
        try:
            with os.fdopen(fd, "w") as f:
                for rec in records.values():
                    f.write(
                        f"{rec.session_key}\t{rec.session_id}"
                        f"\t{rec.created_epoch}\t{rec.last_used_epoch}\n"
                    )
            os.replace(tmp_path, self.map_file)
        except Exception:
            # Clean up temp file on failure.
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise


# ── Helpers ───────────────────────────────────────────────────────


def build_scoped_key(
    base_key: str,
    provider: str,
    model: str = "",
    repo: str = "",
    tool_options_json: str = "",
) -> str:
    """Build a scoped session key.

    Sessions are scoped by repo, provider, model, and tool options so
    that a change in any of these dimensions starts a fresh session
    instead of resuming with stale or incompatible context.

    Note: the hash algorithm (zlib.crc32) differs from the bash
    worker's cksum, so Python-engine and bash-worker session maps are
    NOT interoperable.  This is fine — they run in different contexts
    (plugin engine vs controller-spawned containers) and do not share
    TSV files in practice.
    """
    if not base_key:
        return ""
    import zlib
    resolved_model = model or "default"
    resolved_repo = repo or "_"
    # Normalize empty tool options to "{}" to match the bash worker's
    # default (run-once.sh line 207) before hashing.
    normalized_opts = tool_options_json or "{}"
    options_hash = str(zlib.crc32(normalized_opts.encode()) & 0xFFFFFFFF)
    return (
        f"repo={resolved_repo}"
        f"|provider={provider}"
        f"|model={resolved_model}"
        f"|toolopts={options_hash}"
        f"|key={base_key}"
    )


def create_session_store(config: Any) -> SessionStore:
    """Factory: build a SessionStore from environment / PluginConfig.

    Resolves the TSV file path and resume policy from config.  The
    config object needs a .get(key, default) method (PluginConfig or
    a plain dict wrapper both work).
    """
    provider = config.get("AGENT_PROVIDER", "claude") or "claude"

    # Resolve base directory for the TSV file.
    persistent_dir = config.get("PERSISTENT_SESSION_DIR", "") or ""
    workspace_root = config.get("WORKSPACE_ROOT", "") or ""

    if persistent_dir and os.path.isdir(persistent_dir):
        base_dir = os.path.join(persistent_dir, "sessions", provider)
    elif workspace_root:
        base_dir = os.path.join(workspace_root, "sessions", provider)
    else:
        # Last resort — sessions won't survive container restart but
        # will work within a single engine lifetime.
        base_dir = os.path.join("/tmp", "hivemoot-sessions", provider)

    map_file = os.path.join(base_dir, "tool-session-map.tsv")

    # Resume toggle.
    resume_raw = (
        config.get("SESSION_RESUME", "")
        or config.get("SESSION_RESUME_ENABLED", "1")
        or "1"
    )
    resume_enabled = str(resume_raw) != "0"

    max_idle = int(config.get("SESSION_RESUME_MAX_IDLE_HOURS", "12") or "12")
    max_age = int(config.get("SESSION_RESUME_MAX_AGE_HOURS", "24") or "24")

    reset_hour_raw = config.get("SESSION_RESET_AT_HOUR", "") or ""
    reset_at_hour: int | None = None
    if reset_hour_raw:
        try:
            h = int(reset_hour_raw)
            if 0 <= h <= 23:
                reset_at_hour = h
            else:
                print(
                    f"[sessions] SESSION_RESET_AT_HOUR={h} out of range "
                    f"(0-23), ignoring",
                    file=sys.stderr,
                )
        except ValueError:
            print(
                f"[sessions] SESSION_RESET_AT_HOUR={reset_hour_raw!r} "
                f"is not a valid integer, ignoring",
                file=sys.stderr,
            )

    store = SessionStore(
        map_file=map_file,
        resume_enabled=resume_enabled,
        max_idle_hours=max_idle,
        max_age_hours=max_age,
        reset_at_hour=reset_at_hour,
    )
    store.load()
    return store
