"""Tests for HivemootTaskTrigger and HivemootTaskPlugin lifecycle hooks.

Coverage:
  * Trigger validate / start / dispatch flow.
  * Plugin on_job_started spawns a heartbeat thread + initial progress.
  * Plugin on_job_finished posts complete / fail / timeout, promotes
    silent codex auth failures to fail.
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pathlib import Path

from hivemoot_agent.plugins.interfaces import AgentResult, Job, PluginConfig
from hivemoot_agent.plugins_builtin.hivemoot_task import api as task_api
from hivemoot_agent.plugins_builtin.hivemoot_task import HivemootTaskPlugin
from hivemoot_agent.plugins_builtin.hivemoot_task.config import (
    HivemootTaskConfig,
)
from hivemoot_agent.plugins_builtin.hivemoot_task.trigger import (
    HivemootTaskTrigger,
)


_DEFAULT_TOKEN_FILE = Path("/tmp/.hivemoot-test-token")


def _ensure_token_file() -> Path:
    """Stage a tiny token file for tests that need .token_file populated."""
    if not _DEFAULT_TOKEN_FILE.exists():
        _DEFAULT_TOKEN_FILE.write_text("tok")
    return _DEFAULT_TOKEN_FILE


def _mk_task_config(
    *,
    claim_url: str = "https://api.example/api/tasks/claim",
    execute_base_url: str = "https://api.example/api/tasks",
    token_file: Path | None = None,
    heartbeat_interval_secs: int = 45,
    poll_interval_secs: int = 1,
    workspace: str = "/workspace",
    settings: dict | None = None,
) -> PluginConfig:
    """Build a PluginConfig with a typed HivemootTaskConfig populated."""
    typed = HivemootTaskConfig(
        claim_url=claim_url,
        execute_base_url=execute_base_url,
        token_file=token_file if token_file is not None else _ensure_token_file(),
        heartbeat_interval_secs=heartbeat_interval_secs,
        poll_interval_secs=poll_interval_secs,
        workspace=Path(workspace),
    )
    return PluginConfig(
        name="hivemoot-task",
        settings=settings or {},
        typed=typed,
    )


# ── Trigger ────────────────────────────────────────────────────────


class TriggerValidationTests(unittest.TestCase):
    def test_missing_claim_url_rejected(self) -> None:
        trig = HivemootTaskTrigger(MagicMock())
        config = _mk_task_config(claim_url="")
        errors = trig.validate(config)
        self.assertTrue(any("claim_url" in e for e in errors))

    def test_missing_execute_base_rejected(self) -> None:
        trig = HivemootTaskTrigger(MagicMock())
        config = _mk_task_config(execute_base_url="")
        errors = trig.validate(config)
        self.assertTrue(any("execute_base_url" in e for e in errors))

    def test_missing_token_rejected(self) -> None:
        trig = HivemootTaskTrigger(MagicMock())
        config = _mk_task_config(token_file=None)
        # When token_file=None is explicitly passed, _mk_task_config passes
        # a default file — we want the None path here, override directly:
        from hivemoot_agent.plugins_builtin.hivemoot_task.config import (
            HivemootTaskConfig,
        )
        typed = HivemootTaskConfig(
            claim_url="https://api.example/api/tasks/claim",
            execute_base_url="https://api.example/api/tasks",
            token_file=None,
        )
        config = PluginConfig(name="hivemoot-task", settings={}, typed=typed)
        errors = trig.validate(config)
        self.assertTrue(any("token_file" in e for e in errors))

    def test_complete_config_passes(self) -> None:
        trig = HivemootTaskTrigger(MagicMock())
        config = _mk_task_config()
        self.assertEqual(trig.validate(config), [])


class TriggerDispatchTests(unittest.TestCase):
    def _config(self, **overrides) -> PluginConfig:
        # Default to poll_interval_secs=1 (schema floor) so tests don't sleep
        # meaningfully; override poll_interval_secs in callers if needed.
        return _mk_task_config(poll_interval_secs=1, **overrides)

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

        # First call returns the task, second call returns None which
        # we then pivot into stop().
        calls = {"n": 0}

        def fake_claim(url, bearer, timeout=10):
            calls["n"] += 1
            if calls["n"] == 1:
                return claimed
            trig.stop()
            return None

        with patch.object(task_api, "claim_next_task", fake_claim):
            trig.start(self._config(), dispatcher)

        dispatcher.dispatch.assert_called_once()
        job = dispatcher.dispatch.call_args[0][0]
        self.assertIsInstance(job, Job)
        self.assertEqual(job.session_key, "task:t-1")
        # The trigger renders the per-task template + conversation
        # history into Job.prompt; the raw claim prompt appears inside.
        self.assertIn("do x", job.prompt)
        self.assertIn("t-1", job.prompt)
        # Conversation history (passed in claim) should be appended.
        self.assertIn("Conversation Context", job.prompt)
        self.assertIn("hi", job.prompt)
        self.assertEqual(job.metadata["task_id"], "t-1")
        self.assertEqual(job.metadata["claim_token"], "ctok")
        self.assertEqual(job.metadata["repo"], "o/r")
        self.assertEqual(job.metadata["repos"], ["o/r"])

    def test_dispatches_repo_less_task(self) -> None:
        """Regression: a task with no repos must dispatch successfully.
        Job.metadata carries ``repo=""`` and ``repos=[]`` as
        informational; no plugin-level enforcement."""
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
            trig.start(self._config(), dispatcher)

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
            trig.start(self._config(), dispatcher)

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
            trig.start(self._config(), dispatcher)

        self.assertGreaterEqual(polls["n"], 2)
        dispatcher.dispatch.assert_not_called()

    def test_idle_when_claim_url_missing(self) -> None:
        trig = HivemootTaskTrigger(MagicMock())
        dispatcher = MagicMock()
        config = PluginConfig(name="hivemoot-task", settings={})

        with patch.object(task_api, "claim_next_task") as claim_mock, \
                patch("sys.stderr", io.StringIO()):
            trig.start(config, dispatcher)

        claim_mock.assert_not_called()
        dispatcher.dispatch.assert_not_called()


# ── Plugin lifecycle ──────────────────────────────────────────────


class PluginLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.workspace = self.tmp.name
        self.config = _mk_task_config(
            heartbeat_interval_secs=1,
            workspace=self.workspace,
            settings={"AGENT_PROVIDER": "claude"},
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _job(self) -> Job:
        return Job(
            session_key="task:t-9",
            prompt="run me",
            metadata={
                "task_id": "t-9",
                "claim_token": "ctok",
                "repo": "o/r",
            },
        )

    def test_on_job_started_posts_progress_and_starts_heartbeat(self) -> None:
        plugin = HivemootTaskPlugin()
        with patch.object(task_api, "post_progress") as progress_mock, \
                patch.object(task_api, "post_heartbeat") as heartbeat_mock:
            plugin.on_job_started(self._job(), self.config)
            # Heartbeat thread should fire at least once before we stop.
            time.sleep(1.5)
            plugin._heartbeat_stop.set()
            if plugin._heartbeat_thread:
                plugin._heartbeat_thread.join(timeout=2)

        progress_mock.assert_called_once()
        # First positional args: (execute_base, task_id, bearer, claim_token, msg)
        args, _kw = progress_mock.call_args
        self.assertEqual(args[1], "t-9")
        self.assertGreaterEqual(heartbeat_mock.call_count, 1)

    def test_on_job_started_noop_without_backend(self) -> None:
        plugin = HivemootTaskPlugin()
        # No execute_base_url → no backend → no progress post.
        bare_config = _mk_task_config(
            execute_base_url="",
            workspace=self.workspace,
            settings={"AGENT_PROVIDER": "claude"},
        )
        with patch.object(task_api, "post_progress") as progress_mock:
            plugin.on_job_started(self._job(), bare_config)
        progress_mock.assert_not_called()
        self.assertIsNone(plugin._heartbeat_thread)

    def test_on_job_finished_posts_complete_with_extracted_markdown(self) -> None:
        plugin = HivemootTaskPlugin()
        # Pre-populate heartbeat state so on_job_finished joins cleanly.
        plugin._heartbeat_thread = threading.Thread(
            target=lambda: time.sleep(0.05), daemon=True,
        )
        plugin._heartbeat_thread.start()

        # Provide a fake provider log so result extraction yields text.
        log_dir = os.path.join(self.workspace, "runs", "current")
        os.makedirs(log_dir, exist_ok=True)
        log_path = os.path.join(log_dir, "log")
        with open(log_path, "w") as f:
            f.write(json.dumps({"type": "result", "result": "## Done"}) + "\n")

        with patch.object(task_api, "post_complete") as complete_mock, \
                patch.object(task_api, "post_fail") as fail_mock:
            plugin.on_job_finished(
                self._job(),
                AgentResult(exit_code=0, response=""),
                self.config,
            )

        complete_mock.assert_called_once()
        fail_mock.assert_not_called()
        # Extracted markdown is the 5th positional arg.
        self.assertEqual(complete_mock.call_args[0][4], "## Done")

    def test_on_job_finished_promotes_codex_auth_error(self) -> None:
        plugin = HivemootTaskPlugin()
        codex_config = _mk_task_config(
            heartbeat_interval_secs=1,
            workspace=self.workspace,
            settings={"AGENT_PROVIDER": "codex"},
        )

        # Codex log shows an explicit auth error AND no agent message
        # (so result extraction returns "").
        log_dir = os.path.join(self.workspace, "runs", "current")
        os.makedirs(log_dir, exist_ok=True)
        log_path = os.path.join(log_dir, "log")
        with open(log_path, "w") as f:
            f.write(json.dumps({
                "type": "error", "code": "refresh_token_reused",
            }) + "\n")

        with patch.object(task_api, "post_fail") as fail_mock, \
                patch.object(task_api, "post_complete") as complete_mock, \
                patch("sys.stderr", io.StringIO()):
            plugin.on_job_finished(
                self._job(),
                AgentResult(exit_code=0, response=""),
                codex_config,
            )

        fail_mock.assert_called_once()
        complete_mock.assert_not_called()
        # Error string mentions the auth code so the operator can act.
        self.assertIn("refresh_token_reused", fail_mock.call_args[0][4])

    def test_on_job_finished_posts_timeout_for_124(self) -> None:
        plugin = HivemootTaskPlugin()
        with patch.object(task_api, "post_timeout") as timeout_mock, \
                patch.object(task_api, "post_complete") as complete_mock:
            plugin.on_job_finished(
                self._job(),
                AgentResult(exit_code=124, response=""),
                self.config,
            )
        timeout_mock.assert_called_once()
        complete_mock.assert_not_called()

    def test_on_job_finished_posts_fail_for_nonzero(self) -> None:
        plugin = HivemootTaskPlugin()
        with patch.object(task_api, "post_fail") as fail_mock:
            plugin.on_job_finished(
                self._job(),
                AgentResult(exit_code=1, response="boom"),
                self.config,
            )
        fail_mock.assert_called_once()
        self.assertIn("boom", fail_mock.call_args[0][4])

    def test_on_job_finished_noop_without_backend(self) -> None:
        plugin = HivemootTaskPlugin()
        bare_config = _mk_task_config(
            execute_base_url="",
            workspace=self.workspace,
            settings={"AGENT_PROVIDER": "claude"},
        )
        with patch.object(task_api, "post_complete") as complete_mock:
            plugin.on_job_finished(
                self._job(),
                AgentResult(exit_code=0, response=""),
                bare_config,
            )
        complete_mock.assert_not_called()


class HeartbeatLifecycleTests(unittest.TestCase):
    """Regressions for orphan-thread, interval-0, and bad-env handling."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.workspace = self.tmp.name
        self.config = _mk_task_config(
            heartbeat_interval_secs=1,
            workspace=self.workspace,
            settings={"AGENT_PROVIDER": "claude"},
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _job(self, task_id: str = "t-x") -> Job:
        return Job(
            session_key=f"task:{task_id}",
            prompt="run",
            metadata={
                "task_id": task_id, "claim_token": "ctok", "repo": "o/r",
            },
        )

    def test_interval_zero_skips_heartbeat_thread(self) -> None:
        # B2 regression: interval=0 must NOT start a thread (would
        # busy-loop on Event.wait(0)).
        plugin = HivemootTaskPlugin()
        zero_config = _mk_task_config(
            heartbeat_interval_secs=0,
            workspace=self.workspace,
            settings={"AGENT_PROVIDER": "claude"},
        )
        with patch.object(task_api, "post_progress", return_value=True), \
                patch.object(task_api, "post_heartbeat") as hb:
            plugin.on_job_started(self._job(), zero_config)
        self.assertIsNone(plugin._heartbeat_thread)
        self.assertIsNone(plugin._heartbeat_stop)
        time.sleep(0.2)
        hb.assert_not_called()

    def test_bad_int_env_falls_back_to_default(self) -> None:
        # Pydantic's ge=0 constraint on heartbeat_interval_secs catches
        # negative values at config-load time; the legacy "junk env
        # value" pathway is gone.  The remaining contract is: when the
        # operator omits the field, the schema default (45s) applies.
        plugin = HivemootTaskPlugin()
        default_config = _mk_task_config(
            workspace=self.workspace,
            settings={"AGENT_PROVIDER": "claude"},
        )
        with patch.object(task_api, "post_progress", return_value=True):
            plugin.on_job_started(self._job(), default_config)
        self.assertIsNotNone(plugin._heartbeat_thread)
        plugin._heartbeat_stop.set()
        plugin._heartbeat_thread.join(timeout=2)

    def test_post_complete_failure_is_logged(self) -> None:
        # B7 regression: failed final post must surface a stable
        # operator-visible error line, not a silent drop.
        plugin = HivemootTaskPlugin()
        log_dir = os.path.join(self.workspace, "runs", "current")
        os.makedirs(log_dir, exist_ok=True)
        with open(os.path.join(log_dir, "log"), "w") as f:
            f.write(json.dumps({"type": "result", "result": "ok"}) + "\n")

        stderr = io.StringIO()
        with patch.object(task_api, "post_complete", return_value=False), \
                patch.object(task_api, "post_heartbeat", return_value=True), \
                patch("sys.stderr", stderr):
            plugin.on_job_finished(
                self._job(),
                AgentResult(exit_code=0, response=""),
                self.config,
            )
        self.assertIn("FAILED to post complete", stderr.getvalue())

    def test_orphan_heartbeat_does_not_revive_into_next_job(self) -> None:
        # P2 regression: per-job stop event means a heartbeat that
        # hangs through job A's on_job_finished cannot be re-armed
        # by job B's on_job_started clearing self._heartbeat_stop.
        plugin = HivemootTaskPlugin()
        # Job A: capture the stop event reference before finish.
        with patch.object(task_api, "post_progress", return_value=True), \
                patch.object(task_api, "post_heartbeat", return_value=True):
            plugin.on_job_started(self._job("task-A"), self.config)
            stop_a = plugin._heartbeat_stop
            self.assertIsNotNone(stop_a)
        # Finish A — instance refs cleared.
        with patch.object(task_api, "post_complete", return_value=True), \
                patch.object(task_api, "post_heartbeat", return_value=True):
            log_dir = os.path.join(self.workspace, "runs", "current")
            os.makedirs(log_dir, exist_ok=True)
            with open(os.path.join(log_dir, "log"), "w") as f:
                f.write("")
            plugin.on_job_finished(
                self._job("task-A"),
                AgentResult(exit_code=0, response=""),
                self.config,
            )
        self.assertIsNone(plugin._heartbeat_stop)
        self.assertIsNone(plugin._heartbeat_thread)
        # Start job B: gets a NEW event, distinct from A's.
        with patch.object(task_api, "post_progress", return_value=True), \
                patch.object(task_api, "post_heartbeat", return_value=True):
            plugin.on_job_started(self._job("task-B"), self.config)
            stop_b = plugin._heartbeat_stop
        self.assertIsNotNone(stop_b)
        self.assertIsNot(stop_a, stop_b)
        # A's event is still set (orphan thread, if any, exits next wait).
        self.assertTrue(stop_a.is_set())
        # Cleanup.
        plugin._heartbeat_stop.set()
        if plugin._heartbeat_thread:
            plugin._heartbeat_thread.join(timeout=2)


class TriggersMethodTests(unittest.TestCase):
    def test_returns_trigger_only_when_claim_url_set(self) -> None:
        plugin = HivemootTaskPlugin()
        # Without prior validate()/setup() the cached _cfg is None →
        # no trigger registered (legitimate: triggers() called early).
        self.assertEqual(plugin.triggers(), [])

        # With typed config that has a claim_url → trigger registered.
        plugin._cfg = _mk_task_config().typed
        triggers = plugin.triggers()
        self.assertEqual(len(triggers), 1)
        self.assertIsInstance(triggers[0], HivemootTaskTrigger)

        # Empty claim_url → no trigger.
        plugin._cfg = _mk_task_config(claim_url="").typed
        self.assertEqual(plugin.triggers(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
