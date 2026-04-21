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
from pathlib import Path
from typing import TYPE_CHECKING, Any

from hivemoot_agent.plugins.interfaces import Job, JobDispatcher, PluginConfig
from hivemoot_agent.plugins_builtin.github import prompts, watcher

if TYPE_CHECKING:
    from hivemoot_agent.plugins_builtin.github.config import GitHubConfig


def _cfg_of(config: PluginConfig) -> "GitHubConfig | None":
    """Return the typed GitHubConfig, or None if the engine didn't populate it.

    Kept in one place so a future per-trigger override (e.g. passing the
    config explicitly) only needs updating here.
    """
    return config.typed


def _resolve_target_repo(cfg: "GitHubConfig") -> str:
    """Pick the single repo the watch triggers poll.

    There's no separate ``target_repo`` knob — the first entry in
    ``cfg.repos`` is the canonical primary.  If the operator wants
    a different watch target, they can reorder the list.
    """
    if cfg.repos:
        return cfg.repos[0]
    return ""


def _resolve_state_dir(cfg: "GitHubConfig") -> str:
    """Where to keep ``hivemoot watch`` state files.

    Default to the agent's persistent memory volume so state survives
    container restarts; otherwise the next start would re-fire every
    notification on the GitHub side that hasn't aged out.
    """
    if cfg.watch_state_dir is not None:
        return str(cfg.watch_state_dir)
    memory_dir = (
        str(cfg.agent_memory_dir)
        if cfg.agent_memory_dir is not None
        else (
            os.environ.get("AGENT_MEMORY_DIR", "")
            or "/home/node/.hivemoot/memory"
        )
    )
    return os.path.join(memory_dir, ".github-watch")


def _resolve_gh_token(cfg: "GitHubConfig") -> str:
    """Read the token from cfg.token_file (empty string on any failure)."""
    if cfg.token_file is None:
        return ""
    try:
        return Path(cfg.token_file).read_text().strip()
    except OSError:
        return ""


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
        cfg = _cfg_of(config)
        if cfg is None:
            return [
                f"{self.name} requires typed github config "
                "(plugins.github in hivemoot.yaml)"
            ]
        errors: list[str] = []
        if not _resolve_target_repo(cfg):
            errors.append(
                f"{self.name} requires plugins.github.target_repo or "
                "plugins.github.repos to select a repo to watch"
            )
        if not _resolve_gh_token(cfg):
            errors.append(
                f"{self.name} requires plugins.github.token_file "
                "for GitHub API auth"
            )
        return errors

    def start(self, config: PluginConfig, dispatcher: JobDispatcher) -> None:
        cfg = _cfg_of(config)
        if cfg is None:
            print(
                f"[{self.name}] disabled: no typed github config",
                file=sys.stderr, flush=True,
            )
            return
        repo = _resolve_target_repo(cfg)
        gh_token = _resolve_gh_token(cfg)
        if not repo or not gh_token:
            print(
                f"[{self.name}] disabled: missing repo or token",
                file=sys.stderr, flush=True,
            )
            return

        state_dir = _resolve_state_dir(cfg)
        try:
            os.makedirs(state_dir, exist_ok=True)
        except OSError as exc:
            print(
                f"[{self.name}] cannot create state dir {state_dir}: {exc}",
                file=sys.stderr, flush=True,
            )
            return
        state_file = os.path.join(state_dir, self.state_file_basename)

        poll_interval = max(1, cfg.watch_poll_interval_secs)

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
