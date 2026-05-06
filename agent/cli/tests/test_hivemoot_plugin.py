"""Tests for the consolidated ``hivemoot`` plugin.

Covers:
  * validate() per feature (health / tasks / github_workflows).
  * triggers() wiring: right triggers appear based on enabled flags.
  * on_job_started / on_job_finished task-subsystem semantics
    (progress post, heartbeat thread, complete/fail/timeout, codex
    auth-error promotion).
  * on_job_finished health-subsystem semantics (run report post,
    consecutive_failures counter, outcome mapping).
  * In-flight gate (``wait/reserve/release_task_slot``) that keeps
    the async dispatcher from letting the claim loop run away.
  * Secret scrubbing on the ``error`` field.
  * Rate-limited fallthrough warning when health identity is
    unresolvable mid-run.
  * Per-session_key run-id keying so concurrent jobs don't collide.
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
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins.interfaces import AgentResult, Job, PluginConfig
from hivemoot_agent.plugins_builtin.hivemoot import HivemootPlugin
from hivemoot_agent.plugins_builtin.hivemoot.config import (
    HivemootConfig,
    HivemootGithubWorkflowsConfig,
    HivemootHealthConfig,
    HivemootTasksConfig,
)
from hivemoot_agent.plugins_builtin.hivemoot.health import api as health_api
from hivemoot_agent.plugins_builtin.hivemoot.tasks import api as task_api


_DEFAULT_TOKEN_FILE = Path("/tmp/.hivemoot-test-token")
_UNSET = object()  # sentinel — distinguishes "use default" from "force None"


def _ensure_token_file() -> Path:
    if not _DEFAULT_TOKEN_FILE.exists():
        _DEFAULT_TOKEN_FILE.write_text("tok")
    return _DEFAULT_TOKEN_FILE


def _mk_plugin_config(
    *,
    health: HivemootHealthConfig | None = None,
    tasks: HivemootTasksConfig | None = None,
    github_workflows: HivemootGithubWorkflowsConfig | None = None,
    token_file=_UNSET,
    settings: dict | None = None,
) -> PluginConfig:
    # ``token_file=None`` explicitly propagates None into the schema
    # so the validate-requires-token test can exercise that path.
    # Omitting the kwarg entirely uses the default test token file.
    if token_file is _UNSET:
        tf = _ensure_token_file()
    else:
        tf = token_file
    typed = HivemootConfig(
        token_file=tf,
        health=health or HivemootHealthConfig(),
        tasks=tasks or HivemootTasksConfig(),
        github_workflows=github_workflows or HivemootGithubWorkflowsConfig(),
    )
    return PluginConfig(
        name="hivemoot",
        settings=settings or {},
        typed=typed,
    )


# ── Validation ────────────────────────────────────────────────────


class ValidateTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_agent_id = os.environ.pop("AGENT_ID", None)

    def tearDown(self) -> None:
        if self._saved_agent_id is not None:
            os.environ["AGENT_ID"] = self._saved_agent_id
        else:
            os.environ.pop("AGENT_ID", None)

    def test_all_disabled_passes(self) -> None:
        plugin = HivemootPlugin()
        errors = plugin.validate(_mk_plugin_config())
        self.assertEqual(errors, [])

    def test_tasks_enabled_requires_backend_wiring(self) -> None:
        plugin = HivemootPlugin()
        errors = plugin.validate(_mk_plugin_config(
            tasks=HivemootTasksConfig(enabled=True),
        ))
        self.assertTrue(any("claim_url" in e for e in errors))
        self.assertTrue(any("execute_base_url" in e for e in errors))

    def test_tasks_enabled_with_full_wiring_passes(self) -> None:
        plugin = HivemootPlugin()
        errors = plugin.validate(_mk_plugin_config(
            tasks=HivemootTasksConfig(
                enabled=True,
                claim_url="https://api/x",
                execute_base_url="https://api/y",
            ),
        ))
        self.assertEqual(errors, [])

    def test_health_enabled_requires_agent_id(self) -> None:
        plugin = HivemootPlugin()
        # AGENT_ID deliberately unset.
        errors = plugin.validate(_mk_plugin_config(
            health=HivemootHealthConfig(enabled=True, repo="o/r"),
        ))
        self.assertTrue(any("AGENT_ID" in e for e in errors))

    def test_health_enabled_requires_repo(self) -> None:
        plugin = HivemootPlugin()
        os.environ["AGENT_ID"] = "builder"
        errors = plugin.validate(_mk_plugin_config(
            health=HivemootHealthConfig(enabled=True),
        ))
        self.assertTrue(any("health.repo" in e for e in errors))

    def test_health_enabled_with_agent_and_repo_passes(self) -> None:
        plugin = HivemootPlugin()
        os.environ["AGENT_ID"] = "builder"
        errors = plugin.validate(_mk_plugin_config(
            health=HivemootHealthConfig(enabled=True, repo="o/r"),
        ))
        self.assertEqual(errors, [])

    def test_health_enabled_requires_token(self) -> None:
        plugin = HivemootPlugin()
        os.environ["AGENT_ID"] = "builder"
        saved = {
            k: os.environ.pop(k, None)
            for k in ("HIVEMOOT_AGENT_TOKEN_FILE", "HIVEMOOT_AGENT_TOKEN")
        }
        try:
            errors = plugin.validate(_mk_plugin_config(
                token_file=None,
                health=HivemootHealthConfig(enabled=True, repo="o/r"),
            ))
            self.assertTrue(any("token_file" in e for e in errors))
        finally:
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v


# ── triggers() wiring ─────────────────────────────────────────────


class TriggersTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_agent_id = os.environ.get("AGENT_ID")
        os.environ["AGENT_ID"] = "builder"

    def tearDown(self) -> None:
        if self._saved_agent_id is None:
            os.environ.pop("AGENT_ID", None)
        else:
            os.environ["AGENT_ID"] = self._saved_agent_id

    def test_empty_when_all_disabled(self) -> None:
        plugin = HivemootPlugin()
        plugin._cfg = _mk_plugin_config().typed
        self.assertEqual(plugin.triggers(), [])

    def test_task_trigger_when_tasks_enabled(self) -> None:
        from hivemoot_agent.plugins_builtin.hivemoot.tasks.trigger import (
            HivemootTaskTrigger,
        )
        plugin = HivemootPlugin()
        plugin._cfg = _mk_plugin_config(
            tasks=HivemootTasksConfig(
                enabled=True,
                claim_url="https://api/x",
                execute_base_url="https://api/y",
            ),
        ).typed
        triggers = plugin.triggers()
        self.assertEqual(len(triggers), 1)
        self.assertIsInstance(triggers[0], HivemootTaskTrigger)

    def test_health_trigger_when_health_enabled(self) -> None:
        from hivemoot_agent.plugins_builtin.hivemoot.health.trigger import (
            HealthHeartbeatTrigger,
        )
        plugin = HivemootPlugin()
        plugin._cfg = _mk_plugin_config(
            health=HivemootHealthConfig(enabled=True, repo="o/r"),
        ).typed
        triggers = plugin.triggers()
        self.assertEqual(len(triggers), 1)
        self.assertIsInstance(triggers[0], HealthHeartbeatTrigger)

    def test_both_triggers_when_both_enabled(self) -> None:
        plugin = HivemootPlugin()
        plugin._cfg = _mk_plugin_config(
            health=HivemootHealthConfig(enabled=True, repo="o/r"),
            tasks=HivemootTasksConfig(
                enabled=True,
                claim_url="https://api/x",
                execute_base_url="https://api/y",
            ),
        ).typed
        self.assertEqual(len(plugin.triggers()), 2)

    def test_task_trigger_skipped_when_claim_url_empty(self) -> None:
        plugin = HivemootPlugin()
        plugin._cfg = _mk_plugin_config(
            tasks=HivemootTasksConfig(enabled=True),
        ).typed
        self.assertEqual(plugin.triggers(), [])


# ── Lifecycle multiplexer composition ─────────────────────────────


class LifecycleMuxCompositionTests(unittest.TestCase):
    """Defensive-coexistence regression tests for the
    ``self._lifecycle_mux is None`` guard in ``triggers()``.

    Closes guard's PR #616 review point about composition asymmetry:
    when PR D's tasks branch and this branch's war-rooms branch
    both run in ``triggers()``, the second one MUST attach its
    reporter to the existing multiplexer instead of replacing it
    and silently dropping the first registration.

    These tests simulate the composition without depending on PR
    D's code being in the branch — they pre-populate
    ``self._lifecycle_mux`` with a sentinel multiplexer (acting
    as a stand-in for whatever the OTHER branch would have built)
    and verify the war-rooms registration attaches on top rather
    than overwriting.
    """

    def setUp(self) -> None:
        self._saved_agent_id = os.environ.get("AGENT_ID")
        os.environ["AGENT_ID"] = "builder"

    def tearDown(self) -> None:
        if self._saved_agent_id is None:
            os.environ.pop("AGENT_ID", None)
        else:
            os.environ["AGENT_ID"] = self._saved_agent_id

    def _war_rooms_only_cfg(self):
        from hivemoot_agent.plugins_builtin.hivemoot.config import (
            HivemootWarRoomsConfig,
        )
        cfg = _mk_plugin_config()
        cfg.typed.war_rooms = HivemootWarRoomsConfig(
            enabled=True,
            base_url="https://api/x",
            heartbeat_interval_secs=45,
        )
        return cfg

    def test_war_rooms_registration_attaches_to_existing_mux(self) -> None:
        # Simulate PR D's tasks branch having already created the
        # multiplexer and registered the task reporter. This branch
        # MUST attach the war-rooms registration to the existing
        # mux instead of replacing it.
        from hivemoot_agent.plugins_builtin.hivemoot.job_lifecycle import (
            LifecycleMultiplexer,
        )

        plugin = HivemootPlugin()
        plugin._cfg = self._war_rooms_only_cfg().typed

        # Pre-existing mux with one registration (the "tasks branch
        # already ran" simulation). The matcher returns False so
        # this never matches — it's a sentinel, not a real reporter.
        sentinel_mux = LifecycleMultiplexer(heartbeat_interval=45)
        sentinel_mux.register(lambda j: False, lambda j: None)
        plugin._lifecycle_mux = sentinel_mux

        plugin.triggers()

        # Same mux instance — defensive guard preserved it.
        self.assertIs(
            plugin._lifecycle_mux, sentinel_mux,
            "war-rooms branch overwrote the existing multiplexer; "
            "the defensive `if self._lifecycle_mux is None` guard "
            "is missing or broken.",
        )
        # Two registrations: the sentinel (pre-existing) + war_rooms.
        self.assertEqual(
            len(plugin._lifecycle_mux._registrations), 2,
            "war-rooms registration should have been appended to "
            "the existing mux's registrations.",
        )

    def test_war_rooms_creates_mux_when_none_exists(self) -> None:
        # Sanity: when no other branch has created the mux, the
        # war-rooms branch creates one with the configured interval.
        plugin = HivemootPlugin()
        plugin._cfg = self._war_rooms_only_cfg().typed
        self.assertIsNone(plugin._lifecycle_mux)

        plugin.triggers()

        self.assertIsNotNone(plugin._lifecycle_mux)
        self.assertEqual(
            plugin._lifecycle_mux.heartbeat_interval, 45,
            "Mux should pick up cfg.war_rooms.heartbeat_interval_secs "
            "when only war_rooms is enabled.",
        )
        self.assertEqual(len(plugin._lifecycle_mux._registrations), 1)

    def test_mux_interval_is_min_of_both_domain_settings(self) -> None:
        # When BOTH tasks AND war_rooms are enabled, the multiplexer
        # interval is min(tasks, war_rooms) so neither domain's
        # liveness expectation gets stretched. Slower-tuned domains
        # see more-frequent heartbeats (cheap waste); faster-tuned
        # domains never miss liveness. This test exercises the
        # min() codepath in the war-rooms branch's mux init.
        from hivemoot_agent.plugins_builtin.hivemoot.config import (
            HivemootWarRoomsConfig,
        )
        cfg = _mk_plugin_config(
            tasks=HivemootTasksConfig(
                enabled=True,
                claim_url="https://api/x",
                execute_base_url="https://api/y",
                heartbeat_interval_secs=90,  # slower
            ),
        )
        cfg.typed.war_rooms = HivemootWarRoomsConfig(
            enabled=True,
            base_url="https://api/x",
            heartbeat_interval_secs=30,  # faster
        )
        plugin = HivemootPlugin()
        plugin._cfg = cfg.typed
        plugin.triggers()
        self.assertIsNotNone(plugin._lifecycle_mux)
        self.assertEqual(
            plugin._lifecycle_mux.heartbeat_interval, 30,
            "Mux should pick min(tasks, war_rooms) interval when "
            "both domains are enabled — neither domain should see "
            "stretched liveness expectations.",
        )


# ── System prompt composition ─────────────────────────────────────


class SystemPromptTests(unittest.TestCase):
    def test_empty_when_nothing_enabled(self) -> None:
        plugin = HivemootPlugin()
        cfg = _mk_plugin_config()
        plugin._cfg = cfg.typed
        self.assertEqual(plugin.system_prompt(cfg), "")

    def test_task_prompt_when_tasks_enabled(self) -> None:
        plugin = HivemootPlugin()
        cfg = _mk_plugin_config(
            tasks=HivemootTasksConfig(
                enabled=True,
                claim_url="https://api/x",
                execute_base_url="https://api/y",
            ),
        )
        plugin._cfg = cfg.typed
        prompt = plugin.system_prompt(cfg)
        self.assertIn("executing a specific delegated task", prompt)

    def test_system_prompt_has_no_repo_when_tasks_only(self) -> None:
        """Regression: the old task-only prompt was repo-agnostic.
        Consolidated plugin must preserve that when github_workflows
        is disabled."""
        plugin = HivemootPlugin()
        cfg = _mk_plugin_config(
            tasks=HivemootTasksConfig(
                enabled=True,
                claim_url="https://api/x",
                execute_base_url="https://api/y",
            ),
        )
        plugin._cfg = cfg.typed
        prompt = plugin.system_prompt(cfg)
        self.assertNotIn("Target repository", prompt)
        self.assertNotIn("Local target repository", prompt)


# ── Task-subsystem lifecycle ──────────────────────────────────────


class TaskLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.workspace = self.tmp.name
        self.config = _mk_plugin_config(
            tasks=HivemootTasksConfig(
                enabled=True,
                claim_url="https://api/x",
                execute_base_url="https://api.example/api/tasks",
                heartbeat_interval_secs=1,
                workspace=Path(self.workspace),
            ),
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

    def _primed_plugin(self) -> HivemootPlugin:
        plugin = HivemootPlugin()
        plugin._cfg = self.config.typed
        # PR D: heartbeat thread + initial progress post are now
        # owned by the lifecycle substrate registered in triggers().
        # Initialize it so on_job_started has a multiplexer to
        # dispatch through.
        plugin.triggers()
        return plugin

    def test_on_job_started_posts_progress_and_starts_heartbeat(self) -> None:
        plugin = self._primed_plugin()
        with patch.object(task_api, "post_progress") as progress_mock, \
                patch.object(task_api, "post_heartbeat") as heartbeat_mock:
            plugin.on_job_started(self._job(), self.config)
            time.sleep(1.5)
            # Stop the substrate's heartbeat thread by signalling
            # on_job_finish with a placeholder result; the test
            # would normally let on_job_finished call this.
            plugin._lifecycle_mux.on_job_finish(
                self._job(),
                AgentResult(exit_code=0, response=""),
            )

        progress_mock.assert_called_once()
        args, _kw = progress_mock.call_args
        self.assertEqual(args[1], "t-9")
        self.assertGreaterEqual(heartbeat_mock.call_count, 1)

    def test_on_job_started_noop_without_execute_base(self) -> None:
        bare = _mk_plugin_config(
            tasks=HivemootTasksConfig(
                enabled=True,
                claim_url="https://api/x",
                execute_base_url="",
            ),
            settings={"AGENT_PROVIDER": "claude"},
        )
        plugin = HivemootPlugin()
        plugin._cfg = bare.typed
        plugin.triggers()  # wire substrate
        with patch.object(task_api, "post_progress") as progress_mock, \
                patch.object(task_api, "post_heartbeat") as heartbeat_mock:
            plugin.on_job_started(self._job(), bare)
            # The substrate's heartbeat thread may have spawned (it
            # only inspects interval, not metadata), but the
            # reporter's on_start guards on empty execute_base and
            # returns without posting progress.
            time.sleep(0.2)
            if plugin._lifecycle_mux is not None:
                plugin._lifecycle_mux.on_job_finish(
                    self._job(),
                    AgentResult(exit_code=0, response=""),
                )
        progress_mock.assert_not_called()
        # post_heartbeat was guarded by the same empty-metadata
        # check inside the reporter, so no actual heartbeat fired
        # despite the thread existing.
        heartbeat_mock.assert_not_called()

    def test_on_job_finished_posts_complete(self) -> None:
        plugin = self._primed_plugin()

        log_dir = os.path.join(self.workspace, "runs", "current")
        os.makedirs(log_dir, exist_ok=True)
        with open(os.path.join(log_dir, "log"), "w") as f:
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
        self.assertEqual(complete_mock.call_args[0][4], "## Done")

    def test_on_job_finished_promotes_codex_auth_error(self) -> None:
        codex_config = _mk_plugin_config(
            tasks=HivemootTasksConfig(
                enabled=True,
                claim_url="https://api/x",
                execute_base_url="https://api.example/api/tasks",
                heartbeat_interval_secs=1,
                workspace=Path(self.workspace),
            ),
            settings={"AGENT_PROVIDER": "codex"},
        )
        plugin = HivemootPlugin()
        plugin._cfg = codex_config.typed

        log_dir = os.path.join(self.workspace, "runs", "current")
        os.makedirs(log_dir, exist_ok=True)
        with open(os.path.join(log_dir, "log"), "w") as f:
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
        self.assertIn("refresh_token_reused", fail_mock.call_args[0][4])

    def test_on_job_finished_posts_timeout_for_124(self) -> None:
        plugin = self._primed_plugin()
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
        plugin = self._primed_plugin()
        with patch.object(task_api, "post_fail") as fail_mock:
            plugin.on_job_finished(
                self._job(),
                AgentResult(exit_code=1, response="boom"),
                self.config,
            )
        fail_mock.assert_called_once()
        self.assertIn("boom", fail_mock.call_args[0][4])

    def test_interval_zero_skips_heartbeat_thread(self) -> None:
        zero_config = _mk_plugin_config(
            tasks=HivemootTasksConfig(
                enabled=True,
                claim_url="https://api/x",
                execute_base_url="https://api.example/api/tasks",
                heartbeat_interval_secs=0,
                workspace=Path(self.workspace),
            ),
            settings={"AGENT_PROVIDER": "claude"},
        )
        plugin = HivemootPlugin()
        plugin._cfg = zero_config.typed
        plugin.triggers()  # wire the substrate (with interval=0)
        with patch.object(task_api, "post_progress", return_value=True), \
                patch.object(task_api, "post_heartbeat") as hb:
            plugin.on_job_started(self._job(), zero_config)
            # interval=0 in the substrate's _spawn_heartbeat skips
            # thread startup entirely. Pin the same opt-out
            # semantics the legacy code had.
            self.assertIsNone(plugin._lifecycle_mux._thread)
            self.assertIsNone(plugin._lifecycle_mux._stop_event)
        time.sleep(0.2)
        hb.assert_not_called()

    def test_post_complete_failure_is_logged(self) -> None:
        plugin = self._primed_plugin()
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
        # Per-job stop_event isolation invariant — a slow shutdown
        # of job A's heartbeat thread cannot bleed into job B.
        # Substrate guarantees this via fresh threading.Event per
        # _spawn_heartbeat (pinned by the substrate's own
        # test_per_job_stop_event_isolation); this test exercises
        # the contract through the plugin's full lifecycle.
        plugin = self._primed_plugin()

        def _job(tid: str) -> Job:
            return Job(
                session_key=f"task:{tid}",
                prompt="r",
                metadata={
                    "task_id": tid, "claim_token": "ctok", "repo": "o/r",
                },
            )

        with patch.object(task_api, "post_progress", return_value=True), \
                patch.object(task_api, "post_heartbeat", return_value=True):
            plugin.on_job_started(_job("task-A"), self.config)
            stop_a = plugin._lifecycle_mux._stop_event
            self.assertIsNotNone(stop_a)

        log_dir = os.path.join(self.workspace, "runs", "current")
        os.makedirs(log_dir, exist_ok=True)
        with open(os.path.join(log_dir, "log"), "w") as f:
            f.write("")
        with patch.object(task_api, "post_complete", return_value=True), \
                patch.object(task_api, "post_heartbeat", return_value=True):
            plugin.on_job_finished(
                _job("task-A"),
                AgentResult(exit_code=0, response=""),
                self.config,
            )
        # After on_job_finished, the substrate clears its per-job
        # state — both _stop_event and _thread back to None.
        self.assertIsNone(plugin._lifecycle_mux._stop_event)
        self.assertIsNone(plugin._lifecycle_mux._thread)

        with patch.object(task_api, "post_progress", return_value=True), \
                patch.object(task_api, "post_heartbeat", return_value=True):
            plugin.on_job_started(_job("task-B"), self.config)
            stop_b = plugin._lifecycle_mux._stop_event
        self.assertIsNotNone(stop_b)
        # Fresh event per job — and the previous job's event was
        # signalled on its on_job_finish (so any orphan thread sees
        # the stop signal).
        self.assertIsNot(stop_a, stop_b)
        self.assertTrue(stop_a.is_set())

        # Tear down job B's thread to avoid leaking.
        plugin._lifecycle_mux.on_job_finish(
            _job("task-B"),
            AgentResult(exit_code=0, response=""),
        )


# ── Health-subsystem lifecycle ────────────────────────────────────


class HealthLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_agent_id = os.environ.get("AGENT_ID")
        os.environ["AGENT_ID"] = "builder"

    def tearDown(self) -> None:
        if self._saved_agent_id is None:
            os.environ.pop("AGENT_ID", None)
        else:
            os.environ["AGENT_ID"] = self._saved_agent_id

    def _config(self) -> PluginConfig:
        return _mk_plugin_config(
            health=HivemootHealthConfig(
                enabled=True, repo="o/r", base_url="https://h/",
            ),
        )

    def _job(self, session_key: str = "scheduled:x") -> Job:
        return Job(session_key=session_key, prompt="", metadata={})

    def test_on_job_finished_posts_run_report_success(self) -> None:
        plugin = HivemootPlugin()
        cfg = self._config()
        plugin._cfg = cfg.typed

        with patch.object(health_api, "post_run_report", return_value=True) as rr:
            plugin.on_job_started(self._job(), cfg)
            plugin.on_job_finished(
                self._job(), AgentResult(exit_code=0, response="ok"), cfg,
            )
        rr.assert_called_once()
        kwargs = rr.call_args.kwargs
        self.assertEqual(kwargs["agent_id"], "builder")
        self.assertEqual(kwargs["repo"], "o/r")
        self.assertEqual(kwargs["outcome"], "success")
        self.assertEqual(kwargs["consecutive_failures"], 0)

    def test_failure_increments_consecutive_failures(self) -> None:
        plugin = HivemootPlugin()
        cfg = self._config()
        plugin._cfg = cfg.typed
        with patch.object(health_api, "post_run_report", return_value=True) as rr:
            for _ in range(3):
                plugin.on_job_started(self._job(), cfg)
                plugin.on_job_finished(
                    self._job(), AgentResult(exit_code=1, response="e"), cfg,
                )
        calls = rr.call_args_list
        self.assertEqual(calls[0].kwargs["outcome"], "failure")
        self.assertEqual(calls[0].kwargs["consecutive_failures"], 1)
        self.assertEqual(calls[2].kwargs["consecutive_failures"], 3)

    def test_success_resets_consecutive_failures(self) -> None:
        plugin = HivemootPlugin()
        cfg = self._config()
        plugin._cfg = cfg.typed
        plugin._consecutive_failures = 5
        with patch.object(health_api, "post_run_report", return_value=True) as rr:
            plugin.on_job_started(self._job(), cfg)
            plugin.on_job_finished(
                self._job(), AgentResult(exit_code=0, response=""), cfg,
            )
        self.assertEqual(
            rr.call_args.kwargs["consecutive_failures"], 0,
        )
        self.assertEqual(plugin._consecutive_failures, 0)

    def test_timeout_exit_code_maps_to_timeout(self) -> None:
        plugin = HivemootPlugin()
        cfg = self._config()
        plugin._cfg = cfg.typed
        with patch.object(health_api, "post_run_report", return_value=True) as rr:
            plugin.on_job_started(self._job(), cfg)
            plugin.on_job_finished(
                self._job(), AgentResult(exit_code=124, response=""), cfg,
            )
        self.assertEqual(rr.call_args.kwargs["outcome"], "timeout")

    def test_trigger_label_from_session_key(self) -> None:
        plugin = HivemootPlugin()
        cfg = self._config()
        plugin._cfg = cfg.typed
        with patch.object(health_api, "post_run_report", return_value=True) as rr:
            plugin.on_job_started(self._job("task:t-1"), cfg)
            plugin.on_job_finished(
                self._job("task:t-1"),
                AgentResult(exit_code=0, response=""),
                cfg,
            )
        self.assertEqual(rr.call_args.kwargs["trigger"], "task")

    def test_post_run_reports_disabled(self) -> None:
        cfg = _mk_plugin_config(
            health=HivemootHealthConfig(
                enabled=True, repo="o/r", post_run_reports=False,
            ),
        )
        plugin = HivemootPlugin()
        plugin._cfg = cfg.typed
        with patch.object(health_api, "post_run_report") as rr:
            plugin.on_job_started(self._job(), cfg)
            plugin.on_job_finished(
                self._job(), AgentResult(exit_code=0, response=""), cfg,
            )
        rr.assert_not_called()

    def test_error_field_scrubs_secrets(self) -> None:
        plugin = HivemootPlugin()
        cfg = self._config()
        plugin._cfg = cfg.typed

        dirty = "exec failed: Authorization: Bearer sk-ant-abcd1234567890FEDCBA rejected"
        with patch.object(health_api, "post_run_report", return_value=True) as rr:
            plugin.on_job_started(self._job(), cfg)
            plugin.on_job_finished(
                self._job(),
                AgentResult(exit_code=1, response=dirty),
                cfg,
            )
        sent = rr.call_args.kwargs["error"]
        self.assertNotIn("sk-ant-abcd1234567890", sent)
        self.assertIn("[REDACTED]", sent)

    def test_identity_unresolvable_logs_warning_then_rate_limits(self) -> None:
        """If AGENT_ID disappears mid-run (config reload, bad restart)
        operators must see the skip instead of chasing a silent
        dashboard gap.  Log is rate-limited so a persistent
        misconfig doesn't spam stderr."""
        plugin = HivemootPlugin()
        cfg = self._config()
        plugin._cfg = cfg.typed
        plugin._health_warn_min_interval_secs = 0.5

        # Unset AGENT_ID so identity is unresolvable mid-run.
        os.environ.pop("AGENT_ID", None)

        stderr = io.StringIO()
        with patch.object(health_api, "post_run_report") as rr, \
                patch("sys.stderr", stderr):
            plugin.on_job_started(self._job(), cfg)
            plugin.on_job_finished(
                self._job(), AgentResult(exit_code=0, response=""), cfg,
            )
            # Second consecutive call inside the rate-limit window.
            plugin.on_job_started(self._job(), cfg)
            plugin.on_job_finished(
                self._job(), AgentResult(exit_code=0, response=""), cfg,
            )

        rr.assert_not_called()
        msg = stderr.getvalue()
        # Exactly one warning (rate-limited).
        self.assertEqual(msg.count("run report skipped"), 1)
        self.assertIn("AGENT_ID", msg)

    def test_run_ids_are_session_scoped(self) -> None:
        """Two interleaved jobs on different session_keys must get
        distinct run_ids.  Protects against a future engine change
        that relaxes #605's strict serialization."""
        plugin = HivemootPlugin()
        cfg = self._config()
        plugin._cfg = cfg.typed

        posted: list[dict] = []

        def capture(*_a, **kw):
            posted.append(dict(kw))
            return True

        with patch.object(health_api, "post_run_report", side_effect=capture):
            # Start both jobs (both go into the keyed state dicts).
            plugin.on_job_started(Job(session_key="task:a", prompt="", metadata={}), cfg)
            plugin.on_job_started(Job(session_key="task:b", prompt="", metadata={}), cfg)
            # Finish in opposite order.
            plugin.on_job_finished(
                Job(session_key="task:b", prompt="", metadata={}),
                AgentResult(exit_code=0, response=""), cfg,
            )
            plugin.on_job_finished(
                Job(session_key="task:a", prompt="", metadata={}),
                AgentResult(exit_code=0, response=""), cfg,
            )

        self.assertEqual(len(posted), 2)
        self.assertNotEqual(posted[0]["run_id"], posted[1]["run_id"])


# ── In-flight gate (async dispatcher regression) ──────────────────


class InFlightGateTests(unittest.TestCase):
    """The plugin's ``_task_inflight`` Event is the hand-off between
    the tasks trigger (which must wait before claiming again) and
    ``on_job_finished`` (which releases the gate).  Regression for
    the async-dispatcher issue raised by hivemoot-builder — without
    the gate, the claim loop pre-claims tasks that sit silent in
    the workqueue."""

    def _cfg(self) -> PluginConfig:
        return _mk_plugin_config(
            tasks=HivemootTasksConfig(
                enabled=True,
                claim_url="https://api/x",
                execute_base_url="https://api/y",
                heartbeat_interval_secs=1,
            ),
            settings={"AGENT_PROVIDER": "claude"},
        )

    def _job(self) -> Job:
        return Job(
            session_key="task:t-1",
            prompt="",
            metadata={"task_id": "t-1", "claim_token": "c"},
        )

    def test_slot_is_free_at_init(self) -> None:
        plugin = HivemootPlugin()
        self.assertTrue(plugin._task_inflight.is_set())

    def test_reserve_blocks_wait(self) -> None:
        plugin = HivemootPlugin()
        plugin.reserve_task_slot()
        stop = threading.Event()
        start = time.monotonic()
        ok = plugin.wait_task_slot(stop, timeout=0.3)
        elapsed = time.monotonic() - start
        self.assertFalse(ok)
        self.assertGreaterEqual(elapsed, 0.25)

    def test_release_unblocks_wait(self) -> None:
        plugin = HivemootPlugin()
        plugin.reserve_task_slot()
        stop = threading.Event()

        result: list[bool] = []

        def waiter():
            result.append(plugin.wait_task_slot(stop, timeout=2.0))

        t = threading.Thread(target=waiter, daemon=True)
        t.start()
        time.sleep(0.1)  # make sure waiter is parked
        plugin.release_task_slot()
        t.join(timeout=2)
        self.assertEqual(result, [True])

    def test_wait_respects_stop_event(self) -> None:
        plugin = HivemootPlugin()
        plugin.reserve_task_slot()
        stop = threading.Event()
        stop.set()
        self.assertFalse(plugin.wait_task_slot(stop, timeout=5.0))

    def test_on_job_finished_releases_slot_on_success(self) -> None:
        plugin = HivemootPlugin()
        cfg = self._cfg()
        plugin._cfg = cfg.typed
        plugin.reserve_task_slot()
        self.assertFalse(plugin._task_inflight.is_set())

        with tempfile.TemporaryDirectory() as tmp:
            log_dir = os.path.join(tmp, "runs", "current")
            os.makedirs(log_dir)
            with open(os.path.join(log_dir, "log"), "w") as f:
                f.write(json.dumps({"type": "result", "result": "ok"}) + "\n")
            ws_cfg = _mk_plugin_config(
                tasks=HivemootTasksConfig(
                    enabled=True,
                    claim_url="https://api/x",
                    execute_base_url="https://api/y",
                    heartbeat_interval_secs=0,
                    workspace=Path(tmp),
                ),
                settings={"AGENT_PROVIDER": "claude"},
            )
            plugin._cfg = ws_cfg.typed

            with patch.object(task_api, "post_complete", return_value=True):
                plugin.on_job_finished(
                    self._job(),
                    AgentResult(exit_code=0, response=""),
                    ws_cfg,
                )
        self.assertTrue(plugin._task_inflight.is_set())

    def test_on_job_finished_releases_slot_on_failure(self) -> None:
        plugin = HivemootPlugin()
        cfg = self._cfg()
        plugin._cfg = cfg.typed
        plugin.reserve_task_slot()
        self.assertFalse(plugin._task_inflight.is_set())

        with patch.object(
            plugin, "_task_on_job_finished",
            side_effect=RuntimeError("boom"),
        ), patch.object(plugin, "_task_best_effort_fail"), \
                patch("sys.stderr", io.StringIO()):
            plugin.on_job_finished(
                self._job(),
                AgentResult(exit_code=1, response=""),
                cfg,
            )
        # Release MUST happen in the finally block even though the
        # inner method raised.
        self.assertTrue(plugin._task_inflight.is_set())


if __name__ == "__main__":
    unittest.main(verbosity=2)
