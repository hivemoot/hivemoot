"""Backend client for the desired-state endpoint.

Mirrors `core/backend.py` conventions: httpx, typed exceptions, retry/backoff
on transient failures, and a strictly defensive parse (a malformed 200 is a
protocol error, not data we act on). ETag/`If-None-Match` support lets steady-
state polling short-circuit with 304.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

import httpx

from apiarist.features.reconcile.models import (
    DesiredAgent,
    DesiredState,
    ResolvedEngine,
    Triggers,
)

DESIRED_STATE_PATH = "/api/fleet/desired-state"

# Re-validate the agent name at THIS trust boundary, independent of the backend.
# apiarist owns the "HOW": `name` becomes a host filesystem path + Docker bind
# source + container name, so it must be a strict identifier here even if the
# backend (which also enforces this) is ever buggy or compromised. A violation
# is a protocol error → the whole cycle fails closed (no container is touched).
_AGENT_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")


class FleetError(Exception):
    """Base class for desired-state fetch failures."""


class FleetUnauthorizedError(FleetError):
    """401 — fleet token rejected."""


class FleetForbiddenError(FleetError):
    """403 — token lacks the fleet.read capability."""


class FleetUnavailableError(FleetError):
    """5xx after retries, or network failure."""


class FleetProtocolError(FleetError):
    """200 with a body we can't trust — fail closed, do not act on it."""


class NotModified:
    """Sentinel for a 304 response (roster unchanged since the given etag)."""


class FleetClient:
    def __init__(
        self,
        *,
        backend_url: str,
        fleet_token: str,
        timeout_seconds: int = 10,
        retries: int = 3,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = backend_url.rstrip("/")
        self._fleet_token = fleet_token
        self._retries = retries
        self._client = client or httpx.AsyncClient(timeout=timeout_seconds)
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def fetch_desired_state(self, *, etag: str | None = None) -> DesiredState | NotModified:
        """Fetch the installation's desired-state roster.

        Returns `NotModified` when the server answers 304 to our
        `If-None-Match`. Raises a typed `Fleet*` error on any other failure —
        the caller treats every error as "do nothing this cycle".
        """
        url = f"{self._base_url}{DESIRED_STATE_PATH}"
        headers = {
            "Authorization": f"Bearer {self._fleet_token}",
            "Accept": "application/json",
        }
        if etag is not None:
            headers["If-None-Match"] = f'"{etag}"'

        last_error: Exception | None = None
        for attempt in range(self._retries + 1):
            try:
                response = await self._client.get(url, headers=headers)
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_error = exc
                if attempt >= self._retries:
                    raise FleetUnavailableError(
                        f"network error after {attempt + 1} attempts: {exc}"
                    ) from exc
                await asyncio.sleep(_backoff(attempt))
                continue

            if response.status_code == 304:
                return NotModified()
            if response.status_code == 200:
                return _parse_desired_state(response)
            if response.status_code == 401:
                raise FleetUnauthorizedError("fleet token rejected by backend")
            if response.status_code == 403:
                raise FleetForbiddenError("fleet token lacks fleet.read capability")
            if 500 <= response.status_code < 600:
                last_error = FleetUnavailableError(f"HTTP {response.status_code} from backend")
                if attempt >= self._retries:
                    raise last_error
                await asyncio.sleep(_backoff(attempt))
                continue
            raise FleetError(f"unexpected HTTP {response.status_code} from backend")

        assert last_error is not None
        raise FleetUnavailableError(str(last_error)) from last_error


def _parse_desired_state(response: httpx.Response) -> DesiredState:
    try:
        payload = response.json()
    except ValueError as exc:
        raise FleetProtocolError(f"desired-state returned non-JSON body: {exc}") from exc
    if not isinstance(payload, dict):
        raise FleetProtocolError("desired-state body is not an object")

    version = payload.get("version")
    etag = payload.get("etag")
    raw_agents = payload.get("agents")
    if not isinstance(version, int):
        raise FleetProtocolError("desired-state missing int 'version'")
    if not isinstance(etag, str) or not etag:
        raise FleetProtocolError("desired-state missing string 'etag'")
    if not isinstance(raw_agents, list):
        raise FleetProtocolError("desired-state missing list 'agents'")

    agents = tuple(_parse_agent(entry) for entry in raw_agents)
    return DesiredState(version=version, etag=etag, agents=agents)


def _req_str(d: dict[str, Any], key: str) -> str:
    v = d.get(key)
    if not isinstance(v, str) or not v:
        raise FleetProtocolError(f"agent entry missing string {key!r}")
    return v


def _parse_agent(entry: object) -> DesiredAgent:
    if not isinstance(entry, dict):
        raise FleetProtocolError("agent entry is not an object")
    name = _req_str(entry, "name")
    if not _AGENT_NAME_RE.fullmatch(name):
        # Never let a non-identifier name reach the filesystem/Docker layer.
        raise FleetProtocolError(f"agent name {name!r} is not a valid identifier")
    repos = _parse_repos(entry.get("repos"), name)
    enabled = entry.get("enabled")
    managed = entry.get("managed")
    config_version = entry.get("config_version")
    if not isinstance(enabled, bool) or not isinstance(managed, bool):
        raise FleetProtocolError(f"agent {name!r} has non-bool enabled/managed")
    if not isinstance(config_version, int):
        raise FleetProtocolError(f"agent {name!r} missing int config_version")

    engine = _parse_engine(entry.get("engine"))
    skills = _parse_skills(entry.get("skills"))
    system_prompt = entry.get("system_prompt")
    if not isinstance(system_prompt, str):
        raise FleetProtocolError(f"agent {name!r} missing string system_prompt")
    triggers = _parse_triggers(entry.get("triggers"), name)

    token = entry.get("token")
    if not isinstance(token, dict):
        raise FleetProtocolError(f"agent {name!r} missing object 'token'")
    token_name = _req_str(token, "name")
    agent_role = token.get("agent_role")
    if not isinstance(agent_role, str) or not agent_role:
        agent_role = name

    return DesiredAgent(
        name=name,
        repos=repos,
        enabled=enabled,
        managed=managed,
        config_version=config_version,
        engine=engine,
        skills=skills,
        system_prompt=system_prompt,
        triggers=triggers,
        token_name=token_name,
        agent_role=agent_role,
    )


def _parse_repos(raw: object, name: str) -> tuple[str, ...]:
    # The agent's repos come from the linked token's allowed_repos (non-empty).
    if not isinstance(raw, list) or not raw:
        raise FleetProtocolError(f"agent {name!r} missing non-empty list 'repos'")
    out: list[str] = []
    for r in raw:
        if not isinstance(r, str) or "/" not in r or ".." in r or " " in r:
            raise FleetProtocolError(f"agent {name!r} has invalid repo {r!r}")
        out.append(r)
    return tuple(out)


def _parse_engine(raw: object) -> ResolvedEngine:
    if not isinstance(raw, dict):
        raise FleetProtocolError("agent 'engine' is not an object")
    engine_id = _req_str(raw, "id")
    tool = _req_str(raw, "tool")
    provider = raw.get("provider")
    model = raw.get("model")
    tool_options = raw.get("tool_options")
    if provider is not None and not isinstance(provider, str):
        raise FleetProtocolError("engine 'provider' must be string or null")
    if model is not None and not isinstance(model, str):
        raise FleetProtocolError("engine 'model' must be string or null")
    parsed_opts: dict[str, str] | None = None
    if tool_options is not None:
        if not isinstance(tool_options, dict):
            raise FleetProtocolError("engine 'tool_options' must be an object or null")
        parsed_opts = {}
        for k, v in tool_options.items():
            if not isinstance(k, str) or not isinstance(v, str):
                raise FleetProtocolError("engine 'tool_options' must be string→string")
            parsed_opts[k] = v
    return ResolvedEngine(
        id=engine_id,
        tool=tool,
        provider=provider,
        model=model,
        tool_options=parsed_opts,
    )


def _parse_skills(raw: object) -> tuple[str, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise FleetProtocolError("agent 'skills' must be a list")
    out: list[str] = []
    for s in raw:
        if not isinstance(s, str):
            raise FleetProtocolError("agent 'skills' entries must be strings")
        out.append(s)
    return tuple(out)


def _trigger_block(triggers: dict[str, Any], key: str) -> tuple[bool, dict[str, Any]]:
    block = triggers.get(key)
    if not isinstance(block, dict):
        return (False, {})
    enabled = bool(block.get("enabled") is True)
    settings = block.get("settings")
    return (enabled, settings if isinstance(settings, dict) else {})


def _as_int(v: object, default: int) -> int:
    return v if isinstance(v, int) and not isinstance(v, bool) else default


def _parse_triggers(raw: object, name: str) -> Triggers:
    if not isinstance(raw, dict):
        raise FleetProtocolError(f"agent {name!r} missing object 'triggers'")

    sched_on, sched = _trigger_block(raw, "schedule")
    pr_on, pr = _trigger_block(raw, "pull_requests")
    men_on, men = _trigger_block(raw, "mentions")
    tasks_on, _ = _trigger_block(raw, "tasks")
    war_on, war = _trigger_block(raw, "war_rooms")

    raw_authors = pr.get("author_allowlist")
    authors: tuple[str, ...] = ()
    if isinstance(raw_authors, list):
        authors = tuple(a for a in raw_authors if isinstance(a, str))

    prompt_raw = sched.get("prompt")
    schedule_prompt = prompt_raw if isinstance(prompt_raw, str) else ""

    return Triggers(
        schedule_enabled=sched_on,
        schedule_interval_secs=_as_int(sched.get("interval_secs"), 21600),
        schedule_jitter_secs=_as_int(sched.get("jitter_secs"), 600),
        schedule_prompt=schedule_prompt,
        pr_enabled=pr_on,
        pr_watch_new=bool(pr.get("watch_new_prs") is True),
        pr_watch_reviews=bool(pr.get("watch_review_requests") is True),
        pr_authors=authors,
        pr_poll_secs=_as_int(pr.get("poll_interval_secs"), 300),
        mentions_enabled=men_on,
        mentions_poll_secs=_as_int(men.get("poll_interval_secs"), 90),
        tasks_enabled=tasks_on,
        war_rooms_enabled=war_on,
        war_rooms_contribute=bool(war.get("contribute") is True),
    )


def _backoff(attempt: int) -> float:
    return float(min(0.1 * (2**attempt), 5.0))
