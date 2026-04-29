"""War-room job handler — runs in `on_job_finished` (F.3).

After the engine finishes a triage Job, this handler:

  1. Extracts the engine's markdown response from its log
     (delegated to the existing `tasks.result_extractor` —
     the same NDJSON-aware extractor the tasks plugin uses,
     so behavior is consistent across providers).
  2. Parses the structured triage block via `parse_triage_response`.
  3. Calls the war-room API:
     - PRESENT: `present_to_room` → `submit_contribution`
     - WITHDRAW: `withdraw_participant` (with `reason` if given)

# Failure isolation

The handler swallows all exceptions and logs to stderr. The agent's
exit code is NOT promoted to failure on a post error — the engine
already finished successfully; a stuck post is a transient issue
the next watching tick can re-attempt (the storage layer is
idempotent on (room, role, sequence)).

# Idempotency

The trigger keys its dedupe cache by `{roomId}@{sequence}` so a
re-tick with the same sequence won't re-dispatch. If the agent
re-runs anyway (operator-forced re-dispatch, etc.), the API
returns 409 `duplicate_present` / `duplicate_contribution` and the
handler swallows + logs as a benign race.

# Wire-cost guard

A worker with a stuck/malformed triage output ALWAYS withdraws —
never silently submits an empty contribution that the queen would
read as data. The parse_error path produces a withdraw with
reason `unparseable_triage_output:<class>` so operators can grep
the worker logs and find the LLM that's producing garbage.
"""

from __future__ import annotations

import sys
from typing import Any

from hivemoot_agent.plugins.interfaces import AgentResult, Job

from . import api as wr_api
from .triage import TriageDecision, parse_triage_response


__all__ = (
    "JOB_KIND_TRIAGE",
    "is_war_room_job",
    "handle_war_room_job_finished",
)


# Marker the trigger writes into job.metadata so on_job_finished
# can dispatch deterministically. Stable string — operators can
# grep logs for it.
JOB_KIND_TRIAGE = "war_room_triage"


def is_war_room_job(job: Job) -> bool:
    """Discriminator predicate. Mirrors `_is_task_job` in the
    parent plugin's `__init__.py`. The `room_id` AND `kind` AND
    `sequence` triple are all checked: a partial-marker Job is
    treated as not-ours rather than risking a false-positive
    dispatch."""
    return (
        job.metadata.get("job_kind") == JOB_KIND_TRIAGE
        and bool(job.metadata.get("room_id"))
        and isinstance(job.metadata.get("current_sequence"), int)
    )


def handle_war_room_job_finished(
    job: Job,
    result: AgentResult,
    *,
    base_url: str,
    bearer: str,
    extracted_markdown: str,
) -> TriageDecision:
    """Parse the agent's response and act on it.

    Returns the parsed `TriageDecision` so callers (and tests) can
    introspect what was decided. Side-effects: HTTP calls to the
    war-room API. All API failures swallowed-and-logged; this
    function never raises.
    """
    room_id = str(job.metadata.get("room_id") or "")
    current_sequence = int(job.metadata.get("current_sequence") or 0)
    subject_ref = str(job.metadata.get("subject_ref") or "")

    decision = parse_triage_response(extracted_markdown)

    if decision.kind == "present":
        _do_present_and_contribute(
            base_url=base_url,
            bearer=bearer,
            room_id=room_id,
            current_sequence=current_sequence,
            subject_ref=subject_ref,
            decision=decision,
            result=result,
        )
    else:
        _do_withdraw(
            base_url=base_url,
            bearer=bearer,
            room_id=room_id,
            current_sequence=current_sequence,
            subject_ref=subject_ref,
            decision=decision,
        )

    return decision


def _do_present_and_contribute(
    *,
    base_url: str,
    bearer: str,
    room_id: str,
    current_sequence: int,
    subject_ref: str,
    decision: TriageDecision,
    result: AgentResult,
) -> None:
    """RSVP via /present, then submit the contribution. If the
    /present call benignly fails (already presented, room moved on,
    etc.), still attempt the contribution — the storage layer
    enforces ordering server-side."""

    # 1. Present (RSVP). Best-effort: a benign 409 (already
    #    presented at this sequence) is not fatal; we still want
    #    to submit the contribution body.
    try:
        wr_api.present_to_room(
            base_url=base_url,
            room_id=room_id,
            sequence_observed_by_client=current_sequence,
            bearer=bearer,
            intent_hint=decision.summary,
        )
    except Exception as exc:  # noqa: BLE001 — log + continue
        _log(
            f"present failed (continuing to contribute) "
            f"room={room_id} subject={subject_ref} seq={current_sequence}: "
            f"{type(exc).__name__}: {exc}",
            level="warn",
        )

    # 2. Submit contribution. The structured body matches
    #    WAR_ROOM_DESIGN.md §"Worker contribution body schema".
    body: dict[str, Any] = {
        "verdict": decision.verdict,
        "summary": decision.summary,
    }
    raw_md = decision.body or ""

    try:
        seq = wr_api.submit_contribution(
            base_url=base_url,
            room_id=room_id,
            sequence_observed_by_client=current_sequence,
            contribution_body=body,
            raw_md=raw_md,
            bearer=bearer,
        )
        _log(
            f"contributed room={room_id} subject={subject_ref} "
            f"verdict={decision.verdict} body_bytes={len(raw_md.encode('utf-8'))} "
            f"landed_seq={seq} agent_exit={result.exit_code}",
            level="info",
        )
    except Exception as exc:  # noqa: BLE001
        _log(
            f"contribute failed room={room_id} subject={subject_ref} "
            f"seq={current_sequence} verdict={decision.verdict}: "
            f"{type(exc).__name__}: {exc}",
            level="error",
        )


def _do_withdraw(
    *,
    base_url: str,
    bearer: str,
    room_id: str,
    current_sequence: int,
    subject_ref: str,
    decision: TriageDecision,
) -> None:
    try:
        seq = wr_api.withdraw_participant(
            base_url=base_url,
            room_id=room_id,
            sequence_observed_by_client=current_sequence,
            bearer=bearer,
            reason=decision.reason,
        )
        level = "warn" if decision.parse_error else "info"
        _log(
            f"withdrew room={room_id} subject={subject_ref} "
            f"seq={current_sequence} reason={decision.reason or 'unspecified'} "
            f"landed_seq={seq} parse_error={decision.parse_error}",
            level=level,
        )
    except Exception as exc:  # noqa: BLE001
        _log(
            f"withdraw failed room={room_id} subject={subject_ref} "
            f"seq={current_sequence}: {type(exc).__name__}: {exc}",
            level="error",
        )


def _log(message: str, *, level: str) -> None:
    """Write to stderr with a stable prefix so operators can grep.
    Mirrors the `[hivemoot-tasks]` / `[hivemoot-health]` pattern in
    the parent plugin."""
    prefix = "[hivemoot-war-rooms]"
    if level == "error":
        print(f"{prefix} ERROR {message}", file=sys.stderr, flush=True)
    elif level == "warn":
        print(f"{prefix} WARN {message}", file=sys.stderr, flush=True)
    else:
        print(f"{prefix} {message}", file=sys.stderr, flush=True)
