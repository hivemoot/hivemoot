"""War-room job handler — runs in `on_job_finished` (F.3).

After the engine finishes a triage Job, this handler:

  1. Extracts the engine's markdown response from its log
     (delegated to the existing `tasks.result_extractor` —
     the same NDJSON-aware extractor the tasks plugin uses,
     so behavior is consistent across providers).
  2. Parses the structured triage block via `parse_triage_response`.
  3. Calls the war-room API:
     - PRESENT: `present_to_room` → `submit_contribution`
     - WITHDRAW: `present_to_room` → `withdraw_participant`
       (RSVP first because storage requires an existing
       participant slot before withdrawal — closes #544 builder R1.1.
       Two API calls is correct vs the alternative of relaxing the
       storage contract to allow first-class opt-out.)

# Failure isolation

The handler swallows all exceptions and logs to stderr. The agent's
exit code is NOT promoted to failure on a post error — the engine
already finished successfully; a stuck post is a transient issue
the next watching tick can re-attempt.

# Recovery from total post failure

Optional `on_post_failure` callback (closes #544 builder R1.2):
when supplied (F.5 will wire it to the trigger's seen-cache),
called with `(room_id, sequence, op_kind, exc)` on any API failure
during the post sequence. Enables the trigger to evict the seen-key
so the next watching tick re-dispatches — without this, a transient
network failure during all post operations would silently drop the
worker's participation.

# Idempotency

The trigger keys its dedupe cache by `{roomId}@{sequence}`. If the
agent re-runs anyway (operator-forced re-dispatch, etc.), the API
returns 409 / `duplicate_*` codes and the handler swallows + logs
as benign races.

# Wire-cost guard

A worker with a stuck/malformed triage output ALWAYS withdraws —
never silently submits an empty contribution that the queen would
read as data. The parse_error path produces a withdraw with
reason `unparseable_triage_output:<class>` so operators can grep
the worker logs and find the LLM that's producing garbage.
"""

from __future__ import annotations

import sys
from typing import Any, Callable, Optional

from hivemoot_agent.plugins.interfaces import AgentResult, Job

from . import api as wr_api
from .triage import TriageDecision, parse_triage_response


__all__ = (
    "JOB_KIND_TRIAGE",
    "PostFailureCallback",
    "RAW_MD_CLIENT_CAP_BYTES",
    "is_war_room_job",
    "handle_war_room_job_finished",
    "truncate_raw_md",
)


# Client-side cap on contribution `raw_md` payload size. Storage
# layer enforces 32 KiB server-side; we trim under that to leave
# headroom for the truncation marker + envelope overhead. Closes
# #544 builder R2: an oversized raw_md from the agent would 400
# server-side without firing the post-failure callback (since
# /present succeeded), and each next-tick re-dispatch would call
# /present again — `presentParticipant` rewrites `rsvp_at` on every
# call (war-room.ts:2727), pushing out the watchdog timeout
# indefinitely. Result: stuck-pending participant that never
# resolves and never times out.
RAW_MD_CLIENT_CAP_BYTES = 31 * 1024  # 31 KiB; storage cap is 32 KiB


_TRUNCATION_MARKER = (
    "\n\n_[truncated by worker — agent produced an oversized review]_"
)


def truncate_raw_md(text: str) -> str:
    """Trim `text` to at most `RAW_MD_CLIENT_CAP_BYTES` UTF-8 bytes.

    Cuts on the last newline before the cap so a fenced code block
    or list item doesn't get split mid-line. Appends a clearly-
    flagged marker so the queen's synthesizer (and human readers)
    see the contribution was capped on the worker side.
    """
    encoded = text.encode("utf-8")
    if len(encoded) <= RAW_MD_CLIENT_CAP_BYTES:
        return text
    marker_bytes = _TRUNCATION_MARKER.encode("utf-8")
    budget = RAW_MD_CLIENT_CAP_BYTES - len(marker_bytes)
    if budget <= 0:
        # Pathological — should never trigger since the marker is
        # ~70 bytes and the cap is 31 KiB, but defensive against a
        # config tweak that lowers the cap absurdly.
        return _TRUNCATION_MARKER.lstrip()
    sliced = encoded[:budget]
    decoded = sliced.decode("utf-8", errors="ignore")
    last_newline = decoded.rfind("\n")
    clean_cut = decoded[:last_newline] if last_newline > 0 else decoded
    return clean_cut + _TRUNCATION_MARKER


# Signature the trigger (F.5) will pass in to surface total-failure
# back to the watcher's seen-cache. Args:
#   room_id: the room whose post sequence failed
#   sequence: the sequence the worker was acting on (for re-dispatch
#             keying — same key the trigger originally marked)
#   op_kind: "present" | "contribute" | "withdraw" — which API call
#            raised
#   exc: the underlying exception
PostFailureCallback = Callable[[str, int, str, Exception], None]


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
    on_post_failure: Optional[PostFailureCallback] = None,
) -> TriageDecision:
    """Parse the agent's response and act on it.

    Returns the parsed `TriageDecision` so callers (and tests) can
    introspect what was decided. Side-effects: HTTP calls to the
    war-room API. All API failures swallowed-and-logged; this
    function never raises.

    `on_post_failure`, when supplied, is invoked exactly once per
    call when the post sequence terminates without successfully
    transitioning participant state — i.e. RSVP failed (and
    therefore the follow-on contribute/withdraw was skipped).
    F.5's plugin wiring threads this in to evict the trigger's
    seen-cache so the next watching tick re-dispatches.
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
            on_post_failure=on_post_failure,
        )
    else:
        _do_present_then_withdraw(
            base_url=base_url,
            bearer=bearer,
            room_id=room_id,
            current_sequence=current_sequence,
            subject_ref=subject_ref,
            decision=decision,
            on_post_failure=on_post_failure,
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
    on_post_failure: Optional[PostFailureCallback],
) -> None:
    """RSVP via /present, then submit the contribution.

    If /present raises, /contribute is still attempted (a benign
    409 from /present — already presented at this seq — shouldn't
    block contribute; the storage layer enforces ordering server-
    side). Only when BOTH fail do we fire `on_post_failure` — at
    that point no participant-state change has landed and the
    worker dropped this room silently without re-dispatch.

    `RoomStateRaceError` (the room moved to `deciding` / `closed`
    while the worker was triaging) is treated as a benign race:
    both legs are skipped, no callback fires, and the operator log
    line is INFO-level instead of WARN/ERROR.  This is the
    expected outcome whenever the bot's quiet-period gate hasn't
    quite expired by the time a fast worker reaches /present;
    elevating it to a noisy error trains operators to ignore the
    log lines that DO indicate real problems.
    """

    present_failed_exc: Optional[Exception] = None
    try:
        wr_api.present_to_room(
            base_url=base_url,
            room_id=room_id,
            sequence_observed_by_client=current_sequence,
            bearer=bearer,
            intent_hint=decision.summary,
        )
    except wr_api.RoomStateRaceError as exc:
        # Room moved on between watching → triage → present.  No
        # state change landed; nothing to retry.  /contribute will
        # also race so we skip it AND the post-failure callback
        # (the trigger's seen-cache eviction would re-dispatch a
        # room that no longer accepts our event — pointless work).
        _log(
            f"raced room transition on present "
            f"room={room_id} subject={subject_ref} seq={current_sequence} "
            f"code={exc.code} — skipping contribute",
            level="info",
        )
        return
    except Exception as exc:  # noqa: BLE001 — log + continue
        present_failed_exc = exc
        _log(
            f"present failed (continuing to contribute) "
            f"room={room_id} subject={subject_ref} seq={current_sequence}: "
            f"{type(exc).__name__}: {exc}",
            level="warn",
        )

    body: dict[str, Any] = {
        "verdict": decision.verdict,
        "summary": decision.summary,
    }
    raw_md = truncate_raw_md(decision.body or "")
    truncated = len(raw_md) < len(decision.body or "")

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
            f"truncated={truncated} landed_seq={seq} agent_exit={result.exit_code}",
            level="info",
        )
    except wr_api.RoomStateRaceError as exc:
        # Same race as the /present case but reached on the second
        # leg.  Do NOT fire on_post_failure — the room moved on,
        # not a transient failure; re-dispatching would just race
        # again.  The agent's exit code is preserved by the trigger
        # for observability.
        _log(
            f"raced room transition on contribute "
            f"room={room_id} subject={subject_ref} seq={current_sequence} "
            f"verdict={decision.verdict} code={exc.code}",
            level="info",
        )
    except Exception as exc:  # noqa: BLE001
        _log(
            f"contribute failed room={room_id} subject={subject_ref} "
            f"seq={current_sequence} verdict={decision.verdict}: "
            f"{type(exc).__name__}: {exc}",
            level="error",
        )
        # Both legs failed → no state change landed. Surface to
        # the trigger so the next tick re-dispatches.
        if present_failed_exc is not None:
            _safe_callback(
                on_post_failure, room_id, current_sequence, "contribute", exc,
            )


def _do_present_then_withdraw(
    *,
    base_url: str,
    bearer: str,
    room_id: str,
    current_sequence: int,
    subject_ref: str,
    decision: TriageDecision,
    on_post_failure: Optional[PostFailureCallback],
) -> None:
    """RSVP via /present, then withdraw via /withdraw.

    Closes #544 builder R1.1: storage requires an existing
    participant slot before withdrawal (war-room.ts:2776). A
    first-pass opt-out from /watching that calls /withdraw
    directly returns 409 `participant_not_found` and the withdraw
    event never lands — the worker is silently re-listed by the
    next /watching tick.

    Two API calls vs one is the correct trade vs relaxing the
    storage contract. The /present call here mirrors the
    PRESENT-path's RSVP step exactly; the only difference is
    leg 2 (/withdraw vs /contribute).
    """

    present_failed = False
    try:
        wr_api.present_to_room(
            base_url=base_url,
            room_id=room_id,
            sequence_observed_by_client=current_sequence,
            bearer=bearer,
            intent_hint=decision.reason,
        )
    except wr_api.RoomStateRaceError as exc:
        # See `_do_present_and_contribute` for the rationale: the
        # room moved on, /withdraw will also race, no callback.
        _log(
            f"raced room transition on present (for withdraw) "
            f"room={room_id} subject={subject_ref} seq={current_sequence} "
            f"code={exc.code} — skipping withdraw",
            level="info",
        )
        return
    except Exception as exc:  # noqa: BLE001
        present_failed = True
        _log(
            f"present (for withdraw) failed (continuing to withdraw) "
            f"room={room_id} subject={subject_ref} seq={current_sequence}: "
            f"{type(exc).__name__}: {exc}",
            level="warn",
        )

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
    except wr_api.RoomStateRaceError as exc:
        _log(
            f"raced room transition on withdraw "
            f"room={room_id} subject={subject_ref} seq={current_sequence} "
            f"code={exc.code}",
            level="info",
        )
    except Exception as exc:  # noqa: BLE001
        _log(
            f"withdraw failed room={room_id} subject={subject_ref} "
            f"seq={current_sequence}: {type(exc).__name__}: {exc}",
            level="error",
        )
        if present_failed:
            _safe_callback(
                on_post_failure, room_id, current_sequence, "withdraw", exc,
            )


def _safe_callback(
    callback: Optional[PostFailureCallback],
    room_id: str,
    sequence: int,
    op_kind: str,
    exc: Exception,
) -> None:
    """Invoke the post-failure callback, swallowing any exception
    it raises so a buggy trigger can't propagate into the engine's
    job lifecycle."""
    if callback is None:
        return
    try:
        callback(room_id, sequence, op_kind, exc)
    except Exception as cb_exc:  # noqa: BLE001
        _log(
            f"on_post_failure callback raised "
            f"room={room_id} seq={sequence} op={op_kind}: "
            f"{type(cb_exc).__name__}: {cb_exc}",
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
