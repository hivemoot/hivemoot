"""Local queen synthesis trigger.

Polls rooms that are candidates for synthesis, applies the local
eligibility gates that the status-only endpoint intentionally omits,
claims one room, captures a fresh PR head SHA, and dispatches a single
agent job.
"""

from __future__ import annotations

import sys
import threading
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


class LocalQueenSynthesisTrigger:
    """Poll and dispatch one local queen synthesis job at a time."""

    name = "hivemoot-queen"

    def __init__(
        self,
        plugin: Any,
        *,
        base_url: str,
        token_resolver: Callable[[], str],
        runner_id: str,
        agent_id: str,
        poll_interval_secs: int = DEFAULT_POLL_INTERVAL_SECS,
        ready_limit: int = 10,
        claim_ttl_secs: int = 900,
        fallback_quiet_period_secs: int = 60,
        gh_timeout_secs: int = 30,
        log_prefix: str = "[hivemoot-queen]",
        list_ready_fn: Callable[
            ..., list[q_api.SynthesisReadyRoom]
        ] = q_api.list_synthesis_ready_rooms,
        participants_fn: Callable[..., dict[str, Any]] = q_api.get_room_participants,
        events_fn: Callable[..., list[dict[str, Any]]] = q_api.list_room_events,
        claim_fn: Callable[..., q_api.ClaimedSynthesis] = q_api.claim_synthesis,
        mint_token_fn: Callable[..., str] = q_api.mint_installation_token,
        get_head_sha_fn: Callable[..., str] = gh.get_pr_head_sha,
        now_fn: Callable[[], datetime] | None = None,
    ) -> None:
        self._plugin = plugin
        self._base_url = base_url
        self._token_resolver = token_resolver
        self._runner_id = runner_id
        self._agent_id = agent_id
        self._poll_interval_secs = max(1, poll_interval_secs)
        self._ready_limit = max(1, ready_limit)
        self._claim_ttl_secs = max(1, claim_ttl_secs)
        self._fallback_quiet_period_secs = max(0, fallback_quiet_period_secs)
        self._gh_timeout_secs = max(1, gh_timeout_secs)
        self._log_prefix = log_prefix
        self._list_ready = list_ready_fn
        self._participants = participants_fn
        self._events = events_fn
        self._claim = claim_fn
        self._mint_token = mint_token_fn
        self._get_head_sha = get_head_sha_fn
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
                    queen_runner=self._runner_id,
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

        unresolved = []
        for role, participant in participants.items():
            status = (
                str(participant.get("status") or "")
                if isinstance(participant, dict)
                else ""
            )
            if status not in {"resolved", "withdrew", "timed_out"}:
                unresolved.append(role)
        if unresolved:
            print(
                f"{self._log_prefix} room={room.room_id} not ready: "
                f"unresolved participants={','.join(sorted(unresolved))}",
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
            "queen_runner": self._runner_id,
            "reviewed_head_sha": reviewed_head_sha,
            "coalesce_key": f"queen:{room.room_id}",
        }
        return Job(
            session_key=f"queen:{room.room_id}@{claimed.through_sequence}",
            prompt=build_synthesis_prompt(
                claimed=claimed,
                reviewed_head_sha=reviewed_head_sha,
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
