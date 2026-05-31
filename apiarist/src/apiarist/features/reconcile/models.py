"""Typed models for the reconcile feature.

Kept free of I/O so they're trivially testable. The wire types (DesiredAgent
and friends) are parsed defensively by `client.py`; the local types
(ManagedContainer, RenderedContainer, plan/result) are produced by render +
diff.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Docker label namespace — disjoint from statically-deployed systemd
# containers (`hivemoot-<service>`), so the two systems never fight.
LABEL_MANAGED_BY = "dev.hivemoot.managed-by"
LABEL_MANAGED_VALUE = "apiarist"
LABEL_AGENT = "dev.hivemoot.agent"
LABEL_CONFIG_HASH = "dev.hivemoot.config-hash"
LABEL_REPO = "dev.hivemoot.repo"
LABEL_ENGINE = "dev.hivemoot.engine"

# Bumping this forces a config-hash change for every managed container, so a
# rendering-contract change rolls all managed agents on the next reconcile.
SPEC_VERSION = 1

CONTAINER_NAME_PREFIX = "hivemoot-mgd-"


def container_name_for(agent_name: str) -> str:
    return f"{CONTAINER_NAME_PREFIX}{agent_name}"


@dataclass(frozen=True)
class ResolvedEngine:
    id: str
    tool: str
    provider: str | None
    model: str | None
    tool_options: dict[str, str] | None


# ---------------------------------------------------------------------------
# Plugins — the canonical agent-config shape (mirrors `FleetPlugins` in
# web/src/server/fleet-store.ts). `repos` live ONLY under `plugins.github`;
# the old top-level `repos` + `triggers` shape is gone (v2 of the contract).
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GithubPlugin:
    """The `github` plugin — the ONLY place `repos` lives.

    Field names/types mirror `GithubPlugin` in web/src/server/fleet-store.ts.
    The three `watch_*` flags are the plugin's triggers; `poll_interval_secs`
    is the web-side field name (rendered as `watch_poll_interval_secs`).
    `watch_new_prs_authors` is empty when react-to-all-authors.
    """

    enabled: bool
    repos: tuple[str, ...]
    watch_new_prs: bool
    watch_review_requests: bool
    watch_mentions: bool
    watch_new_prs_authors: tuple[str, ...]
    poll_interval_secs: int


@dataclass(frozen=True)
class SchedulePlugin:
    """The `schedule` plugin — periodic prompt ticks (rendered to `cron`)."""

    enabled: bool
    interval_secs: int
    jitter_secs: int
    prompt: str


@dataclass(frozen=True)
class TasksPlugin:
    """The `tasks` plugin — claims from the dashboard queue (no v1 config)."""

    enabled: bool


@dataclass(frozen=True)
class WarRoomsPlugin:
    """The `war_rooms` plugin — observe, and optionally contribute."""

    enabled: bool
    contribute: bool


@dataclass(frozen=True)
class FleetPlugins:
    """The set of plugins an agent can enable. Each is OPTIONAL — an agent only
    carries the plugins it has configured (mirrors `FleetPlugins` in the web)."""

    github: GithubPlugin | None = None
    schedule: SchedulePlugin | None = None
    tasks: TasksPlugin | None = None
    war_rooms: WarRoomsPlugin | None = None


@dataclass(frozen=True)
class DesiredAgent:
    """One agent from the backend's desired-state roster.

    `repos` is NOT a top-level field — it lives only under `plugins.github.repos`.
    """

    name: str
    enabled: bool
    managed: bool
    config_version: int
    engine: ResolvedEngine
    skills: tuple[str, ...]
    system_prompt: str
    plugins: FleetPlugins
    token_name: str
    agent_role: str


@dataclass(frozen=True)
class DesiredState:
    version: int
    etag: str
    agents: tuple[DesiredAgent, ...]


@dataclass(frozen=True)
class RenderedContainer:
    """Everything needed to (re)create one managed container."""

    container_name: str
    agent_name: str
    repo: str
    engine_id: str
    image: str
    hivemoot_yaml: str
    identity_md: str
    env: dict[str, str]
    config_hash: str


@dataclass(frozen=True)
class ManagedContainer:
    """A container apiarist currently owns (from a Docker list)."""

    container_name: str
    container_id: str
    agent_name: str
    config_hash: str
    state: str  # e.g. "running", "exited", "created"


@dataclass(frozen=True)
class ReconcileAction:
    kind: str  # "create" | "delete" | "replace" | "noop"
    agent_name: str
    reason: str


@dataclass(frozen=True)
class ReconcilePlan:
    actions: tuple[ReconcileAction, ...]

    @property
    def creates(self) -> list[ReconcileAction]:
        return [a for a in self.actions if a.kind == "create"]

    @property
    def deletes(self) -> list[ReconcileAction]:
        return [a for a in self.actions if a.kind == "delete"]

    @property
    def replaces(self) -> list[ReconcileAction]:
        return [a for a in self.actions if a.kind == "replace"]

    @property
    def mutating(self) -> list[ReconcileAction]:
        return [a for a in self.actions if a.kind != "noop"]


@dataclass
class ReconcileResult:
    created: int = 0
    deleted: int = 0
    replaced: int = 0
    noop: int = 0
    failed: int = 0
    dry_run: bool = False
    skipped_reason: str | None = None
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {
            "created": self.created,
            "deleted": self.deleted,
            "replaced": self.replaced,
            "noop": self.noop,
            "failed": self.failed,
            "dry_run": self.dry_run,
            "skipped_reason": self.skipped_reason,
            "errors": list(self.errors),
        }
