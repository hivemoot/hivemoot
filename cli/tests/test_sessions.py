"""Tests for sessions.SessionStore — TSV persistence, resume policy, day boundaries."""

import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.sessions import (
    SessionRecord,
    SessionStore,
    build_scoped_key,
    create_session_store,
)


# ── TSV round-trip ───────────────────────────────────────────────


def test_tsv_round_trip(tmp_path: Path):
    tsv = str(tmp_path / "sessions" / "claude" / "tool-session-map.tsv")
    store = SessionStore(map_file=tsv)

    store.save("key-a", "uuid-a", was_resume=False, prior_record=None)
    store.save("key-b", "uuid-b", was_resume=False, prior_record=None)

    store2 = SessionStore(map_file=tsv)
    store2.load()

    sid_a, rec_a = store2.lookup("key-a")
    sid_b, rec_b = store2.lookup("key-b")

    assert sid_a == "uuid-a"
    assert sid_b == "uuid-b"
    assert rec_a is not None
    assert rec_b is not None
    assert rec_a.created_epoch > 0
    assert rec_b.last_used_epoch > 0


def test_missing_file_loads_empty(tmp_path: Path):
    tsv = str(tmp_path / "nonexistent" / "map.tsv")
    store = SessionStore(map_file=tsv)
    store.load()

    sid, rec = store.lookup("anything")
    assert sid == ""
    assert rec is None


def test_corrupted_lines_skipped(tmp_path: Path):
    tsv = str(tmp_path / "map.tsv")
    now = int(time.time())
    with open(tsv, "w") as f:
        f.write(f"good-key\tgood-uuid\t{now - 60}\t{now - 10}\n")
        f.write("bad-line-no-tabs\n")
        f.write("bad-epoch\tuuid\tnotanumber\t1000\n")
        f.write("too\tmany\tfields\there\textra\n")

    store = SessionStore(map_file=tsv)
    store.load()

    sid, rec = store.lookup("good-key")
    assert sid == "good-uuid"

    # Bad lines should not appear.
    sid2, _ = store.lookup("bad-line-no-tabs")
    assert sid2 == ""
    sid3, _ = store.lookup("bad-epoch")
    assert sid3 == ""


# ── Resume policy: idle ──────────────────────────────────────────


def test_should_resume_idle_within_limit():
    store = SessionStore(map_file="/dev/null", max_idle_hours=12)
    now = 1_700_000_000
    rec = SessionRecord("k", "s", now - 3600, now - 3600)  # 1h idle
    assert store.should_resume(rec, now) is True


def test_should_resume_idle_exceeded():
    store = SessionStore(map_file="/dev/null", max_idle_hours=12)
    now = 1_700_000_000
    rec = SessionRecord("k", "s", now - 50000, now - 50000)  # ~13.9h idle
    assert store.should_resume(rec, now) is False


# ── Resume policy: age ───────────────────────────────────────────


def test_should_resume_age_within_limit():
    store = SessionStore(map_file="/dev/null", max_age_hours=24)
    now = 1_700_000_000
    rec = SessionRecord("k", "s", now - 80000, now - 100)  # ~22h old
    assert store.should_resume(rec, now) is True


def test_should_resume_age_exceeded():
    store = SessionStore(map_file="/dev/null", max_age_hours=24)
    now = 1_700_000_000
    rec = SessionRecord("k", "s", now - 90000, now - 100)  # 25h old
    assert store.should_resume(rec, now) is False


# ── Resume policy: day boundary ──────────────────────────────────


def test_should_resume_day_boundary_expired_and_idle():
    store = SessionStore(map_file="/dev/null", reset_at_hour=4)
    now = 1_700_000_000
    boundary = store._last_reset_boundary(now)
    assert boundary is not None

    # Session created before boundary AND idle for 2h → expired.
    rec = SessionRecord("k", "s", boundary - 3600, now - 7200)
    assert store.should_resume(rec, now) is False


def test_should_resume_day_boundary_but_still_active():
    """Active conversation should NOT be killed by the day boundary.

    Scenario: user chatting at 3 AM, boundary at 4 AM, next message at
    4:05.  Only 5 minutes idle — well within the grace window.  The
    conversation must continue uninterrupted.
    """
    store = SessionStore(map_file="/dev/null", reset_at_hour=4)
    now = 1_700_000_000
    boundary = store._last_reset_boundary(now)
    assert boundary is not None

    # Created before boundary but last used 5 min ago → still active.
    rec = SessionRecord("k", "s", boundary - 3600, now - 300)
    assert store.should_resume(rec, now) is True


def test_should_resume_day_boundary_valid():
    store = SessionStore(map_file="/dev/null", reset_at_hour=4)
    now = 1_700_000_000
    boundary = store._last_reset_boundary(now)
    assert boundary is not None

    # Created after the boundary → not affected.
    rec = SessionRecord("k", "s", boundary + 3600, now - 60)
    assert store.should_resume(rec, now) is True


def test_should_resume_no_day_boundary():
    store = SessionStore(map_file="/dev/null", reset_at_hour=None)
    now = 1_700_000_000
    rec = SessionRecord("k", "s", now - 3600, now - 60)
    assert store.should_resume(rec, now) is True


# ── Resume policy: clock skew ────────────────────────────────────


def test_should_resume_negative_idle_rejected():
    store = SessionStore(map_file="/dev/null")
    now = 1_700_000_000
    # last_used is in the future → clock skew.
    rec = SessionRecord("k", "s", now - 100, now + 100)
    assert store.should_resume(rec, now) is False


# ── Resume disabled ──────────────────────────────────────────────


def test_lookup_resume_disabled(tmp_path: Path):
    tsv = str(tmp_path / "map.tsv")
    store = SessionStore(map_file=tsv, resume_enabled=False)
    store.save("key", "uuid", was_resume=False, prior_record=None)

    # Even though a record exists, lookup returns empty.
    sid, rec = store.lookup("key")
    assert sid == ""
    assert rec is None


# ── Save preserves created_epoch on resume ───────────────────────


def test_save_preserves_created_on_resume(tmp_path: Path):
    tsv = str(tmp_path / "map.tsv")
    store = SessionStore(map_file=tsv)

    # Initial save.
    store.save("key", "uuid-1", was_resume=False, prior_record=None)
    _, rec1 = store.lookup("key")
    assert rec1 is not None
    original_created = rec1.created_epoch

    # Simulate brief delay so timestamps differ.
    time.sleep(0.05)

    # Resume save — should preserve original created_epoch.
    store.save("key", "uuid-2", was_resume=True, prior_record=rec1)
    _, rec2 = store.lookup("key")
    assert rec2 is not None
    assert rec2.session_id == "uuid-2"
    assert rec2.created_epoch == original_created
    assert rec2.last_used_epoch >= rec1.last_used_epoch


def test_save_new_created_on_fresh(tmp_path: Path):
    tsv = str(tmp_path / "map.tsv")
    store = SessionStore(map_file=tsv)

    store.save("key", "uuid-1", was_resume=False, prior_record=None)
    _, rec1 = store.lookup("key")
    assert rec1 is not None

    time.sleep(0.05)

    # Fresh save (not resume) — new created_epoch.
    store.save("key", "uuid-2", was_resume=False, prior_record=None)
    _, rec2 = store.lookup("key")
    assert rec2 is not None
    assert rec2.created_epoch >= rec1.created_epoch


# ── Atomic write ─────────────────────────────────────────────────


def test_atomic_write_no_leftover_temp(tmp_path: Path):
    tsv = str(tmp_path / "map.tsv")
    store = SessionStore(map_file=tsv)
    store.save("key", "uuid", was_resume=False, prior_record=None)

    # No temp files should be left behind.
    files = list(tmp_path.iterdir())
    assert len(files) == 1
    assert files[0].name == "map.tsv"


# ── build_scoped_key ─────────────────────────────────────────────


def test_build_scoped_key_format():
    key = build_scoped_key("tg:12345", "claude", "opus")
    assert "provider=claude" in key
    assert "model=opus" in key
    assert "key=tg:12345" in key
    assert "repo=_" in key
    assert "toolopts=" in key


def test_build_scoped_key_with_repo_and_tools():
    key = build_scoped_key(
        "tg:12345", "claude", "opus",
        repo="hivemoot/hivemoot-agent",
        tool_options_json='{"foo": true}',
    )
    assert "repo=hivemoot/hivemoot-agent" in key
    assert "toolopts=" in key
    # Different tool options must produce different keys.
    key2 = build_scoped_key(
        "tg:12345", "claude", "opus",
        repo="hivemoot/hivemoot-agent",
        tool_options_json='{"foo": false}',
    )
    assert key != key2


def test_build_scoped_key_empty_tool_options_normalized():
    """Empty tool_options_json should produce the same hash as '{}'."""
    key_empty = build_scoped_key("tg:1", "claude", tool_options_json="")
    key_braces = build_scoped_key("tg:1", "claude", tool_options_json="{}")
    assert key_empty == key_braces


def test_build_scoped_key_default_model():
    key = build_scoped_key("tg:12345", "claude")
    assert "model=default" in key
    assert "key=tg:12345" in key


def test_build_scoped_key_empty_base():
    key = build_scoped_key("", "claude")
    assert key == ""


# ── create_session_store ─────────────────────────────────────────


def test_create_session_store_from_env(tmp_path: Path):
    from unittest.mock import patch

    env = {
        "AGENT_PROVIDER": "claude",
        "WORKSPACE_ROOT": str(tmp_path),
        "SESSION_RESUME": "1",
        "SESSION_RESUME_MAX_IDLE_HOURS": "6",
        "SESSION_RESUME_MAX_AGE_HOURS": "18",
        "SESSION_RESET_AT_HOUR": "4",
    }
    with patch.dict(os.environ, env, clear=False):
        config = _DictConfig(env)
        store = create_session_store(config)

    assert store.resume_enabled is True
    assert store.max_idle_hours == 6
    assert store.max_age_hours == 18
    assert store.reset_at_hour == 4
    assert "claude" in store.map_file
    assert str(tmp_path) in store.map_file


def test_create_session_store_disabled(tmp_path: Path):
    config = _DictConfig({
        "WORKSPACE_ROOT": str(tmp_path),
        "SESSION_RESUME": "0",
    })
    store = create_session_store(config)
    assert store.resume_enabled is False


def test_create_session_store_invalid_hour(tmp_path: Path):
    config = _DictConfig({
        "WORKSPACE_ROOT": str(tmp_path),
        "SESSION_RESET_AT_HOUR": "25",
    })
    store = create_session_store(config)
    assert store.reset_at_hour is None


# ── Thread safety ────────────────────────────────────────────────


def test_concurrent_save_and_lookup(tmp_path: Path):
    tsv = str(tmp_path / "map.tsv")
    store = SessionStore(map_file=tsv)
    errors: list[str] = []

    def writer(i: int) -> None:
        try:
            for j in range(20):
                store.save(f"key-{i}", f"uuid-{i}-{j}", False, None)
        except Exception as exc:
            errors.append(f"writer-{i}: {exc}")

    def reader(i: int) -> None:
        try:
            for _ in range(20):
                store.lookup(f"key-{i}")
        except Exception as exc:
            errors.append(f"reader-{i}: {exc}")

    threads = []
    for i in range(5):
        threads.append(threading.Thread(target=writer, args=(i,)))
        threads.append(threading.Thread(target=reader, args=(i,)))

    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)

    assert not errors, f"Thread errors: {errors}"

    # Verify the file is still readable after concurrent writes.
    store2 = SessionStore(map_file=tsv)
    store2.load()
    for i in range(5):
        sid, rec = store2.lookup(f"key-{i}")
        assert sid.startswith(f"uuid-{i}-"), f"key-{i} has unexpected sid={sid}"


# ── Helpers ──────────────────────────────────────────────────────


class _DictConfig:
    """Minimal config stand-in for testing."""

    def __init__(self, data: dict) -> None:
        self._data = data

    def get(self, key: str, default: object = None) -> object:
        return self._data.get(key, default)


# ── Standalone runner ────────────────────────────────────────────


if __name__ == "__main__":
    import inspect
    import tempfile

    passed = 0
    failed = 0
    for name, func in sorted(
        inspect.getmembers(sys.modules[__name__], inspect.isfunction)
    ):
        if not name.startswith("test_"):
            continue
        try:
            params = inspect.signature(func).parameters
            if "tmp_path" in params:
                with tempfile.TemporaryDirectory() as td:
                    func(Path(td))
            else:
                func()
            print(f"  \u2713 {name}")
            passed += 1
        except Exception as e:
            print(f"  \u2717 {name}: {e}")
            failed += 1

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
