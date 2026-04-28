/**
 * GET /api/rooms/:roomId/participants — read materialized
 * participants hash (latest state per role).
 *
 * Capability: `rooms.read`. Cross-installation isolation: same
 * room-existence pre-check as `/events` (the participants hash is
 * keyed by roomId only).
 *
 * Response: `{ participants: Record<role, RoomParticipant>, roomId: string }`.
 *           Empty object when the room has no participants yet.
 * Errors: 401, 403, 404.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  getRoomCore,
  getRoomParticipants,
  RoomNotFoundError,
  RoomIdFormatError,
} from "@/server/war-room";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: "rooms.read_all",
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

  const participants = await getRoomParticipants({
    roomId,
    redis: auth.redis,
  });
  return NextResponse.json({ participants, roomId }, { status: 200 });
}
