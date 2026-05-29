/**
 * GET /api/rooms/watching — list rooms eligible for THIS bearer's
 * role to RSVP / contribute on.
 *
 * Capability: `rooms.watch`. Workers (drone / builder / guard /
 * etc.) call this on their watcher tick to discover rooms they
 * should attend to. Cross-installation isolation is enforced via
 * the bearer's `installationId`; per-role visibility via the
 * `canRoleRsvpToRoom` predicate from war-room.ts.
 *
 * Filter (per WAR_ROOM_DESIGN.md L780-790):
 *   - Status ∈ {awaiting_contributions} (closed and
 *     deciding rooms hidden — workers shouldn't act on either)
 *   - Per-role: include if NOT already terminally done (resolved /
 *     timed_out), AND if withdrew, only if room has new events
 *     past withdrew_at_sequence
 *
 * Response:
 *   {
 *     rooms: Array<{
 *       core: RoomCore,
 *       participants: Record<role, RoomParticipant>,
 *       currentSequence: number
 *     }>
 *   }
 *
 * The enriched response (core + participants + currentSequence) lets
 * workers make RSVP decisions without a follow-up read — compensates
 * for `rooms.read_all` not being on the worker preset.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  listRooms,
  getRoomParticipants,
  listRoomEvents,
  canRoleRsvpToRoom,
  seqKey,
  type RoomCoreWithId,
  type RoomParticipant,
} from "@hivemoot/war-room";

const MAX_LIMIT = 100;

interface WatchingRoom {
  core: RoomCoreWithId;
  participants: Record<string, RoomParticipant>;
  currentSequence: number;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: "rooms.watch",
  });
  if (!auth.ok) return auth.response;

  // Listing is bounded — we hard-cap at 100 to keep the
  // worker-watcher tick latency predictable. listRooms is
  // newest-first, so a fleet under burst load surfaces the most
  // recent rooms first.
  const allRooms = await listRooms({
    installationId: auth.installationId,
    redis: auth.redis,
    limit: MAX_LIMIT,
  });

  // Filter to open statuses BEFORE the per-room participant fetches —
  // closed/deciding rooms are excluded by status alone, no need to
  // pull their participants hash + currentSequence. Heartbeat model:
  // `awaiting_contributions` is the only pre-decide open status.
  const openRooms = allRooms.filter(
    (r) => r.status === "awaiting_contributions",
  );

  if (openRooms.length === 0) {
    return NextResponse.json({ rooms: [] }, { status: 200 });
  }

  // Fan out per-room participants + currentSequence + event reads in
  // parallel. For typical fleet sizes (<20 open rooms) this is one
  // round-trip; the filter cuts almost all the data fetched on a
  // typical tick where the worker has nothing to do.
  const fanout = await Promise.all(
    openRooms.map(async (room) => {
      const [participants, seqRaw, events] = await Promise.all([
        getRoomParticipants({ roomId: room.roomId, redis: auth.redis }),
        auth.redis.get<string | number>(seqKey(room.roomId)),
        listRoomEvents({ roomId: room.roomId, redis: auth.redis, limit: 500 }),
      ]);
      const currentSequence =
        typeof seqRaw === "number"
          ? seqRaw
          : typeof seqRaw === "string"
            ? Number.parseInt(seqRaw, 10)
            : 0;
      return { room, participants, currentSequence, events };
    }),
  );

  const watching: WatchingRoom[] = [];
  for (const { room, participants, currentSequence, events } of fanout) {
    if (
      canRoleRsvpToRoom({
        participants,
        bearerRole: auth.agent_role,
        currentSequence,
        events,
      })
    ) {
      watching.push({ core: room, participants, currentSequence });
    }
  }

  return NextResponse.json({ rooms: watching }, { status: 200 });
}
