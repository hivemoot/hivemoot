"""Tests for the tasks TaskLifecycleReporter (PR D of the
JOB_LIFECYCLE_UNIFICATION RFC).

Exercises the per-job hooks against mocks of the existing
``tasks.api`` helpers so the wire shapes don't need a server.

The substrate already has tests covering the multiplexer's
threading invariants (per-job stop_event, 5s join, bearer
re-resolution per tick); these tests focus on the **task-domain
contract**:

* on_start — posts initial progress with the correct task_id +
  message; tolerates post_progress returning False; tolerates
  unexpected exceptions.
* on_heartbeat — calls post_heartbeat with task_id + claim_token;
  re-resolves the bearer per tick; transient exception is logged
  and swallowed (loop must not die).
* on_finish / on_failure — explicit no-ops; the legacy
  ``_task_on_job_finished`` keeps owning post_complete /
  post_fail / post_timeout.
* Matcher disjointness — task matcher returns True only for
  jobs with both ``task_id`` AND ``claim_token``; rejects
  war-room jobs and partial-marker jobs.
"""

from __future__ import annotations

import os
import sys
import unittest
from typing import Any
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins.interfaces import AgentResult, Job
from hivemoot_agent.plugins_builtin.hivemoot.tasks import api as task_api
from hivemoot_agent.plugins_builtin.hivemoot.tasks.lifecycle import (
    TaskLifecycleReporter,
    build_task_reporter,
    is_task_job_for_lifecycle,
)


def _job(**metadata: Any) -> Job:
    md: dict[str, Any] = {
        "task_id": "task-42",
        "claim_token": "ct-abc",
    }
    md.update(metadata)
    return Job(session_key="task-42", prompt="p", metadata=md)


class _FakeBearerFactory:
    """Counts calls to assert per-tick re-resolution."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self) -> str:
        self.calls += 1
        return f"hmt_call_{self.calls}"


# ── on_start ────────────────────────────────────────────────────────


class TaskLifecycleReporterStartTests(unittest.TestCase):

    def test_on_start_posts_initial_progress(self):
        bearer = _FakeBearerFactory()
        with patch.object(
            task_api, "post_progress", return_value=True,
        ) as m:
            r = TaskLifecycleReporter(
                _job(),
                execute_base="https://www.hivemoot.dev/api/tasks",
                bearer_factory=bearer,
            )
            r.on_start(_job())
        m.assert_called_once_with(
            "https://www.hivemoot.dev/api/tasks",
            "task-42",
            "hmt_call_1",
            "ct-abc",
            "Task task-42 claimed. Starting execution.",
        )

    def test_on_start_skips_with_empty_metadata(self):
        # Defensive: a Job with empty task_id should not produce
        # an HTTP call. Same guard the legacy code had.
        bad_job = Job(session_key="x", prompt="p", metadata={})
        with patch.object(task_api, "post_progress") as m:
            r = TaskLifecycleReporter(
                bad_job,
                execute_base="x",
                bearer_factory=_FakeBearerFactory(),
            )
            r.on_start(bad_job)
        m.assert_not_called()

    def test_on_start_logs_when_post_progress_returns_false(self):
        # post_progress returns bool — False means transport
        # failure. Reporter logs but doesn't raise (heartbeat
        # thread will retry).
        with patch.object(
            task_api, "post_progress", return_value=False,
        ) as m:
            r = TaskLifecycleReporter(
                _job(),
                execute_base="x",
                bearer_factory=_FakeBearerFactory(),
            )
            r.on_start(_job())
        m.assert_called_once()  # called; failure swallowed

    def test_on_start_swallows_exception(self):
        # A network error in the initial post must not propagate;
        # the substrate proceeds to spawn the heartbeat thread.
        with patch.object(
            task_api, "post_progress",
            side_effect=RuntimeError("network blip"),
        ):
            r = TaskLifecycleReporter(
                _job(),
                execute_base="x",
                bearer_factory=_FakeBearerFactory(),
            )
            r.on_start(_job())  # must not raise


# ── on_heartbeat ────────────────────────────────────────────────────


class TaskLifecycleReporterHeartbeatTests(unittest.TestCase):

    def test_on_heartbeat_posts_with_task_id(self):
        with patch.object(
            task_api, "post_heartbeat", return_value=True,
        ) as m:
            r = TaskLifecycleReporter(
                _job(),
                execute_base="https://www.hivemoot.dev/api/tasks",
                bearer_factory=_FakeBearerFactory(),
            )
            r.on_heartbeat(_job())
        m.assert_called_once_with(
            "https://www.hivemoot.dev/api/tasks",
            "task-42",
            "hmt_call_1",
            "ct-abc",
        )

    def test_on_heartbeat_re_resolves_bearer_per_tick(self):
        # Token rotation invariant — every tick gets a fresh
        # bearer. Three calls → three bearer_factory invocations.
        bearer = _FakeBearerFactory()
        with patch.object(
            task_api, "post_heartbeat", return_value=True,
        ):
            r = TaskLifecycleReporter(
                _job(),
                execute_base="x",
                bearer_factory=bearer,
            )
            r.on_heartbeat(_job())
            r.on_heartbeat(_job())
            r.on_heartbeat(_job())
        self.assertEqual(bearer.calls, 3)

    def test_on_heartbeat_swallows_exception(self):
        # A transient error in post_heartbeat must not propagate
        # — the substrate's loop catches whatever escapes anyway,
        # but the reporter's own try/except gives task-domain
        # context in the log line.
        with patch.object(
            task_api, "post_heartbeat",
            side_effect=RuntimeError("transient 503"),
        ):
            r = TaskLifecycleReporter(
                _job(),
                execute_base="x",
                bearer_factory=_FakeBearerFactory(),
            )
            r.on_heartbeat(_job())  # must not raise

    def test_on_heartbeat_skips_with_empty_metadata(self):
        bad_job = Job(session_key="x", prompt="p", metadata={})
        with patch.object(task_api, "post_heartbeat") as m:
            r = TaskLifecycleReporter(
                bad_job,
                execute_base="x",
                bearer_factory=_FakeBearerFactory(),
            )
            r.on_heartbeat(bad_job)
        m.assert_not_called()


# ── on_finish / on_failure (explicit no-op contract) ──────────────


class TaskLifecycleReporterFinishTests(unittest.TestCase):

    def test_on_finish_is_noop(self):
        # The legacy _task_on_job_finished still owns post_complete
        # / post_fail / post_timeout. Reporter explicitly delegates;
        # if this changes, the contract update should be deliberate.
        with (
            patch.object(task_api, "post_complete") as mc,
            patch.object(task_api, "post_fail") as mf,
            patch.object(task_api, "post_timeout") as mt,
        ):
            r = TaskLifecycleReporter(
                _job(),
                execute_base="x",
                bearer_factory=_FakeBearerFactory(),
            )
            r.on_finish(_job(), AgentResult(exit_code=0, response="x"))
        mc.assert_not_called()
        mf.assert_not_called()
        mt.assert_not_called()

    def test_on_failure_is_noop(self):
        with patch.object(task_api, "post_fail") as m:
            r = TaskLifecycleReporter(
                _job(),
                execute_base="x",
                bearer_factory=_FakeBearerFactory(),
            )
            r.on_failure(_job(), "agent crashed")
        m.assert_not_called()


# ── Matcher disjointness (Q6 invariant) ───────────────────────────


class TaskMatcherDisjointnessTests(unittest.TestCase):

    def test_matches_well_formed_task_job(self):
        self.assertTrue(is_task_job_for_lifecycle(_job()))

    def test_does_not_match_war_room_job(self):
        # A war-room job has room_id + job_kind but no task_id.
        # Mutual exclusion holds.
        wr_job = Job(
            session_key="war-room",
            prompt="p",
            metadata={
                "job_kind": "war_room_triage",
                "room_id": "room-A",
                "current_sequence": 5,
            },
        )
        self.assertFalse(is_task_job_for_lifecycle(wr_job))

    def test_does_not_match_partial_metadata(self):
        # task_id without claim_token is partial — matcher rejects
        # to avoid false-positive dispatch (mirrors the legacy
        # _is_task_job's strict check).
        partial = Job(
            session_key="x",
            prompt="p",
            metadata={"task_id": "t-1"},
        )
        self.assertFalse(is_task_job_for_lifecycle(partial))

        partial2 = Job(
            session_key="x",
            prompt="p",
            metadata={"claim_token": "ct-1"},
        )
        self.assertFalse(is_task_job_for_lifecycle(partial2))

    def test_does_not_match_health_job(self):
        # Health jobs have no shared markers with tasks.
        health_job = Job(session_key="h", prompt="p", metadata={})
        self.assertFalse(is_task_job_for_lifecycle(health_job))


# ── Factory smoke ──────────────────────────────────────────────────


class FactorySmokeTests(unittest.TestCase):

    def test_build_task_reporter_returns_configured_instance(self):
        bearer = _FakeBearerFactory()
        r = build_task_reporter(
            _job(),
            execute_base="https://staging.hivemoot.dev/api/tasks",
            bearer_factory=bearer,
        )
        self.assertIsInstance(r, TaskLifecycleReporter)
        self.assertEqual(
            r._execute_base,
            "https://staging.hivemoot.dev/api/tasks",
        )
        self.assertEqual(r._task_id, "task-42")
        self.assertEqual(r._claim_token, "ct-abc")


if __name__ == "__main__":
    unittest.main()
