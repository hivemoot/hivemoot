"""Tasks domain reporter — the tasks plugin's adapter onto the
engine-side ``JobLifecycleReporter`` substrate (PR B).

Closes the JOB_LIFECYCLE_UNIFICATION RFC, **PR D**. The substrate
was modeled directly on the existing tasks heartbeat thread, so
this PR is mostly a port: extract the heartbeat-loop body + the
initial-progress post into reporter hooks; delete the local
``_task_heartbeat_loop`` / ``_task_heartbeat_stop`` /
``_task_heartbeat_thread`` machinery from the parent plugin.

# What's in scope here

* ``on_start`` posts the initial "starting execution" progress
  message — same one the legacy ``_task_on_job_started`` posted
  before spawning its heartbeat thread.
* ``on_heartbeat`` calls ``api.post_heartbeat`` (PR-A pre-existing
  endpoint) — re-resolves the bearer per tick so token rotation
  takes effect within one interval.
* ``on_finish`` / ``on_failure`` are explicit no-ops. The legacy
  ``_task_on_job_finished`` keeps owning ``post_complete`` /
  ``post_fail`` / ``post_timeout`` because that path branches on
  exit code, codex auth-error detection, sidecar resolution, and
  the in-flight gate (release_task_slot) — non-trivial and
  orthogonal to lifecycle wiring. A future PR can fold those in.

# Bearer rotation

The reporter captures a ``bearer_factory`` (a callable returning
a fresh bearer per call), not a resolved bearer. This is the
same convention the legacy heartbeat thread used:
``resolve_agent_token(token_file)`` per tick so an operator
rotating ``HIVEMOOT_AGENT_TOKEN`` takes effect within one
``heartbeat_interval`` without process restart.

# Failure model

Every hook (on_start, on_heartbeat) wraps its post in
try/except: a transient post-heartbeat failure logs to stderr
and returns; the substrate's loop keeps firing. Same behaviour
the legacy heartbeat thread had — one bad tick must not kill
the thread.
"""

from __future__ import annotations

import sys
from typing import Callable, Optional

from hivemoot_agent.plugins.interfaces import AgentResult, Job
from hivemoot_agent.plugins_builtin.hivemoot.job_lifecycle import (
    JobLifecycleReporter,
)

from . import api as task_api

__all__ = (
    "TaskLifecycleReporter",
    "build_task_reporter",
    "is_task_job_for_lifecycle",
)


def is_task_job_for_lifecycle(job: Job) -> bool:
    """Discriminator predicate for the multiplexer. Mirrors the
    parent plugin's private ``_is_task_job`` exactly — a Job is
    a task iff both ``task_id`` and ``claim_token`` are present.
    Mutually exclusive with the war-rooms matcher (which requires
    ``job_kind == "war_room_triage"`` AND ``room_id``)."""
    return bool(job.metadata.get("task_id")) and bool(
        job.metadata.get("claim_token")
    )


# A nullary callable returning a fresh bearer string. Re-resolved
# every tick so token rotation takes effect within one heartbeat
# interval. The caller (parent plugin) typically supplies
# ``lambda: resolve_agent_token(token_file)``.
BearerFactory = Callable[[], str]


class TaskLifecycleReporter(JobLifecycleReporter):
    """Per-job tasks reporter. Owns the initial-progress post and
    heartbeat. Defers complete/fail/timeout posting to the legacy
    ``_task_on_job_finished`` flow for now.

    The reporter is constructed fresh per Job — the parent plugin's
    ReporterFactory closes over its config (execute_base_url,
    bearer_factory) and binds the per-job task_id + claim_token
    here.
    """

    def __init__(
        self,
        job: Job,
        *,
        execute_base: str,
        bearer_factory: BearerFactory,
    ) -> None:
        self._execute_base = execute_base
        self._bearer_factory = bearer_factory
        self._task_id = str(job.metadata.get("task_id") or "")
        self._claim_token = str(job.metadata.get("claim_token") or "")

    # ── JobLifecycleReporter contract ────────────────────────────

    def on_start(self, job: Job) -> None:
        """Post the initial "starting execution" progress message.

        Mirrors the legacy ``_task_on_job_started`` step that ran
        before the heartbeat thread spawned. ``api.post_progress``
        returns a bool (False on transport failure); we log on
        failure so the operator sees the issue, but don't raise —
        the substrate then proceeds to spawn the heartbeat thread,
        which will keep retrying via post_heartbeat.
        """
        del job  # task_id captured in __init__
        if not self._task_id or not self._claim_token or not self._execute_base:
            self._log(
                "on_start skipped — incomplete job metadata "
                f"(task_id='{self._task_id}', execute_base='{self._execute_base}')",
                level="warn",
            )
            return
        try:
            ok = task_api.post_progress(
                self._execute_base,
                self._task_id,
                self._bearer_factory(),
                self._claim_token,
                f"Task {self._task_id} claimed. Starting execution.",
            )
        except Exception as exc:  # noqa: BLE001
            self._log(
                f"initial progress post raised "
                f"task={self._task_id}: {type(exc).__name__}: {exc}",
                level="warn",
            )
            return
        if not ok:
            self._log(
                f"failed to post initial progress for task {self._task_id}",
                level="warn",
            )

    def on_heartbeat(self, job: Job) -> None:
        """Post a per-task heartbeat. Same shape as the legacy
        ``_task_heartbeat_loop`` body — the substrate just owns the
        thread + interval + stop-event now.
        """
        del job
        if not self._task_id or not self._claim_token or not self._execute_base:
            return
        try:
            task_api.post_heartbeat(
                self._execute_base,
                self._task_id,
                self._bearer_factory(),
                self._claim_token,
            )
        except Exception as exc:  # noqa: BLE001
            # Same log shape as the legacy loop. Keep it terse —
            # the substrate's loop already logs at the [lifecycle]
            # prefix; we add task-domain context.
            self._log(
                f"heartbeat error for {self._task_id}: "
                f"{type(exc).__name__}",
                level="warn",
            )

    def on_finish(self, job: Job, result: AgentResult) -> None:
        """No-op — legacy ``_task_on_job_finished`` owns
        post_complete / post_fail / post_timeout dispatch (branches
        on exit_code, codex auth-error detection, etc.). PR-follow-up
        can fold those in."""
        del job, result

    def on_failure(self, job: Job, error_text: str) -> None:
        """No-op — legacy ``_task_best_effort_fail`` already handles
        engine-side failures with its own log + post_fail attempt.
        Wiring the multiplexer in does not change that path."""
        del job, error_text

    # ── Helpers ──────────────────────────────────────────────────

    def _log(self, message: str, *, level: str) -> None:
        """Match the legacy ``[hivemoot-tasks]`` prefix so operator
        greps continue to work after the migration."""
        prefix = "[hivemoot-tasks]"
        if level == "error":
            print(f"{prefix} ERROR {message}", file=sys.stderr, flush=True)
        elif level == "warn":
            print(f"{prefix} WARN {message}", file=sys.stderr, flush=True)
        else:
            print(f"{prefix} {message}", file=sys.stderr, flush=True)


def build_task_reporter(
    job: Job,
    *,
    execute_base: str,
    bearer_factory: BearerFactory,
) -> TaskLifecycleReporter:
    """ReporterFactory shape — bound to per-engine context
    (execute_base + bearer_factory) at registration time, takes the
    per-job ``Job`` at dispatch time. Parent plugin closes over its
    config when registering with the multiplexer."""
    return TaskLifecycleReporter(
        job,
        execute_base=execute_base,
        bearer_factory=bearer_factory,
    )
