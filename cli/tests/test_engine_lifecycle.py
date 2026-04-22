"""Regression tests for the engine ↔ plugin lifecycle contract.

Exercises three bugs from the post-PR-575 ultrareview:

- bug_001: ``on_job_started`` MUST run before ``_build_provider_cmd``
  so plugins can set per-job env (e.g. CODEX_ANSWER_FILE) the provider
  command builder reads.
- bug_002: ``AGENT_LAST_RUN_LOG`` MUST be cleared when the new run
  produces no log (empty stdout) so the previous job's path doesn't
  leak into the next job's ``on_job_finished`` via the long-lived
  ``_PluginDispatcher`` config.
- bug_003: ``on_job_finished`` MUST run even when the body between
  ``on_job_started`` and the end of ``run_agent`` raises — otherwise
  the hivemoot-task plugin's heartbeat thread is orphaned and the
  backend never sees the terminal outcome.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.engine import Engine
from hivemoot_agent.plugins.interfaces import (
    AgentResult,
    Job,
    PluginConfig,
)


def _make_engine(workspace: str) -> Engine:
    eng = Engine()
    # Bypass session-store init / plugin discovery — we drive the
    # engine surface directly.
    eng._session_store = None
    # Redirect memory dir off /home/node into the test tmp.
    os.environ["AGENT_MEMORY_DIR"] = os.path.join(workspace, "memory")
    return eng


def _make_job(session_key: str = "task:t-1") -> Job:
    return Job(
        session_key=session_key,
        prompt="run me",
        metadata={"task_id": session_key.split(":", 1)[-1]},
    )


def _config(workspace: str) -> PluginConfig:
    return PluginConfig(
        name="hivemoot-task",
        settings={
            "WORKSPACE_ROOT": workspace,
            "AGENT_PROVIDER": "claude",
            "GITHUB_REPOS": "owner/repo",
            # Redirect memory storage off /home/node into the test tmp.
            "AGENT_MEMORY_DIR": os.path.join(workspace, "memory"),
        },
    )


class _OrderingPlugin:
    """Records the order of lifecycle calls relative to provider-cmd build."""

    name = "ordering"
    version = "0.0.0"
    description = "test"

    def __init__(self) -> None:
        self.events: list[str] = []

    def on_job_started(self, job: Job, config: PluginConfig) -> None:
        # The hivemoot-task plugin sets CODEX_ANSWER_FILE here; this
        # fake records the event so the test can assert ordering.
        self.events.append("on_job_started")
        os.environ["TEST_LIFECYCLE_TOKEN"] = "from-on-job-started"

    def on_job_finished(
        self, job: Job, result: AgentResult, config: PluginConfig,
    ) -> None:
        self.events.append(f"on_job_finished:exit={result.exit_code}")


class StartedBeforeBuildCmdTest(unittest.TestCase):
    """bug_001: provider command builder must see env set by on_job_started."""

    def setUp(self) -> None:
        os.environ.pop("TEST_LIFECYCLE_TOKEN", None)

    def tearDown(self) -> None:
        os.environ.pop("TEST_LIFECYCLE_TOKEN", None)

    def test_on_job_started_runs_before_build_provider_cmd(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            engine = _make_engine(tmp)
            plugin = _OrderingPlugin()

            # Track the env value visible to _build_provider_cmd.  If
            # the bug regresses (build_cmd called first), the captured
            # value will be empty.
            captured: dict = {}

            def fake_build(*args, **kwargs):
                captured["TEST_LIFECYCLE_TOKEN"] = os.environ.get(
                    "TEST_LIFECYCLE_TOKEN", "",
                )
                return ["true"]

            with patch.object(engine, "_build_provider_cmd", fake_build), \
                    patch.object(
                        engine, "_run_subprocess", return_value=(0, ""),
                    ), \
                    patch.object(
                        engine, "_resolve_skill_runtime",
                        return_value=MagicMock(
                            plugin_dir="", scope_json="", prompt_skills="",
                        ),
                    ), \
                    patch.object(engine, "_cleanup_skill_runtime"), \
                    patch.object(engine, "_build_mcp_config", return_value=""), \
                    patch.object(engine, "_init_session_store"):
                engine.run_agent(
                    plugin, _make_job(), _config(tmp), "ordering",
                )

            self.assertEqual(
                captured["TEST_LIFECYCLE_TOKEN"], "from-on-job-started",
                "on_job_started must run before _build_provider_cmd so the "
                "provider command builder sees per-job env vars",
            )
            # Sanity: lifecycle pair both fired.
            self.assertIn("on_job_started", plugin.events)
            self.assertTrue(
                any(e.startswith("on_job_finished") for e in plugin.events),
            )


class StaleLogPathClearedTest(unittest.TestCase):
    """bug_002: empty stdout must clear AGENT_LAST_RUN_LOG, not leak prior run."""

    def setUp(self) -> None:
        os.environ.pop("AGENT_LAST_RUN_LOG", None)

    def tearDown(self) -> None:
        os.environ.pop("AGENT_LAST_RUN_LOG", None)

    def test_empty_stdout_clears_stale_log_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            engine = _make_engine(tmp)
            plugin = _OrderingPlugin()
            config = _config(tmp)

            # Pre-populate the slot to simulate a prior job's path.
            stale = os.path.join(tmp, "stale-log")
            with open(stale, "w") as f:
                f.write("prior")
            os.environ["AGENT_LAST_RUN_LOG"] = stale
            config.settings["AGENT_LAST_RUN_LOG"] = stale

            with patch.object(
                engine, "_build_provider_cmd", return_value=["true"],
            ), patch.object(
                engine, "_run_subprocess", return_value=(0, ""),  # empty stdout
            ), patch.object(
                engine, "_resolve_skill_runtime",
                return_value=MagicMock(
                    plugin_dir="", scope_json="", prompt_skills="",
                ),
            ), patch.object(engine, "_cleanup_skill_runtime"), \
                    patch.object(engine, "_build_mcp_config", return_value=""), \
                    patch.object(engine, "_init_session_store"):
                engine.run_agent(plugin, _make_job(), config, "ordering")

            self.assertNotIn(
                "AGENT_LAST_RUN_LOG", os.environ,
                "stale AGENT_LAST_RUN_LOG must be cleared from the "
                "process environment when the new run produces no log",
            )
            self.assertNotIn(
                "AGENT_LAST_RUN_LOG", config.settings,
                "stale AGENT_LAST_RUN_LOG must be cleared from PluginConfig "
                "settings (long-lived across daemon dispatches)",
            )


class FinishedRunsOnExceptionTest(unittest.TestCase):
    """bug_003: try/finally must guarantee on_job_finished even on raise."""

    def test_on_job_finished_runs_when_subprocess_raises(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            engine = _make_engine(tmp)
            plugin = _OrderingPlugin()

            def boom(*args, **kwargs):
                raise RuntimeError("simulated mid-run failure")

            with patch.object(
                engine, "_build_provider_cmd", return_value=["true"],
            ), patch.object(engine, "_run_subprocess", side_effect=boom), \
                    patch.object(
                        engine, "_resolve_skill_runtime",
                        return_value=MagicMock(
                            plugin_dir="", scope_json="", prompt_skills="",
                        ),
                    ), \
                    patch.object(engine, "_cleanup_skill_runtime"), \
                    patch.object(engine, "_build_mcp_config", return_value=""), \
                    patch.object(engine, "_init_session_store"):
                with self.assertRaises(RuntimeError):
                    engine.run_agent(
                        plugin, _make_job(), _config(tmp), "ordering",
                    )

            # Both lifecycle hooks must have fired despite the raise.
            self.assertIn("on_job_started", plugin.events)
            finished_events = [
                e for e in plugin.events if e.startswith("on_job_finished")
            ]
            self.assertEqual(
                len(finished_events), 1,
                "on_job_finished must run exactly once even when the body "
                "between on_job_started and on_job_finished raises — "
                "otherwise the hivemoot-task heartbeat thread is orphaned",
            )
            # The bare-failure result lets the plugin's failure-path post.
            self.assertIn("exit=1", finished_events[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
