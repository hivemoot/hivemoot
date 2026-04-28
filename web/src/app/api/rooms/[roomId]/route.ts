/**
 * GET /api/rooms/:roomId — fetch a single room's core record.
 *
 * Capability: `rooms.read`. Cross-installation isolation: the room
 * is read from the bearer's installation only — a roomId belonging
 * to another installation will return 404 (the storage primitive
 * uses the installation-scoped key).
 *
 * Path params:
 *   - `roomId`: RFC 4122 UUIDv4 lowercase. Validated by the storage
 *     primitive; malformed roomId returns 404 (not 400 — no oracle
 *     for "room not found vs malformed id" since both are
 *     unauthorized-discovery vectors).
 *
 * Response: `RoomCore` JSON.
 * Errors: 401 (auth), 403 (capability), 404 (room not found OR
 * malformed roomId — same response shape).
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  getRoomCore,
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
    const room = await getRoomCore({
      installationId: auth.installationId,
      roomId,
      redis: auth.redis,
    });
    return NextResponse.json(room, { status: 200 });
  } catch (err) {
    if (err instanceof RoomNotFoundError || err instanceof RoomIdFormatError) {
      return NextResponse.json(
        { code: "room_not_found", message: `Room ${roomId} not found.` },
        { status: 404 },
      );
    }
    throw err;
  }
}
