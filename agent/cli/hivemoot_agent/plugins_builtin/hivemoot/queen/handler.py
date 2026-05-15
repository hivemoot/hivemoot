"""Local queen job completion handler."""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from hivemoot_agent.plugins.interfaces import AgentResult, Job
from hivemoot_agent.plugins_builtin.hivemoot.queen import api as q_api
from hivemoot_agent.plugins_builtin.hivemoot.queen import gh


JOB_KIND_SYNTHESIS = "queen_synthesis"

_VALID_VERDICTS = {"APPROVE", "COMMENT", "CONCERNS", "REQUEST_CHANGES"}
_VALID_ACTIONS = {"comment", "squash-merge"}
_HIVEMOOT_HTML_COMMENT_RE = re.compile(
    r"<!--\s*hivemoot(?:[-:][\s\S]*?)?-->",
    re.IGNORECASE,
)


@dataclass
class QueenDecisionOutput:
    verdict: str
    reasoning: str
    recommended_action: str
    comment_body: str


def is_queen_job(job: Job) -> bool:
    return bool(
        job.metadata.get("job_kind") == JOB_KIND_SYNTHESIS
        and job.metadata.get("room_id")
    )


def build_seal_header(verb: str, audit_id: str) -> str:
    if verb not in {"merge", "comment"}:
        raise ValueError("seal verb must be merge or comment")
    if not audit_id:
        raise ValueError("audit_id must be non-empty")
    return f"<!-- hivemoot:queen-action:{verb}:{audit_id} -->"


def parse_decision_output(markdown: str) -> QueenDecisionOutput:
    data = _extract_json_object(markdown)
    verdict = str(data.get("verdict") or "").strip().upper()
    if verdict not in _VALID_VERDICTS:
        raise ValueError(
            f"verdict must be one of {', '.join(sorted(_VALID_VERDICTS))}"
        )

    reasoning = str(data.get("reasoning") or "").strip()
    if len(reasoning) > 500:
        reasoning = reasoning[:500]

    action = str(
        data.get("recommended_action")
        or data.get("recommendedAction")
        or "",
    ).strip().lower()
    if action not in _VALID_ACTIONS:
        raise ValueError("recommended_action must be comment or squash-merge")

    body = str(
        data.get("comment_body")
        or data.get("commentBody")
        or data.get("body")
        or "",
    ).strip()
    if not body:
        body = reasoning or f"Queen synthesized verdict: {verdict}."

    return QueenDecisionOutput(
        verdict=verdict,
        reasoning=reasoning,
        recommended_action=action,
        comment_body=_sanitize_comment_body(body),
    )


def handle_queen_job_finished(
    job: Job,
    result: AgentResult,
    *,
    base_url: str,
    bearer: str,
    extracted_markdown: str,
    queen_runner: str,
    agent_id: str | None = None,
    gh_timeout_secs: int = 30,
    enable_squash_merge: bool = False,
) -> None:
    if not is_queen_job(job):
        return

    room_id = str(job.metadata.get("room_id") or "")
    subject_ref = str(job.metadata.get("subject_ref") or "")
    sealed_through_sequence = _metadata_int(job, "sealed_through_sequence")
    reviewed_head_sha = str(job.metadata.get("reviewed_head_sha") or "").strip()

    if result.exit_code != 0:
        print(
            f"[hivemoot-queen] synthesis job failed room={room_id} "
            f"exit={result.exit_code}; claim TTL will release",
            file=sys.stderr,
            flush=True,
        )
        return
    if not bearer:
        raise RuntimeError("missing local queen bearer")
    if not queen_runner:
        raise RuntimeError("missing queen runner id")
    if not room_id or not subject_ref:
        raise RuntimeError("queen job metadata missing room_id/subject_ref")
    if sealed_through_sequence < 0:
        raise RuntimeError("queen job metadata missing sealed_through_sequence")
    if not reviewed_head_sha:
        raise RuntimeError("queen job metadata missing reviewed_head_sha")

    decision = parse_decision_output(extracted_markdown)
    recommended_action = (
        decision.recommended_action if enable_squash_merge else "comment"
    )

    resolved = q_api.resolve_action(
        base_url,
        room_id,
        bearer,
        queen_runner=queen_runner,
        verdict=decision.verdict,
        reasoning=decision.reasoning,
        recommended_action=recommended_action,
        reviewed_head_sha=reviewed_head_sha,
        sealed_through_sequence=sealed_through_sequence,
    )

    if resolved.permitted_action == "squash-merge" and not enable_squash_merge:
        raise RuntimeError(
            "local queen squash-merge path was permitted while "
            "enable_squash_merge=false"
        )
    if resolved.permitted_action not in {"comment", "squash-merge"}:
        raise RuntimeError(
            f"resolve-action returned unknown permittedAction={resolved.permitted_action}"
        )

    pr = gh.parse_subject_ref(subject_ref)
    token = q_api.mint_installation_token(
        base_url,
        bearer,
        repo=pr.full_repo,
        agent_id=agent_id,
    )

    public_comment = _build_public_comment(
        decision=decision,
        audit_id=resolved.audit_id,
        permitted_action=resolved.permitted_action,
    )

    try:
        comment_url = gh.post_pr_comment(
            pr,
            public_comment,
            token=token,
            timeout_secs=gh_timeout_secs,
        )
    except Exception as exc:
        if resolved.permitted_action == "squash-merge":
            q_api.seal_decision(
                base_url,
                room_id,
                bearer,
                queen_runner=queen_runner,
                audit_id=resolved.audit_id,
                sealed_through_sequence=sealed_through_sequence,
                decision=_room_decision(
                    queen_runner=queen_runner,
                    sealed_through_sequence=sealed_through_sequence,
                    content=decision.comment_body,
                ),
                downgrade_reason="intended_action_post_failed",
                error_class=type(exc).__name__,
                retry_count=1,
            )
        raise

    final_state = (
        "decided_pending_action"
        if resolved.permitted_action == "squash-merge"
        else "closed"
    )
    sealed = _seal_decision_with_retry(
        base_url,
        room_id,
        bearer,
        queen_runner=queen_runner,
        audit_id=resolved.audit_id,
        sealed_through_sequence=sealed_through_sequence,
        decision=_room_decision(
            queen_runner=queen_runner,
            sealed_through_sequence=sealed_through_sequence,
            content=decision.comment_body,
        ),
        final_state=final_state,
        comment_url=comment_url,
    )

    print(
        f"[hivemoot-queen] sealed room={room_id} "
        f"finalState={sealed.final_state} auditId={sealed.audit_id}",
        file=sys.stderr,
        flush=True,
    )


def _extract_json_object(markdown: str) -> dict[str, Any]:
    text = markdown.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    else:
        first = text.find("{")
        if first >= 0:
            text = text[first:]

    decoder = json.JSONDecoder()
    try:
        parsed, _ = decoder.raw_decode(text)
    except json.JSONDecodeError as exc:
        raise ValueError("queen output did not contain a JSON object") from exc
    if not isinstance(parsed, dict):
        raise ValueError("queen output JSON must be an object")
    return parsed


def _sanitize_comment_body(body: str) -> str:
    cleaned = _HIVEMOOT_HTML_COMMENT_RE.sub("", body).strip()
    return cleaned or "Queen synthesized a decision for this PR."


def _seal_decision_with_retry(
    base_url: str,
    room_id: str,
    bearer: str,
    *,
    queen_runner: str,
    audit_id: str,
    sealed_through_sequence: int,
    decision: dict[str, Any],
    final_state: str,
    comment_url: str,
) -> q_api.SealDecisionResult:
    kwargs: dict[str, Any] = {
        "queen_runner": queen_runner,
        "audit_id": audit_id,
        "sealed_through_sequence": sealed_through_sequence,
        "decision": decision,
        "final_state": final_state,
        "comment_url": comment_url,
    }
    try:
        return q_api.seal_decision(base_url, room_id, bearer, **kwargs)
    except Exception as exc:
        print(
            f"[hivemoot-queen] seal-decision retry room={room_id}: "
            f"{type(exc).__name__}: {exc}",
            file=sys.stderr,
            flush=True,
        )
        kwargs["retry_count"] = 1
        return q_api.seal_decision(base_url, room_id, bearer, **kwargs)


def _build_public_comment(
    *,
    decision: QueenDecisionOutput,
    audit_id: str,
    permitted_action: str,
) -> str:
    verb = "merge" if permitted_action == "squash-merge" else "comment"
    header = build_seal_header(verb, audit_id)
    return f"{header}\n\n{decision.comment_body.strip()}\n"


def _room_decision(
    *,
    queen_runner: str,
    sealed_through_sequence: int,
    content: str,
) -> dict[str, Any]:
    return {
        "synthesized_at": datetime.now(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "synthesis_runner": queen_runner,
        "content": content,
        "sequence_closed": sealed_through_sequence,
    }


def _metadata_int(job: Job, key: str) -> int:
    value = job.metadata.get(key)
    if isinstance(value, bool):
        return -1
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return -1
    return -1
