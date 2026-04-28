/**
 * GET /api/rooms — list war rooms for the bearer's installation.
 *
 * Capability: `rooms.read`. The bearer's installation is the
 * canonical scope — clients cannot list other installations' rooms
 * regardless of any query parameter (cross-installation isolation
 * is enforced server-side from the envelope).
 *
 * Query params:
 *   - `limit` (optional): max rooms to return. Default 50, max 200,
 *     min 1. Out-of-range values clamp silently to the bounds.
 *
 * Response: `{ rooms: RoomCore[] }` ordered newest-first by `opened_at`.
 *
 * Auth model: `requires: "rooms.read_all"`. Sub-endpoints
 * (`/api/rooms/:id/...`) defer to the same capability since they're
 * all read-shaped data about the same scope.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { listRooms } from "@/server/war-room";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: "rooms.read_all",
  });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (Number.isFinite(parsed)) {
      limit = Math.min(MAX_LIMIT, Math.max(1, parsed));
    }
  }

  const rooms = await listRooms({
    installationId: auth.installationId,
    redis: auth.redis,
    limit,
  });

  return NextResponse.json({ rooms }, { status: 200 });
}

export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    {
      code: "method_not_allowed",
      message: "GET /api/rooms only — POST not yet implemented (lands in D.1.b-ii).",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}
