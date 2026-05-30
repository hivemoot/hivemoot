"""Declarative reconcile: diff desired vs actual, apply safely.

The diff (`plan_reconcile`) is pure and exhaustively testable. The `Reconciler`
wraps it with the safety rails the security model demands:
  - FAIL CLOSED: any backend error / 304 → skip the cycle, keep last-known-good.
    A backend hiccup can NEVER be read as "desired roster is empty".
  - MASS-DELETE VALVE: a cycle that would delete more than `max_delete_per_cycle`
    refuses unless explicitly allowed.
  - DRY RUN: computes the full plan and renders (to hash) but issues zero
    mutating Docker calls.
  - PARTIAL FAILURE: one agent failing doesn't abort the others.
"""

from __future__ import annotations

import structlog

from apiarist.features.reconcile.client import (
    FleetClient,
    FleetError,
    NotModified,
)
from apiarist.features.reconcile.docker import DockerClient
from apiarist.features.reconcile.models import (
    DesiredAgent,
    ManagedContainer,
    ReconcileAction,
    ReconcilePlan,
    ReconcileResult,
    RenderedContainer,
)
from apiarist.features.reconcile.render import render_agent


def plan_reconcile(
    want: dict[str, RenderedContainer],
    have: dict[str, ManagedContainer],
) -> ReconcilePlan:
    """Pure set-difference between desired (rendered) and actual containers."""
    actions: list[ReconcileAction] = []
    for name in sorted(want.keys()):
        r = want[name]
        c = have.get(name)
        if c is None:
            actions.append(ReconcileAction("create", name, "absent"))
        elif c.config_hash != r.config_hash:
            actions.append(ReconcileAction("replace", name, "config changed"))
        else:
            actions.append(ReconcileAction("noop", name, "up to date"))
    for name in sorted(set(have.keys()) - set(want.keys())):
        actions.append(
            ReconcileAction("delete", name, "not desired (deleted/disabled/out-of-scope)")
        )
    return ReconcilePlan(tuple(actions))


class Reconciler:
    def __init__(
        self,
        *,
        fleet_client: FleetClient,
        docker_client: DockerClient,
        backend_url: str,
        image: str,
        image_allowlist: list[str],
        managed_filter: set[str] | None,
        dry_run: bool,
        max_delete_per_cycle: int,
        allow_mass_delete: bool,
    ) -> None:
        # Image allowlist is enforced at construction — the reconciler refuses to
        # run an image outside the allowlist, even if a record somehow named one.
        repo_part = image.split(":", 1)[0].split("@", 1)[0]
        if repo_part not in image_allowlist:
            raise ValueError(
                f"reconcile image {image!r} (repo {repo_part!r}) is not in "
                f"the allowlist {image_allowlist!r}"
            )
        self._fleet = fleet_client
        self._docker = docker_client
        self._backend_url = backend_url
        self._image = image
        self._managed_filter = managed_filter
        self._dry_run = dry_run
        self._max_delete = max_delete_per_cycle
        self._allow_mass_delete = allow_mass_delete
        self._last_etag: str | None = None
        self._log = structlog.get_logger().bind(component="reconcile")

    def _in_scope(self, name: str) -> bool:
        return self._managed_filter is None or name in self._managed_filter

    def _build_want(self, agents: tuple[DesiredAgent, ...]) -> dict[str, RenderedContainer]:
        want: dict[str, RenderedContainer] = {}
        for a in agents:
            # Managed + in-scope + enabled ⇒ we want a running container. Disabled
            # agents are intentionally NOT rendered, so they fall into the delete
            # set (their container is stopped).
            if not a.managed or not a.enabled or not self._in_scope(a.name):
                continue
            want[a.name] = render_agent(a, backend_url=self._backend_url, image=self._image)
        return want

    async def run_cycle(self) -> ReconcileResult:
        try:
            ds = await self._fleet.fetch_desired_state(etag=self._last_etag)
        except FleetError as exc:
            # FAIL CLOSED — keep last-known-good, do not touch any container.
            self._log.warning("desired-state fetch failed; skipping cycle", error=str(exc))
            return ReconcileResult(skipped_reason=f"backend_error: {exc}", errors=[str(exc)])

        if isinstance(ds, NotModified):
            return ReconcileResult(skipped_reason="not_modified")

        # Do NOT commit the new etag yet. Advancing it here would let a
        # guard-trip / docker error / partial failure move past a roster that
        # was never (fully) reconciled: the next poll would 304 and the
        # situation would never be re-evaluated — the mass-delete valve would
        # latch itself off and stop alarming. Commit only on a clean cycle.
        new_etag = ds.etag
        want = self._build_want(ds.agents)

        try:
            actual = await self._docker.list_managed()
        except Exception as exc:  # docker unreachable — fail closed
            self._log.warning("docker list failed; skipping cycle", error=str(exc))
            return ReconcileResult(skipped_reason=f"docker_error: {exc}", errors=[str(exc)])

        have = {c.agent_name: c for c in actual if self._in_scope(c.agent_name)}
        plan = plan_reconcile(want, have)

        if len(plan.deletes) > self._max_delete and not self._allow_mass_delete:
            self._log.error(
                "mass-delete guard tripped; refusing cycle",
                would_delete=len(plan.deletes),
                limit=self._max_delete,
            )
            return ReconcileResult(skipped_reason="mass_delete_guard")

        result = ReconcileResult(dry_run=self._dry_run, noop=len(plan.actions) - len(plan.mutating))

        if self._dry_run:
            for a in plan.mutating:
                self._log.info(
                    "DRY-RUN would apply", kind=a.kind, agent=a.agent_name, reason=a.reason
                )
            result.created = len(plan.creates)
            result.deleted = len(plan.deletes)
            result.replaced = len(plan.replaces)
            # Dry-run "completed": commit the etag so a stable roster 304s next
            # cycle instead of re-logging the same plan forever. A roster change
            # busts the etag and the plan is re-observed.
            self._last_etag = new_etag
            return result

        for action in plan.mutating:
            try:
                await self._apply(action, want.get(action.agent_name))
                if action.kind == "create":
                    result.created += 1
                elif action.kind == "delete":
                    result.deleted += 1
                elif action.kind == "replace":
                    result.replaced += 1
            except Exception as exc:  # partial-failure tolerant
                result.failed += 1
                msg = f"{action.kind} {action.agent_name}: {exc}"
                result.errors.append(msg)
                self._log.error(
                    "reconcile action failed",
                    kind=action.kind,
                    agent=action.agent_name,
                    error=str(exc),
                )

        # Commit the etag only when every action applied cleanly. On any failure
        # leave it unchanged so the next cycle re-fetches (no 304) and retries the
        # failed/unapplied actions — the reconciler converges instead of stranding
        # a roster generation.
        if result.failed == 0:
            self._last_etag = new_etag
        return result

    async def _apply(self, action: ReconcileAction, rendered: RenderedContainer | None) -> None:
        if action.kind == "delete":
            await self._docker.stop_and_remove(action.agent_name)
            return
        if rendered is None:  # defensive — create/replace always have a render
            raise RuntimeError(f"no rendered container for {action.agent_name}")
        if action.kind == "replace":
            await self._docker.stop_and_remove(action.agent_name)
        await self._docker.pull_if_absent(rendered.image)
        await self._docker.create_and_start(rendered)
