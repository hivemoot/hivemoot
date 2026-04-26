"""Lifecycle subscriber that brokers GitHub installation tokens via
the apiarist daemon and keeps the env populated for the lifetime of
the container.

V1 of the apiarist token broker integration (DESIGN.md §12.3, Phase L').
The subscriber:

- **start()** (called once from the hivemoot plugin's
  ``setup_lifecycle()`` BEFORE the lifecycle subscribes it):
  performs an initial synchronous mint and starts a background
  refresh thread. Triggers running in subscriber mode read
  ``GH_TOKEN`` / ``GITHUB_TOKEN`` from env; doing the initial mint
  here guarantees the env is populated before the trigger threads
  start polling.
- **Background refresh thread**: re-mints when the current token is
  within ``refresh_lead_time_secs`` (default 5 minutes) of expiry.
  Required because trigger services (drone, builder review queue)
  poll continuously and need a valid token even during long idle
  periods between jobs that exceed the 1-hour token TTL.
- **on_active** (IDLE→ACTIVE): proactively refreshes if the current
  token is within the lead-time window. Normally a no-op (the
  background thread keeps things fresh) — defensive for the case
  where the thread is wedged or a job starts during the lead-time
  window.
- **on_idle** (ACTIVE→IDLE): NO-OP. The env stays populated between
  jobs so trigger threads can poll. See §12.3 trade-off discussion.
- **stop()**: signals the refresh thread to exit. Daemon=True
  thread also dies with the process, so this is mainly for clean
  test teardown; not strictly required at container shutdown.

Why on_idle is a no-op (different from earlier V1 sketch):

Watch-driven services (drone with watch_mentions / watch_review_requests
/ watch_new_prs) have NO work source besides their trigger threads.
Trigger threads run on the engine event loop, INDEPENDENT of jobs.
Between jobs they need to poll GitHub to discover new events. If
on_idle clears the env, the trigger has no token between jobs →
deadlock (no events → no jobs → no on_active → token stays missing).

The defense-in-depth value of "env clear when idle" turned out to
be marginal anyway: the token is held in process memory by this
subscriber regardless of whether it's also in env. The hard guarantee
that DOES matter (~1h max TTL via apiarist's policy) is preserved.

Failure modes:

- Apiarist daemon down at start() → :class:`ApiaristTransportError`
  propagates from start(); plugin setup fails; container exits
  fail-closed. Operator's runbook covers this (apiarist must be
  running before the agent container starts; the apiarist install
  script enables it as a systemd unit).
- Apiarist returns ``BACKEND_FORBIDDEN`` (e.g. repo not in token
  policy) → same; fail-closed at startup, operator must fix the
  policy via the set-agent-policy CLI.
- Mint failure in the refresh loop → logged, retried after
  ``refresh_backoff_on_error_secs``. The previous token stays in env
  and may expire → triggers eventually start failing 401 → operator
  sees it in logs. NOT silent.
- Mint failure in on_active (defensive refresh) → propagates,
  lifecycle rolls back the counter, the triggering job fails and
  retries; same fail-closed semantics as the original design.
"""

from __future__ import annotations

import os
import sys
import threading
from datetime import datetime, timedelta, timezone
from typing import Final

from hivemoot_agent.apiarist_client import (
    ApiaristClient,
    ApiaristError,
    MintedToken,
)
from hivemoot_agent.lifecycle import LifecycleSubscriber

# Both env vars are exported because GitHub tooling is split-brain
# about which it reads. Authoritatively:
#
# - ``GH_TOKEN`` — what the ``gh`` CLI uses (and prefers over
#   ``GITHUB_TOKEN`` when both are set).
# - ``GITHUB_TOKEN`` — what ``actions/checkout`` and most third-party
#   GitHub libraries (octokit, PyGithub, hub) read first.
#
# Setting both eliminates the "which one wins?" question across the
# tool surface the agent uses (gh, git remote, octokit-bearing tools).
_TOKEN_ENV_VARS: Final[tuple[str, ...]] = ("GH_TOKEN", "GITHUB_TOKEN")

# Default refresh window: re-mint when within 5 minutes of expiry.
# Apiarist tokens default to 1h TTL; this gives the refresh thread
# 55 minutes between routine re-mints. Tightening below ~60 seconds
# would create contention with on_active's defensive refresh during
# active job periods; widening beyond ~10 minutes risks expiry mid-poll
# under clock skew.
_DEFAULT_REFRESH_LEAD_TIME_SECS: Final[int] = 300

# Default backoff between mint retries when the refresh loop hits
# an apiarist error (transport / remote / protocol). Short enough to
# recover quickly from a transient blip; long enough that a sustained
# outage doesn't burn through a 60-RPM apiarist rate-limit budget.
_DEFAULT_REFRESH_BACKOFF_SECS: Final[float] = 60.0


class HivemootGithubAuthSubscriber(LifecycleSubscriber):
    """Lifecycle subscriber that brokers GitHub installation tokens
    via the apiarist daemon and maintains an always-on env populated
    via a background refresh thread.

    Single-instance per container. Built and started by the hivemoot
    plugin's ``setup_lifecycle()`` hook when the operator opts into
    apiarist token brokering via the ``apiarist:`` config block.

    Thread-safety: the engine calls ``on_active`` / ``on_idle`` on the
    ContainerLifecycle's serialized boundary (sequential under
    ``threading.RLock``). The background refresh thread also touches
    ``self._current`` and env. We rely on Python's GIL to make single
    attribute writes and ``os.environ[k] = v`` atomic; readers
    (triggers consulting env each poll) see a consistent snapshot.
    For invariants stronger than "atomic per write", a lock would be
    needed — none of the current readers care.
    """

    def __init__(
        self,
        client: ApiaristClient,
        *,
        service: str,
        repo: str,
        agent_id: str | None = None,
        refresh_lead_time_secs: int = _DEFAULT_REFRESH_LEAD_TIME_SECS,
        refresh_backoff_on_error_secs: float = _DEFAULT_REFRESH_BACKOFF_SECS,
    ) -> None:
        """
        Args:
            client: pre-built apiarist client (caller owns its
                lifetime; we just hold the reference).
            service: caller identifier for apiarist's audit log
                (typically the systemd service / container name like
                ``"drone-zai"``). Required.
            repo: ``owner/name`` of the repo this agent works on.
                Required — apiarist scopes the minted token to this
                single repo per the token policy.
            agent_id: optional audit-only identifier (``AGENT_ID`` env
                value, e.g. ``"drone"``). Logged by apiarist; ignored
                for authorization.
            refresh_lead_time_secs: re-mint when the current token is
                within this many seconds of expiry. Default 300 (5 min)
                gives the refresh thread plenty of margin against a
                transient apiarist outage at the moment of refresh.
            refresh_backoff_on_error_secs: how long the refresh thread
                waits after a mint error before retrying. Default 60s.
        """
        if client is None:
            raise ValueError("client is required")
        if not service:
            raise ValueError("service must be non-empty")
        if not repo:
            raise ValueError("repo must be non-empty")
        if refresh_lead_time_secs <= 0:
            raise ValueError(
                f"refresh_lead_time_secs must be positive "
                f"(got {refresh_lead_time_secs!r})"
            )
        if refresh_backoff_on_error_secs <= 0:
            raise ValueError(
                f"refresh_backoff_on_error_secs must be positive "
                f"(got {refresh_backoff_on_error_secs!r})"
            )
        self._client: ApiaristClient = client
        self._service: str = service
        self._repo: str = repo
        self._agent_id: str | None = agent_id
        self._refresh_lead_time_secs: int = refresh_lead_time_secs
        self._refresh_backoff_on_error_secs: float = refresh_backoff_on_error_secs
        # Last successfully-minted token. Held in memory for diagnostics
        # and so on_active can decide whether a defensive refresh is
        # needed (compare expiry to now + lead-time).
        self._current: MintedToken | None = None
        # Refresh thread coordination. _started is single-shot: a second
        # start() call is a no-op so plugin setup_lifecycle is idempotent
        # under retry.
        self._stop_event: threading.Event = threading.Event()
        self._refresh_thread: threading.Thread | None = None
        self._started: bool = False

    # ── Diagnostics ──────────────────────────────────────────────

    @property
    def repo(self) -> str:
        """The repo this subscriber mints tokens for. Diagnostics."""
        return self._repo

    @property
    def service(self) -> str:
        """The caller identifier reported to apiarist. Diagnostics."""
        return self._service

    @property
    def current_token(self) -> MintedToken | None:
        """The last successfully-minted token, or None before start().

        Diagnostics only — callers must not pluck the raw token out
        of this property to authenticate; they should read
        ``GH_TOKEN`` / ``GITHUB_TOKEN`` from env so the contract
        with downstream tools stays uniform.
        """
        return self._current

    @property
    def is_started(self) -> bool:
        """Whether ``start()`` has run successfully. Diagnostics + tests."""
        return self._started

    # ── Explicit lifecycle (called by the plugin, not the engine) ─

    def start(self) -> None:
        """Initial mint + start the background refresh thread.

        Called once by the hivemoot plugin's ``setup_lifecycle()``
        BEFORE the lifecycle subscribes this instance. The initial
        mint is synchronous so trigger threads (which start shortly
        after) see env populated on their first poll.

        Idempotent — a second call is a silent no-op so plugin
        setup_lifecycle can be retried safely.

        Raises whatever ``client.mint_token`` raises on the initial
        mint (Transport / Protocol / Remote errors). Plugin setup
        fails fast; container exits with a clear error pointing the
        operator at apiarist health.
        """
        if self._started:
            return
        # Initial mint synchronously so triggers see env populated
        # immediately — without this they'd skip their first N polls
        # waiting for the refresh thread to schedule a mint.
        self._mint_and_set_env()
        self._refresh_thread = threading.Thread(
            target=self._refresh_loop,
            name=f"hivemoot-auth-refresh-{self._service}",
            daemon=True,
        )
        self._refresh_thread.start()
        self._started = True

    def stop(self) -> None:
        """Signal the refresh thread to exit and wait for it to finish.

        Daemon thread also exits at process shutdown, so this is mainly
        for clean test teardown — production code rarely needs to call
        it. Idempotent; safe to call multiple times or before start().
        """
        self._stop_event.set()
        thread = self._refresh_thread
        if thread is not None:
            thread.join(timeout=5)
        self._refresh_thread = None

    # ── Lifecycle hooks (called by the engine) ───────────────────

    def on_active(self) -> None:
        """Defensive refresh on the IDLE→ACTIVE boundary.

        Normally the background refresh thread keeps the token fresh,
        so this is a no-op. We re-mint here only when:

        - The thread has somehow not run (bug / hang / not yet
          started), and we have no current token. Force-mint to
          fail-closed cleanly.
        - The current token is within the refresh-lead-time window
          (about to expire). Refresh proactively so the upcoming job
          doesn't race the refresh thread on the boundary.

        Raises whatever ``client.mint_token`` raises in either of
        those branches. The lifecycle module catches and rolls back
        the counter, the triggering job fails, the runtime retries.
        """
        if self._current is None:
            # No token yet — start() wasn't called, OR the refresh
            # loop hasn't recovered from a sustained mint outage.
            # Force a synchronous mint to fail-closed cleanly.
            self._mint_and_set_env()
            return
        now = datetime.now(timezone.utc)
        seconds_to_expiry = (self._current.expires_at - now).total_seconds()
        if seconds_to_expiry < self._refresh_lead_time_secs:
            # Inside the lead-time window — refresh now so the job
            # doesn't race the refresh thread.
            self._mint_and_set_env()

    def on_idle(self) -> None:
        """No-op — env stays populated between jobs.

        Trigger threads (mention / review-request / new-PR watchers)
        poll continuously and need a valid token between jobs. Clearing
        env on idle would deadlock watch-driven services that have NO
        work source besides triggers (drone is the V1 example).

        See module docstring "Why on_idle is a no-op" for the full
        trade-off rationale.
        """
        return None

    # ── Internal: mint + refresh loop ────────────────────────────

    def _mint_and_set_env(self) -> None:
        """Mint a fresh token via apiarist, atomically replace env.

        Caller is responsible for catching exceptions (the refresh
        loop wraps + logs; on_active and start() let them propagate
        for fail-closed behavior).
        """
        token = self._client.mint_token(
            service=self._service,
            repo=self._repo,
            agent_id=self._agent_id,
        )
        for var in _TOKEN_ENV_VARS:
            os.environ[var] = token.token
        self._current = token
        print(
            f"[hivemoot-auth] minted token for {self._repo} "
            f"(installation={token.installation_id}, "
            f"expires_at={token.expires_at.isoformat()})",
            file=sys.stderr, flush=True,
        )

    def _seconds_until_refresh(self) -> float:
        """How many seconds the refresh loop should sleep before next mint.

        Returns ``refresh_backoff_on_error_secs`` when there's no
        current token (we're recovering from a mint failure and want
        to retry sooner than the full TTL). Otherwise returns time
        until ``expires_at - lead_time``, clamped to a minimum of 1s
        so a clock skew can't yield a tight loop.
        """
        if self._current is None:
            return self._refresh_backoff_on_error_secs
        now = datetime.now(timezone.utc)
        target = self._current.expires_at - timedelta(
            seconds=self._refresh_lead_time_secs,
        )
        delta = (target - now).total_seconds()
        return max(1.0, delta)

    def _refresh_loop(self) -> None:
        """Background: re-mint when current token nears expiry.

        Runs in its own daemon thread for the lifetime of the container.
        Sleeps on the stop_event so a stop() call interrupts the wait
        immediately instead of running out the full sleep.
        """
        while not self._stop_event.is_set():
            sleep_secs = self._seconds_until_refresh()
            if self._stop_event.wait(sleep_secs):
                return
            try:
                self._mint_and_set_env()
            except ApiaristError as exc:
                # Don't update self._current — keep using the previous
                # token. If it's already expired, downstream callers
                # will see 401s; we log here so the operator can
                # correlate with apiarist health.
                print(
                    f"[hivemoot-auth] refresh failed for {self._repo}: "
                    f"{type(exc).__name__}: {exc}; retrying in "
                    f"{self._refresh_backoff_on_error_secs}s",
                    file=sys.stderr, flush=True,
                )
                if self._stop_event.wait(self._refresh_backoff_on_error_secs):
                    return
            except Exception as exc:
                # Defensive — unknown exceptions from the client
                # shouldn't kill the refresh loop. Same backoff +
                # retry behavior.
                print(
                    f"[hivemoot-auth] refresh raised unexpectedly for "
                    f"{self._repo}: {type(exc).__name__}: {exc}; "
                    f"retrying in {self._refresh_backoff_on_error_secs}s",
                    file=sys.stderr, flush=True,
                )
                if self._stop_event.wait(self._refresh_backoff_on_error_secs):
                    return


__all__ = ["HivemootGithubAuthSubscriber", "ApiaristError"]
