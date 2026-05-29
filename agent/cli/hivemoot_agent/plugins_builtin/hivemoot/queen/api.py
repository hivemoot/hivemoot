"""Local queen API client.

Worker-side wrappers for the web endpoints used by the hive-hosted
queen runner. The transport stays on the shared hivemoot HTTP client
so bearer handling, redirect refusal, and timeout behavior match the
existing tasks and war-room clients.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote
from uuid import uuid4

from hivemoot_agent.plugins_builtin.hivemoot.http import (
    DEFAULT_TIMEOUT_SECS,
    get_json,
    post_json,
)


__all__ = (
    "ClaimedSynthesis",
    "ConfirmMergeResult",
    "CreatedRoom",
    "MergeReportResult",
    "QueenAPIConflictError",
    "ResolveActionResult",
    "RoomSummary",
    "SealDecisionResult",
    "SynthesisReadyRoom",
    "append_subject_updated_event",
    "claim_synthesis",
    "confirm_merge",
    "create_pr_review_room",
    "get_room_participants",
    "list_room_events",
    "list_decided_pending_ready_rooms",
    "list_rooms",
    "list_synthesis_ready_rooms",
    "mint_installation_token",
    "report_merge_result",
    "resolve_action",
    "seal_decision",
)


class QueenAPIConflictError(RuntimeError):
    """A benign 409 from a local-queen endpoint.

    The room moved, the claim is already held, or the caller's claim
    view is stale. Trigger/handler code should log and wait for the
    next poll rather than crashing the agent process.
    """

    def __init__(self, op: str, code: str, body_excerpt: str) -> None:
        super().__init__(f"{op} returned conflict code={code}: {body_excerpt}")
        self.op = op
        self.code = code
        self.body_excerpt = body_excerpt


@dataclass
class SynthesisReadyRoom:
    room_id: str
    status: str
    subject_type: str
    subject_ref: str
    manager: str
    opened_at: str
    timing_config: dict[str, Any] = field(default_factory=dict)
    closed_at: str = ""


@dataclass
class RoomSummary:
    room_id: str
    status: str
    subject_type: str
    subject_ref: str
    manager: str
    opened_at: str
    timing_config: dict[str, Any] = field(default_factory=dict)
    closed_at: str = ""


@dataclass
class CreatedRoom:
    room_id: str
    subject_ref: str
    status: str


@dataclass
class ClaimedSynthesis:
    room_id: str
    through_sequence: int
    claim_ttl_secs: int
    room: dict[str, Any]
    participants: dict[str, Any]
    contributions: dict[str, Any]


@dataclass
class ResolveActionResult:
    permitted_action: str
    clamped_verdict: str
    downgrade_reason: str | None
    reviewed_head_sha: str
    current_head_sha: str
    floor_overridden: bool
    audit_id: str


@dataclass
class SealDecisionResult:
    final_state: str
    closed_sequence: int
    audit_id: str
    pending_sequence: int = 0
    idempotent: bool = False


@dataclass
class ConfirmMergeResult:
    decision_outcome: str
    decision_outcome_reason: str | None
    github_merge_status: str | None
    merge_attempt_id: str
    closed_sequence: int
    idempotent: bool = False


@dataclass
class MergeReportResult:
    github_merge_status: str
    merge_attempt_id: str
    merge_commit_oid: str | None
    error_class: str | None
    idempotent: bool = False


def _room_path(room_id: str) -> str:
    return quote(room_id, safe="")


def _body_excerpt(raw: bytes) -> str:
    return raw.decode(errors="replace")[:200]


def _as_int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return default
    return default


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _parse_ready_room(entry: dict[str, Any]) -> SynthesisReadyRoom:
    room_id = str(entry.get("roomId") or entry.get("room_id") or "").strip()
    if not room_id:
        raise RuntimeError(f"synthesis-ready room missing roomId: {str(entry)[:200]}")
    return SynthesisReadyRoom(
        room_id=room_id,
        status=str(entry.get("status") or ""),
        subject_type=str(entry.get("subject_type") or entry.get("subjectType") or ""),
        subject_ref=str(entry.get("subject_ref") or entry.get("subjectRef") or ""),
        manager=str(entry.get("manager") or ""),
        opened_at=str(entry.get("opened_at") or entry.get("openedAt") or ""),
        timing_config=_as_dict(
            entry.get("timing_config") or entry.get("timingConfig"),
        ),
        closed_at=str(entry.get("closed_at") or entry.get("closedAt") or ""),
    )


def _parse_room_summary(entry: dict[str, Any]) -> RoomSummary:
    room_id = str(entry.get("roomId") or entry.get("room_id") or "").strip()
    if not room_id:
        raise RuntimeError(f"room summary missing roomId: {str(entry)[:200]}")
    return RoomSummary(
        room_id=room_id,
        status=str(entry.get("status") or ""),
        subject_type=str(entry.get("subject_type") or entry.get("subjectType") or ""),
        subject_ref=str(entry.get("subject_ref") or entry.get("subjectRef") or ""),
        manager=str(entry.get("manager") or ""),
        opened_at=str(entry.get("opened_at") or entry.get("openedAt") or ""),
        timing_config=_as_dict(
            entry.get("timing_config") or entry.get("timingConfig"),
        ),
        closed_at=str(entry.get("closed_at") or entry.get("closedAt") or ""),
    )


def list_synthesis_ready_rooms(
    base_url: str,
    bearer: str,
    *,
    limit: int = 10,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> list[SynthesisReadyRoom]:
    url = (
        f"{base_url.rstrip('/')}/api/rooms/synthesis-ready?"
        f"limit={max(1, int(limit))}"
    )
    status, parsed, raw = get_json(url, bearer, timeout=timeout)
    if status != 200:
        raise RuntimeError(
            f"synthesis-ready returned status {status}: {_body_excerpt(raw)}"
        )
    if not isinstance(parsed, dict):
        raise RuntimeError("synthesis-ready response was not a JSON object")
    rooms_raw = parsed.get("rooms")
    if rooms_raw is None:
        return []
    if not isinstance(rooms_raw, list):
        raise RuntimeError("synthesis-ready response `rooms` must be a list")
    rooms: list[SynthesisReadyRoom] = []
    for entry in rooms_raw:
        if isinstance(entry, dict):
            rooms.append(_parse_ready_room(entry))
    return rooms


def list_decided_pending_ready_rooms(
    base_url: str,
    bearer: str,
    *,
    limit: int = 10,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> list[SynthesisReadyRoom]:
    url = (
        f"{base_url.rstrip('/')}/api/rooms/decided-pending-ready?"
        f"limit={max(1, int(limit))}"
    )
    status, parsed, raw = get_json(url, bearer, timeout=timeout)
    if status != 200:
        raise RuntimeError(
            f"decided-pending-ready returned status {status}: {_body_excerpt(raw)}"
        )
    if not isinstance(parsed, dict):
        raise RuntimeError("decided-pending-ready response was not a JSON object")
    rooms_raw = parsed.get("rooms")
    if rooms_raw is None:
        return []
    if not isinstance(rooms_raw, list):
        raise RuntimeError("decided-pending-ready response `rooms` must be a list")
    rooms: list[SynthesisReadyRoom] = []
    for entry in rooms_raw:
        if isinstance(entry, dict):
            rooms.append(_parse_ready_room(entry))
    return rooms


def list_rooms(
    base_url: str,
    bearer: str,
    *,
    limit: int = 200,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> list[RoomSummary]:
    url = f"{base_url.rstrip('/')}/api/rooms?limit={max(1, int(limit))}"
    status, parsed, raw = get_json(url, bearer, timeout=timeout)
    if status != 200:
        raise RuntimeError(f"rooms returned status {status}: {_body_excerpt(raw)}")
    if not isinstance(parsed, dict):
        raise RuntimeError("rooms response was not a JSON object")
    rooms_raw = parsed.get("rooms")
    if rooms_raw is None:
        return []
    if not isinstance(rooms_raw, list):
        raise RuntimeError("rooms response `rooms` must be a list")
    rooms: list[RoomSummary] = []
    for entry in rooms_raw:
        if isinstance(entry, dict):
            rooms.append(_parse_room_summary(entry))
    return rooms


def create_pr_review_room(
    base_url: str,
    bearer: str,
    *,
    subject_ref: str,
    manager: str,
    quiet_period_secs: int = 180,
    max_age_secs: int = 3600,
    drop_threshold_secs: int = 1200,
    room_id: str | None = None,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> CreatedRoom:
    created_room_id = room_id or str(uuid4())
    url = f"{base_url.rstrip('/')}/api/rooms"
    status, parsed, raw = post_json(
        url,
        {
            "roomId": created_room_id,
            "manager": manager,
            "subject": {"type": "pr_review", "ref": subject_ref},
            "timing": {
                "quiet_period_secs": max(0, int(quiet_period_secs)),
                "max_age_secs": max(1, int(max_age_secs)),
                "drop_threshold_secs": max(0, int(drop_threshold_secs)),
            },
        },
        bearer,
        timeout=timeout,
    )
    if status == 409 and isinstance(parsed, dict):
        raise QueenAPIConflictError(
            "create-room",
            str(parsed.get("code") or "conflict"),
            _body_excerpt(raw),
        )
    if status != 201:
        raise RuntimeError(
            f"create-room returned status {status}: {_body_excerpt(raw)}"
        )
    if not isinstance(parsed, dict):
        raise RuntimeError("create-room response was not a JSON object")
    return CreatedRoom(
        room_id=str(parsed.get("roomId") or parsed.get("room_id") or created_room_id),
        subject_ref=str(parsed.get("subject_ref") or parsed.get("subjectRef") or subject_ref),
        status=str(parsed.get("status") or "awaiting_contributions"),
    )


def append_subject_updated_event(
    base_url: str,
    room_id: str,
    bearer: str,
    *,
    change_kind: str,
    head_sha: str | None = None,
    idempotency_key: str,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> int:
    url = f"{base_url.rstrip('/')}/api/rooms/{_room_path(room_id)}/event"
    body: dict[str, Any] = {"change_kind": change_kind}
    if head_sha:
        body["head_sha"] = head_sha
    status, parsed, raw = post_json(
        url,
        {
            "event_type": "subject_updated",
            "body": body,
            "idempotencyKey": idempotency_key,
        },
        bearer,
        timeout=timeout,
    )
    if status == 409 and isinstance(parsed, dict):
        raise QueenAPIConflictError(
            "subject-updated",
            str(parsed.get("code") or "conflict"),
            _body_excerpt(raw),
        )
    if status != 200:
        raise RuntimeError(
            f"subject-updated returned status {status}: {_body_excerpt(raw)}"
        )
    if not isinstance(parsed, dict):
        raise RuntimeError("subject-updated response was not a JSON object")
    return _as_int(parsed.get("sequence"))


def get_room_participants(
    base_url: str,
    room_id: str,
    bearer: str,
    *,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> dict[str, Any]:
    url = f"{base_url.rstrip('/')}/api/rooms/{_room_path(room_id)}/participants"
    status, parsed, raw = get_json(url, bearer, timeout=timeout)
    if status != 200:
        raise RuntimeError(
            f"participants returned status {status}: {_body_excerpt(raw)}"
        )
    if not isinstance(parsed, dict):
        raise RuntimeError("participants response was not a JSON object")
    return _as_dict(parsed.get("participants"))


def list_room_events(
    base_url: str,
    room_id: str,
    bearer: str,
    *,
    limit: int = 500,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> list[dict[str, Any]]:
    url = (
        f"{base_url.rstrip('/')}/api/rooms/{_room_path(room_id)}/events?"
        f"limit={max(1, int(limit))}"
    )
    status, parsed, raw = get_json(url, bearer, timeout=timeout)
    if status != 200:
        raise RuntimeError(f"events returned status {status}: {_body_excerpt(raw)}")
    if not isinstance(parsed, dict):
        raise RuntimeError("events response was not a JSON object")
    events = parsed.get("events")
    if events is None:
        return []
    if not isinstance(events, list):
        raise RuntimeError("events response `events` must be a list")
    return [e for e in events if isinstance(e, dict)]


def claim_synthesis(
    base_url: str,
    room_id: str,
    bearer: str,
    *,
    queen_runner: str,
    claim_ttl_secs: int,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> ClaimedSynthesis:
    url = f"{base_url.rstrip('/')}/api/rooms/{_room_path(room_id)}/claim-synthesis"
    status, parsed, raw = post_json(
        url,
        {"queenRunner": queen_runner, "claimTtlSecs": claim_ttl_secs},
        bearer,
        timeout=timeout,
    )
    if status == 409 and isinstance(parsed, dict):
        raise QueenAPIConflictError(
            "claim-synthesis",
            str(parsed.get("code") or "conflict"),
            _body_excerpt(raw),
        )
    if status != 200:
        raise RuntimeError(
            f"claim-synthesis returned status {status}: {_body_excerpt(raw)}"
        )
    if not isinstance(parsed, dict):
        raise RuntimeError("claim-synthesis response was not a JSON object")

    claim = _as_dict(parsed.get("claim"))
    through = _as_int(
        claim.get("throughSequence") or claim.get("through_sequence"),
    )
    if through < 0:
        raise RuntimeError("claim-synthesis returned invalid throughSequence")
    return ClaimedSynthesis(
        room_id=room_id,
        through_sequence=through,
        claim_ttl_secs=_as_int(
            claim.get("claimTtlSecs") or claim.get("claim_ttl_secs"),
            default=claim_ttl_secs,
        ),
        room=_as_dict(parsed.get("room")),
        participants=_as_dict(parsed.get("participants")),
        contributions=_as_dict(parsed.get("contributions")),
    )


def mint_installation_token(
    base_url: str,
    bearer: str,
    *,
    repo: str,
    agent_id: str | None = None,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> str:
    url = f"{base_url.rstrip('/')}/api/github/installation-tokens"
    body: dict[str, Any] = {"repo": repo}
    if agent_id:
        body["agent_id"] = agent_id
    status, parsed, raw = post_json(url, body, bearer, timeout=timeout)
    if status != 200:
        raise RuntimeError(
            f"installation-token mint returned status {status}: {_body_excerpt(raw)}"
        )
    if not isinstance(parsed, dict) or not isinstance(parsed.get("token"), str):
        raise RuntimeError("installation-token response missing token")
    return parsed["token"]


def resolve_action(
    base_url: str,
    room_id: str,
    bearer: str,
    *,
    queen_runner: str,
    verdict: str,
    reasoning: str,
    recommended_action: str,
    reviewed_head_sha: str,
    sealed_through_sequence: int,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> ResolveActionResult:
    url = f"{base_url.rstrip('/')}/api/rooms/{_room_path(room_id)}/resolve-action"
    status, parsed, raw = post_json(
        url,
        {
            "queenRunner": queen_runner,
            "derivedVerdict": {"verdict": verdict, "reasoning": reasoning},
            "recommendedAction": recommended_action,
            "reviewedHeadSha": reviewed_head_sha,
            "sealedThroughSequence": sealed_through_sequence,
        },
        bearer,
        timeout=timeout,
    )
    if status == 409 and isinstance(parsed, dict):
        raise QueenAPIConflictError(
            "resolve-action",
            str(parsed.get("code") or "conflict"),
            _body_excerpt(raw),
        )
    if status != 200:
        raise RuntimeError(
            f"resolve-action returned status {status}: {_body_excerpt(raw)}"
        )
    if not isinstance(parsed, dict):
        raise RuntimeError("resolve-action response was not a JSON object")
    audit_id = parsed.get("auditId") or parsed.get("audit_id")
    if not isinstance(audit_id, str) or not audit_id:
        raise RuntimeError("resolve-action response missing auditId")
    return ResolveActionResult(
        permitted_action=str(
            parsed.get("permittedAction") or parsed.get("permitted_action") or "",
        ),
        clamped_verdict=str(
            parsed.get("clampedVerdict") or parsed.get("clamped_verdict") or "",
        ),
        downgrade_reason=(
            str(parsed.get("downgradeReason") or parsed.get("downgrade_reason"))
            if parsed.get("downgradeReason") or parsed.get("downgrade_reason")
            else None
        ),
        reviewed_head_sha=str(
            parsed.get("reviewedHeadSha") or parsed.get("reviewed_head_sha") or "",
        ),
        current_head_sha=str(
            parsed.get("currentHeadSha") or parsed.get("current_head_sha") or "",
        ),
        floor_overridden=bool(
            parsed.get("floorOverridden") or parsed.get("floor_overridden") or False,
        ),
        audit_id=audit_id,
    )


def seal_decision(
    base_url: str,
    room_id: str,
    bearer: str,
    *,
    queen_runner: str,
    audit_id: str,
    sealed_through_sequence: int,
    decision: dict[str, Any],
    final_state: str = "closed",
    comment_url: str | None = None,
    downgrade_reason: str | None = None,
    error_class: str | None = None,
    retry_count: int | None = None,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> SealDecisionResult:
    url = f"{base_url.rstrip('/')}/api/rooms/{_room_path(room_id)}/seal-decision"
    body: dict[str, Any] = {
        "queenRunner": queen_runner,
        "auditId": audit_id,
        "finalState": final_state,
        "sealedThroughSequence": sealed_through_sequence,
        "decision": decision,
    }
    if comment_url:
        body["commentUrl"] = comment_url
    if downgrade_reason:
        body["downgradeReason"] = downgrade_reason
    if error_class:
        body["errorClass"] = error_class
    if retry_count is not None:
        body["retryCount"] = retry_count

    status, parsed, raw = post_json(url, body, bearer, timeout=timeout)
    if status == 409 and isinstance(parsed, dict):
        raise QueenAPIConflictError(
            "seal-decision",
            str(parsed.get("code") or "conflict"),
            _body_excerpt(raw),
        )
    if status != 200:
        raise RuntimeError(
            f"seal-decision returned status {status}: {_body_excerpt(raw)}"
        )
    if not isinstance(parsed, dict):
        raise RuntimeError("seal-decision response was not a JSON object")
    return SealDecisionResult(
        final_state=str(parsed.get("finalState") or parsed.get("final_state") or ""),
        closed_sequence=_as_int(
            parsed.get("closedSequence") or parsed.get("closed_sequence"),
        ),
        pending_sequence=_as_int(
            parsed.get("pendingSequence") or parsed.get("pending_sequence"),
        ),
        audit_id=str(parsed.get("auditId") or parsed.get("audit_id") or ""),
        idempotent=bool(parsed.get("idempotent") or False),
    )


def confirm_merge(
    base_url: str,
    room_id: str,
    bearer: str,
    *,
    queen_runner: str,
    merge_attempt_id: str,
    current_head_sha: str,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> ConfirmMergeResult:
    url = f"{base_url.rstrip('/')}/api/rooms/{_room_path(room_id)}/confirm-merge"
    status, parsed, raw = post_json(
        url,
        {
            "queenRunner": queen_runner,
            "mergeAttemptId": merge_attempt_id,
            "currentHeadSha": current_head_sha,
        },
        bearer,
        timeout=timeout,
    )
    if status == 409 and isinstance(parsed, dict):
        raise QueenAPIConflictError(
            "confirm-merge",
            str(parsed.get("code") or "conflict"),
            _body_excerpt(raw),
        )
    if status != 200:
        raise RuntimeError(
            f"confirm-merge returned status {status}: {_body_excerpt(raw)}"
        )
    if not isinstance(parsed, dict):
        raise RuntimeError("confirm-merge response was not a JSON object")
    return ConfirmMergeResult(
        decision_outcome=str(
            parsed.get("decisionOutcome") or parsed.get("decision_outcome") or "",
        ),
        decision_outcome_reason=(
            str(
                parsed.get("decisionOutcomeReason")
                or parsed.get("decision_outcome_reason")
            )
            if (
                parsed.get("decisionOutcomeReason")
                or parsed.get("decision_outcome_reason")
            )
            else None
        ),
        github_merge_status=(
            str(parsed.get("githubMergeStatus") or parsed.get("github_merge_status"))
            if parsed.get("githubMergeStatus") or parsed.get("github_merge_status")
            else None
        ),
        merge_attempt_id=str(
            parsed.get("mergeAttemptId") or parsed.get("merge_attempt_id") or "",
        ),
        closed_sequence=_as_int(
            parsed.get("closedSequence") or parsed.get("closed_sequence"),
        ),
        idempotent=bool(parsed.get("idempotent") or False),
    )


def report_merge_result(
    base_url: str,
    room_id: str,
    bearer: str,
    *,
    queen_runner: str,
    merge_attempt_id: str,
    github_merge_status: str,
    merge_commit_oid: str | None = None,
    error_class: str | None = None,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> MergeReportResult:
    url = (
        f"{base_url.rstrip('/')}/api/rooms/"
        f"{_room_path(room_id)}/report-merge-result"
    )
    body: dict[str, Any] = {
        "queenRunner": queen_runner,
        "mergeAttemptId": merge_attempt_id,
        "githubMergeStatus": github_merge_status,
    }
    if merge_commit_oid:
        body["mergeCommitOid"] = merge_commit_oid
    if error_class:
        body["errorClass"] = error_class
    status, parsed, raw = post_json(url, body, bearer, timeout=timeout)
    if status == 409 and isinstance(parsed, dict):
        raise QueenAPIConflictError(
            "report-merge-result",
            str(parsed.get("code") or "conflict"),
            _body_excerpt(raw),
        )
    if status != 200:
        raise RuntimeError(
            f"report-merge-result returned status {status}: {_body_excerpt(raw)}"
        )
    if not isinstance(parsed, dict):
        raise RuntimeError("report-merge-result response was not a JSON object")
    return MergeReportResult(
        github_merge_status=str(
            parsed.get("githubMergeStatus") or parsed.get("github_merge_status") or "",
        ),
        merge_attempt_id=str(
            parsed.get("mergeAttemptId") or parsed.get("merge_attempt_id") or "",
        ),
        merge_commit_oid=(
            str(parsed.get("mergeCommitOid") or parsed.get("merge_commit_oid"))
            if parsed.get("mergeCommitOid") or parsed.get("merge_commit_oid")
            else None
        ),
        error_class=(
            str(parsed.get("errorClass") or parsed.get("error_class"))
            if parsed.get("errorClass") or parsed.get("error_class")
            else None
        ),
        idempotent=bool(parsed.get("idempotent") or False),
    )
