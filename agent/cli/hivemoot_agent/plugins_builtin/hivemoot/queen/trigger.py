"""Local queen synthesis trigger.

Polls rooms that are candidates for synthesis, applies the local
eligibility gates that the status-only endpoint intentionally omits,
claims one room, captures a fresh PR head SHA, and dispatches a single
agent job.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from hivemoot_agent.plugins.interfaces import Job, JobDispatcher, PluginConfig
from hivemoot_agent.plugins_builtin.hivemoot.queen import api as q_api
from hivemoot_agent.plugins_builtin.hivemoot.queen import gh
from hivemoot_agent.plugins_builtin.hivemoot.queen.handler import (
    JOB_KIND_SYNTHESIS,
)
from hivemoot_agent.plugins_builtin.hivemoot.queen.prompts import (
    build_synthesis_prompt,
)


DEFAULT_POLL_INTERVAL_SECS = 60


@dataclass(frozen=True)
class PendingMergeReport:
    room_id: str
    subject_ref: str
    merge_attempt_id: str
    merge_commit_oid: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PendingMergeReport | None":
        room_id = str(data.get("room_id") or "").strip()
        subject_ref = str(data.get("subject_ref") or "").strip()
        merge_attempt_id = str(data.get("merge_attempt_id") or "").strip()
        merge_commit_oid = str(data.get("merge_commit_oid") or "").strip()
        if not room_id or not merge_attempt_id or not merge_commit_oid:
            return None
        return cls(
            room_id=room_id,
            subject_ref=subject_ref,
            merge_attempt_id=merge_attempt_id,
            merge_commit_oid=merge_commit_oid,
        )

    def to_dict(self) -> dict[str, str]:
        return {
            "room_id": self.room_id,
            "subject_ref": self.subject_ref,
            "merge_attempt_id": self.merge_attempt_id,
            "merge_commit_oid": self.merge_commit_oid,
        }


class LocalQueenSynthesisTrigger:
    """Poll and dispatch one local queen synthesis job at a time."""

    name = "hivemoot-queen"

    def __init__(
        self,
        plugin: Any,
        *,
        base_url: str,
        token_resolver: Callable[[], str],
        agent_id: str,
        poll_interval_secs: int = DEFAULT_POLL_INTERVAL_SECS,
        ready_limit: int = 10,
        claim_ttl_secs: int = 900,
        fallback_quiet_period_secs: int = 60,
        gh_timeout_secs: int = 30,
        enable_squash_merge: bool = False,
        merge_report_queue_file: str = "",
        log_prefix: str = "[hivemoot-queen]",
        list_ready_fn: Callable[
            ..., list[q_api.SynthesisReadyRoom]
        ] = q_api.list_synthesis_ready_rooms,
        list_pending_fn: Callable[
            ..., list[q_api.SynthesisReadyRoom]
        ] = q_api.list_decided_pending_ready_rooms,
        participants_fn: Callable[..., dict[str, Any]] = q_api.get_room_participants,
        events_fn: Callable[..., list[dict[str, Any]]] = q_api.list_room_events,
        claim_fn: Callable[..., q_api.ClaimedSynthesis] = q_api.claim_synthesis,
        confirm_merge_fn: Callable[
            ..., q_api.ConfirmMergeResult
        ] = q_api.confirm_merge,
        report_merge_result_fn: Callable[
            ..., q_api.MergeReportResult
        ] = q_api.report_merge_result,
        mint_token_fn: Callable[..., str] = q_api.mint_installation_token,
        get_head_sha_fn: Callable[..., str] = gh.get_pr_head_sha,
        squash_merge_fn: Callable[..., str] = gh.squash_merge_pr,
        now_fn: Callable[[], datetime] | None = None,
    ) -> None:
        self._plugin = plugin
        self._base_url = base_url
        self._token_resolver = token_resolver
        self._agent_id = agent_id
        self._poll_interval_secs = max(1, poll_interval_secs)
        self._ready_limit = max(1, ready_limit)
        self._claim_ttl_secs = max(1, claim_ttl_secs)
        self._fallback_quiet_period_secs = max(0, fallback_quiet_period_secs)
        self._gh_timeout_secs = max(1, gh_timeout_secs)
        self._enable_squash_merge = enable_squash_merge
        self._log_prefix = log_prefix
        self._merge_report_queue_file = merge_report_queue_file
        self._pending_merge_reports = self._load_pending_merge_reports()
        self._list_ready = list_ready_fn
        self._list_pending = list_pending_fn
        self._participants = participants_fn
        self._events = events_fn
        self._claim = claim_fn
        self._confirm_merge = confirm_merge_fn
        self._report_merge_result = report_merge_result_fn
        self._mint_token = mint_token_fn
        self._get_head_sha = get_head_sha_fn
        self._squash_merge = squash_merge_fn
        self._now_fn = now_fn or (lambda: datetime.now(timezone.utc))
        self._stop_event = threading.Event()

    def validate(self, config: PluginConfig) -> list[str]:
        del config
        return []

    def stop(self) -> None:
        self._stop_event.set()

    def start(self, config: PluginConfig, dispatcher: JobDispatcher) -> None:
        del config
        self._stop_event.clear()
        print(
            f"{self._log_prefix} polling "
            f"{self._base_url}/api/rooms/synthesis-ready every "
            f"{self._poll_interval_secs}s",
            file=sys.stderr,
            flush=True,
        )

        while not self._stop_event.is_set():
            try:
                self._tick(dispatcher)
            except Exception as exc:
                print(
                    f"{self._log_prefix} tick error: "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
            self._stop_event.wait(self._poll_interval_secs)

    def _tick(self, dispatcher: JobDispatcher) -> None:
        if not self._plugin.wait_queen_slot(self._stop_event, timeout=0):
            return

        bearer = self._token_resolver()
        if not bearer:
            return

        if self._enable_squash_merge:
            if self._flush_pending_merge_reports(bearer):
                return
            if self._confirm_pending_merge(bearer):
                return

        try:
            rooms = self._list_ready(
                self._base_url,
                bearer,
                limit=self._ready_limit,
            )
        except Exception as exc:
            print(
                f"{self._log_prefix} synthesis-ready failed: "
                f"{type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )
            return

        for room in rooms:
            if not self._is_room_ready(room, bearer):
                continue

            try:
                claimed = self._claim(
                    self._base_url,
                    room.room_id,
                    bearer,
                    queen_runner=self._agent_id,
                    claim_ttl_secs=self._claim_ttl_secs,
                )
            except q_api.QueenAPIConflictError as exc:
                print(
                    f"{self._log_prefix} claim skipped room={room.room_id}: "
                    f"{exc.code}",
                    file=sys.stderr,
                    flush=True,
                )
                continue
            except Exception as exc:
                print(
                    f"{self._log_prefix} claim failed room={room.room_id}: "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                continue

            # Re-gate on the claim's own participant snapshot. The pre-claim
            # check read participants separately; a participant can change
            # state in that window, so the claimed snapshot is authoritative.
            # Bailing here is safe: the claim is a TTL lease that expires and
            # returns the room to the ready pool, so nothing is stranded.
            ok, reason = self._participants_eligible(claimed.participants)
            if not ok:
                print(
                    f"{self._log_prefix} room={room.room_id} "
                    f"not ready after claim: {reason}",
                    file=sys.stderr,
                    flush=True,
                )
                continue

            try:
                pr = gh.parse_subject_ref(room.subject_ref)
                gh_token = self._mint_token(
                    self._base_url,
                    bearer,
                    repo=pr.full_repo,
                    agent_id=self._agent_id or None,
                )
                reviewed_head_sha = self._get_head_sha(
                    pr,
                    token=gh_token,
                    timeout_secs=self._gh_timeout_secs,
                )
            except Exception as exc:
                print(
                    f"{self._log_prefix} head-sha capture failed "
                    f"room={room.room_id}: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                return

            job = self._build_job(
                room=room,
                claimed=claimed,
                reviewed_head_sha=reviewed_head_sha,
            )

            self._plugin.reserve_queen_slot()
            try:
                ok = dispatcher.dispatch(job)
            except Exception as exc:
                print(
                    f"{self._log_prefix} dispatch raised room={room.room_id}: "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                self._plugin.release_queen_slot()
                return
            if not ok:
                print(
                    f"{self._log_prefix} dispatch refused room={room.room_id}",
                    file=sys.stderr,
                    flush=True,
                )
                self._plugin.release_queen_slot()
                return

            print(
                f"{self._log_prefix} dispatched room={room.room_id} "
                f"subject={room.subject_ref} seq={claimed.through_sequence}",
                file=sys.stderr,
                flush=True,
            )
            return

    def _confirm_pending_merge(self, bearer: str) -> bool:
        try:
            rooms = self._list_pending(
                self._base_url,
                bearer,
                limit=self._ready_limit,
            )
        except Exception as exc:
            print(
                f"{self._log_prefix} decided-pending-ready failed: "
                f"{type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )
            return False

        for room in rooms:
            try:
                pr = gh.parse_subject_ref(room.subject_ref)
                gh_token = self._mint_token(
                    self._base_url,
                    bearer,
                    repo=pr.full_repo,
                    agent_id=self._agent_id or None,
                )
                current_head_sha = self._get_head_sha(
                    pr,
                    token=gh_token,
                    timeout_secs=self._gh_timeout_secs,
                )
                merge_attempt_id = (
                    f"{self._agent_id}:{room.room_id}:{current_head_sha[:12]}"
                )
                confirmed = self._confirm_merge(
                    self._base_url,
                    room.room_id,
                    bearer,
                    queen_runner=self._agent_id,
                    merge_attempt_id=merge_attempt_id,
                    current_head_sha=current_head_sha,
                )
            except q_api.QueenAPIConflictError as exc:
                print(
                    f"{self._log_prefix} confirm skipped room={room.room_id}: "
                    f"{exc.code}",
                    file=sys.stderr,
                    flush=True,
                )
                continue
            except Exception as exc:
                print(
                    f"{self._log_prefix} confirm failed room={room.room_id}: "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                continue

            if confirmed.decision_outcome != "merge_approved":
                print(
                    f"{self._log_prefix} merge downgraded room={room.room_id} "
                    f"reason={confirmed.decision_outcome_reason}",
                    file=sys.stderr,
                    flush=True,
                )
                return True

            try:
                merge_commit_oid = self._squash_merge(
                    pr,
                    expected_head_sha=current_head_sha,
                    token=gh_token,
                    timeout_secs=self._gh_timeout_secs,
                )
            except Exception as exc:
                self._report_merge_failure(
                    bearer=bearer,
                    room=room,
                    merge_attempt_id=confirmed.merge_attempt_id,
                    error_class=type(exc).__name__,
                )
                print(
                    f"{self._log_prefix} squash merge failed "
                    f"room={room.room_id}: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                return True

            try:
                self._report_merge_result(
                    self._base_url,
                    room.room_id,
                    bearer,
                    queen_runner=self._agent_id,
                    merge_attempt_id=confirmed.merge_attempt_id,
                    github_merge_status="succeeded",
                    merge_commit_oid=merge_commit_oid,
                )
            except Exception as exc:
                self._enqueue_pending_merge_report(
                    PendingMergeReport(
                        room_id=room.room_id,
                        subject_ref=room.subject_ref,
                        merge_attempt_id=confirmed.merge_attempt_id,
                        merge_commit_oid=merge_commit_oid,
                    ),
                )
                print(
                    f"{self._log_prefix} merge result report failed "
                    f"room={room.room_id}: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                return True

            print(
                f"{self._log_prefix} squash merged room={room.room_id} "
                f"commit={merge_commit_oid}",
                file=sys.stderr,
                flush=True,
            )
            return True

        return False

    def _flush_pending_merge_reports(self, bearer: str) -> bool:
        if not self._pending_merge_reports:
            return False
        remaining: list[PendingMergeReport] = []
        for report in self._pending_merge_reports:
            try:
                self._report_merge_result(
                    self._base_url,
                    report.room_id,
                    bearer,
                    queen_runner=self._agent_id,
                    merge_attempt_id=report.merge_attempt_id,
                    github_merge_status="succeeded",
                    merge_commit_oid=report.merge_commit_oid,
                )
            except Exception as exc:
                remaining.append(report)
                print(
                    f"{self._log_prefix} queued merge-result report failed "
                    f"room={report.room_id}: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                continue
            print(
                f"{self._log_prefix} reported queued squash merge "
                f"room={report.room_id} commit={report.merge_commit_oid}",
                file=sys.stderr,
                flush=True,
            )
        if len(remaining) != len(self._pending_merge_reports):
            self._pending_merge_reports = remaining
            self._save_pending_merge_reports()
        return bool(self._pending_merge_reports)

    def _enqueue_pending_merge_report(self, report: PendingMergeReport) -> None:
        self._pending_merge_reports = [
            existing
            for existing in self._pending_merge_reports
            if existing.merge_attempt_id != report.merge_attempt_id
        ]
        self._pending_merge_reports.append(report)
        self._save_pending_merge_reports()

    def _load_pending_merge_reports(self) -> list[PendingMergeReport]:
        path = self._merge_report_queue_file
        if not path:
            return []
        try:
            with open(path, encoding="utf-8") as fh:
                raw = json.load(fh)
        except FileNotFoundError:
            return []
        except Exception as exc:
            print(
                f"{self._log_prefix} merge report queue load failed: "
                f"{type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )
            return []
        if not isinstance(raw, list):
            return []
        reports: list[PendingMergeReport] = []
        for entry in raw:
            if isinstance(entry, dict):
                parsed = PendingMergeReport.from_dict(entry)
                if parsed is not None:
                    reports.append(parsed)
        return reports

    def _save_pending_merge_reports(self) -> None:
        path = self._merge_report_queue_file
        if not path:
            return
        try:
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            tmp_path = f"{path}.tmp"
            with open(tmp_path, "w", encoding="utf-8") as fh:
                json.dump(
                    [report.to_dict() for report in self._pending_merge_reports],
                    fh,
                    indent=2,
                    sort_keys=True,
                )
                fh.write("\n")
            os.replace(tmp_path, path)
        except Exception as exc:
            print(
                f"{self._log_prefix} merge report queue save failed: "
                f"{type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )

    def _report_merge_failure(
        self,
        *,
        bearer: str,
        room: q_api.SynthesisReadyRoom,
        merge_attempt_id: str,
        error_class: str,
    ) -> None:
        try:
            self._report_merge_result(
                self._base_url,
                room.room_id,
                bearer,
                queen_runner=self._agent_id,
                merge_attempt_id=merge_attempt_id,
                github_merge_status="failed",
                error_class=error_class,
            )
        except Exception as exc:
            print(
                f"{self._log_prefix} failed merge-result report failed "
                f"room={room.room_id}: {type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )

    def _participants_eligible(
        self, participants: dict[str, Any]
    ) -> tuple[bool, str | None]:
        """Apply the synthesis participant gate, returning (eligible, reason).

        A room is eligible only when at least one participant exists, none are
        still unresolved, and at least one has actually resolved. This mirrors
        the bot-side queen so the local queen never synthesizes an empty or
        fully-withdrawn room.

        Called both before claiming (against the live participants read) and
        after claiming (against the claim's own snapshot). The post-claim call
        closes the read-then-claim race: a participant can change state between
        the eligibility read and the claim, so the claimed snapshot is the
        authoritative one to gate on.
        """
        if not participants:
            return False, "no participants"
        unresolved = []
        has_resolved = False
        for role, participant in participants.items():
            status = (
                str(participant.get("status") or "")
                if isinstance(participant, dict)
                else ""
            )
            if status not in {"resolved", "withdrew", "timed_out"}:
                unresolved.append(role)
            if status == "resolved":
                has_resolved = True
        if unresolved:
            joined = ",".join(sorted(unresolved))
            return False, f"unresolved participants={joined}"
        if not has_resolved:
            return False, "no resolved participants"
        return True, None

    def _is_room_ready(self, room: q_api.SynthesisReadyRoom, bearer: str) -> bool:
        try:
            participants = self._participants(self._base_url, room.room_id, bearer)
            events = self._events(self._base_url, room.room_id, bearer, limit=500)
        except Exception as exc:
            print(
                f"{self._log_prefix} eligibility read failed "
                f"room={room.room_id}: {type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )
            return False

        ok, reason = self._participants_eligible(participants)
        if not ok:
            print(
                f"{self._log_prefix} room={room.room_id} not ready: {reason}",
                file=sys.stderr,
                flush=True,
            )
            return False

        quiet_period = self._quiet_period_for(room)
        if quiet_period <= 0:
            return True

        last_ts = self._last_event_timestamp(room, events)
        if last_ts is None:
            return False
        age = (self._now_fn() - last_ts).total_seconds()
        if age < quiet_period:
            print(
                f"{self._log_prefix} room={room.room_id} not ready: "
                f"quiet age={int(age)}s required={quiet_period}s",
                file=sys.stderr,
                flush=True,
            )
            return False
        return True

    def _quiet_period_for(self, room: q_api.SynthesisReadyRoom) -> int:
        value = room.timing_config.get("quiet_period_secs")
        if isinstance(value, bool):
            return self._fallback_quiet_period_secs
        if isinstance(value, int):
            return max(0, value)
        if isinstance(value, str):
            try:
                return max(0, int(value))
            except ValueError:
                pass
        return self._fallback_quiet_period_secs

    def _last_event_timestamp(
        self,
        room: q_api.SynthesisReadyRoom,
        events: list[dict[str, Any]],
    ) -> datetime | None:
        for event in reversed(events):
            parsed = _parse_iso(str(event.get("timestamp") or ""))
            if parsed is not None:
                return parsed
        return _parse_iso(room.opened_at)

    def _build_job(
        self,
        *,
        room: q_api.SynthesisReadyRoom,
        claimed: q_api.ClaimedSynthesis,
        reviewed_head_sha: str,
    ) -> Job:
        metadata = {
            "job_kind": JOB_KIND_SYNTHESIS,
            "room_id": room.room_id,
            "subject_type": room.subject_type,
            "subject_ref": room.subject_ref,
            "manager": room.manager,
            "sealed_through_sequence": claimed.through_sequence,
            "queen_runner": self._agent_id,
            "reviewed_head_sha": reviewed_head_sha,
            "coalesce_key": f"queen:{room.room_id}",
        }
        return Job(
            session_key=f"queen:{room.room_id}@{claimed.through_sequence}",
            prompt=build_synthesis_prompt(
                claimed=claimed,
                reviewed_head_sha=reviewed_head_sha,
                enable_squash_merge=self._enable_squash_merge,
            ),
            metadata=metadata,
        )


def _parse_iso(value: str) -> datetime | None:
    if not value:
        return None
    try:
        normalized = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None
