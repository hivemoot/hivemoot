/**
 * GET /api/dashboard/rooms — list war rooms for the operator's
 * installation (Phase I dashboard).
 *
 * Distinct from `/api/rooms` which uses the V1 capability bearer
 * (agent-facing). This route uses BYOK session auth (browser
 * dashboard) and scopes by `session.installationId`.
 *
 * Response: `{ rooms: RoomCoreWithId[] }`. Empty list when:
 *   - Session has no installationId (unscoped browser session)
 *   - The installation has no rooms yet
 *
 * Errors:
 *   - 401 — missing / invalid session
 *   - 500 — Redis / storage failure
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { listRooms } from "@hivemoot/war-room";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return DEFAULT_LIMIT;
  if (parsed < 1) return 1;
  if (parsed > MAX_LIMIT) return MAX_LIMIT;
  return parsed;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const installationId = auth.session.installationId;
  // Null-installation sessions (browser without a linked GitHub
  // installation) never own rooms — return empty so the dashboard
  // renders its empty state instead of an error.
  if (installationId === null) {
    return NextResponse.json({ rooms: [] });
  }

  const { searchParams } = new URL(request.url);
  const limit = parseLimit(searchParams.get("limit"));

  try {
    const rooms = await listRooms({
      installationId: String(installationId),
      redis: auth.redis,
      limit,
    });
    return NextResponse.json({ rooms });
  } catch (error) {
    console.error("[dashboard.rooms] Failed to list rooms", {
      installationId,
      error,
    });
    return NextResponse.json(
      { code: "list_rooms_failed", message: "Failed to load rooms." },
      { status: 500 },
    );
  }
}
