"""War-room domain reporter — the war_rooms plugin's adapter onto
the engine-side ``JobLifecycleReporter`` substrate (PR B).

Closes the JOB_LIFECYCLE_UNIFICATION RFC, **PR C**. Wires war-room
jobs onto the substrate so the multiplexer drives an early /present
+ heartbeat-thread for every triage Job — this is the change that
ends the race we keep seeing in the drone logs:

    [hivemoot-war-rooms] raced room transition on present
    room=... seq=N code=status_precondition_failed
    — skipping contribute

Today /present fires from ``handler.py``'s ``on_job_finished``,
*after* the agent subprocess (a 5–15 minute LLM run on a large PR)
exits. By the time /present POSTs, the room has aged out via
``max_age_secs`` and transitioned to ``deciding`` / ``closed``. The
reporter moves /present to ``on_start`` (before the agent runs) so
the slot is claimed early, then heartbeats every ``heartbeat_interval``
seconds keep the watchdog from auto-closing.

# Lifecycle vs handler.py

This PR is intentionally minimal: ``on_finish`` and ``on_failure``
are no-ops here. ``handler.py``'s ``handle_war_room_job_finished``
keeps owning the /contribute and /withdraw paths — its existing
/present call is now a benign idempotent re-RSVP (same agent_id,
same role, server returns 200 without conflict). PR-follow-up can
fold the post-finish flow into the reporter; for now we ship the
heartbeat where the user-visible value lives.

# Bearer rotation

The reporter captures a ``bearer_factory`` (a callable returning a
fresh bearer per call) rather than a resolved bearer. This mirrors
the tasks-plugin convention — re-resolve every tick so an operator
rotating ``HIVEMOOT_AGENT_TOKEN`` takes effect within one
``heartbeat_interval`` instead of waiting for process restart.

# What ``on_start`` failure means for ``on_heartbeat``

If ``on_start``'s /present hits ``RoomStateRaceError`` (room moved
on between watching and dispatch — same race we're trying to fix
but smaller window now), the reporter records ``_presented=False``
and ``on_heartbeat`` becomes a no-op. The substrate's heartbeat
thread keeps spinning but doesn't make HTTP calls — cheap, no
spam. The legacy handler.py path will then surface its own race
log line at ``on_job_finished`` and skip the contribute leg.
"""

from __future__ import annotations

import os
import sys
from typing import Callable, Optional

from hivemoot_agent.plugins.interfaces import AgentResult, Job
from hivemoot_agent.plugins_builtin.hivemoot.job_lifecycle import (
    JobLifecycleReporter,
)

from . import api as wr_api
from .handler import is_war_room_job

__all__ = (
    "RoomLifecycleReporter",
    "build_room_reporter",
    "is_war_room_job_for_lifecycle",
)


# Re-export the existing matcher under a name that signals its role
# in the multiplexer. The underlying predicate is unchanged; the
# alias makes call sites (``mux.register(is_war_room_job_for_lifecycle, ...)``)
# self-documenting.
is_war_room_job_for_lifecycle = is_war_room_job


# A nullary callable returning a fresh bearer string. Re-resolved
# every tick so token rotation takes effect within one heartbeat
# interval. The caller (parent plugin) typically supplies
# ``lambda: resolve_agent_token(token_file)``.
BearerFactory = Callable[[], str]


class RoomLifecycleReporter(JobLifecycleReporter):
    """Per-job war-room reporter. Owns ``/present`` (early) and
    ``/heartbeat``. Defers ``/contribute`` / ``/withdraw`` to the
    legacy handler.py for now — PR-follow-up can migrate those.

    Failure model:
    * ``on_start`` /present raising ``RoomStateRaceError`` → record
      not-presented; ``on_heartbeat`` becomes no-op; legacy handler
      will see the same race and skip its leg.
    * ``on_heartbeat`` /heartbeat raising ``RoomStateRaceError`` →
      log and clear the presented flag so subsequent ticks skip.
      The handler.py path will independently surface the room
      transition at ``on_job_finished``.
    * ``on_heartbeat`` benign no-op (server returned
      ``skipped: "non_pending"``) → clear the presented flag too;
      slot is already terminal, nothing to keep alive.
    """

    def __init__(
        self,
        job: Job,
        *,
        base_url: str,
        bearer_factory: BearerFactory,
        agent_id: Optional[str] = None,
    ) -> None:
        self._base_url = base_url
        self._bearer_factory = bearer_factory
        self._room_id = str(job.metadata.get("room_id") or "")
        self._current_sequence = int(job.metadata.get("current_sequence") or 0)
        self._subject_ref = str(job.metadata.get("subject_ref") or "")
        # AGENT_ID for the first-wins gate. None falls back to
        # bearer.name on the server side — single-runner deployments
        # don't need to set it. Subscriber-mode runners should pass
        # their per-runner identity.
        self._agent_id = (
            agent_id
            if agent_id is not None
            else (os.environ.get("AGENT_ID", "") or "").strip() or None
        )
        # Tracks whether on_start successfully /presented. Heartbeat
        # is a no-op until this is True; cleared back to False if
        # the server reports the slot is terminal.
        self._presented = False

    # ── JobLifecycleReporter contract ────────────────────────────

    def on_start(self, job: Job) -> None:
        """Early /present so the slot exists before the agent runs.

        Idempotent for the same agent_id+role: a follow-up /present
        in handler.py at on_job_finished is harmless (server-side
        first-wins gate accepts re-RSVP from the same owner).
        """
        if not self._room_id:
            self._log(
                "on_start skipped — empty room_id in job metadata",
                level="warn",
            )
            return
        try:
            seq = wr_api.present_to_room(
                base_url=self._base_url,
                room_id=self._room_id,
                sequence_observed_by_client=self._current_sequence,
                bearer=self._bearer_factory(),
            )
            self._presented = True
            self._log(
                f"early-presented room={self._room_id} "
                f"subject={self._subject_ref} "
                f"seq={self._current_sequence} landed_seq={seq}",
                level="info",
            )
        except wr_api.RoomStateRaceError as exc:
            # Race window between /watching and dispatch is tiny but
            # not zero. Keep _presented=False; heartbeats no-op;
            # handler will see same race at on_job_finished.
            self._log(
                f"raced on early-present room={self._room_id} "
                f"seq={self._current_sequence} code={exc.code}",
                level="info",
            )
        except Exception as exc:  # noqa: BLE001
            self._log(
                f"early-present failed room={self._room_id} "
                f"seq={self._current_sequence}: "
                f"{type(exc).__name__}: {exc}",
                level="warn",
            )

    def on_heartbeat(self, job: Job) -> None:
        """Pure-liveness heartbeat (PR A's endpoint). No-op when we
        never successfully /presented or when the slot has gone
        terminal (server replies ``skipped: "non_pending"``)."""
        if not self._presented:
            return
        try:
            rsvp_at = wr_api.heartbeat_room_participant(
                base_url=self._base_url,
                room_id=self._room_id,
                bearer=self._bearer_factory(),
                agent_id=self._agent_id,
            )
        except wr_api.RoomStateRaceError as exc:
            # Slot is no longer in awaiting_contributions, OR a
            # different runner won the first-wins gate. Either way
            # the lifecycle for this Job is effectively over —
            # stop heartbeating.
            self._presented = False
            self._log(
                f"heartbeat raced room={self._room_id} code={exc.code} "
                "— stopping heartbeats for this job",
                level="info",
            )
            return
        except Exception as exc:  # noqa: BLE001
            # Transient (network blip, 5xx) — keep _presented True so
            # the next tick retries. The substrate's loop already
            # logs to stderr; this branch keeps the reporter's log
            # prefix consistent for grep ergonomics.
            self._log(
                f"heartbeat error room={self._room_id}: "
                f"{type(exc).__name__}: {exc}",
                level="warn",
            )
            return

        if rsvp_at is None:
            # Benign no-op — participant withdrew / resolved /
            # timed_out. Stop heartbeating; nothing to keep alive.
            self._presented = False
            self._log(
                f"heartbeat skipped room={self._room_id} "
                "— participant non-pending",
                level="info",
            )

    def on_finish(self, job: Job, result: AgentResult) -> None:
        """No-op — handler.py's ``handle_war_room_job_finished``
        owns /contribute and /withdraw. Keeps PR C minimal; the
        post-finish flow can migrate in a follow-up.
        """
        del job, result

    def on_failure(self, job: Job, error_text: str) -> None:
        """No-op — handler.py's failure path also owns this for now.
        See ``on_finish`` rationale.
        """
        del job, error_text

    # ── Helpers ──────────────────────────────────────────────────

    def _log(self, message: str, *, level: str) -> None:
        """Write to stderr with the war_rooms prefix so operators
        can grep this reporter's lines alongside handler.py's. Same
        format as handler._log."""
        prefix = "[hivemoot-war-rooms]"
        if level == "error":
            print(f"{prefix} ERROR {message}", file=sys.stderr, flush=True)
        elif level == "warn":
            print(f"{prefix} WARN {message}", file=sys.stderr, flush=True)
        else:
            print(f"{prefix} {message}", file=sys.stderr, flush=True)


def build_room_reporter(
    job: Job,
    *,
    base_url: str,
    bearer_factory: BearerFactory,
    agent_id: Optional[str] = None,
) -> RoomLifecycleReporter:
    """ReporterFactory shape — bound to per-engine context (base_url,
    bearer_factory) at registration time, takes the per-job
    ``Job`` at dispatch time. Parent plugin closes over its config
    when calling this::

        cfg = self._cfg
        mux.register(
            is_war_room_job_for_lifecycle,
            lambda job: build_room_reporter(
                job,
                base_url=cfg.war_rooms.base_url,
                bearer_factory=lambda: resolve_agent_token(
                    str(cfg.token_file) if cfg.token_file else "",
                ),
            ),
        )
    """
    return RoomLifecycleReporter(
        job,
        base_url=base_url,
        bearer_factory=bearer_factory,
        agent_id=agent_id,
    )
