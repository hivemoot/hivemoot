"""War-room API client — worker side.

GETs `/api/rooms/watching` for the role-bound list of rooms this
worker should attend to, and POSTs the lifecycle events
(`/present`, `/contributions`, `/withdraw`).

Auth: `rooms.watch` for `/watching`; `rooms.contribute` for the
write paths. Both come from the worker's V1 capability bearer
(provisioned via `apiary.secrets.yaml` and threaded through the
existing ``..auth.resolve_agent_token`` helper).

Transport: shared ``..http`` client. Same redirect refusal +
URL-scheme guard as the tasks plugin.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from hivemoot_agent.plugins_builtin.hivemoot.http import (
    DEFAULT_TIMEOUT_SECS,
    get_json,
    post_json,
)


__all__ = (
    "RoomStateRaceError",
    "WatchingRoom",
    "heartbeat_room_participant",
    "list_watching_rooms",
    "present_to_room",
    "submit_contribution",
    "withdraw_participant",
)


class RoomStateRaceError(RuntimeError):
    """The room moved to a status that no longer accepts this op
    while the worker was producing its triage.  Distinguishes
    benign races (e.g. queen claimed → `deciding` between the
    worker's triage finishing and its /present) from real failures
    (network, 5xx, malformed bearer, etc.).

    Carries the underlying API error code (`status_precondition_failed`,
    etc.) so the handler can log it at info level and skip the
    post-failure callback — there's nothing to retry, the room is
    already past us.
    """

    def __init__(self, op: str, code: str, body_excerpt: str) -> None:
        super().__init__(
            f"{op} lost race to room state transition (code={code}): {body_excerpt}",
        )
        self.op = op
        self.code = code
        self.body_excerpt = body_excerpt


# API error codes the storage layer returns to indicate a benign
# race rather than a transient failure. Mapped to RoomStateRaceError
# so the caller stops retrying — the next dispatch tick rebuilds
# state instead. Indexed by HTTP status so each code only fires for
# the response shape that actually carries it.
#
# 409s:
#   * status_precondition_failed — room left ``awaiting_contributions``
#     (closed / deciding / expired). Affects every op kind.
#   * owner_conflict — first-wins gate lost; another runner already
#     holds this role's slot in subscriber-mode. Surfaced by /present
#     and /heartbeat.
#
# 404s (added per guard's PR #615 review feedback so heartbeats stop
# instead of spinning forever):
#   * room_not_found — operator deleted the room mid-flight, or the
#     ``roomId`` metadata was stale. Terminal — nothing to retry.
#   * participant_not_found — slot was withdrawn or never created.
#     Also terminal; the lifecycle is over.
_RACE_CODES_BY_STATUS: dict[int, frozenset[str]] = {
    409: frozenset({"status_precondition_failed", "owner_conflict"}),
    404: frozenset({"room_not_found", "participant_not_found"}),
}


def _maybe_raise_race(
    *,
    op: str,
    status: int,
    parsed: Any,
    raw: bytes,
) -> None:
    """Raise `RoomStateRaceError` when the response is one of the
    known race-class statuses (4xx with a code we recognize as a
    benign state shift). No-op for 2xx or any other status —
    callers still wrap those as generic ``RuntimeError`` so the
    failure-mode signal isn't lost.

    Single source of race-detection truth used by every war_rooms.api
    helper. Closes guard's PR #615 review point about duplicate race
    detection logic between heartbeat_room_participant and the
    legacy /present, /contribute, /withdraw helpers.
    """
    codes = _RACE_CODES_BY_STATUS.get(status)
    if codes is None:
        return
    if not isinstance(parsed, dict):
        return
    code = parsed.get("code")
    if not isinstance(code, str) or code not in codes:
        return
    raise RoomStateRaceError(
        op=op,
        code=code,
        body_excerpt=raw.decode(errors="replace")[:200],
    )


@dataclass
class WatchingRoom:
    """One room from the `/watching` enriched response.

    The watching endpoint pre-filters by the bearer's `agent_role`
    via `canRoleRsvpToRoom` (storage layer). Workers don't need
    to compute eligibility themselves — every room here is one
    the role SHOULD act on.

    Carries enough context (`core` + `participants` + `current_sequence`)
    that the worker can decide RSVP-vs-contribute without a
    follow-up read on the API.
    """

    room_id: str
    status: str
    subject_type: str
    subject_ref: str
    manager: str
    opened_at: str
    current_sequence: int
    participants: dict[str, Any] = field(default_factory=dict)


def _parse_room(entry: dict) -> WatchingRoom:
    """Parse one `/watching` response entry. Defensive — server
    may add fields; this client tolerates extras silently and
    rejects only on missing-required."""
    core = entry.get("core") or {}
    participants = entry.get("participants") or {}
    current_sequence = entry.get("currentSequence", 0)

    room_id = str(core.get("roomId", "")).strip()
    if not room_id:
        raise RuntimeError(
            "watching response entry missing core.roomId: "
            f"{str(entry)[:200]}"
        )
    return WatchingRoom(
        room_id=room_id,
        status=str(core.get("status", "")),
        subject_type=str(core.get("subject_type", "")),
        subject_ref=str(core.get("subject_ref", "")),
        manager=str(core.get("manager", "")),
        opened_at=str(core.get("opened_at", "")),
        current_sequence=int(current_sequence)
        if isinstance(current_sequence, (int, str))
        else 0,
        participants=participants if isinstance(participants, dict) else {},
    )


def list_watching_rooms(
    base_url: str,
    bearer: str,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> list[WatchingRoom]:
    """GET `{base_url}/api/rooms/watching`.

    Returns the list of rooms eligible for the bearer's role.
    Empty list when there's nothing to attend to (steady state
    for an idle fleet).

    Raises:
        RuntimeError on non-200 status / malformed body. Trigger
        loop's outer try/except engages backoff.
    """
    url = f"{base_url.rstrip('/')}/api/rooms/watching"
    status, parsed, raw = get_json(url, bearer, timeout=timeout)

    if status != 200:
        raise RuntimeError(
            f"watching returned status {status}: "
            f"{raw.decode(errors='replace')[:200]}"
        )

    if not isinstance(parsed, dict):
        raise RuntimeError("watching response was not a JSON object")

    rooms_raw = parsed.get("rooms")
    if rooms_raw is None:
        return []
    if not isinstance(rooms_raw, list):
        raise RuntimeError(
            f"watching response `rooms` must be a list, got {type(rooms_raw).__name__}"
        )

    out: list[WatchingRoom] = []
    for entry in rooms_raw:
        if not isinstance(entry, dict):
            continue
        out.append(_parse_room(entry))
    return out


def present_to_room(
    base_url: str,
    room_id: str,
    sequence_observed_by_client: int,
    bearer: str,
    *,
    intent_hint: str | None = None,
    agent_id: str | None = None,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> int:
    """POST `{base_url}/api/rooms/{room_id}/present`.

    The role is server-derived from the bearer envelope; ``agent_id``
    is the per-runner identity for the subscriber-mode first-wins
    gate (#522). When omitted the server falls back to the bearer's
    ``name`` — single-runner deployments don't need to set it.
    Sequence is the ``current_sequence`` the worker observed on
    ``/watching`` (used for idempotency).

    Closes guard's PR #615 review point about subscriber-mode
    asymmetry: ``/heartbeat`` carries ``agent_id`` for the gate;
    ``/present`` MUST carry the same identity so both calls hit
    the same slot. Without this, runner-A's /present creates a
    slot at agent_id=bearer.name, then runner-A's /heartbeat with
    body.agentId="runner-A" hits the owner_conflict path.

    Returns the sequence the `participant_presented` event landed at.

    Raises:
        RoomStateRaceError on the known benign-race codes
        (status_precondition_failed, owner_conflict, room_not_found,
        participant_not_found).
        RuntimeError on any other non-2xx / malformed body.
    """
    url = f"{base_url.rstrip('/')}/api/rooms/{room_id}/present"
    body: dict[str, Any] = {
        "sequenceObservedByClient": sequence_observed_by_client,
    }
    if intent_hint is not None:
        body["intentHint"] = intent_hint
    if agent_id is not None:
        body["agentId"] = agent_id

    status, parsed, raw = post_json(url, body, bearer, timeout=timeout)

    _maybe_raise_race(op="present", status=status, parsed=parsed, raw=raw)
    if status != 200:
        raise RuntimeError(
            f"present returned status {status}: "
            f"{raw.decode(errors='replace')[:200]}"
        )

    if not isinstance(parsed, dict):
        raise RuntimeError("present response was not a JSON object")

    seq = parsed.get("sequence")
    if not isinstance(seq, int):
        raise RuntimeError(
            f"present response missing/invalid `sequence`: {str(parsed)[:200]}"
        )
    return seq


def submit_contribution(
    base_url: str,
    room_id: str,
    sequence_observed_by_client: int,
    contribution_body: dict[str, Any],
    raw_md: str,
    bearer: str,
    *,
    agent_id: str | None = None,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> int:
    """POST `{base_url}/api/rooms/{room_id}/contributions`.

    Submits a typed contribution body (verdict + summary + findings)
    plus the worker's raw markdown analysis. Both bounded server-
    side (body schema + 32 KiB raw_md cap).

    ``agent_id`` follows the same subscriber-mode-parity contract as
    ``/present`` and ``/heartbeat`` — the storage layer's per-(room,
    role) gate compares it to the slot's existing ``agent_id``, so
    the value MUST match what was passed on the slot's first
    ``/present``. When omitted the server falls back to ``bearer.name``;
    that fallback was the regression PR #618 partially fixed (only
    on /present) — /contribute had the same hole, captured here.

    Returns the sequence the `contribution_submitted` event landed at.
    """
    url = f"{base_url.rstrip('/')}/api/rooms/{room_id}/contributions"
    body: dict[str, Any] = {
        "sequenceObservedByClient": sequence_observed_by_client,
        "body": contribution_body,
        "rawMd": raw_md,
    }
    if agent_id is not None:
        body["agentId"] = agent_id
    status, parsed, raw = post_json(url, body, bearer, timeout=timeout)

    _maybe_raise_race(op="contributions", status=status, parsed=parsed, raw=raw)
    if status != 200:
        raise RuntimeError(
            f"contributions returned status {status}: "
            f"{raw.decode(errors='replace')[:200]}"
        )

    if not isinstance(parsed, dict):
        raise RuntimeError("contributions response was not a JSON object")

    seq = parsed.get("sequence")
    if not isinstance(seq, int):
        raise RuntimeError(
            f"contributions response missing/invalid `sequence`: {str(parsed)[:200]}"
        )
    return seq


def heartbeat_room_participant(
    base_url: str,
    room_id: str,
    bearer: str,
    *,
    agent_id: str | None = None,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> str | None:
    """POST `{base_url}/api/rooms/{room_id}/heartbeat`.

    Pure-liveness ping that bumps the participant's ``rsvp_at`` so
    the watchdog ``drop_threshold_secs`` timeout doesn't fire on a
    worker still doing genuine work. Per the JOB_LIFECYCLE_UNIFICATION
    RFC's Q3 decision: **no payload**. The optional ``agent_id`` is
    the per-runner identity for the first-wins gate (#522) — when
    omitted the server falls back to the bearer's ``name``.

    Returns:
        ISO-8601 timestamp string when the heartbeat applied. The
        caller can log it to confirm the slot is healthy.
        ``None`` when the server reports a benign no-op
        (``skipped: "non_pending"``) — the participant has already
        withdrawn / resolved / timed_out and the lifecycle should
        stop heartbeating. Caller MUST NOT treat this as an error.

    Raises:
        RoomStateRaceError: any of the known race codes:
            * 409 ``status_precondition_failed`` — room left
              awaiting_contributions.
            * 409 ``owner_conflict`` — different runner holds the
              slot (subscriber-mode collision).
            * 404 ``room_not_found`` — room is gone.
            * 404 ``participant_not_found`` — slot was never created
              (caller never /presented) or has been removed.
            All four indicate the lifecycle should stop heartbeating
            for this Job — the next dispatch tick rebuilds state.
        RuntimeError: any other non-2xx / malformed body. Caller
            logs and keeps trying — a transient network blip is
            recoverable on the next tick.
    """
    url = f"{base_url.rstrip('/')}/api/rooms/{room_id}/heartbeat"
    body: dict[str, Any] = {}
    if agent_id is not None:
        body["agentId"] = agent_id

    status, parsed, raw = post_json(url, body, bearer, timeout=timeout)

    # Race-class codes (4xx with a known code) — single helper covers
    # all of them so heartbeat shares the same race detection used by
    # /present, /contribute, /withdraw. Closes guard's PR #615 review
    # point about duplicate logic.
    _maybe_raise_race(op="heartbeat", status=status, parsed=parsed, raw=raw)

    if status != 200:
        raise RuntimeError(
            f"heartbeat returned status {status}: "
            f"{raw.decode(errors='replace')[:200]}"
        )

    if not isinstance(parsed, dict):
        raise RuntimeError("heartbeat response was not a JSON object")

    # Benign no-op — slot already withdrew/resolved/timed_out. The
    # storage-layer Lua script returns null upstream → the route
    # returns `{ skipped: "non_pending" }`. Stop heartbeating; the
    # caller's `_presented` flag (or equivalent) should track this.
    if parsed.get("skipped") == "non_pending":
        return None

    rsvp_at = parsed.get("rsvpAt")
    if not isinstance(rsvp_at, str):
        raise RuntimeError(
            f"heartbeat response missing/invalid `rsvpAt`: "
            f"{str(parsed)[:200]}"
        )
    return rsvp_at


def withdraw_participant(
    base_url: str,
    room_id: str,
    sequence_observed_by_client: int,
    bearer: str,
    *,
    reason: str | None = None,
    agent_id: str | None = None,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> int:
    """POST `{base_url}/api/rooms/{room_id}/withdraw`.

    Worker explicitly withdraws their RSVP — used when triage
    determines no contribution is warranted (PR too small, out
    of scope, etc.). Distinct from `submit_contribution` (a
    contribution that opts out via `verdict: COMMENT`).

    ``agent_id`` follows the same subscriber-mode-parity contract
    as ``/present``, ``/contribute``, and ``/heartbeat`` — must
    match the slot's existing ``agent_id`` or the storage layer's
    first-wins gate raises owner_conflict.

    Returns the sequence the `participant_withdrawn` event landed at.
    """
    url = f"{base_url.rstrip('/')}/api/rooms/{room_id}/withdraw"
    body: dict[str, Any] = {
        "sequenceObservedByClient": sequence_observed_by_client,
    }
    if reason is not None:
        body["reason"] = reason
    if agent_id is not None:
        body["agentId"] = agent_id

    status, parsed, raw = post_json(url, body, bearer, timeout=timeout)

    _maybe_raise_race(op="withdraw", status=status, parsed=parsed, raw=raw)
    if status != 200:
        raise RuntimeError(
            f"withdraw returned status {status}: "
            f"{raw.decode(errors='replace')[:200]}"
        )

    if not isinstance(parsed, dict):
        raise RuntimeError("withdraw response was not a JSON object")

    seq = parsed.get("sequence")
    if not isinstance(seq, int):
        raise RuntimeError(
            f"withdraw response missing/invalid `sequence`: {str(parsed)[:200]}"
        )
    return seq
