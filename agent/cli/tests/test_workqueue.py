"""Unit + concurrency tests for the keyed workqueue.

Covers the three correctness properties coalescing depends on:

1. Same-key coalescing: events added for a key already queued (or being
   processed) merge into that key's payload list rather than creating
   a second queue entry.
2. FIFO fairness: keys are popped in insertion order; a dirty re-run
   of key A goes to the back of the queue, so key B (added between
   A's initial add and A's dirty re-run) never starves.
3. No payload loss: every ``add`` eventually delivers its payload to
   a ``get`` call, including adds that race with the consumer's pop.

Concurrency tests validate (3) under real thread contention.
"""

from __future__ import annotations

import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.workqueue import WorkQueue


# ── Basic mechanics ───────────────────────────────────────────────


class BasicAddGetDoneTests(unittest.TestCase):
    def test_add_one_get_one(self) -> None:
        q = WorkQueue()
        q.add("k1", "payload-1")
        item = q.get(timeout=0.1)
        self.assertIsNotNone(item)
        key, payloads = item
        self.assertEqual(key, "k1")
        self.assertEqual(payloads, ["payload-1"])
        q.done("k1")

    def test_add_same_key_twice_coalesces(self) -> None:
        """Two adds with same key produce one queue entry, two payloads."""
        q = WorkQueue()
        q.add("k1", "first")
        q.add("k1", "second")
        # One pop should give both payloads.
        key, payloads = q.get(timeout=0.1)
        self.assertEqual(key, "k1")
        self.assertEqual(payloads, ["first", "second"])
        q.done("k1")
        # No second entry queued.
        self.assertIsNone(q.get(timeout=0.05))

    def test_add_different_keys_fifo(self) -> None:
        q = WorkQueue()
        q.add("a", 1)
        q.add("b", 2)
        q.add("c", 3)
        k1, _ = q.get(timeout=0.1)
        q.done(k1)
        k2, _ = q.get(timeout=0.1)
        q.done(k2)
        k3, _ = q.get(timeout=0.1)
        q.done(k3)
        self.assertEqual([k1, k2, k3], ["a", "b", "c"])

    def test_empty_key_rejected(self) -> None:
        q = WorkQueue()
        with self.assertRaises(ValueError):
            q.add("", "payload")

    def test_get_returns_none_on_timeout(self) -> None:
        q = WorkQueue()
        self.assertIsNone(q.get(timeout=0.01))


# ── Dirty re-enqueue (the coalescing heart) ────────────────────────


class DirtyReEnqueueTests(unittest.TestCase):
    def test_add_during_processing_triggers_reenqueue(self) -> None:
        """Events for a processing key accumulate; done() re-queues."""
        q = WorkQueue()
        q.add("k1", "first")
        key1, payloads1 = q.get(timeout=0.1)
        self.assertEqual(payloads1, ["first"])
        # New event arrives mid-processing — MUST NOT create a second
        # queue entry (key is in _processing).
        q.add("k1", "second")
        self.assertEqual(q.stats()["queue_len"], 0)
        q.done("k1")
        # Now the accumulated payload should be available.
        self.assertEqual(q.stats()["queue_len"], 1)
        key2, payloads2 = q.get(timeout=0.1)
        self.assertEqual(key2, "k1")
        self.assertEqual(payloads2, ["second"])
        q.done("k1")

    def test_many_adds_during_processing_all_flush(self) -> None:
        """N adds during one processing round → one re-run with N payloads."""
        q = WorkQueue()
        q.add("k1", 0)
        key, first = q.get(timeout=0.1)
        self.assertEqual(first, [0])
        for i in range(1, 6):
            q.add("k1", i)
        q.done("k1")
        key2, payloads = q.get(timeout=0.1)
        self.assertEqual(payloads, [1, 2, 3, 4, 5])
        q.done("k1")

    def test_dirty_reenqueue_goes_to_tail(self) -> None:
        """K1 dirty re-run must NOT jump ahead of K2 that was queued first."""
        q = WorkQueue()
        q.add("k1", "a")
        k1, _ = q.get(timeout=0.1)  # pulls k1, k1 in _processing
        q.add("k2", "b")             # k2 queued
        q.add("k1", "c")             # k1 dirty (mid-processing)
        q.done("k1")                 # k1 re-enqueued — goes to tail
        # Expected FIFO: k2, then k1.
        k_first, _ = q.get(timeout=0.1)
        q.done(k_first)
        k_second, _ = q.get(timeout=0.1)
        q.done(k_second)
        self.assertEqual(
            [k_first, k_second], ["k2", "k1"],
            "dirty re-enqueue must not starve other keys",
        )

    def test_clean_key_cleanup_removes_empty_payload_list(self) -> None:
        """After done() with no dirty payloads, the key's entry is dropped."""
        q = WorkQueue()
        q.add("k1", 0)
        q.get(timeout=0.1)
        q.done("k1")
        # Internal invariant: empty payload list must be cleaned up
        # so the payload map doesn't grow unbounded for one-shot keys.
        self.assertNotIn("k1", q._payloads)


# ── Shutdown ──────────────────────────────────────────────────────


class ShutdownTests(unittest.TestCase):
    def test_shutdown_wakes_blocked_get(self) -> None:
        """A thread blocked in get() must return None after shutdown."""
        q = WorkQueue()
        result: list = []

        def worker():
            item = q.get(timeout=5.0)
            result.append(item)

        t = threading.Thread(target=worker, daemon=True)
        t.start()
        time.sleep(0.05)  # let the worker park in cond.wait
        q.shutdown()
        t.join(timeout=1.0)
        self.assertFalse(t.is_alive(), "shutdown must unblock get()")
        self.assertEqual(result, [None])

    def test_shutdown_rejects_new_adds(self) -> None:
        q = WorkQueue()
        q.shutdown()
        with self.assertRaises(RuntimeError):
            q.add("k1", "x")

    def test_shutdown_allows_done_to_finish_inflight(self) -> None:
        """done() must still work after shutdown so workers can clean up."""
        q = WorkQueue()
        q.add("k1", "x")
        key, _ = q.get(timeout=0.1)
        q.shutdown()
        q.done(key)  # must not raise
        # Subsequent get returns None (drained).
        self.assertIsNone(q.get(timeout=0.05))

    def test_shutdown_after_enqueue_drains_remaining(self) -> None:
        """Items enqueued before shutdown are still retrievable."""
        q = WorkQueue()
        q.add("k1", 1)
        q.add("k2", 2)
        q.shutdown()
        key1, p1 = q.get(timeout=0.1)
        q.done(key1)
        key2, p2 = q.get(timeout=0.1)
        q.done(key2)
        self.assertEqual({key1, key2}, {"k1", "k2"})
        self.assertIsNone(q.get(timeout=0.05))


# ── Concurrency stress ────────────────────────────────────────────


class ConcurrencyStressTests(unittest.TestCase):
    """Validate no payload is ever lost under real thread contention."""

    def test_many_producers_one_consumer_no_loss(self) -> None:
        q = WorkQueue()
        producer_count = 5
        events_per_producer = 100
        expected_total = producer_count * events_per_producer

        def produce(pid: int) -> None:
            for i in range(events_per_producer):
                # Vary keys so we get coalescing AND spread.
                key = f"k{i % 10}"
                q.add(key, (pid, i))

        received: list = []

        def consume_until(target: int) -> None:
            while len(received) < target:
                item = q.get(timeout=2.0)
                if item is None:
                    continue
                key, payloads = item
                received.extend(payloads)
                q.done(key)

        producers = [
            threading.Thread(target=produce, args=(p,), daemon=True)
            for p in range(producer_count)
        ]
        consumer = threading.Thread(
            target=consume_until, args=(expected_total,), daemon=True,
        )
        consumer.start()
        for t in producers:
            t.start()
        for t in producers:
            t.join(timeout=5.0)
        consumer.join(timeout=5.0)

        self.assertEqual(
            len(received), expected_total,
            f"lost payloads: expected {expected_total}, got {len(received)}",
        )

    def test_many_producers_many_consumers_same_key(self) -> None:
        """Two consumers must never pop the same key concurrently.

        This is the invariant that the _processing set guarantees:
        even if both workers race on get(), they see different keys.
        """
        q = WorkQueue()
        key_count = 50
        for i in range(key_count):
            q.add(f"key-{i}", i)

        concurrent_holders: set = set()
        lock = threading.Lock()
        seen_keys: list = []
        max_concurrent = [0]

        def worker():
            while True:
                item = q.get(timeout=0.5)
                if item is None:
                    return
                key, _ = item
                with lock:
                    if key in concurrent_holders:
                        self.fail(
                            f"two workers popped {key!r} at the same time",
                        )
                    concurrent_holders.add(key)
                    max_concurrent[0] = max(
                        max_concurrent[0], len(concurrent_holders),
                    )
                # Simulate work.
                time.sleep(0.001)
                with lock:
                    concurrent_holders.discard(key)
                    seen_keys.append(key)
                q.done(key)

        threads = [
            threading.Thread(target=worker, daemon=True) for _ in range(4)
        ]
        for t in threads:
            t.start()
        # Wait for all keys to be processed, then shut down.
        deadline = time.monotonic() + 5.0
        while len(seen_keys) < key_count and time.monotonic() < deadline:
            time.sleep(0.01)
        q.shutdown()
        for t in threads:
            t.join(timeout=1.0)

        self.assertEqual(
            len(seen_keys), key_count,
            "not all keys were processed",
        )
        self.assertGreaterEqual(
            max_concurrent[0], 2,
            "test didn't actually achieve concurrency",
        )


# ── Observability ─────────────────────────────────────────────────


class StatsTests(unittest.TestCase):
    def test_stats_reflect_queue_state(self) -> None:
        q = WorkQueue()
        self.assertEqual(q.stats()["queue_len"], 0)
        q.add("a", 1)
        q.add("b", 2)
        self.assertEqual(q.stats()["queue_len"], 2)
        q.get(timeout=0.1)
        stats = q.stats()
        self.assertEqual(stats["queue_len"], 1)
        self.assertEqual(stats["processing"], 1)
        self.assertEqual(stats["total_adds"], 2)
        self.assertEqual(stats["total_gets"], 1)
        self.assertEqual(stats["total_dones"], 0)

    def test_stats_show_pending_during_dirty(self) -> None:
        q = WorkQueue()
        q.add("k", 1)
        q.get(timeout=0.1)
        q.add("k", 2)  # dirty — accumulated during processing
        stats = q.stats()
        # Queue still empty (key is processing), but pending_keys = 1.
        self.assertEqual(stats["queue_len"], 0)
        self.assertEqual(stats["processing"], 1)
        self.assertEqual(stats["pending_keys"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
