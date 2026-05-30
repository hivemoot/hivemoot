"""Tests for the pure reconcile diff."""

from __future__ import annotations

from apiarist.features.reconcile.models import ManagedContainer, RenderedContainer
from apiarist.features.reconcile.reconcile import plan_reconcile


def _rendered(name: str, config_hash: str) -> RenderedContainer:
    return RenderedContainer(
        container_name=f"hivemoot-mgd-{name}",
        agent_name=name,
        repo="o/r",
        engine_id="claude",
        image="ghcr.io/hivemoot/agent:latest",
        hivemoot_yaml="",
        identity_md="",
        env={},
        config_hash=config_hash,
    )


def _managed(name: str, config_hash: str) -> ManagedContainer:
    return ManagedContainer(
        container_name=f"hivemoot-mgd-{name}",
        container_id="id",
        agent_name=name,
        config_hash=config_hash,
        state="running",
    )


def test_create_when_absent() -> None:
    plan = plan_reconcile({"a": _rendered("a", "h1")}, {})
    assert [x.kind for x in plan.actions] == ["create"]


def test_noop_when_hash_matches() -> None:
    plan = plan_reconcile({"a": _rendered("a", "h1")}, {"a": _managed("a", "h1")})
    assert plan.mutating == []


def test_replace_when_hash_differs() -> None:
    plan = plan_reconcile({"a": _rendered("a", "h2")}, {"a": _managed("a", "h1")})
    assert [x.kind for x in plan.replaces] == ["replace"]


def test_delete_when_not_wanted() -> None:
    plan = plan_reconcile({}, {"a": _managed("a", "h1")})
    assert [x.kind for x in plan.deletes] == ["delete"]


def test_mixed_plan() -> None:
    want = {
        "keep": _rendered("keep", "h"),
        "change": _rendered("change", "new"),
        "new": _rendered("new", "h"),
    }
    have = {
        "keep": _managed("keep", "h"),
        "change": _managed("change", "old"),
        "gone": _managed("gone", "h"),
    }
    plan = plan_reconcile(want, have)
    kinds = {a.agent_name: a.kind for a in plan.actions}
    assert kinds == {"keep": "noop", "change": "replace", "new": "create", "gone": "delete"}
