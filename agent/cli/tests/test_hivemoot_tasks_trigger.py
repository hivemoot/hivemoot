"""Tests for the hivemoot.tasks polling trigger.

Coverage:
  * start() dispatches a Job when a task is claimed.
  * start() handles the no-task (204) path without dispatching.
  * start() backs off on transient claim errors.
  * start() goes idle when tasks are disabled or claim_url empty.

Plugin lifecycle hooks (on_job_started / on_job_finished) and their
heartbeat / outcome semantics are covered in test_hivemoot_plugin.py.
Trigger config validation is centralized on the parent plugin so
this file no longer drives HivemootTaskTrigger.validate().
"""

from __future__ import annotations

import io
import os
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins.interfaces import Job, PluginConfig
from hivemoot_agent.plugins_builtin.hivemoot.config import (
    HivemootConfig,
    HivemootTasksConfig,
)
from hivemoot_agent.plugins_builtin.hivemoot.tasks import api as task_api
from hivemoot_agent.plugins_builtin.hivemoot.tasks.trigger import (
    HivemootTaskTrigger,
)


_DEFAULT_TOKEN_FILE = Path("/tmp/.hivemoot-test-token")


def _ensure_token_file() -> Path:
    if not _DEFAULT_TOKEN_FILE.exists():
        _DEFAULT_TOKEN_FILE.write_text("tok")
    return _DEFAULT_TOKEN_FILE


def _mk_config(
    *,
    enabled: bool = True,
    claim_url: str = "https://api.example/api/tasks/claim",
    execute_base_url: str = "https://api.example/api/tasks",
    token_file: Path | None = None,
    poll_interval_secs: int = 1,
    heartbeat_interval_secs: int = 45,
    settings: dict | None = None,
) -> PluginConfig:
    tasks = HivemootTasksConfig(
        enabled=enabled,
        claim_url=claim_url,
        execute_base_url=execute_base_url,
        poll_interval_secs=poll_interval_secs,
        heartbeat_interval_secs=heartbeat_interval_secs,
    )
    typed = HivemootConfig(
        token_file=token_file if token_file is not None else _ensure_token_file(),
        tasks=tasks,
    )
    return PluginConfig(
        name="hivemoot",
        settings=settings or {},
        typed=typed,
    )


class TriggerDispatchTests(unittest.TestCase):
    def test_dispatches_job_on_claim(self) -> None:
        trig = HivemootTaskTrigger(MagicMock())
        dispatcher = MagicMock()
        dispatcher.dispatch.return_value = True

        claimed = task_api.ClaimedTask(
            task_id="t-1",
            prompt="do x",
            repo="o/r",
            claim_token="ctok",
            messages=[{"role": "user", "content": "hi"}],
            repos=["o/r"],
        )

        calls = {"n": 0}

        def fake_claim(url, bearer, timeout=10):
            calls["n"] += 1
            if calls["n"] == 1:
                return claimed
            trig.stop()
            return None

        with patch.object(task_api, "claim_next_task", fake_claim):
            trig.start(_mk_config(), dispatcher)

        dispatcher.dispatch.assert_called_once()
        job = dispatcher.dispatch.call_args[0][0]
        self.assertIsInstance(job, Job)
        self.assertEqual(job.session_key, "task:t-1")
        self.assertIn("do x", job.prompt)
        self.assertIn("t-1", job.prompt)
        self.assertIn("Conversation Context", job.prompt)
        self.assertEqual(job.metadata["task_id"], "t-1")
        self.assertEqual(job.metadata["claim_token"], "ctok")
        self.assertEqual(job.metadata["repo"], "o/r")
        self.assertEqual(job.metadata["repos"], ["o/r"])

    def test_dispatches_repo_less_task(self) -> None:
        trig = HivemootTaskTrigger(MagicMock())
        dispatcher = MagicMock()
        dispatcher.dispatch.return_value = True

        claimed = task_api.ClaimedTask(
            task_id="generic-1",
            prompt="draft an RFC",
            repo="",
            claim_token="ctok",
            messages=[],
            repos=[],
        )

        calls = {"n": 0}

        def fake_claim(url, bearer, timeout=10):
            calls["n"] += 1
            if calls["n"] == 1:
                return claimed
            trig.stop()
            return None

        with patch.object(task_api, "claim_next_task", fake_claim):
            trig.start(_mk_config(), dispatcher)

        dispatcher.dispatch.assert_called_once()
        job = dispatcher.dispatch.call_args[0][0]
        self.assertEqual(job.session_key, "task:generic-1")
        self.assertEqual(job.metadata["repo"], "")
        self.assertEqual(job.metadata["repos"], [])

    def test_no_task_loops_then_stops(self) -> None:
        trig = HivemootTaskTrigger(MagicMock())
        dispatcher = MagicMock()

        polls = {"n": 0}

        def fake_claim(url, bearer, timeout=10):
            polls["n"] += 1
            if polls["n"] >= 3:
                trig.stop()
            return None

        with patch.object(task_api, "claim_next_task", fake_claim):
            trig.start(_mk_config(), dispatcher)

        self.assertGreaterEqual(polls["n"], 3)
        dispatcher.dispatch.assert_not_called()

    def test_claim_error_backs_off_and_retries(self) -> None:
        trig = HivemootTaskTrigger(MagicMock())
        dispatcher = MagicMock()

        polls = {"n": 0}

        def fake_claim(url, bearer, timeout=10):
            polls["n"] += 1
            if polls["n"] == 1:
                raise RuntimeError("backend down")
            trig.stop()
            return None

        with patch.object(task_api, "claim_next_task", fake_claim), \
                patch("sys.stderr", io.StringIO()):
            trig.start(_mk_config(), dispatcher)

        self.assertGreaterEqual(polls["n"], 2)
        dispatcher.dispatch.assert_not_called()

    def test_idle_when_tasks_disabled(self) -> None:
        """Regression: the trigger runs inside a list returned by
        Plugin.triggers(); with tasks.enabled=False it shouldn't be
        registered at all, but if something drives start() directly
        the loop must bail out rather than poll."""
        trig = HivemootTaskTrigger(MagicMock())
        dispatcher = MagicMock()

        with patch.object(task_api, "claim_next_task") as claim_mock, \
                patch("sys.stderr", io.StringIO()):
            trig.start(
                _mk_config(enabled=False, claim_url="https://api/x"),
                dispatcher,
            )

        claim_mock.assert_not_called()
        dispatcher.dispatch.assert_not_called()

    def test_idle_when_claim_url_missing(self) -> None:
        trig = HivemootTaskTrigger(MagicMock())
        dispatcher = MagicMock()

        with patch.object(task_api, "claim_next_task") as claim_mock, \
                patch("sys.stderr", io.StringIO()):
            trig.start(_mk_config(claim_url=""), dispatcher)

        claim_mock.assert_not_called()
        dispatcher.dispatch.assert_not_called()


class InFlightGateIntegrationTests(unittest.TestCase):
    """Async-dispatcher regression: the trigger MUST wait on the
    plugin's in-flight gate before claiming a new task, and MUST
    reserve the slot around dispatch so on_job_finished is the
    sole release path (with dispatch-failed releasing manually)."""

    def test_waits_for_slot_then_reserves_before_dispatch(self) -> None:
        plugin = MagicMock()
        plugin.wait_task_slot.return_value = True

        trig = HivemootTaskTrigger(plugin)
        dispatcher = MagicMock()
        dispatcher.dispatch.return_value = True

        claimed = task_api.ClaimedTask(
            task_id="t-1", prompt="p", repo="o/r",
            claim_token="c", messages=[], repos=[],
        )

        calls = {"n": 0}

        def fake_claim(url, bearer, timeout=10):
            calls["n"] += 1
            if calls["n"] == 1:
                return claimed
            trig.stop()
            return None

        with patch.object(task_api, "claim_next_task", fake_claim):
            trig.start(_mk_config(), dispatcher)

        # Gate acquired before dispatch.
        plugin.wait_task_slot.assert_called()
        plugin.reserve_task_slot.assert_called_once()
        dispatcher.dispatch.assert_called_once()
        # Successful dispatch path does NOT release — on_job_finished does.
        plugin.release_task_slot.assert_not_called()

    def test_dispatch_failed_releases_slot_manually(self) -> None:
        """The engine never calls on_job_finished for a
        dispatch-failed job, so the trigger must release the slot
        itself to avoid the claim loop deadlocking."""
        plugin = MagicMock()
        plugin.wait_task_slot.return_value = True

        trig = HivemootTaskTrigger(plugin)
        dispatcher = MagicMock()
        dispatcher.dispatch.return_value = False

        claimed = task_api.ClaimedTask(
            task_id="t-1", prompt="p", repo="o/r",
            claim_token="c", messages=[], repos=[],
        )

        calls = {"n": 0}

        def fake_claim(url, bearer, timeout=10):
            calls["n"] += 1
            if calls["n"] >= 2:
                trig.stop()
            return claimed if calls["n"] == 1 else None

        with patch.object(task_api, "claim_next_task", fake_claim), \
                patch("sys.stderr", io.StringIO()):
            trig.start(_mk_config(), dispatcher)

        plugin.reserve_task_slot.assert_called_once()
        plugin.release_task_slot.assert_called_once()

    def test_does_not_claim_while_inflight(self) -> None:
        """Regression: wait_task_slot blocks the claim loop when
        the plugin has reserved the slot, so no backend claim can
        happen while a previous task is in-flight through the
        async workqueue."""
        plugin = MagicMock()
        plugin.wait_task_slot.return_value = False  # always busy

        trig = HivemootTaskTrigger(plugin)
        dispatcher = MagicMock()

        # Background-stop so the trigger doesn't block forever.
        def stopper():
            time.sleep(0.3)
            trig.stop()

        threading.Thread(target=stopper, daemon=True).start()

        with patch.object(task_api, "claim_next_task") as claim_mock, \
                patch("sys.stderr", io.StringIO()):
            trig.start(_mk_config(), dispatcher)

        # Gate never opened → never reached claim.
        claim_mock.assert_not_called()
        dispatcher.dispatch.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
