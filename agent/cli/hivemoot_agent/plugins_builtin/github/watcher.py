"""Wrapper for ``hivemoot watch --once`` — one poll, NDJSON events back.

The Go ``hivemoot`` binary owns GitHub Notifications API rate limiting,
etag handling, and ``--state-file`` semantics.  The plugin shells out
to it once per poll cycle (``--once`` mode) and parses each NDJSON line
into a typed event.  Long-running streaming mode is intentionally not
used: the trigger's ``start()`` loop dispatches each event synchronously
(serial per agent) and a slow dispatch shouldn't backpressure a
streaming subprocess.

Malformed lines are reported but do not abort the poll — a single bad
line should not silence the rest of a batch.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass


_WATCH_TIMEOUT_SECS = 120


@dataclass
class WatchEvent:
    """One notification, normalized from the binary's NDJSON output."""

    thread_id: str = ""
    number: str = ""
    title: str = ""
    author: str = ""
    url: str = ""
    timestamp: str = ""

    @property
    def display_number(self) -> str:
        return self.number or "?"

    @property
    def ack_key(self) -> str:
        """Stable key for ack — matches the shell's ``threadId:timestamp``."""
        if self.thread_id and self.timestamp:
            return f"{self.thread_id}:{self.timestamp}"
        return ""


def poll_once(
    repo: str,
    state_file: str,
    interval_secs: int,
    gh_token: str,
    reasons: list[str] | None = None,
) -> list[WatchEvent]:
    """Run one ``hivemoot watch --once`` poll and return parsed events.

    ``reasons`` filters to specific notification reasons (e.g.
    ``["review_requested"]``); omit / empty for the default mention
    semantics the binary uses.
    """
    if not repo:
        raise ValueError("repo is required for poll_once")
    if not state_file:
        raise ValueError("state_file is required for poll_once")
    if not gh_token:
        raise ValueError("gh_token is required for poll_once")

    cmd = [
        "hivemoot", "watch",
        "--repo", repo,
        "--state-file", state_file,
        "--interval", str(interval_secs),
        "--once",
    ]
    if reasons:
        cmd.extend(["--reasons", ",".join(reasons)])

    env = {**os.environ, "GH_TOKEN": gh_token}
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=_WATCH_TIMEOUT_SECS,
            env=env,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("hivemoot binary not found") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"hivemoot watch timed out after {_WATCH_TIMEOUT_SECS}s"
        ) from exc

    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip() or "no detail"
        raise RuntimeError(
            f"hivemoot watch exited {result.returncode}: {detail}"
        )

    return parse_events(result.stdout)


def parse_events(stdout: str) -> list[WatchEvent]:
    """Parse NDJSON stdout into events, tolerating malformed lines."""
    events: list[WatchEvent] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            print(
                f"[github-watch] dropping non-JSON output: {line[:120]!r}",
                file=sys.stderr, flush=True,
            )
            continue
        if not isinstance(payload, dict):
            continue
        events.append(
            WatchEvent(
                thread_id=str(payload.get("threadId") or ""),
                number=str(payload.get("number") or ""),
                title=str(payload.get("title") or ""),
                author=str(payload.get("author") or "") or "unknown",
                url=str(payload.get("url") or ""),
                timestamp=str(payload.get("timestamp") or ""),
            )
        )
    return events
