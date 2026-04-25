"""HTTP client for hivemoot.dev.

The single backend dependency in V1 is `POST /api/github/installation-tokens`
(see DESIGN.md §11). This module wraps that call with httpx, maps HTTP
status codes to typed exceptions, and retries transient failures.

Two distinct credential kinds flow through this module — keep them
straight:
  - **Agent token** (the bearer credential to hivemoot.dev): a string
    from `apiary.secrets.yaml`, passed to this client at construction
    time, sent in `Authorization: Bearer <agent_token>`.
  - **GitHub installation access token** (the `ghs_`-prefixed value
    returned by GitHub via the backend): the result this module
    returns. Apiarist holds it in its in-memory cache (default 5 min
    TTL, never written to disk) and delivers it to the requesting
    agent over the UDS socket on demand. The agent uses it directly
    in process memory for the immediate GitHub API call(s).

The agent token is long-lived and identifies the Hive to the backend.
The installation access token is short-lived (~1h), narrowly-scoped,
and what agent containers actually use to talk to GitHub. Confusing
the two is the easiest way to leak a credential, so they live in
different types here (`str` for the bearer, `InstallationAccessToken`
dataclass for the result) so static typing keeps them distinct.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from apiarist.config import Config


# The single endpoint path. Kept here as a constant rather than a
# config knob because the backend's URL shape is part of the contract,
# not deployment-specific. The hostname comes from config.backend_url.
INSTALLATION_TOKEN_PATH = "/api/github/installation-tokens"


@dataclass(frozen=True)
class Repository:
    """A repository entry in a token's scope.

    GitHub's installation tokens narrow via `repository_ids` (immutable),
    not names — repo IDs survive renames and transfers. The `full_name`
    is included for log readability; `id` is the source of truth.
    """

    full_name: str
    id: int


@dataclass(frozen=True)
class InstallationAccessToken:
    """A minted GitHub installation access token.

    Attributes:
        token: The `ghs_`-prefixed value. Bearer for `api.github.com`.
        expires_at: When GitHub will start rejecting this token. Used
            by the cache to decide eviction time. Server-authoritative —
            don't substitute the local clock.
        installation_id: Echoed from the response for audit/log
            correlation. Hashed-token correlation comes later (see
            DESIGN.md §11 audit-hash note).
        permissions: Actual permissions granted (may be narrower than
            requested if the token's policy restricts further). Map of
            permission name → access level (e.g. ``{"contents": "read",
            "pull_requests": "write"}``).
        repositories: Repos this token can access. May be a strict
            subset of the installation's repo set if the token's
            policy narrows it. Always ≥ 1 — the backend rejects empty
            scopes (a token with access to nothing is a bug).
    """

    token: str
    expires_at: datetime
    installation_id: str
    permissions: dict[str, str]
    repositories: list[Repository]


# ---------------------------------------------------------------------------
# Typed exceptions
# ---------------------------------------------------------------------------
#
# Each maps to one of the IPC error codes in DESIGN.md §8 (the dispatcher
# in features/tokens/plugin.py — Phase E — translates these to the
# wire-level codes apiarist clients see). Using exceptions rather than
# Result-types keeps the client surface readable (`token = await client.
# mint(...)`) while still forcing every failure mode to be named.


class BackendError(Exception):
    """Base class for all backend-call failures."""


class BackendUnauthorizedError(BackendError):
    """HTTP 401 — the agent token was rejected by hivemoot.dev."""


class BackendForbiddenError(BackendError):
    """HTTP 403 — token valid but requested repo not in installation."""


class BackendRateLimitedError(BackendError):
    """HTTP 429 — token-creation rate limit hit (no auto-retry within window)."""


class BackendNotImplementedError(BackendError):
    """HTTP 501 — endpoint scaffolded but minting not yet wired."""


class BackendUnavailableError(BackendError):
    """HTTP 5xx (after retries exhausted) or network-layer failure."""


class BackendProtocolError(BackendError):
    """HTTP 200 with malformed body, or `expires_at` already in the past.

    The wire said 'success' but the response is unusable — fail closed
    rather than serving a token that won't work or doesn't exist.
    """


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class BackendClient:
    """Async client for the hivemoot.dev backend.

    Construct once at daemon startup, share across the process. Holds an
    `httpx.AsyncClient` configured with the request timeout from config.
    Caller is responsible for `aclose()` at shutdown (Phase D's server
    will own this lifecycle; until then the manual-test client in
    examples/ does it explicitly).
    """

    def __init__(
        self,
        *,
        backend_url: str,
        agent_token: str,
        timeout_seconds: int = 10,
        retries: int = 3,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = backend_url.rstrip("/")
        self._agent_token = agent_token
        self._retries = retries
        self._client = client or httpx.AsyncClient(timeout=timeout_seconds)
        self._owns_client = client is None

    @classmethod
    def from_config(
        cls,
        config: Config,
        agent_token: str,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> BackendClient:
        return cls(
            backend_url=config.backend_url,
            agent_token=agent_token,
            timeout_seconds=config.backend_timeout_seconds,
            retries=config.backend_retries,
            client=client,
        )

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> BackendClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    async def mint_installation_token(self, repo: str) -> InstallationAccessToken:
        """Request a fresh GitHub installation access token for `repo`.

        `repo` is `owner/name`. The actual installation is determined
        server-side from the agent token; `repo` is for verification +
        audit logging. Raises one of the `Backend*` exceptions on
        failure (each maps to an IPC error code in DESIGN.md §8).
        """
        url = f"{self._base_url}{INSTALLATION_TOKEN_PATH}"
        body = {"repo": repo}
        headers = {
            "Authorization": f"Bearer {self._agent_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

        last_error: Exception | None = None
        for attempt in range(self._retries + 1):
            try:
                response = await self._client.post(url, json=body, headers=headers)
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_error = exc
                if not _should_retry_on_exception(attempt, self._retries):
                    raise BackendUnavailableError(
                        f"network error after {attempt + 1} attempts: {exc}"
                    ) from exc
                await asyncio.sleep(_backoff(attempt))
                continue

            # Status-based dispatch. Non-retryable codes raise immediately;
            # 5xx triggers retry until we exhaust the budget.
            if response.status_code == 200:
                return _parse_success(response)
            if response.status_code == 401:
                raise BackendUnauthorizedError("agent token rejected by hivemoot.dev")
            if response.status_code == 403:
                raise BackendForbiddenError(
                    f"repo {repo!r} not covered by the token's installation"
                )
            if response.status_code == 429:
                raise BackendRateLimitedError(
                    "token-creation rate limit hit; do not retry within window"
                )
            if response.status_code == 501:
                raise BackendNotImplementedError(
                    "backend endpoint is scaffolded but minting not wired yet"
                )
            if 500 <= response.status_code < 600:
                last_error = BackendUnavailableError(
                    f"HTTP {response.status_code} from backend"
                )
                if not _should_retry_on_exception(attempt, self._retries):
                    raise last_error
                await asyncio.sleep(_backoff(attempt))
                continue
            # Any other status (4xx other than the ones above) is a bug
            # we should learn about, not silently retry.
            raise BackendError(
                f"unexpected HTTP {response.status_code} from backend"
            )

        # Loop exited via `continue` after exhausting retries — last_error
        # holds the final attempt's failure.
        assert last_error is not None
        raise BackendUnavailableError(str(last_error)) from last_error


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _parse_success(response: httpx.Response) -> InstallationAccessToken:
    """Validate and parse a 200 OK response into a typed token.

    Defensive: a malformed body (missing fields, bad types, expired-on-
    arrival) raises `BackendProtocolError` rather than passing junk
    further down the stack. Cache eviction relies on `expires_at`
    being a valid future timestamp; an expired-on-arrival token would
    cause us to serve a dead value.
    """
    try:
        payload = response.json()
    except ValueError as exc:
        raise BackendProtocolError(f"backend returned non-JSON body: {exc}") from exc

    if not isinstance(payload, dict):
        raise BackendProtocolError(
            f"backend returned non-object body (got {type(payload).__name__})"
        )

    token = payload.get("token")
    expires_at_raw = payload.get("expires_at")
    installation_id = payload.get("installation_id")

    if not isinstance(token, str) or not token:
        raise BackendProtocolError("response missing required string field 'token'")
    if not isinstance(expires_at_raw, str) or not expires_at_raw:
        raise BackendProtocolError(
            "response missing required string field 'expires_at'"
        )
    if not isinstance(installation_id, str) or not installation_id:
        raise BackendProtocolError(
            "response missing required string field 'installation_id'"
        )

    try:
        expires_at = _parse_iso8601(expires_at_raw)
    except ValueError as exc:
        raise BackendProtocolError(
            f"response 'expires_at' is not a valid ISO 8601 timestamp: {expires_at_raw!r}"
        ) from exc

    if expires_at <= _now_utc():
        raise BackendProtocolError(
            f"backend returned token that is already expired: expires_at={expires_at_raw!r}"
        )

    permissions = _parse_permissions(payload.get("permissions"))
    repositories = _parse_repositories(payload.get("repositories"))

    return InstallationAccessToken(
        token=token,
        expires_at=expires_at,
        installation_id=installation_id,
        permissions=permissions,
        repositories=repositories,
    )


def _parse_permissions(raw: object) -> dict[str, str]:
    """Validate the permissions map.

    GitHub returns `{"contents": "read", "pull_requests": "write", ...}`.
    All values must be strings (one of "read", "write", or "admin"); we
    don't pin the value enum here because GitHub may add new tiers, but
    we do reject non-string values to catch obvious malformed responses.
    """
    if raw is None:
        # Backend MAY omit on the not-yet-implemented stub path; return
        # empty rather than fail the parse so the 501-codepath stays
        # exercisable end-to-end.
        return {}
    if not isinstance(raw, dict):
        raise BackendProtocolError(
            f"response 'permissions' must be a mapping (got {type(raw).__name__})"
        )
    for key, value in raw.items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise BackendProtocolError(
                f"response 'permissions' has non-string key or value: {key!r}={value!r}"
            )
    return dict(raw)


def _parse_repositories(raw: object) -> list[Repository]:
    """Validate and parse the scoped repositories list.

    Empty list and None both treated as "scope not narrowed in response"
    — surface as empty list. The backend MUST include this field when
    actual minting is wired (the not-implemented stub omits it, which
    is fine).
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise BackendProtocolError(
            f"response 'repositories' must be a list (got {type(raw).__name__})"
        )
    repos: list[Repository] = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise BackendProtocolError(
                f"response 'repositories' entry is not an object: {entry!r}"
            )
        full_name = entry.get("full_name")
        repo_id = entry.get("id")
        if not isinstance(full_name, str) or not full_name:
            raise BackendProtocolError(
                f"response 'repositories' entry missing string 'full_name': {entry!r}"
            )
        if not isinstance(repo_id, int) or isinstance(repo_id, bool):
            # bool is a subtype of int in Python — explicit reject.
            raise BackendProtocolError(
                f"response 'repositories' entry missing int 'id': {entry!r}"
            )
        repos.append(Repository(full_name=full_name, id=repo_id))
    return repos


def _parse_iso8601(value: str) -> datetime:
    """Parse the backend's ISO 8601 timestamp.

    GitHub's installation-token responses use `YYYY-MM-DDTHH:MM:SSZ`.
    Python's `fromisoformat` accepts this from 3.11 onwards (it learned
    to handle the trailing 'Z' in 3.11), so apiarist's >= 3.11 floor is
    sufficient — no third-party parser needed.
    """
    return datetime.fromisoformat(value)


def _now_utc() -> datetime:
    """Wrapped for monkeypatching in tests."""

    return datetime.now(UTC)


def _should_retry_on_exception(attempt: int, retries: int) -> bool:
    return attempt < retries


def _backoff(attempt: int) -> float:
    """Exponential backoff: 0.1s, 0.2s, 0.4s, 0.8s, ...

    Capped at 5 seconds for sanity; with the default `retries=3` this
    means at most 0.1 + 0.2 + 0.4 = 0.7s of cumulative sleep before the
    final attempt.
    """
    return float(min(0.1 * (2**attempt), 5.0))
