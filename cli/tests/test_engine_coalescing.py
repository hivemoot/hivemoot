"""Integration tests for event coalescing via the engine workqueue.

These exercise the glue between ``_PluginDispatcher.dispatch`` →
``Engine.enqueue`` → ``Engine._drain_workqueue`` →
``Engine._process_coalesced_payloads`` → ``plugin.on_job_finished``
(with merged ``acks`` list).  Each test drives the queue directly
(no trigger threads, no real agent subprocess) so the failure modes
stay visible and the tests are fast.
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.engine import Engine, _PluginDispatcher
from hivemoot_agent.plugins.interfaces import (
    AgentResult,
    Job,
    PluginConfig,
)


class _RecordingPlugin:
    """Plugin stub that records every on_job_finished payload.

    Mirrors the github plugin's acks[] contract so tests can assert on
    the list of acks processed per coalesced run.
    """

    name = "recording"
    version = "0.0.0"
    description = "test"

    def __init__(self) -> None:
        self.started: list[Job] = []
        self.finished: list[tuple[Job, AgentResult]] = []
        self.acks_seen: list[list[dict]] = []

    def on_job_started(self, job: Job, config: PluginConfig) -> None:
        self.started.append(job)

    def on_agent_output(self, job, event, config) -> None:  # pragma: no cover
        pass

    def on_job_finished(
        self, job: Job, result: AgentResult, config: PluginConfig,
    ) -> None:
        self.finished.append((job, result))
        if result.exit_code != 0:
            self.acks_seen.append([])
            return
        watch_meta = (job.metadata or {}).get("github_watch") or {}
        acks = watch_meta.get("acks")
        if isinstance(acks, list) and acks:
            self.acks_seen.append(list(acks))
        else:
            # Legacy single-ack path — synthesize a list of one for
            # parity with the coalesced assertions.
            self.acks_seen.append([{
                "trigger": watch_meta.get("trigger", ""),
                "ack_strategy": watch_meta.get("ack_strategy", "notification"),
                "ack_key": watch_meta.get("ack_key", ""),
                "state_file": watch_meta.get("state_file", ""),
            }])


def _make_engine(tmp: str) -> Engine:
    eng = Engine()
    eng._session_store = None
    os.environ["AGENT_MEMORY_DIR"] = os.path.join(tmp, "memory")
    return eng


def _make_job(coalesce_key: str, ack_key: str, trigger: str = "t") -> Job:
    return Job(
        session_key=f"sess:{coalesce_key}",
        prompt=f"do work for {coalesce_key}",
        metadata={
            "coalesce_key": coalesce_key,
            "github_watch": {
                "trigger": trigger,
                "ack_strategy": "notification",
                "ack_key": ack_key,
                "state_file": f"/tmp/state-{trigger}.json",
                "number": coalesce_key,
            },
        },
    )


def _config(tmp: str) -> PluginConfig:
    return PluginConfig(
        name="recording",
        settings={
            "WORKSPACE_ROOT": tmp,
            "AGENT_PROVIDER": "claude",
            "GITHUB_REPOS": "o/r",
            "AGENT_MEMORY_DIR": os.path.join(tmp, "memory"),
        },
    )


def _patch_run_agent_noop(engine: Engine):
    """Patch the engine so run_agent succeeds without touching subprocess.

    Returns a context-manager-like that yields the patched engine.
    """
    return patch.multiple(
        engine,
        _build_provider_cmd=MagicMock(return_value=["true"]),
        _run_subprocess=MagicMock(return_value=(0, "")),
        _resolve_skill_runtime=MagicMock(
            return_value=MagicMock(
                plugin_dir="", scope_json="", prompt_skills="",
            ),
        ),
        _cleanup_skill_runtime=MagicMock(),
        _build_mcp_config=MagicMock(return_value=""),
        _init_session_store=MagicMock(),
    )


# ── Worker drains single event ────────────────────────────────────


class SingleEnqueueTest(unittest.TestCase):
    """One enqueued job → one on_job_finished with a single-ack list."""

    def test_single_event_runs_once_with_one_ack(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            engine = _make_engine(tmp)
            plugin = _RecordingPlugin()
            config = _config(tmp)
            job = _make_job("k:1", "ack-1")

            # Start worker thread (same machinery Engine.run uses).
            worker = threading.Thread(
                target=engine._drain_workqueue, daemon=True,
            )
            with _patch_run_agent_noop(engine):
                worker.start()
                engine.enqueue("k:1", plugin, job, config, "recording")
                # Drain + shutdown.
                deadline = time.monotonic() + 2.0
                while not plugin.finished and time.monotonic() < deadline:
                    time.sleep(0.01)
                engine._running = False
                engine._workqueue.shutdown()
                worker.join(timeout=2.0)

            self.assertEqual(len(plugin.finished), 1)
            self.assertEqual(len(plugin.acks_seen), 1)
            self.assertEqual(len(plugin.acks_seen[0]), 1)
            self.assertEqual(plugin.acks_seen[0][0]["ack_key"], "ack-1")


# ── Two events, same key → one run, two acks ──────────────────────


class CoalescedAcksTest(unittest.TestCase):
    """Two events for one key coalesce: one run, ack list has both."""

    def test_two_events_same_key_one_run_two_acks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            engine = _make_engine(tmp)
            plugin = _RecordingPlugin()
            config = _config(tmp)

            # Pause the worker inside run_agent so both enqueues happen
            # before the worker pops — that's the scenario where the
            # queue actually has two payloads under one key.
            start = threading.Event()
            proceed = threading.Event()

            def fake_run_subprocess(*args, **kwargs):
                start.set()
                proceed.wait(timeout=5.0)
                return (0, "")

            worker = threading.Thread(
                target=engine._drain_workqueue, daemon=True,
            )
            with _patch_run_agent_noop(engine):
                engine._run_subprocess = MagicMock(
                    side_effect=fake_run_subprocess,
                )
                worker.start()
                # First enqueue — worker picks it up and blocks.
                engine.enqueue(
                    "k:42", plugin, _make_job("k:42", "ack-a", "mention"),
                    config, "recording",
                )
                self.assertTrue(
                    start.wait(timeout=1.0),
                    "worker did not start processing the first event",
                )
                # Second enqueue — worker is busy; this accumulates
                # as a "dirty" payload.
                engine.enqueue(
                    "k:42", plugin,
                    _make_job("k:42", "ack-b", "review-request"),
                    config, "recording",
                )
                # Let the first run complete.  The worker will then
                # see the dirty payload and run a second time.
                proceed.set()
                deadline = time.monotonic() + 3.0
                while len(plugin.finished) < 2 and time.monotonic() < deadline:
                    time.sleep(0.01)
                engine._running = False
                engine._workqueue.shutdown()
                worker.join(timeout=2.0)

            # Two runs: first had ack-a only (single event), second
            # had ack-b only (dirty event).  The design coalesces
            # dirty events into one extra run; each run carries just
            # its own payloads.
            self.assertEqual(
                len(plugin.finished), 2,
                f"expected 2 runs (one + dirty re-run), got {len(plugin.finished)}",
            )
            # The acks for both source events must have been delivered.
            all_ack_keys = [
                a["ack_key"]
                for ack_list in plugin.acks_seen
                for a in ack_list
            ]
            self.assertEqual(sorted(all_ack_keys), ["ack-a", "ack-b"])

    def test_two_events_same_key_before_worker_one_run_with_both_acks(
        self,
    ) -> None:
        """When two events land before the worker pops, ONE run handles both."""
        with tempfile.TemporaryDirectory() as tmp:
            engine = _make_engine(tmp)
            plugin = _RecordingPlugin()
            config = _config(tmp)

            worker = threading.Thread(
                target=engine._drain_workqueue, daemon=True,
            )
            with _patch_run_agent_noop(engine):
                # Enqueue both BEFORE starting the worker — they sit in
                # the same key's payload list.
                engine.enqueue(
                    "k:42", plugin,
                    _make_job("k:42", "ack-a", "mention"),
                    config, "recording",
                )
                engine.enqueue(
                    "k:42", plugin,
                    _make_job("k:42", "ack-b", "review-request"),
                    config, "recording",
                )
                worker.start()
                deadline = time.monotonic() + 2.0
                while not plugin.finished and time.monotonic() < deadline:
                    time.sleep(0.01)
                engine._running = False
                engine._workqueue.shutdown()
                worker.join(timeout=2.0)

            self.assertEqual(
                len(plugin.finished), 1,
                "two events enqueued before the worker popped should "
                "coalesce into ONE run",
            )
            # That one run's ack list has BOTH events' acks.
            self.assertEqual(len(plugin.acks_seen), 1)
            acks = plugin.acks_seen[0]
            self.assertEqual(
                sorted(a["ack_key"] for a in acks),
                ["ack-a", "ack-b"],
            )
            # Latest-wins: the job's own (non-acks[]) fields reflect
            # the latest event (ack-b → review-request trigger).
            last_job = plugin.finished[-1][0]
            self.assertEqual(
                last_job.prompt, "do work for k:42",  # both jobs same prompt
            )
            self.assertIn(
                "review-request",
                (last_job.metadata or {}).get("github_watch", {}).get("trigger", ""),
            )


# ── Different keys run serially, no coalescing ────────────────────


class DifferentKeysRunSeparately(unittest.TestCase):
    def test_two_different_keys_run_serially_no_coalesce(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            engine = _make_engine(tmp)
            plugin = _RecordingPlugin()
            config = _config(tmp)

            worker = threading.Thread(
                target=engine._drain_workqueue, daemon=True,
            )
            with _patch_run_agent_noop(engine):
                engine.enqueue(
                    "k:1", plugin, _make_job("k:1", "ack-1"),
                    config, "recording",
                )
                engine.enqueue(
                    "k:2", plugin, _make_job("k:2", "ack-2"),
                    config, "recording",
                )
                worker.start()
                deadline = time.monotonic() + 2.0
                while len(plugin.finished) < 2 and time.monotonic() < deadline:
                    time.sleep(0.01)
                engine._running = False
                engine._workqueue.shutdown()
                worker.join(timeout=2.0)

            self.assertEqual(len(plugin.finished), 2)
            self.assertEqual(len(plugin.acks_seen), 2)
            self.assertEqual(
                [a[0]["ack_key"] for a in plugin.acks_seen],
                ["ack-1", "ack-2"],
            )


# ── Failure path: no acks fire ────────────────────────────────────


class FailureSkipsAcksTest(unittest.TestCase):
    def test_agent_failure_skips_all_acks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            engine = _make_engine(tmp)
            plugin = _RecordingPlugin()
            config = _config(tmp)

            worker = threading.Thread(
                target=engine._drain_workqueue, daemon=True,
            )
            with _patch_run_agent_noop(engine):
                engine._run_subprocess = MagicMock(return_value=(1, ""))
                engine.enqueue(
                    "k:1", plugin, _make_job("k:1", "ack-1"),
                    config, "recording",
                )
                engine.enqueue(
                    "k:1", plugin, _make_job("k:1", "ack-2"),
                    config, "recording",
                )
                worker.start()
                deadline = time.monotonic() + 2.0
                while not plugin.finished and time.monotonic() < deadline:
                    time.sleep(0.01)
                engine._running = False
                engine._workqueue.shutdown()
                worker.join(timeout=2.0)

            # One run that failed → no acks recorded.  Events will
            # replay via trigger polling on the next cycle.
            self.assertEqual(len(plugin.finished), 1)
            self.assertEqual(plugin.finished[0][1].exit_code, 1)
            self.assertEqual(plugin.acks_seen, [[]])


# ── Dispatcher routes through the queue ───────────────────────────


class DispatcherUsesQueueTest(unittest.TestCase):
    def test_dispatch_enqueues_via_coalesce_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            engine = _make_engine(tmp)
            plugin = _RecordingPlugin()
            config = _config(tmp)
            dispatcher = _PluginDispatcher(engine, plugin, config, "recording")

            job = _make_job("custom:42", "ack-1")
            self.assertTrue(dispatcher.dispatch(job))
            stats = engine._workqueue.stats()
            self.assertEqual(stats["queue_len"], 1)
            self.assertEqual(stats["total_adds"], 1)

    def test_dispatch_without_coalesce_key_uses_unique_keys(self) -> None:
        """No coalesce_key in metadata ⇒ every dispatch is its own run.

        Regression test for the blocker guard flagged: earlier code
        fell back to session_key as the coalesce key, which silently
        dropped earlier messaging payloads on the dirty re-enqueue
        (latest-wins).  The correct behavior is opt-in coalescing:
        without an explicit coalesce_key the dispatcher must generate
        a unique key per event so nothing collapses.
        """
        with tempfile.TemporaryDirectory() as tmp:
            engine = _make_engine(tmp)
            plugin = _RecordingPlugin()
            config = _config(tmp)
            dispatcher = _PluginDispatcher(engine, plugin, config, "recording")

            # Two messaging-style jobs, same session_key, no coalesce_key.
            self.assertTrue(dispatcher.dispatch(
                Job(session_key="tg:12345", prompt="first"),
            ))
            self.assertTrue(dispatcher.dispatch(
                Job(session_key="tg:12345", prompt="second"),
            ))
            stats = engine._workqueue.stats()
            # Each dispatch got its own queue entry — two separate runs.
            self.assertEqual(stats["queue_len"], 2)
            self.assertEqual(stats["total_adds"], 2)

    def test_dispatch_namespaces_coalesce_key_by_plugin(self) -> None:
        """Dispatcher prefixes coalesce_key with plugin_name.

        Prevents cross-plugin collisions: two plugins that happen to
        pick the same raw coalesce_key can never merge payloads into
        one run (which would call on_job_finished on the wrong plugin).
        """
        with tempfile.TemporaryDirectory() as tmp:
            engine = _make_engine(tmp)
            plugin_a = _RecordingPlugin()
            plugin_b = _RecordingPlugin()
            config = _config(tmp)

            d_a = _PluginDispatcher(engine, plugin_a, config, "plugin-a")
            d_b = _PluginDispatcher(engine, plugin_b, config, "plugin-b")

            # Both plugins pick the same raw key "shared:42".
            shared = Job(
                session_key="s", prompt="p",
                metadata={"coalesce_key": "shared:42"},
            )
            self.assertTrue(d_a.dispatch(shared))
            self.assertTrue(d_b.dispatch(shared))
            stats = engine._workqueue.stats()
            # Namespaced by plugin_name ⇒ two separate keys, two runs.
            self.assertEqual(stats["queue_len"], 2)

    def test_no_payload_loss_across_many_no_coalesce_dispatches(self) -> None:
        """Enqueue N messaging-shaped jobs, assert N distinct runs.

        Belt-and-braces regression test for the blocker: even under
        heavy burst + worker holding the first key while later ones
        arrive, every dispatched prompt MUST land in exactly one
        agent run.
        """
        with tempfile.TemporaryDirectory() as tmp:
            engine = _make_engine(tmp)
            plugin = _RecordingPlugin()
            config = _config(tmp)
            dispatcher = _PluginDispatcher(
                engine, plugin, config, "recording",
            )

            worker = threading.Thread(
                target=engine._drain_workqueue, daemon=True,
            )
            n = 10
            with _patch_run_agent_noop(engine):
                # Enqueue N messaging-shaped jobs (no coalesce_key,
                # same session_key) BEFORE starting the worker so
                # they'd all pile up under the same key if coalescing
                # was incorrectly enabled.
                prompts = [f"message-{i}" for i in range(n)]
                for p in prompts:
                    self.assertTrue(dispatcher.dispatch(
                        Job(session_key="tg:12345", prompt=p),
                    ))
                worker.start()
                deadline = time.monotonic() + 3.0
                while (
                    len(plugin.finished) < n
                    and time.monotonic() < deadline
                ):
                    time.sleep(0.01)
                engine._running = False
                engine._workqueue.shutdown()
                worker.join(timeout=2.0)

            # Every prompt must surface in exactly one agent run —
            # zero loss, regardless of worker scheduling.
            self.assertEqual(
                len(plugin.finished), n,
                f"payload loss: expected {n} runs, got {len(plugin.finished)}",
            )
            seen_prompts = sorted(j.prompt for j, _ in plugin.finished)
            self.assertEqual(seen_prompts, sorted(prompts))


# ── Shutdown behavior ─────────────────────────────────────────────


class ShutdownDispatchTest(unittest.TestCase):
    def test_dispatch_after_shutdown_returns_false(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            engine = _make_engine(tmp)
            plugin = _RecordingPlugin()
            config = _config(tmp)
            dispatcher = _PluginDispatcher(engine, plugin, config, "recording")

            engine._workqueue.shutdown()
            job = _make_job("k:1", "ack-1")
            self.assertFalse(dispatcher.dispatch(job))


if __name__ == "__main__":
    unittest.main(verbosity=2)
