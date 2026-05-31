"""Tests for the Reconciler safety rails (fail-closed, dry-run, mass-delete, partial failure)."""

from __future__ import annotations

from typing import Any

from apiarist.features.reconcile.client import FleetUnavailableError, NotModified
from apiarist.features.reconcile.models import (
    DesiredAgent,
    DesiredState,
    FleetPlugins,
    GithubPlugin,
    ManagedContainer,
    RenderedContainer,
    ResolvedEngine,
)
from apiarist.features.reconcile.reconcile import Reconciler

IMAGE = "ghcr.io/hivemoot/agent:latest"
ALLOWLIST = ["ghcr.io/hivemoot/agent"]


def _plugins() -> FleetPlugins:
    return FleetPlugins(
        github=GithubPlugin(
            enabled=True,
            repos=("hivemoot/hivemoot",),
            watch_new_prs=True,
            watch_review_requests=True,
            watch_mentions=False,
            watch_new_prs_authors=(),
            poll_interval_secs=300,
        )
    )


def _agent(name: str = "builder", enabled: bool = True, managed: bool = True) -> DesiredAgent:
    return DesiredAgent(
        name=name,
        enabled=enabled,
        managed=managed,
        config_version=1,
        engine=ResolvedEngine(
            id="claude", tool="claude", provider=None, model=None, tool_options=None
        ),
        skills=(),
        system_prompt="hi",
        plugins=_plugins(),
        token_name=name,
        agent_role=name,
    )


def _state(*agents: DesiredAgent) -> DesiredState:
    return DesiredState(version=1, etag="roster-v1", agents=tuple(agents))


def _managed(name: str) -> ManagedContainer:
    return ManagedContainer(
        container_name=f"hivemoot-mgd-{name}",
        container_id="id",
        agent_name=name,
        config_hash="stale",
        state="running",
    )


class FakeFleet:
    def __init__(self, result: Any) -> None:
        self._result = result
        self.calls = 0

    async def fetch_desired_state(self, *, etag: str | None = None) -> Any:
        self.calls += 1
        if isinstance(self._result, Exception):
            raise self._result
        return self._result


class FakeDocker:
    def __init__(
        self, managed: list[ManagedContainer] | None = None, fail_create: bool = False
    ) -> None:
        self.managed = managed or []
        self.created: list[str] = []
        self.removed: list[str] = []
        self.pulled: list[str] = []
        self._fail_create = fail_create

    async def list_managed(self) -> list[ManagedContainer]:
        return list(self.managed)

    async def pull_if_absent(self, image: str) -> None:
        self.pulled.append(image)

    async def create_and_start(self, rendered: RenderedContainer) -> None:
        if self._fail_create:
            raise RuntimeError("boom")
        self.created.append(rendered.agent_name)

    async def stop_and_remove(self, agent_name: str) -> None:
        self.removed.append(agent_name)


def _reconciler(fleet: FakeFleet, docker: FakeDocker, **over: Any) -> Reconciler:
    kwargs: dict[str, Any] = dict(
        fleet_client=fleet,
        docker_client=docker,
        backend_url="https://x",
        image=IMAGE,
        image_allowlist=ALLOWLIST,
        managed_filter=None,
        dry_run=False,
        max_delete_per_cycle=1,
        allow_mass_delete=False,
    )
    kwargs.update(over)
    return Reconciler(**kwargs)


async def test_fail_closed_on_backend_error_touches_nothing() -> None:
    docker = FakeDocker(managed=[_managed("builder")])
    r = _reconciler(FakeFleet(FleetUnavailableError("down")), docker)
    result = await r.run_cycle()
    assert result.skipped_reason is not None and result.skipped_reason.startswith("backend_error")
    assert docker.created == [] and docker.removed == []


async def test_not_modified_skips() -> None:
    docker = FakeDocker()
    r = _reconciler(FakeFleet(NotModified()), docker)
    result = await r.run_cycle()
    assert result.skipped_reason == "not_modified"
    assert docker.created == []


async def test_dry_run_issues_no_mutations() -> None:
    docker = FakeDocker()
    r = _reconciler(FakeFleet(_state(_agent())), docker, dry_run=True)
    result = await r.run_cycle()
    assert result.dry_run is True
    assert result.created == 1  # planned
    assert docker.created == []  # but nothing actually created


async def test_enforce_creates_enabled_agent() -> None:
    docker = FakeDocker()
    r = _reconciler(FakeFleet(_state(_agent())), docker)
    result = await r.run_cycle()
    assert result.created == 1
    assert docker.created == ["builder"]


async def test_disabled_agent_is_deleted() -> None:
    docker = FakeDocker(managed=[_managed("builder")])
    r = _reconciler(FakeFleet(_state(_agent(enabled=False))), docker)
    result = await r.run_cycle()
    assert result.deleted == 1
    assert docker.removed == ["builder"]


async def test_mass_delete_guard_refuses() -> None:
    docker = FakeDocker(managed=[_managed("a"), _managed("b")])
    # desired roster is empty ⇒ would delete 2 (> max_delete=1) ⇒ refuse.
    r = _reconciler(FakeFleet(_state()), docker, max_delete_per_cycle=1)
    result = await r.run_cycle()
    assert result.skipped_reason == "mass_delete_guard"
    assert docker.removed == []


async def test_partial_failure_is_isolated() -> None:
    docker = FakeDocker(fail_create=True)
    r = _reconciler(FakeFleet(_state(_agent())), docker)
    result = await r.run_cycle()
    assert result.failed == 1
    assert result.errors


async def test_image_outside_allowlist_is_rejected() -> None:
    raised = False
    try:
        _reconciler(FakeFleet(_state()), FakeDocker(), image="evil.io/x:latest")
    except ValueError:
        raised = True
    assert raised


# ---------------------------------------------------------------------------
# Cross-cycle etag behavior — the etag must advance ONLY on a clean cycle, so a
# guard-trip / partial failure / backend error keeps re-evaluating (does not
# latch the safety valve off). Honors If-None-Match like the real backend.
# ---------------------------------------------------------------------------


class EtagFleet:
    """Returns the roster when the sent etag != current; 304 when it matches."""

    def __init__(self, etag: str, agents: tuple[DesiredAgent, ...]) -> None:
        self._etag = etag
        self._agents = agents
        self.sent_etags: list[str | None] = []

    async def fetch_desired_state(self, *, etag: str | None = None) -> Any:
        self.sent_etags.append(etag)
        if etag == self._etag:
            return NotModified()
        return DesiredState(version=1, etag=self._etag, agents=self._agents)


class SeqFleet:
    """Yields a fixed sequence of results (DesiredState / NotModified / Exception)."""

    def __init__(self, results: list[Any]) -> None:
        self._results = list(results)
        self.sent_etags: list[str | None] = []

    async def fetch_desired_state(self, *, etag: str | None = None) -> Any:
        self.sent_etags.append(etag)
        r = self._results.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


async def test_mass_delete_guard_re_trips_next_cycle() -> None:
    # Empty roster while 2 containers run ⇒ would delete 2 (> max=1) ⇒ guard trips.
    # The guard must KEEP re-evaluating: the etag must not advance on a guard-trip.
    docker = FakeDocker(managed=[_managed("a"), _managed("b")])
    fleet = EtagFleet("roster-v1", ())
    r = _reconciler(fleet, docker, max_delete_per_cycle=1)
    first = await r.run_cycle()
    second = await r.run_cycle()
    assert first.skipped_reason == "mass_delete_guard"
    assert second.skipped_reason == "mass_delete_guard"  # NOT "not_modified"
    assert fleet.sent_etags == [None, None]  # never advanced to the dangerous etag
    assert docker.removed == []


async def test_clean_cycle_advances_etag_then_304s() -> None:
    docker = FakeDocker()
    fleet = EtagFleet("roster-v1", (_agent(),))
    r = _reconciler(fleet, docker)
    first = await r.run_cycle()
    second = await r.run_cycle()
    assert first.created == 1
    assert second.skipped_reason == "not_modified"
    assert fleet.sent_etags == [None, "roster-v1"]  # committed etag sent on cycle 2
    assert docker.created == ["builder"]  # created exactly once


async def test_partial_failure_does_not_advance_etag() -> None:
    docker = FakeDocker(fail_create=True)
    fleet = EtagFleet("roster-v1", (_agent(),))
    r = _reconciler(fleet, docker)
    first = await r.run_cycle()
    second = await r.run_cycle()
    assert first.failed == 1
    assert second.failed == 1  # retried (not 304-skipped)
    assert fleet.sent_etags == [None, None]


async def test_fleet_error_preserves_etag_and_recovers() -> None:
    docker = FakeDocker()
    ds = DesiredState(version=1, etag="roster-v1", agents=(_agent(),))
    fleet = SeqFleet([ds, FleetUnavailableError("blip"), NotModified()])
    r = _reconciler(fleet, docker)
    await r.run_cycle()  # success → etag committed, builder created
    second = await r.run_cycle()  # backend error → skip, etag preserved
    third = await r.run_cycle()  # recovers → 304
    assert second.skipped_reason is not None and second.skipped_reason.startswith("backend_error")
    assert third.skipped_reason == "not_modified"
    assert fleet.sent_etags == [None, "roster-v1", "roster-v1"]
    assert docker.created == ["builder"]


async def test_managed_filter_never_touches_out_of_scope_containers() -> None:
    # builder is in scope (and its container is stale ⇒ replace); "other" is an
    # apiarist-managed container OUTSIDE the allowlist and must never be deleted.
    docker = FakeDocker(managed=[_managed("builder"), _managed("other")])
    fleet = EtagFleet("roster-v1", (_agent("builder"),))
    r = _reconciler(fleet, docker, managed_filter={"builder"})
    result = await r.run_cycle()
    assert result.skipped_reason is None
    assert "other" not in docker.removed
    assert "other" not in docker.created
