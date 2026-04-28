/**
 * GET /api/rooms/:roomId/events — list events from the room's
 * append-only log, ordered by sequence ascending.
 *
 * Capability: `rooms.read`. Cross-installation isolation: the
 * underlying events sorted set is keyed only by `roomId`, BUT the
 * caller proves they have access to the room by passing the auth
 * gate AND the route handler verifies the room exists in the
 * bearer's installation before returning events (closes the
 * cross-installation discovery vector — without the existence
 * check, a worker could enumerate roomIds and read events from
 * rooms in other installations).
 *
 * Query params:
 *   - `since` (optional, default 0): events with `seq > since` are
 *     returned. Use the last-seen `seq` from the prior page as the
 *     cursor.
 *   - `limit` (optional, default 200, max 500, min 1).
 *
 * Response: `{ events: RoomEvent[], roomId: string }`.
 * Errors: 401, 403, 404 (room not found or in another installation).
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  getRoomCore,
  listRoomEvents,
  RoomNotFoundError,
  RoomIdFormatError,
} from "@/server/war-room";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: "rooms.read_all",
  });
  if (!auth.ok) return auth.response;

  const { roomId } = await params;
  const url = new URL(request.url);
  const rawSince = url.searchParams.get("since");
  const rawLimit = url.searchParams.get("limit");
  let since = 0;
  if (rawSince !== null) {
    const parsed = Number.parseInt(rawSince, 10);
    if (Number.isFinite(parsed) && parsed >= 0) since = parsed;
  }
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (Number.isFinite(parsed)) {
      limit = Math.min(MAX_LIMIT, Math.max(1, parsed));
    }
  }

  // Verify the room exists in THIS installation before reading
  // events. Without this, a roomId from another installation would
  // return that installation's events (events sorted set is keyed
  // by roomId only). Closes the cross-installation discovery vector.
  try {
    await getRoomCore({
      installationId: auth.installationId,
      roomId,
      redis: auth.redis,
    });
  } catch (err) {
    if (err instanceof RoomNotFoundError || err instanceof RoomIdFormatError) {
      return NextResponse.json(
        { code: "room_not_found", message: `Room ${roomId} not found.` },
        { status: 404 },
      );
    }
    throw err;
  }

  const events = await listRoomEvents({
    roomId,
    since,
    limit,
    redis: auth.redis,
  });

  return NextResponse.json({ events, roomId }, { status: 200 });
}
