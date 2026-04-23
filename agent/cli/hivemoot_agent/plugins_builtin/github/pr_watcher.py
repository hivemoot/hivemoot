"""Poll newly opened pull requests for the github plugin.

Unlike the notification-backed mention/review watchers, this watcher is
*poll-based* and *locally-state-backed*:

- The first poll bootstraps state and intentionally emits nothing so a fresh
  deployment does not replay the entire existing open-PR backlog.
- Subsequent polls list recent open PRs, filter by author when configured, and
  emit only PRs created after bootstrap that have not been acked yet.
- Ack happens only after a successful agent run, so failed reviews retry on
  the next cycle while the PR remains open.

The dedup key is the PR ``number``, not the node_id.  GitHub PR numbers are
immutable and unique within a repo, so ``number`` is sufficient: repo
transfers keep the numbers; deletion does not reuse them.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


_PR_WATCH_TIMEOUT_SECS = 120
_STATE_VERSION = 1


@dataclass
class PullRequestEvent:
    """One newly opened pull request that matched the watch rules."""

    number: str = ""
    title: str = ""
    author: str = ""
    url: str = ""
    created_at: str = ""
    draft: bool = False

    @property
    def display_number(self) -> str:
        return self.number or "?"

    @property
    def ack_key(self) -> str:
        return self.number


def _utcnow_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _parse_timestamp(value: str) -> datetime:
    if not value:
        return datetime.min.replace(tzinfo=timezone.utc)
    normalized = value.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _normalize_authors(authors: list[str] | None) -> set[str]:
    return {
        author.strip().lower()
        for author in authors or []
        if author and author.strip()
    }


def _default_state() -> dict[str, Any]:
    return {
        "version": _STATE_VERSION,
        "bootstrapped_at": "",
        "acked_numbers": [],
    }


def _load_state(state_file: str) -> dict[str, Any] | None:
    if not os.path.exists(state_file):
        return None
    try:
        with open(state_file, encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"failed to read PR watch state {state_file}: {exc}") from exc

    if not isinstance(raw, dict):
        raise RuntimeError(f"invalid PR watch state in {state_file}: expected object")

    state = _default_state()
    state["bootstrapped_at"] = str(raw.get("bootstrapped_at") or "")
    acked = raw.get("acked_numbers") or []
    if not isinstance(acked, list):
        raise RuntimeError(
            f"invalid PR watch state in {state_file}: acked_numbers must be a list"
        )
    state["acked_numbers"] = [
        str(number).strip()
        for number in acked
        if str(number).strip()
    ]
    return state


def _write_state(state_file: str, state: dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(state_file) or ".", exist_ok=True)
    tmp_path = f"{state_file}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        json.dump(state, fh, sort_keys=True)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp_path, state_file)


def _bootstrap_state(state_file: str) -> dict[str, Any]:
    state = _default_state()
    state["bootstrapped_at"] = _utcnow_iso()
    _write_state(state_file, state)
    return state


def _build_event(payload: dict[str, Any]) -> PullRequestEvent:
    user = payload.get("user") or {}
    if not isinstance(user, dict):
        user = {}
    return PullRequestEvent(
        number=str(payload.get("number") or ""),
        title=str(payload.get("title") or ""),
        author=str(user.get("login") or "") or "unknown",
        url=str(payload.get("html_url") or ""),
        created_at=str(payload.get("created_at") or ""),
        draft=bool(payload.get("draft")),
    )


def _fetch_open_pull_requests(repo: str, gh_token: str) -> list[dict[str, Any]]:
    # Sort=created + direction=desc + per_page=100 returns the 100 most
    # recent open PRs, which is the bound we need: the bootstrap filter
    # excludes anything older than bootstrapped_at, so >100 truly new
    # PRs between polls would be the only way to miss one.  At the
    # default 5-minute poll that requires >1 PR/3s — infeasible for
    # human repos.  Callers who need to support backlog bursts can
    # reduce the interval or poll with --paginate in a follow-up.
    endpoint = (
        f"repos/{repo}/pulls"
        "?state=open&sort=created&direction=desc&per_page=100"
    )
    try:
        result = subprocess.run(
            ["gh", "api", endpoint],
            capture_output=True,
            text=True,
            timeout=_PR_WATCH_TIMEOUT_SECS,
            env={**os.environ, "GH_TOKEN": gh_token, "GITHUB_TOKEN": gh_token},
        )
    except FileNotFoundError as exc:
        raise RuntimeError("gh CLI not found") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"gh api timed out after {_PR_WATCH_TIMEOUT_SECS}s"
        ) from exc

    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip() or "no detail"
        raise RuntimeError(f"gh api exited {result.returncode}: {detail}")

    try:
        payload = json.loads(result.stdout or "[]")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"gh api returned invalid JSON: {exc}") from exc

    if not isinstance(payload, list):
        raise RuntimeError("gh api returned non-list PR payload")
    items = [item for item in payload if isinstance(item, dict)]
    return items


def poll_new_prs_once(
    repo: str,
    state_file: str,
    gh_token: str,
    authors: list[str] | None = None,
) -> list[PullRequestEvent]:
    """Return newly opened PRs that match the optional author filter."""
    if not repo:
        raise ValueError("repo is required for poll_new_prs_once")
    if not state_file:
        raise ValueError("state_file is required for poll_new_prs_once")
    if not gh_token:
        raise ValueError("gh_token is required for poll_new_prs_once")

    state = _load_state(state_file)
    if state is None or not state.get("bootstrapped_at"):
        _bootstrap_state(state_file)
        return []

    author_filter = _normalize_authors(authors)
    acked_numbers = set(
        str(number).strip()
        for number in state.get("acked_numbers", [])
        if str(number).strip()
    )
    bootstrapped_at = _parse_timestamp(str(state.get("bootstrapped_at") or ""))

    events: list[PullRequestEvent] = []
    for item in _fetch_open_pull_requests(repo, gh_token):
        event = _build_event(item)
        if not event.number:
            continue
        if event.draft:
            continue
        if author_filter and event.author.lower() not in author_filter:
            continue
        if event.number in acked_numbers:
            continue
        if _parse_timestamp(event.created_at) <= bootstrapped_at:
            continue
        events.append(event)

    return sorted(events, key=lambda event: _parse_timestamp(event.created_at))


def ack_new_pr(ack_key: str, state_file: str) -> bool:
    """Mark a new-PR event handled in the local state file.

    Returns ``True`` on success, ``False`` on any failure.  The trigger's
    lifecycle guarantees at-least-once delivery: if ack fails after a
    successful agent run, the next poll will re-emit the same PR and the
    agent will process it again.  Keep ack cheap and robust.
    """
    if not ack_key or not state_file:
        return False

    try:
        state = _load_state(state_file) or _default_state()
        if not state.get("bootstrapped_at"):
            state["bootstrapped_at"] = _utcnow_iso()

        acked_numbers = [
            str(number).strip()
            for number in state.get("acked_numbers", [])
            if str(number).strip()
        ]
        if ack_key not in acked_numbers:
            acked_numbers.append(ack_key)
            state["acked_numbers"] = acked_numbers
            _write_state(state_file, state)
        return True
    except (OSError, RuntimeError) as exc:
        print(
            f"[github-new-pr] ack failed (key={ack_key}): {exc}",
            file=sys.stderr,
            flush=True,
        )
        return False
