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
DEFAULT_PR_DISCOVERY_INTERVAL_SECS = 900
DEFAULT_PR_DISCOVERY_ROOM_LIMIT = 200
DEFAULT_PR_DISCOVERY_CREATE_LIMIT = 20
DEFAULT_PR_ROOM_QUIET_PERIOD_SECS = 180
DEFAULT_PR_ROOM_MAX_AGE_SECS = 3600
DEFAULT_PR_ROOM_DROP_THRESHOLD_SECS = 1200
DEFAULT_PR_ROOM_RECENT_CLOSED_SECS = 6 * 60 * 60


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
        watched_repos: list[str] | tuple[str, ...] = (),
        pr_discovery_enabled: bool = True,
        pr_discovery_interval_secs: int = DEFAULT_PR_DISCOVERY_INTERVAL_SECS,
        pr_discovery_room_limit: int = DEFAULT_PR_DISCOVERY_ROOM_LIMIT,
        pr_discovery_create_limit: int = DEFAULT_PR_DISCOVERY_CREATE_LIMIT,
        pr_room_quiet_period_secs: int = DEFAULT_PR_ROOM_QUIET_PERIOD_SECS,
        pr_room_max_age_secs: int = DEFAULT_PR_ROOM_MAX_AGE_SECS,
        pr_room_drop_threshold_secs: int = DEFAULT_PR_ROOM_DROP_THRESHOLD_SECS,
        pr_room_recent_closed_secs: int = DEFAULT_PR_ROOM_RECENT_CLOSED_SECS,
        log_prefix: str = "[hivemoot-queen]",
        list_rooms_fn: Callable[
            ..., list[q_api.RoomSummary]
        ] = q_api.list_rooms,
        create_room_fn: Callable[
            ..., q_api.CreatedRoom
        ] = q_api.create_pr_review_room,
        append_subject_updated_fn: Callable[
            ..., int
        ] = q_api.append_subject_updated_event,
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
        list_pull_requests_fn: Callable[
            ..., list[gh.PullRequestSnapshot]
        ] = gh.list_pull_requests,
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
        self._watched_repos = [
            repo.strip()
            for repo in watched_repos
            if isinstance(repo, str) and repo.strip()
        ]
        self._pr_discovery_enabled = pr_discovery_enabled
        self._pr_discovery_interval_secs = max(1, pr_discovery_interval_secs)
        self._pr_discovery_room_limit = max(1, pr_discovery_room_limit)
        self._pr_discovery_create_limit = max(0, pr_discovery_create_limit)
        self._pr_room_quiet_period_secs = max(0, pr_room_quiet_period_secs)
        self._pr_room_max_age_secs = max(1, pr_room_max_age_secs)
        self._pr_room_drop_threshold_secs = max(0, pr_room_drop_threshold_secs)
        self._pr_room_recent_closed_secs = max(0, pr_room_recent_closed_secs)
        self._last_pr_discovery_at: datetime | None = None
        self._known_pr_heads: dict[str, str] = {}
        self._known_pr_states: dict[str, str] = {}
        self._list_rooms = list_rooms_fn
        self._create_room = create_room_fn
        self._append_subject_updated = append_subject_updated_fn
        self._list_ready = list_ready_fn
        self._list_pending = list_pending_fn
        self._participants = participants_fn
        self._events = events_fn
        self._claim = claim_fn
        self._confirm_merge = confirm_merge_fn
        self._report_merge_result = report_merge_result_fn
        self._mint_token = mint_token_fn
        self._list_pull_requests = list_pull_requests_fn
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

        self._maybe_discover_pr_rooms(bearer)

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
                reviewed_head_sha = self._ensure_room_head_fresh(room, bearer)
            except Exception as exc:
                print(
                    f"{self._log_prefix} head freshness check failed "
                    f"room={room.room_id}: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                return
            if not reviewed_head_sha:
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
                current_head_sha = self._current_pr_head(room, bearer)
            except Exception as exc:
                print(
                    f"{self._log_prefix} post-claim head-sha capture failed "
                    f"room={room.room_id}: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                return

            if current_head_sha != reviewed_head_sha:
                self._emit_subject_updated(
                    bearer=bearer,
                    room=room,
                    subject_ref=room.subject_ref,
                    change_kind="synchronize",
                    head_sha=current_head_sha,
                )
                print(
                    f"{self._log_prefix} room={room.room_id} skipped: "
                    "PR head changed during claim; requested fresh reviews",
                    file=sys.stderr,
                    flush=True,
                )
                continue

            job = self._build_job(
                room=room,
                claimed=claimed,
                reviewed_head_sha=current_head_sha,
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

    def _maybe_discover_pr_rooms(self, bearer: str) -> None:
        if (
            not self._pr_discovery_enabled
            or not self._watched_repos
        ):
            return

        now = self._now_fn()
        if self._last_pr_discovery_at is not None:
            elapsed = (now - self._last_pr_discovery_at).total_seconds()
            if elapsed < self._pr_discovery_interval_secs:
                return
        self._last_pr_discovery_at = now

        try:
            self._discover_pr_rooms(bearer, now)
        except Exception as exc:
            print(
                f"{self._log_prefix} PR discovery failed: "
                f"{type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )

    def _discover_pr_rooms(self, bearer: str, now: datetime) -> None:
        rooms = self._list_rooms(
            self._base_url,
            bearer,
            limit=self._pr_discovery_room_limit,
        )
        rooms_by_subject = self._index_pr_rooms_by_subject(rooms)

        created_count = 0
        updated_count = 0
        skipped_count = 0
        error_count = 0
        for repo in self._watched_repos:
            try:
                gh_token = self._mint_token(
                    self._base_url,
                    bearer,
                    repo=repo,
                    agent_id=self._agent_id or None,
                )
                prs = self._list_pull_requests(
                    repo,
                    token=gh_token,
                    state="open",
                    timeout_secs=self._gh_timeout_secs,
                )
                if (
                    self._has_known_open_prs(repo)
                    or self._has_active_pr_room(repo, rooms_by_subject)
                ):
                    prs = [
                        *prs,
                        *self._list_pull_requests(
                            repo,
                            token=gh_token,
                            state="closed",
                            timeout_secs=self._gh_timeout_secs,
                        ),
                    ]
            except Exception as exc:
                error_count += 1
                print(
                    f"{self._log_prefix} PR discovery repo={repo} failed: "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                continue

            for pr in prs:
                if not pr.targets_default_branch:
                    skipped_count += 1
                    continue
                subject_ref = f"{repo}#{pr.number}"
                room = rooms_by_subject.get(subject_ref)

                if pr.state == "open":
                    self._known_pr_states[subject_ref] = "open"
                    if not self._room_blocks_create(room, now):
                        if created_count >= self._pr_discovery_create_limit:
                            skipped_count += 1
                            continue
                        try:
                            created = self._create_room(
                                self._base_url,
                                bearer,
                                subject_ref=subject_ref,
                                manager=self._agent_id or "local-queen",
                                quiet_period_secs=self._pr_room_quiet_period_secs,
                                max_age_secs=self._pr_room_max_age_secs,
                                drop_threshold_secs=(
                                    self._pr_room_drop_threshold_secs
                                ),
                            )
                            created_count += 1
                            room = q_api.RoomSummary(
                                room_id=created.room_id,
                                status=created.status,
                                subject_type="pr_review",
                                subject_ref=subject_ref,
                                manager=self._agent_id or "local-queen",
                                opened_at=now.isoformat(),
                                timing_config={
                                    "quiet_period_secs": (
                                        self._pr_room_quiet_period_secs
                                    ),
                                    "max_age_secs": self._pr_room_max_age_secs,
                                    "drop_threshold_secs": (
                                        self._pr_room_drop_threshold_secs
                                    ),
                                },
                            )
                            rooms_by_subject[subject_ref] = room
                            if pr.head_sha and self._emit_subject_updated(
                                bearer=bearer,
                                room=room,
                                subject_ref=subject_ref,
                                change_kind="synchronize",
                                head_sha=pr.head_sha,
                            ):
                                updated_count += 1
                                self._known_pr_heads[subject_ref] = pr.head_sha
                        except q_api.QueenAPIConflictError as exc:
                            if exc.code == "subject_already_open":
                                skipped_count += 1
                                continue
                            error_count += 1
                            print(
                                f"{self._log_prefix} create room conflict "
                                f"subject={subject_ref}: {exc.code}",
                                file=sys.stderr,
                                flush=True,
                            )
                        except Exception as exc:
                            error_count += 1
                            print(
                                f"{self._log_prefix} create room failed "
                                f"subject={subject_ref}: "
                                f"{type(exc).__name__}: {exc}",
                                file=sys.stderr,
                                flush=True,
                            )
                        continue

                    if room is not None and pr.head_sha:
                        if self._maybe_emit_head_update(
                            bearer=bearer,
                            room=room,
                            subject_ref=subject_ref,
                            head_sha=pr.head_sha,
                        ):
                            updated_count += 1
                    continue

                if (
                    room is not None
                    and (
                        self._known_pr_states.get(subject_ref) == "open"
                        or self._room_is_active(room)
                    )
                ):
                    emitted_closed = self._maybe_emit_closed_update(
                        bearer=bearer,
                        room=room,
                        subject_ref=subject_ref,
                    )
                    if emitted_closed:
                        updated_count += 1
                    if emitted_closed or room.status in {"closed", "expired"}:
                        self._known_pr_states[subject_ref] = pr.state or "closed"

        if created_count or updated_count or error_count:
            print(
                f"{self._log_prefix} PR discovery "
                f"created={created_count} updated={updated_count} "
                f"skipped={skipped_count} errors={error_count}",
                file=sys.stderr,
                flush=True,
            )

    def _index_pr_rooms_by_subject(
        self,
        rooms: list[q_api.RoomSummary],
    ) -> dict[str, q_api.RoomSummary]:
        rooms_by_subject: dict[str, q_api.RoomSummary] = {}
        for room in rooms:
            if room.subject_type != "pr_review" or not room.subject_ref:
                continue
            current = rooms_by_subject.get(room.subject_ref)
            if current is None or self._prefer_room(room, current):
                rooms_by_subject[room.subject_ref] = room
        return rooms_by_subject

    def _prefer_room(
        self,
        candidate: q_api.RoomSummary,
        current: q_api.RoomSummary,
    ) -> bool:
        candidate_active = self._room_is_active(candidate)
        current_active = self._room_is_active(current)
        if candidate_active != current_active:
            return candidate_active
        return self._room_sort_time(candidate) >= self._room_sort_time(current)

    @staticmethod
    def _room_is_active(room: q_api.RoomSummary) -> bool:
        return room.status not in {"closed", "expired"}

    @staticmethod
    def _room_sort_time(room: q_api.RoomSummary) -> datetime:
        return (
            _parse_iso(room.closed_at)
            or _parse_iso(room.opened_at)
            or datetime.min.replace(tzinfo=timezone.utc)
        )

    def _room_blocks_create(
        self,
        room: q_api.RoomSummary | None,
        now: datetime,
    ) -> bool:
        if room is None:
            return False
        if room.status == "expired":
            return False
        if room.status != "closed":
            return True
        if self._pr_room_recent_closed_secs <= 0:
            return False
        closed_at = _parse_iso(room.closed_at) or _parse_iso(room.opened_at)
        if closed_at is None:
            return True
        age = (now - closed_at).total_seconds()
        return age < self._pr_room_recent_closed_secs

    def _maybe_emit_head_update(
        self,
        *,
        bearer: str,
        room: q_api.RoomSummary | q_api.SynthesisReadyRoom,
        subject_ref: str,
        head_sha: str,
    ) -> bool:
        previous_head = self._known_pr_heads.get(subject_ref)
        if previous_head is None:
            previous_head = self._latest_recorded_room_head(
                bearer=bearer,
                room=room,
                subject_ref=subject_ref,
            )
            if previous_head is None:
                emitted = self._emit_subject_updated(
                    bearer=bearer,
                    room=room,
                    subject_ref=subject_ref,
                    change_kind="synchronize",
                    head_sha=head_sha,
                )
                if emitted:
                    self._known_pr_heads[subject_ref] = head_sha
                return emitted
            self._known_pr_heads[subject_ref] = previous_head
        if previous_head == head_sha:
            return False
        emitted = self._emit_subject_updated(
            bearer=bearer,
            room=room,
            subject_ref=subject_ref,
            change_kind="synchronize",
            head_sha=head_sha,
        )
        if emitted:
            self._known_pr_heads[subject_ref] = head_sha
        return emitted

    def _latest_recorded_room_head(
        self,
        *,
        bearer: str,
        room: q_api.RoomSummary | q_api.SynthesisReadyRoom,
        subject_ref: str,
    ) -> str | None:
        try:
            events = self._events(
                self._base_url,
                room.room_id,
                bearer,
                limit=500,
            )
        except Exception as exc:
            print(
                f"{self._log_prefix} room-event scan failed "
                f"subject={subject_ref}: {type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )
            return None

        latest_head: str | None = None
        for event in sorted(events, key=_event_sort_key):
            if event.get("event_type") != "subject_updated":
                continue
            body = event.get("body")
            if not isinstance(body, dict):
                continue
            if body.get("change_kind") != "synchronize":
                continue
            head_sha = str(body.get("head_sha") or "").strip()
            if head_sha:
                latest_head = head_sha
        return latest_head

    def _ensure_room_head_fresh(
        self,
        room: q_api.SynthesisReadyRoom,
        bearer: str,
    ) -> str:
        current_head = self._current_pr_head(room, bearer)
        recorded_head = self._latest_recorded_room_head(
            bearer=bearer,
            room=room,
            subject_ref=room.subject_ref,
        )
        if recorded_head == current_head:
            return current_head

        self._emit_subject_updated(
            bearer=bearer,
            room=room,
            subject_ref=room.subject_ref,
            change_kind="synchronize",
            head_sha=current_head,
        )
        print(
            f"{self._log_prefix} room={room.room_id} skipped: "
            "PR head is not recorded on the room; requested fresh reviews",
            file=sys.stderr,
            flush=True,
        )
        return ""

    def _current_pr_head(
        self,
        room: q_api.SynthesisReadyRoom,
        bearer: str,
    ) -> str:
        pr = gh.parse_subject_ref(room.subject_ref)
        gh_token = self._mint_token(
            self._base_url,
            bearer,
            repo=pr.full_repo,
            agent_id=self._agent_id or None,
        )
        return self._get_head_sha(
            pr,
            token=gh_token,
            timeout_secs=self._gh_timeout_secs,
        )

    def _maybe_emit_closed_update(
        self,
        *,
        bearer: str,
        room: q_api.RoomSummary | q_api.SynthesisReadyRoom,
        subject_ref: str,
    ) -> bool:
        return self._emit_subject_updated(
            bearer=bearer,
            room=room,
            subject_ref=subject_ref,
            change_kind="closed",
            head_sha=None,
        )

    def _emit_subject_updated(
        self,
        *,
        bearer: str,
        room: q_api.RoomSummary | q_api.SynthesisReadyRoom,
        subject_ref: str,
        change_kind: str,
        head_sha: str | None,
    ) -> bool:
        if room.status != "awaiting_contributions":
            return False
        key_head = head_sha or "no-sha"
        idempotency_key = (
            f"local-queen.subject_updated.{room.room_id}."
            f"{change_kind}.{key_head}"
        )
        try:
            self._append_subject_updated(
                self._base_url,
                room.room_id,
                bearer,
                change_kind=change_kind,
                head_sha=head_sha,
                idempotency_key=idempotency_key,
            )
            return True
        except q_api.QueenAPIConflictError as exc:
            print(
                f"{self._log_prefix} subject_updated skipped "
                f"subject={subject_ref}: {exc.code}",
                file=sys.stderr,
                flush=True,
            )
            return False
        except Exception as exc:
            print(
                f"{self._log_prefix} subject_updated failed "
                f"subject={subject_ref}: {type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )
            return False

    def _has_known_open_prs(self, repo: str) -> bool:
        prefix = f"{repo}#"
        return any(
            subject_ref.startswith(prefix) and state == "open"
            for subject_ref, state in self._known_pr_states.items()
        )

    def _has_active_pr_room(
        self,
        repo: str,
        rooms_by_subject: dict[str, q_api.RoomSummary],
    ) -> bool:
        prefix = f"{repo}#"
        return any(
            subject_ref.startswith(prefix) and self._room_is_active(room)
            for subject_ref, room in rooms_by_subject.items()
        )

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

        if room.subject_type == "pr_review":
            ok, reason = self._pr_review_contributions_fresh(
                participants,
                events,
            )
            if not ok:
                print(
                    f"{self._log_prefix} room={room.room_id} not ready: "
                    f"{reason}",
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

    def _pr_review_contributions_fresh(
        self,
        participants: dict[str, Any],
        events: list[dict[str, Any]],
    ) -> tuple[bool, str | None]:
        latest_head_seq = 0
        for event in events:
            if event.get("event_type") != "subject_updated":
                continue
            body = event.get("body")
            if not isinstance(body, dict):
                continue
            if body.get("change_kind") == "synchronize":
                latest_head_seq = max(latest_head_seq, _event_seq(event))

        if latest_head_seq <= 0:
            return False, "no recorded PR head"

        resolved_roles = {
            role
            for role, participant in participants.items()
            if (
                isinstance(participant, dict)
                and str(participant.get("status") or "") == "resolved"
            )
        }
        if not resolved_roles:
            return False, "no resolved participants"

        fresh_roles: set[str] = set()
        for event in events:
            if event.get("event_type") != "contribution_submitted":
                continue
            if _event_seq(event) <= latest_head_seq:
                continue
            actor_role = str(
                event.get("actor_role") or event.get("actorRole") or ""
            )
            if actor_role in resolved_roles:
                fresh_roles.add(actor_role)

        if fresh_roles:
            return True, None
        return False, "no resolved contributions after latest PR head"

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


def _event_sort_key(event: dict[str, Any]) -> tuple[int, str]:
    seq_value = _event_seq(event)
    timestamp = str(event.get("timestamp") or "")
    return (seq_value, timestamp)


def _event_seq(event: dict[str, Any]) -> int:
    seq = event.get("seq", event.get("sequence", 0))
    if isinstance(seq, bool):
        return 0
    if isinstance(seq, int):
        return seq
    if isinstance(seq, str):
        try:
            return int(seq)
        except ValueError:
            return 0
    return 0
