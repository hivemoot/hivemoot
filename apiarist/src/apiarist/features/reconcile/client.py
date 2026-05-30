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
    FleetPlugins,
    GithubPlugin,
    ResolvedEngine,
    SchedulePlugin,
    TasksPlugin,
    WarRoomsPlugin,
)

DESIRED_STATE_PATH = "/api/fleet/desired-state"

# Re-validate the agent name at THIS trust boundary, independent of the backend.
# apiarist owns the "HOW": `name` becomes a host filesystem path + Docker bind
# source + container name, so it must be a strict identifier here even if the
# backend (which also enforces this) is ever buggy or compromised. A violation
# is a protocol error → the whole cycle fails closed (no container is touched).
_AGENT_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")

# Repo `owner/name` slug — mirrors the web's REPO_REGEX (fleet-store.ts): each
# half starts alphanumeric then `[A-Za-z0-9._-]`, exactly one slash. Re-checked
# here at the trust boundary because a repo string reaches yaml/log/label
# surfaces; the explicit `..`/whitespace rejects below block path traversal.
_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")


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
    plugins = _parse_plugins(entry.get("plugins"), name)

    token = entry.get("token")
    if not isinstance(token, dict):
        raise FleetProtocolError(f"agent {name!r} missing object 'token'")
    token_name = _req_str(token, "name")
    agent_role = token.get("agent_role")
    if not isinstance(agent_role, str) or not agent_role:
        agent_role = name

    return DesiredAgent(
        name=name,
        enabled=enabled,
        managed=managed,
        config_version=config_version,
        engine=engine,
        skills=skills,
        system_prompt=system_prompt,
        plugins=plugins,
        token_name=token_name,
        agent_role=agent_role,
    )


def _parse_repo_list(raw: object, field: str) -> tuple[str, ...]:
    # `repos` live ONLY under plugins.github. Each entry must be a well-formed
    # `owner/name` slug (mirrors the web's REPO_REGEX) — re-checked here at the
    # trust boundary because the value reaches yaml/log/label surfaces. The
    # regex enforces exactly one slash with non-empty halves, so `a/`, `/b`,
    # `a/b/c`, and `a//b` are all rejected; the explicit `..`/whitespace guards
    # block path traversal.
    if not isinstance(raw, list):
        raise FleetProtocolError(f"{field} must be a list")
    out: list[str] = []
    for r in raw:
        if (
            not isinstance(r, str)
            or ".." in r
            or " " in r
            or not _REPO_RE.fullmatch(r)
        ):
            raise FleetProtocolError(f"{field} has invalid repo {r!r}")
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


# ---------------------------------------------------------------------------
# Plugin parsing — FAIL-CLOSED. The web ships the canonical validated
# `FleetPlugins` shape (web/src/server/fleet-store.ts): each present plugin is
# an object with `enabled: bool` plus its typed fields. A malformed/type-wrong
# plugin block raises FleetProtocolError, aborting the whole cycle (no-op) —
# we never act on a partial/corrupt roster.
# ---------------------------------------------------------------------------


def _req_bool(d: dict[str, Any], key: str, field: str) -> bool:
    # Required: a present key with a real bool. The web always emits these
    # (normalized output), so an absent/typewrong value is a contract violation.
    v = d.get(key)
    if not isinstance(v, bool):
        raise FleetProtocolError(f"{field} must be a boolean")
    return v


def _req_int(d: dict[str, Any], key: str, field: str) -> int:
    v = d.get(key)
    # bool is an int subclass — reject it so true/false can't satisfy an int.
    if not isinstance(v, int) or isinstance(v, bool):
        raise FleetProtocolError(f"{field} must be an int")
    return v


def _parse_github_plugin(raw: object, name: str) -> GithubPlugin:
    # The web ALWAYS normalizes and ships fully-populated github blocks (watch
    # flags defaulted, poll clamped from a default). apiarist consumes that
    # normalized output, so it REQUIRES every such field and fails the cycle
    # closed on absence — never silently re-applying a default that would
    # degrade a live container on a contract violation. The only optional field
    # is `watch_new_prs_authors` (the web omits it when the allowlist is empty).
    field = f"agent {name!r} plugins.github"
    if not isinstance(raw, dict):
        raise FleetProtocolError(f"{field} must be an object")
    enabled = _req_bool(raw, "enabled", f"{field}.enabled")
    repos = _parse_repo_list(raw.get("repos", []), f"{field}.repos")
    # An ENABLED github plugin must have at least one repo — restores the v1
    # trust-boundary guarantee (the web enforces this; disabled may be empty).
    if enabled and not repos:
        raise FleetProtocolError(f"{field}.repos must be non-empty when github is enabled")
    authors_raw = raw.get("watch_new_prs_authors")
    authors: tuple[str, ...] = ()
    if authors_raw is not None:
        if not isinstance(authors_raw, list) or not all(isinstance(a, str) for a in authors_raw):
            raise FleetProtocolError(f"{field}.watch_new_prs_authors must be a list of strings")
        authors = tuple(authors_raw)
    return GithubPlugin(
        enabled=enabled,
        repos=repos,
        watch_new_prs=_req_bool(raw, "watch_new_prs", f"{field}.watch_new_prs"),
        watch_review_requests=_req_bool(
            raw, "watch_review_requests", f"{field}.watch_review_requests"
        ),
        watch_mentions=_req_bool(raw, "watch_mentions", f"{field}.watch_mentions"),
        watch_new_prs_authors=authors,
        poll_interval_secs=_req_int(raw, "poll_interval_secs", f"{field}.poll_interval_secs"),
    )


def _parse_schedule_plugin(raw: object, name: str) -> SchedulePlugin:
    # The web ships fully-populated schedule blocks (interval/jitter clamped,
    # prompt always set). REQUIRE every field; fail closed on absence rather
    # than re-applying a default that could silently change a live container.
    field = f"agent {name!r} plugins.schedule"
    if not isinstance(raw, dict):
        raise FleetProtocolError(f"{field} must be an object")
    if "prompt" not in raw or not isinstance(raw.get("prompt"), str):
        raise FleetProtocolError(f"{field}.prompt must be a string")
    prompt = raw["prompt"]
    return SchedulePlugin(
        enabled=_req_bool(raw, "enabled", f"{field}.enabled"),
        interval_secs=_req_int(raw, "interval_secs", f"{field}.interval_secs"),
        jitter_secs=_req_int(raw, "jitter_secs", f"{field}.jitter_secs"),
        prompt=prompt,
    )


def _parse_tasks_plugin(raw: object, name: str) -> TasksPlugin:
    field = f"agent {name!r} plugins.tasks"
    if not isinstance(raw, dict):
        raise FleetProtocolError(f"{field} must be an object")
    return TasksPlugin(enabled=_req_bool(raw, "enabled", f"{field}.enabled"))


def _parse_war_rooms_plugin(raw: object, name: str) -> WarRoomsPlugin:
    field = f"agent {name!r} plugins.war_rooms"
    if not isinstance(raw, dict):
        raise FleetProtocolError(f"{field} must be an object")
    # The web always sets `contribute` (the capability gate distinguishes
    # observe-only from contributing), so REQUIRE it — fail closed on absence.
    return WarRoomsPlugin(
        enabled=_req_bool(raw, "enabled", f"{field}.enabled"),
        contribute=_req_bool(raw, "contribute", f"{field}.contribute"),
    )


def _parse_plugins(raw: object, name: str) -> FleetPlugins:
    if not isinstance(raw, dict):
        raise FleetProtocolError(f"agent {name!r} missing object 'plugins'")
    github = raw.get("github")
    schedule = raw.get("schedule")
    tasks = raw.get("tasks")
    war_rooms = raw.get("war_rooms")
    return FleetPlugins(
        github=_parse_github_plugin(github, name) if github is not None else None,
        schedule=_parse_schedule_plugin(schedule, name) if schedule is not None else None,
        tasks=_parse_tasks_plugin(tasks, name) if tasks is not None else None,
        war_rooms=_parse_war_rooms_plugin(war_rooms, name) if war_rooms is not None else None,
    )


def _backoff(attempt: int) -> float:
    return float(min(0.1 * (2**attempt), 5.0))
