"""GitHub mention + review-request triggers.

Both triggers wrap a ``hivemoot watch --once`` poll cycle inside the
plugin engine (per ADR-002).  Each event becomes a Job dispatched
synchronously; the plugin's ``on_job_finished`` hook later calls
``hivemoot ack`` to mark the notification consumed so the next cycle
won't re-emit it.

Dedup is owned by the Go binary's ``--state-file`` plus our serial
dispatch loop: only one event is in flight at a time per trigger, and
once acked the binary refuses to re-emit.  No in-process bookkeeping
needed.

Failure semantics: if dispatch fails OR the agent run fails, ack is
skipped — the event reappears on the next cycle and gets retried.
That matches the shell controller's ``watch_trigger_failure_backoff``
behaviour without the file-based scaffolding.
"""

from __future__ import annotations

import os
import sys
import threading
from typing import Any

from hivemoot_agent.plugins.interfaces import Job, JobDispatcher, PluginConfig
from hivemoot_agent.plugins_builtin.github import prompts, watcher


_DEFAULT_POLL_INTERVAL_SECS = 300


def _resolve_target_repo(config: PluginConfig) -> str:
    """Pick the repo to watch.

    The shell trigger used ``$target_repo`` (a single value).  Plugins
    operate on potentially-many repos via ``GITHUB_REPOS``; ``TARGET_REPO``
    if set wins, otherwise the first entry of ``GITHUB_REPOS``.  Watching
    multiple repos at once is out of scope here — fleet config gives
    each agent one primary repo and a separate container per repo.
    """
    target = (config.get("TARGET_REPO", "") or "").strip()
    if target:
        return target
    repos_raw = (config.get("GITHUB_REPOS", "") or "").strip()
    if not repos_raw:
        return ""
    first = repos_raw.split(",")[0].strip()
    return first


def _resolve_state_dir(config: PluginConfig) -> str:
    """Where to keep ``hivemoot watch`` state files.

    Default to the agent's persistent memory volume so state survives
    container restarts; otherwise the next start would re-fire every
    notification on the GitHub side that hasn't aged out.
    """
    explicit = (config.get("GITHUB_WATCH_STATE_DIR", "") or "").strip()
    if explicit:
        return explicit
    memory_dir = (
        config.get("AGENT_MEMORY_DIR", "")
        or os.environ.get("AGENT_MEMORY_DIR", "")
        or "/home/node/.hivemoot/memory"
    )
    return os.path.join(memory_dir, ".github-watch")


def _resolve_gh_token(config: PluginConfig) -> str:
    return (
        config.get("GITHUB_TOKEN", "")
        or os.environ.get("GITHUB_TOKEN", "")
        or os.environ.get("GH_TOKEN", "")
        or ""
    )


def _safe_int(value: Any, default: int) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


class _GitHubWatchTrigger:
    """Shared poll loop for the two github watchers.

    Subclasses set the basename of the state file, optional watch reasons,
    the prompt builder, and the session-key prefix.  Everything else
    lives here.
    """

    name: str = ""
    state_file_basename: str = ""
    watch_reasons: list[str] = []
    enable_env: str = ""

    def __init__(self, plugin: Any) -> None:
        self._plugin = plugin
        self._stop_event = threading.Event()

    # Subclass hooks — keep tiny so the diff between mention/review is
    # easy to eyeball.

    def _build_prompt(self, event: watcher.WatchEvent) -> str:
        raise NotImplementedError

    def _session_key(self, event: watcher.WatchEvent) -> str:
        raise NotImplementedError

    # Shared lifecycle.

    def validate(self, config: PluginConfig) -> list[str]:
        errors: list[str] = []
        if not _resolve_target_repo(config):
            errors.append(
                f"{self.name} requires TARGET_REPO or GITHUB_REPOS to "
                "select a repo to watch"
            )
        if not _resolve_gh_token(config):
            errors.append(
                f"{self.name} requires GITHUB_TOKEN for GitHub API auth"
            )
        return errors

    def start(self, config: PluginConfig, dispatcher: JobDispatcher) -> None:
        repo = _resolve_target_repo(config)
        gh_token = _resolve_gh_token(config)
        if not repo or not gh_token:
            print(
                f"[{self.name}] disabled: missing repo or token",
                file=sys.stderr, flush=True,
            )
            return

        state_dir = _resolve_state_dir(config)
        try:
            os.makedirs(state_dir, exist_ok=True)
        except OSError as exc:
            print(
                f"[{self.name}] cannot create state dir {state_dir}: {exc}",
                file=sys.stderr, flush=True,
            )
            return
        state_file = os.path.join(state_dir, self.state_file_basename)

        poll_interval = max(
            1,
            _safe_int(
                config.get("GITHUB_WATCH_POLL_INTERVAL", ""),
                _DEFAULT_POLL_INTERVAL_SECS,
            ),
        )

        self._stop_event.clear()
        print(
            f"[{self.name}] watching {repo} every {poll_interval}s "
            f"(state={state_file})",
            file=sys.stderr, flush=True,
        )

        while not self._stop_event.is_set():
            try:
                events = watcher.poll_once(
                    repo=repo,
                    state_file=state_file,
                    interval_secs=poll_interval,
                    gh_token=gh_token,
                    reasons=self.watch_reasons or None,
                )
            except (RuntimeError, ValueError) as exc:
                print(
                    f"[{self.name}] poll failed: {exc}",
                    file=sys.stderr, flush=True,
                )
                self._stop_event.wait(poll_interval)
                continue

            for event in events:
                if self._stop_event.is_set():
                    break
                self._dispatch_event(event, state_file, dispatcher)

            self._stop_event.wait(poll_interval)

    def _dispatch_event(
        self,
        event: watcher.WatchEvent,
        state_file: str,
        dispatcher: JobDispatcher,
    ) -> None:
        prompt_body = self._build_prompt(event)
        session_key = self._session_key(event)
        ack_key = event.ack_key

        print(
            f"[{self.name}] event #{event.display_number} by @{event.author}",
            file=sys.stderr, flush=True,
        )

        # Stash everything the plugin's on_job_finished needs to ack the
        # event without re-querying — keeps the trigger and the lifecycle
        # hook decoupled from any shared mutable state.
        job = Job(
            session_key=session_key,
            prompt=prompt_body,
            metadata={
                "github_watch": {
                    "trigger": self.name,
                    "ack_key": ack_key,
                    "state_file": state_file,
                    "number": event.display_number,
                },
            },
        )

        ok = dispatcher.dispatch(job)
        if not ok:
            print(
                f"[{self.name}] dispatch failed for #{event.display_number}",
                file=sys.stderr, flush=True,
            )

    def stop(self) -> None:
        self._stop_event.set()


class GitHubMentionsTrigger(_GitHubWatchTrigger):
    name = "github-mention"
    state_file_basename = "mentions.json"
    watch_reasons: list[str] = []  # default: all mention reasons

    def _build_prompt(self, event: watcher.WatchEvent) -> str:
        return prompts.build_mention_prompt(event.display_number, event.url)

    def _session_key(self, event: watcher.WatchEvent) -> str:
        if event.thread_id:
            return f"mention-thread:{event.thread_id}"
        if event.number:
            return f"mention-number:{event.number}"
        # Last resort — every event gets a fresh session.  Better than
        # collapsing distinct events into one resumed session.
        return f"mention:{event.ack_key or 'unknown'}"


class GitHubReviewRequestsTrigger(_GitHubWatchTrigger):
    name = "github-review-request"
    state_file_basename = "review-requests.json"
    watch_reasons = ["review_requested"]

    def _build_prompt(self, event: watcher.WatchEvent) -> str:
        return prompts.build_review_request_prompt(
            event.display_number, event.title, event.author, event.url,
        )

    def _session_key(self, event: watcher.WatchEvent) -> str:
        if event.number:
            return f"review-pr:{event.number}"
        return f"review:{event.ack_key or 'unknown'}"
