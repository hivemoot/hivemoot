"""Tests for cli/hivemoot_agent/plugins_builtin/hivemoot/war_rooms/trigger.py."""

from __future__ import annotations

import os
import sys
import threading
import time
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.hivemoot.war_rooms import (
    WatchingRoom,
    WarRoomWatcherTrigger,
)
from hivemoot_agent.plugins_builtin.hivemoot.war_rooms.trigger import (
    _BoundedSeenCache,
    _seen_key,
)


def _room(
    room_id: str = "01234567-89ab-4cde-9012-3456789abcde",
    sequence: int = 1,
    status: str = "awaiting_rsvp",
    subject_ref: str = "hivemoot/hivemoot#1",
) -> WatchingRoom:
    return WatchingRoom(
        room_id=room_id,
        status=status,
        subject_type="pr_review",
        subject_ref=subject_ref,
        manager="bot-queen",
        opened_at="2026-04-28T07:00:00.000Z",
        current_sequence=sequence,
        participants={},
    )


class BoundedSeenCacheTests(unittest.TestCase):
    def test_add_and_contains(self) -> None:
        cache = _BoundedSeenCache(max_size=5)
        cache.add("key1")
        self.assertIn("key1", cache)
        self.assertNotIn("key2", cache)

    def test_eviction_at_max_size(self) -> None:
        cache = _BoundedSeenCache(max_size=3)
        cache.add("a")
        cache.add("b")
        cache.add("c")
        cache.add("d")  # evicts "a"
        self.assertNotIn("a", cache)
        self.assertIn("b", cache)
        self.assertIn("c", cache)
        self.assertIn("d", cache)
        self.assertEqual(len(cache), 3)

    def test_contains_promotes_to_most_recent(self) -> None:
        cache = _BoundedSeenCache(max_size=3)
        cache.add("a")
        cache.add("b")
        cache.add("c")
        # Access "a" — it becomes most recently used
        _ = "a" in cache
        cache.add("d")  # should evict "b" (oldest), not "a"
        self.assertIn("a", cache)
        self.assertNotIn("b", cache)

    def test_re_add_doesnt_grow(self) -> None:
        cache = _BoundedSeenCache(max_size=3)
        cache.add("a")
        cache.add("a")
        cache.add("a")
        self.assertEqual(len(cache), 1)


class SeenKeyTests(unittest.TestCase):
    def test_includes_room_id_and_sequence(self) -> None:
        room = _room(room_id="abc", sequence=5)
        self.assertEqual(_seen_key(room), "abc@5")

    def test_different_sequences_produce_different_keys(self) -> None:
        a = _seen_key(_room(room_id="abc", sequence=1))
        b = _seen_key(_room(room_id="abc", sequence=2))
        self.assertNotEqual(a, b)


class WarRoomWatcherTriggerTickTests(unittest.TestCase):
    """Single-tick semantics — invoke `_tick(dispatcher)` directly
    so tests don't have to manage the poll loop's threading."""

    def test_dispatches_one_job_per_visible_room(self) -> None:
        rooms = [_room("a"*8 + "-89ab-4cde-9012-3456789abcde", sequence=1),
                 _room("b"*8 + "-89ab-4cde-9012-3456789abcde", sequence=1)]
        list_fn = MagicMock(return_value=rooms)
        dispatcher = MagicMock()
        dispatcher.dispatch.return_value = True

        trigger = WarRoomWatcherTrigger(
            base_url="https://api.example",
            token_resolver=lambda: "tok",
            list_watching_fn=list_fn,
        )
        trigger._tick(dispatcher)

        self.assertEqual(dispatcher.dispatch.call_count, 2)
        list_fn.assert_called_once_with("https://api.example", "tok")

    def test_skips_already_seen_rooms_on_second_tick(self) -> None:
        room = _room("a"*8 + "-89ab-4cde-9012-3456789abcde", sequence=1)
        list_fn = MagicMock(return_value=[room])
        dispatcher = MagicMock()
        dispatcher.dispatch.return_value = True

        trigger = WarRoomWatcherTrigger(
            base_url="https://api.example",
            token_resolver=lambda: "tok",
            list_watching_fn=list_fn,
        )
        trigger._tick(dispatcher)
        trigger._tick(dispatcher)
        # Only one dispatch — second tick saw the same (room, seq) cached.
        self.assertEqual(dispatcher.dispatch.call_count, 1)

    def test_re_dispatches_on_new_sequence(self) -> None:
        room1 = _room("a"*8 + "-89ab-4cde-9012-3456789abcde", sequence=1)
        room2 = _room("a"*8 + "-89ab-4cde-9012-3456789abcde", sequence=2)
        list_fn = MagicMock(side_effect=[[room1], [room2]])
        dispatcher = MagicMock()
        dispatcher.dispatch.return_value = True

        trigger = WarRoomWatcherTrigger(
            base_url="https://api.example",
            token_resolver=lambda: "tok",
            list_watching_fn=list_fn,
        )
        trigger._tick(dispatcher)
        trigger._tick(dispatcher)
        # Both ticks dispatched — same room, different sequence.
        self.assertEqual(dispatcher.dispatch.call_count, 2)

    def test_skips_tick_when_token_resolver_returns_empty(self) -> None:
        list_fn = MagicMock()
        dispatcher = MagicMock()
        trigger = WarRoomWatcherTrigger(
            base_url="https://api.example",
            token_resolver=lambda: "",
            list_watching_fn=list_fn,
        )
        trigger._tick(dispatcher)
        # Neither call was made.
        list_fn.assert_not_called()
        dispatcher.dispatch.assert_not_called()

    def test_continues_on_list_failure(self) -> None:
        list_fn = MagicMock(side_effect=RuntimeError("network down"))
        dispatcher = MagicMock()
        trigger = WarRoomWatcherTrigger(
            base_url="https://api.example",
            token_resolver=lambda: "tok",
            list_watching_fn=list_fn,
        )
        # Should not raise — failure is logged and tick exits cleanly.
        trigger._tick(dispatcher)
        dispatcher.dispatch.assert_not_called()

    def test_dispatch_failure_evicts_from_cache_for_retry(self) -> None:
        room = _room("a"*8 + "-89ab-4cde-9012-3456789abcde", sequence=1)
        list_fn = MagicMock(return_value=[room])
        dispatcher = MagicMock()
        dispatcher.dispatch.return_value = False  # refused

        trigger = WarRoomWatcherTrigger(
            base_url="https://api.example",
            token_resolver=lambda: "tok",
            list_watching_fn=list_fn,
        )
        trigger._tick(dispatcher)
        trigger._tick(dispatcher)
        # Both ticks dispatched (cache eviction lets retry happen)
        self.assertEqual(dispatcher.dispatch.call_count, 2)

    def test_dispatch_raise_evicts_from_cache_for_retry(self) -> None:
        room = _room("a"*8 + "-89ab-4cde-9012-3456789abcde", sequence=1)
        list_fn = MagicMock(return_value=[room])
        dispatcher = MagicMock()
        dispatcher.dispatch.side_effect = RuntimeError("worker dead")

        trigger = WarRoomWatcherTrigger(
            base_url="https://api.example",
            token_resolver=lambda: "tok",
            list_watching_fn=list_fn,
        )
        trigger._tick(dispatcher)
        # Reset to succeed on second tick
        dispatcher.dispatch.side_effect = None
        dispatcher.dispatch.return_value = True
        trigger._tick(dispatcher)
        self.assertEqual(dispatcher.dispatch.call_count, 2)

    def test_job_metadata_carries_room_context(self) -> None:
        room = _room(
            room_id="abc12345-89ab-4cde-9012-3456789abcde",
            sequence=7,
            status="awaiting_contributions",
            subject_ref="hivemoot/colony#42",
        )
        list_fn = MagicMock(return_value=[room])
        dispatcher = MagicMock()
        dispatcher.dispatch.return_value = True

        trigger = WarRoomWatcherTrigger(
            base_url="https://api.example",
            token_resolver=lambda: "tok",
            list_watching_fn=list_fn,
        )
        trigger._tick(dispatcher)

        call_args = dispatcher.dispatch.call_args
        job = call_args[0][0]
        # Job is either the real plugins.interfaces.Job (with attrs)
        # or the dict fallback (when plugin-interfaces unavailable in
        # test). Test against both.
        if isinstance(job, dict):
            self.assertEqual(
                job["session_key"],
                "war-room:abc12345-89ab-4cde-9012-3456789abcde@7",
            )
            md = job["metadata"]
        else:
            self.assertEqual(
                job.session_key,
                "war-room:abc12345-89ab-4cde-9012-3456789abcde@7",
            )
            md = job.metadata
        self.assertEqual(md["room_id"], "abc12345-89ab-4cde-9012-3456789abcde")
        self.assertEqual(md["current_sequence"], 7)
        self.assertEqual(md["subject_ref"], "hivemoot/colony#42")
        self.assertEqual(md["status"], "awaiting_contributions")


class WarRoomWatcherTriggerStartStopTests(unittest.TestCase):
    """Lifecycle: start runs the loop, stop signals shutdown."""

    def test_stop_exits_loop_promptly(self) -> None:
        list_fn = MagicMock(return_value=[])
        dispatcher = MagicMock()
        trigger = WarRoomWatcherTrigger(
            base_url="https://api.example",
            token_resolver=lambda: "tok",
            poll_interval_secs=1,  # min allowed
            list_watching_fn=list_fn,
        )

        thread = threading.Thread(
            target=trigger.start, args=(dispatcher,), daemon=True,
        )
        thread.start()
        # Let the loop tick at least once
        time.sleep(0.1)
        trigger.stop()
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        # At least one list_watching call happened
        self.assertGreaterEqual(list_fn.call_count, 1)


if __name__ == "__main__":
    unittest.main()
