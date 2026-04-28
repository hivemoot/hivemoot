/**
 * GET /api/rooms/:roomId/contributions — read materialized
 * contributions hash (latest contribution per role, plus tombstones
 * for withdrawn).
 *
 * Capability: `rooms.read`. Cross-installation isolation: same
 * room-existence pre-check as `/events` (the contributions hash is
 * keyed by roomId only).
 *
 * Response: `{ contributions: Record<role, RoomContribution>, roomId: string }`.
 *           Withdrawn contributions surface as tombstones with
 *           `{ withdrawn: true, contributed_at }`.
 * Errors: 401, 403, 404.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  getRoomCore,
  getRoomContributions,
  RoomNotFoundError,
  RoomIdFormatError,
} from "@/server/war-room";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: "rooms.read",
  });
  if (!auth.ok) return auth.response;

  const { roomId } = await params;

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

  const contributions = await getRoomContributions({
    roomId,
    redis: auth.redis,
  });
  return NextResponse.json({ contributions, roomId }, { status: 200 });
}
