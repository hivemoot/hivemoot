"""GitHub event triggers.

Notification-backed triggers (mentions, review requests) wrap a
``hivemoot watch --once`` poll cycle inside the plugin engine (per
ADR-002).  Dedup is owned by the Go binary's ``--state-file`` plus our
serial dispatch loop: only one event is in flight at a time per trigger
and, once acked, the binary refuses to re-emit.

The new-PR trigger is poll-based against the GitHub REST ``/pulls``
endpoint with a local state file — it filters by author and skips the
existing open-PR backlog on first boot.  See ``pr_watcher`` for details.

Failure semantics: if dispatch fails OR the agent run fails, ack is
skipped — the event reappears on the next cycle and gets retried.  That
matches the shell controller's ``watch_trigger_failure_backoff`` without
the file-based scaffolding.
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any

from hivemoot_agent.plugins.interfaces import Job, JobDispatcher, PluginConfig
from hivemoot_agent.plugins_builtin.github import pr_watcher, prompts, watcher

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
    """Read the token for trigger polls, returning ``""`` on failure.

    Two-mode resolution (apiarist Phase L'):

    - ``token_source: file`` — read once per call from ``cfg.token_file``.
      Existing long-lived-PAT path; the file is local + cheap to re-read.
    - ``token_source: subscriber`` — read from ``GH_TOKEN`` /
      ``GITHUB_TOKEN`` env, populated by the hivemoot apiarist auth
      subscriber. The subscriber mints a token in ``setup_lifecycle``
      (so env is populated before triggers' first poll) and refreshes
      it via a background thread (so env stays populated during long
      idle periods between jobs — critical for trigger services like
      drone that have NO work source but the watch triggers).

    Called per-poll-iteration (not just at ``start()``) so a token
    rotation in either mode takes effect within one poll interval
    instead of waiting for container restart.
    """
    if cfg.token_source == "subscriber":
        return os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
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

    # Subclass hooks — keep tiny so the diff between mention/review/new-PR
    # implementations is easy to eyeball.

    def _build_prompt(self, event: Any) -> str:
        raise NotImplementedError

    def _session_key(self, event: Any) -> str:
        raise NotImplementedError

    def _ack_strategy(self) -> str:
        """Which ack path ``on_job_finished`` should take after success.

        ``"notification"`` — the default — routes to ``ack_module.ack_event``
        (GitHub-notification-backed).  Poll-based subclasses override to
        route to their own local-state ack helper.
        """
        return "notification"

    def _poll_events(
        self,
        cfg: "GitHubConfig",
        repo: str,
        state_file: str,
        poll_interval: int,
        gh_token: str,
    ) -> list[Any]:
        """Return the events to dispatch this cycle.

        Default implementation wraps ``watcher.poll_once`` for the
        notification-backed triggers.  Poll-based subclasses override
        with their own fetcher.
        """
        return watcher.poll_once(
            repo=repo,
            state_file=state_file,
            interval_secs=poll_interval,
            gh_token=gh_token,
            reasons=self.watch_reasons or None,
        )

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
        # Token validation is mode-dependent:
        #   - file mode: token must be readable NOW (validate-time fail-fast).
        #   - subscriber mode: env populated asynchronously by the hivemoot
        #     auth subscriber after setup_lifecycle; checking at validate()
        #     time would always fail. The trigger's poll loop re-reads
        #     each iteration and skips empty-token cycles with a log.
        if cfg.token_source == "file" and not _resolve_gh_token(cfg):
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
        if not repo:
            print(
                f"[{self.name}] disabled: missing repo",
                file=sys.stderr, flush=True,
            )
            return
        # In file mode we can fail fast on missing token here. In
        # subscriber mode the env token is populated by the hivemoot
        # auth subscriber asynchronously; the poll loop tolerates
        # empty-token cycles, so we proceed.
        if cfg.token_source == "file" and not _resolve_gh_token(cfg):
            print(
                f"[{self.name}] disabled: missing token file",
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
            f"(state={state_file}, token_source={cfg.token_source})",
            file=sys.stderr, flush=True,
        )

        # Rate-limit the "no token this cycle" warning so a long idle
        # period (subscriber mode, awaiting initial mint) doesn't flood
        # stderr with one warning per poll. One warning per minute
        # covers operator visibility without spam.
        last_no_token_warn = 0.0
        no_token_warn_interval = 60.0

        while not self._stop_event.is_set():
            # Re-resolve token EACH poll so a rotation in either mode
            # (file mode: file replaced on disk; subscriber mode:
            # apiarist auth subscriber re-mints into env) takes effect
            # within one poll interval instead of waiting for restart.
            gh_token = _resolve_gh_token(cfg)
            if not gh_token:
                # In subscriber mode this happens briefly between
                # container start and the auth subscriber's initial
                # mint. Skip this poll cycle and retry next interval.
                import time as _time
                now = _time.monotonic()
                if now - last_no_token_warn >= no_token_warn_interval:
                    print(
                        f"[{self.name}] no token this cycle "
                        f"(token_source={cfg.token_source}); "
                        "skipping poll, retry next interval",
                        file=sys.stderr, flush=True,
                    )
                    last_no_token_warn = now
                self._stop_event.wait(poll_interval)
                continue

            try:
                events = self._poll_events(
                    cfg=cfg,
                    repo=repo,
                    state_file=state_file,
                    poll_interval=poll_interval,
                    gh_token=gh_token,
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
                self._dispatch_event(event, repo, state_file, dispatcher)

            self._stop_event.wait(poll_interval)

    def _coalesce_key(self, event: Any, repo: str) -> str:
        """Coalescing key — subclasses override to opt in to merging.

        Default: session_key-based, so each session gets its own
        coalesce key (effectively no cross-event coalescing).
        Subclasses (mentions per-thread, review+new-pr per-PR) return
        a stable key to enable dedup + ack merging in the engine.
        """
        return self._session_key(event)

    def _dispatch_event(
        self,
        event: Any,
        repo: str,
        state_file: str,
        dispatcher: JobDispatcher,
    ) -> None:
        prompt_body = self._build_prompt(event)
        session_key = self._session_key(event)
        coalesce_key = self._coalesce_key(event, repo)
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
                "coalesce_key": coalesce_key,
                "github_watch": {
                    "trigger": self.name,
                    "ack_strategy": self._ack_strategy(),
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

    def _coalesce_key(
        self, event: watcher.WatchEvent, repo: str,
    ) -> str:
        """Coalesce per-thread — rapid-fire mentions in one thread merge.

        NOT per-PR — a mention thread is its own conversation unit and
        may live inside an issue (not a PR) or span multiple comments;
        coalescing by PR would conflate distinct threads on the same PR.
        """
        if event.thread_id:
            return f"{repo}:mention-thread:{event.thread_id}"
        if event.number:
            return f"{repo}:mention-number:{event.number}"
        return f"{repo}:mention:{event.ack_key or 'unknown'}"


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

    def _coalesce_key(
        self, event: watcher.WatchEvent, repo: str,
    ) -> str:
        """Coalesce per-PR — shared with new-PR events for the same PR.

        "Someone opened #42 AND assigned guard as reviewer" is a common
        human workflow; the two events merge into a single review run
        because the prompts are level-triggered (agent reads the PR
        state fresh) and the ack list preserves both notifications.
        """
        if event.number:
            return f"{repo}:pr:{event.number}"
        return f"{repo}:review:{event.ack_key or 'unknown'}"


class GitHubNewPullRequestsTrigger(_GitHubWatchTrigger):
    """Poll newly opened PRs filtered by author — see pr_watcher.py."""

    name = "github-new-pr"
    state_file_basename = "new-prs.json"

    def _build_prompt(self, event: pr_watcher.PullRequestEvent) -> str:
        return prompts.build_new_pr_prompt(
            event.display_number, event.title, event.author, event.url,
        )

    def _session_key(self, event: pr_watcher.PullRequestEvent) -> str:
        if event.number:
            return f"new-pr:{event.number}"
        return f"new-pr:{event.ack_key or 'unknown'}"

    def _coalesce_key(
        self, event: pr_watcher.PullRequestEvent, repo: str,
    ) -> str:
        """Coalesce per-PR — shared with review-request events.

        See GitHubReviewRequestsTrigger._coalesce_key for the rationale.
        """
        if event.number:
            return f"{repo}:pr:{event.number}"
        return f"{repo}:new-pr:{event.ack_key or 'unknown'}"

    def _ack_strategy(self) -> str:
        return "new_pr"

    def _poll_events(
        self,
        cfg: "GitHubConfig",
        repo: str,
        state_file: str,
        poll_interval: int,  # noqa: ARG002 — base-class signature only
        gh_token: str,
    ) -> list[pr_watcher.PullRequestEvent]:
        return pr_watcher.poll_new_prs_once(
            repo=repo,
            state_file=state_file,
            gh_token=gh_token,
            authors=list(cfg.watch_new_prs_authors),
        )
