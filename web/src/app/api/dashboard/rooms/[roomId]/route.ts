/**
 * GET /api/dashboard/rooms/:roomId — composite room detail for the
 * dashboard (Phase I). Returns core + participants + contributions
 * + recent events in a single response so the detail page can
 * render without a fan-out of round-trips.
 *
 * Distinct from `/api/rooms/:roomId` (capability-bearer agent route)
 * which returns only the bare core. The composite shape is dashboard-
 * specific.
 *
 * Auth: BYOK browser session. Cross-installation isolation: the
 * room is read from the session's installation only — a roomId
 * belonging to another installation returns 404.
 *
 * Response shape:
 * ```
 * {
 *   roomId: string,
 *   core: RoomCore,
 *   participants: Record<role, RoomParticipant>,
 *   contributions: Record<role, RoomContribution>,
 *   events: RoomEvent[],            // most recent up to limit, chronological
 *   eventLimit: number,             // requested limit
 * }
 *
 * `events` is the tail of the room's event log — for a room with N
 * events, the response includes the last `min(N, eventLimit)`
 * entries in chronological order. Most-recent activity (close,
 * recovery, subject_updated) is always visible, regardless of how
 * deep the log is.
 * ```
 *
 * Errors:
 *   - 401 — missing / invalid session
 *   - 404 — room not found OR cross-installation OR malformed roomId
 *           (same response shape — no oracle for unauthorized
 *           discovery)
 *   - 500 — Redis / storage failure
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import {
  getRoomCore,
  getRoomContributions,
  getRoomParticipants,
  listRecentRoomEvents,
  RoomNotFoundError,
  RoomIdFormatError,
} from "@hivemoot/war-room";

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;

function parseEventLimit(value: string | null): number {
  if (!value) return DEFAULT_EVENT_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return DEFAULT_EVENT_LIMIT;
  }
  if (parsed < 1) return 1;
  if (parsed > MAX_EVENT_LIMIT) return MAX_EVENT_LIMIT;
  return parsed;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const installationId = auth.session.installationId;
  if (installationId === null) {
    // Same response as cross-installation read — no oracle for
    // "unscoped session vs nonexistent room".
    return NextResponse.json(
      { code: "room_not_found", message: "Room not found." },
      { status: 404 },
    );
  }

  const { roomId } = await params;
  const installationIdStr = String(installationId);
  const eventLimit = parseEventLimit(
    new URL(request.url).searchParams.get("eventLimit"),
  );

  try {
    // Fetch core first — if it's not in this installation, 404
    // before paying for the parallel sub-reads.
    const core = await getRoomCore({
      installationId: installationIdStr,
      roomId,
      redis: auth.redis,
    });
    // Parallel fan-out for the auxiliary reads — they're
    // independent of each other.
    const [participants, contributions, events] = await Promise.all([
      getRoomParticipants({ roomId, redis: auth.redis }),
      getRoomContributions({ roomId, redis: auth.redis }),
      // Tail read — newest `eventLimit` events (chronological in
      // returned slice). Closes #551 builder R1 #2: prior code used
      // listRoomEvents with since=0 which returns the OLDEST events,
      // hiding the most recent close/recovery/subject_updated activity
      // from the dashboard detail view.
      listRecentRoomEvents({ roomId, limit: eventLimit, redis: auth.redis }),
    ]);
    return NextResponse.json({
      roomId,
      core,
      participants,
      contributions,
      events,
      eventLimit,
    });
  } catch (err) {
    if (err instanceof RoomNotFoundError || err instanceof RoomIdFormatError) {
      return NextResponse.json(
        { code: "room_not_found", message: "Room not found." },
        { status: 404 },
      );
    }
    console.error("[dashboard.rooms] Failed to load room detail", {
      installationId,
      roomId,
      err,
    });
    return NextResponse.json(
      { code: "load_room_failed", message: "Failed to load room." },
      { status: 500 },
    );
  }
}
