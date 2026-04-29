"""War-room watcher plugin — agent runtime side.

Phase F of the post-apiarist-V1 ultra plan. Workers (drone /
builder / guard / etc.) poll `/api/rooms/watching` to discover
rooms eligible for their role, then RSVP and contribute.

V1 layering:
  * `api` — HTTP client wrapping `/api/rooms/*` (F.1)
  * `trigger` — poll loop + dispatch + per-room state cache (F.2)
  * `triage` — prompt template + structured-output parser (F.3)
  * `handler` — on_job_finished dispatch to present/contribute/
    withdraw based on parsed triage (F.3)
  * plugin-manifest wiring + config schema (future F.5)

The HTTP client uses the same shared transport (`..http`) and
auth helper (`..auth`) as the existing tasks/health plugins.
"""

from hivemoot_agent.plugins_builtin.hivemoot.war_rooms.api import (
    WatchingRoom,
    list_watching_rooms,
    present_to_room,
    submit_contribution,
    withdraw_participant,
)
from hivemoot_agent.plugins_builtin.hivemoot.war_rooms.handler import (
    JOB_KIND_TRIAGE,
    PostFailureCallback,
    RAW_MD_CLIENT_CAP_BYTES,
    handle_war_room_job_finished,
    is_war_room_job,
    truncate_raw_md,
)
from hivemoot_agent.plugins_builtin.hivemoot.war_rooms.triage import (
    TRIAGE_OUTPUT_INSTRUCTIONS,
    TriageDecision,
    build_triage_prompt,
    parse_triage_response,
)
from hivemoot_agent.plugins_builtin.hivemoot.war_rooms.trigger import (
    DEFAULT_POLL_INTERVAL_SECS,
    DEFAULT_SEEN_CACHE_MAX,
    WarRoomWatcherTrigger,
)


__all__ = (
    "WatchingRoom",
    "list_watching_rooms",
    "present_to_room",
    "submit_contribution",
    "withdraw_participant",
    "WarRoomWatcherTrigger",
    "DEFAULT_POLL_INTERVAL_SECS",
    "DEFAULT_SEEN_CACHE_MAX",
    "TriageDecision",
    "TRIAGE_OUTPUT_INSTRUCTIONS",
    "build_triage_prompt",
    "parse_triage_response",
    "JOB_KIND_TRIAGE",
    "handle_war_room_job_finished",
    "is_war_room_job",
    "PostFailureCallback",
    "RAW_MD_CLIENT_CAP_BYTES",
    "truncate_raw_md",
)
