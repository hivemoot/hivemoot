"""Lifecycle subscriber that mints a GitHub token via apiarist on
the IDLE→ACTIVE boundary.

This is the V1 implementation of the apiarist token broker integration
(DESIGN.md §12.3). It bridges the engine's container lifecycle FSM to
the apiarist UDS daemon:

- **on_active** (IDLE→ACTIVE): call ``mint_token`` over the apiarist
  socket, populate ``GH_TOKEN`` + ``GITHUB_TOKEN`` env vars.
- **on_idle** (ACTIVE→IDLE): clear those env vars so a stale token
  doesn't linger if the daemon restarts or the operator stops it.

Why mint per IDLE→ACTIVE (not at process startup):

- A container can sit IDLE for hours between jobs. Minting upfront
  burns a 1-hour-TTL token that will have expired by the time a job
  arrives.
- Minting per IDLE→ACTIVE means every job sees a freshly-minted
  token, so the only way the token can expire mid-job is if the job
  itself runs longer than the token TTL (~55 min effective). V1
  treats that as out-of-scope; long-running jobs (>50 min) see the
  edge case and the operator's runbook covers it.

Why clear on ACTIVE→IDLE (not just leave the token sitting):

- Defense-in-depth. If the env-var leaks (subprocess dump, log
  capture, /proc inspection), it's only exposed during active jobs.
- If a debug shell attaches between jobs, ``env | grep TOKEN`` shows
  nothing — clear signal that the token broker is wired and working.

The subscriber is NOT registered with a background refresh thread in
V1. Refresh-during-job (rotating the env mid-flight) does not reach
already-spawned subprocesses (they snapshot env at exec time), so the
benefit is marginal vs. the complexity of join-on-idle thread
lifecycle. A future V1.1 iteration may add it for nested-gh-call
freshness; see DESIGN.md §12.3.4 "Future variants".

Failure modes:

- Apiarist daemon down → :class:`ApiaristTransportError` propagates
  from ``on_active``, lifecycle module rolls back the counter, the
  triggering job fails to start, runtime retries.
- Apiarist returns ``BACKEND_FORBIDDEN`` (e.g. repo not in token
  policy) → :class:`ApiaristRemoteError` propagates the same way.
  This is fail-closed: a misconfigured policy never lets a request
  silently fall back to a long-lived PAT.
"""

from __future__ import annotations

import os
import sys
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


class HivemootGithubAuthSubscriber(LifecycleSubscriber):
    """Lifecycle subscriber that brokers GitHub installation tokens
    via the apiarist daemon.

    Single-instance per container. Registered by the hivemoot plugin's
    ``setup_lifecycle()`` hook when the operator opts into apiarist
    token brokering via the ``apiarist:`` config block.

    Thread-safety: the engine calls ``on_active`` / ``on_idle`` on the
    ContainerLifecycle's serialized boundary (sequential under
    ``threading.RLock``), so the subscriber's internal state changes
    don't need their own lock. The env-var reads from other threads
    (e.g. heartbeat threads in the hivemoot tasks subsystem) see a
    consistent snapshot — Python's GIL makes a single
    ``os.environ[k] = v`` assignment atomic.
    """

    def __init__(
        self,
        client: ApiaristClient,
        *,
        service: str,
        repo: str,
        agent_id: str | None = None,
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
        """
        if client is None:
            raise ValueError("client is required")
        if not service:
            raise ValueError("service must be non-empty")
        if not repo:
            raise ValueError("repo must be non-empty")
        self._client: ApiaristClient = client
        self._service: str = service
        self._repo: str = repo
        self._agent_id: str | None = agent_id
        # Last successfully-minted token, kept for diagnostics and to
        # short-circuit the env-clear when on_idle fires before the
        # first on_active (defensive — the lifecycle module shouldn't
        # do this but the cost of guarding is zero).
        self._current: MintedToken | None = None

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
        """The last successfully-minted token, or None when idle.

        Diagnostics only — callers must not pluck the raw token out
        of this property to authenticate; they should read
        ``GH_TOKEN`` / ``GITHUB_TOKEN`` from env so the contract
        with downstream tools stays uniform.
        """
        return self._current

    # ── Lifecycle hooks ──────────────────────────────────────────

    def on_active(self) -> None:
        """Mint a fresh token and populate the GitHub auth env vars.

        Raises whatever the apiarist client raises (Transport /
        Protocol / Remote errors). The lifecycle module catches the
        exception, rolls back the counter, and tears down any prior
        successful subscribers — the triggering job fails and the
        runtime retries the full chain cleanly.

        We intentionally do NOT swallow errors here: a missing
        GITHUB_TOKEN is silently catastrophic (the github plugin's
        clone subscriber would fail to authenticate, possibly falling
        back to anonymous and leaking access patterns). Fail-closed
        keeps the contract crisp.
        """
        token = self._client.mint_token(
            service=self._service,
            repo=self._repo,
            agent_id=self._agent_id,
        )
        for var in _TOKEN_ENV_VARS:
            os.environ[var] = token.token
        self._current = token
        # Diagnostics only — operator can correlate with apiarist log
        # via the installation_id and the token's last-12 chars
        # (sha-prefixed, not the raw secret). Token full value is
        # never logged.
        print(
            f"[hivemoot-auth] minted token for {self._repo} "
            f"(installation={token.installation_id}, "
            f"expires_at={token.expires_at.isoformat()})",
            file=sys.stderr, flush=True,
        )

    def on_idle(self) -> None:
        """Clear the GitHub auth env vars.

        Best-effort by lifecycle contract (I4) — exceptions get
        logged by the lifecycle module and don't propagate. Clearing
        env is a few atomic dict ops, so failures here are unlikely;
        we still wrap defensively because an early ``on_idle`` (no
        prior ``on_active``) would otherwise leak ``KeyError`` from
        the lifecycle module's exception logger.
        """
        for var in _TOKEN_ENV_VARS:
            os.environ.pop(var, None)
        if self._current is not None:
            print(
                f"[hivemoot-auth] cleared token env for {self._repo} "
                f"(installation={self._current.installation_id})",
                file=sys.stderr, flush=True,
            )
        self._current = None


__all__ = ["HivemootGithubAuthSubscriber", "ApiaristError"]
