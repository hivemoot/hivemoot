"""Tests for apiarist.core.registry."""

from __future__ import annotations

from typing import Any

import pytest

from apiarist.core.registry import Registry


async def _noop_handler(_params: dict[str, Any]) -> dict[str, Any]:
    return {}


def test_register_and_get() -> None:
    r = Registry()
    r.register("foo", _noop_handler)
    assert r.get("foo") is _noop_handler


def test_get_unknown_returns_none() -> None:
    r = Registry()
    assert r.get("nope") is None


def test_register_duplicate_raises() -> None:
    r = Registry()
    r.register("foo", _noop_handler)
    with pytest.raises(ValueError, match="already registered"):
        r.register("foo", _noop_handler)


def test_unregister() -> None:
    r = Registry()
    r.register("foo", _noop_handler)
    r.unregister("foo")
    assert r.get("foo") is None


def test_unregister_unknown_is_noop() -> None:
    r = Registry()
    r.unregister("never-registered")  # should not raise


def test_list_ops_sorted() -> None:
    r = Registry()
    r.register("zebra", _noop_handler)
    r.register("alpha", _noop_handler)
    r.register("middle", _noop_handler)
    assert r.list_ops() == ["alpha", "middle", "zebra"]


def test_list_ops_empty() -> None:
    r = Registry()
    assert r.list_ops() == []
