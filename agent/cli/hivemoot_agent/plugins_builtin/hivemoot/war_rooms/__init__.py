"""War-room watcher plugin — agent runtime side.

Phase F of the post-apiarist-V1 ultra plan. Workers (drone /
builder / guard / etc.) poll `/api/rooms/watching` to discover
rooms eligible for their role, then RSVP and contribute.

V1 layering:
  * `api` — HTTP client wrapping `/api/rooms/*` (this slice F.1)
  * `trigger` — poll loop that drives watcher tick (future F.2)
  * `dispatch` — per-room triage + heavy-contribution dispatch
    (future F.3)

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


__all__ = (
    "WatchingRoom",
    "list_watching_rooms",
    "present_to_room",
    "submit_contribution",
    "withdraw_participant",
)
