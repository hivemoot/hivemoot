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
import {
  createRoom,
  listRooms,
  RoomSubjectAlreadyOpenError,
  RoomSubjectRefError,
  RoomIdFormatError,
  RoomIdTakenError,
  type SubjectType,
} from "@hivemoot/war-room";

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

/**
 * Allowed subject types for operator-driven room creation. Today
 * only `general` (free-form coordination room) is valid here —
 * `pr_review` / `mention_response` / `issue_triage` rooms are
 * always created by the bot's webhook path with deterministic
 * roomIds, so accepting them here would let an operator collide
 * with a future bot create. Keep this allowlist tight; revisit
 * if/when manual creation of repo-anchored rooms becomes a real
 * use case.
 */
const ALLOWED_MANUAL_SUBJECT_TYPES: ReadonlySet<SubjectType> = new Set([
  "general",
]);

interface CreateRoomBody {
  subject_type?: unknown;
  subject_ref?: unknown;
}

/**
 * POST /api/dashboard/rooms — operator-driven room creation
 * (currently only `general` rooms; see ALLOWED_MANUAL_SUBJECT_TYPES).
 *
 * Body shape: `{ subject_type: "general", subject_ref: <title> }`.
 *
 * Response: `{ roomId: string, room: RoomCoreWithId }` on 201.
 *
 * Errors:
 *   - 400 — invalid body (missing/unknown type, malformed ref)
 *   - 401 — missing / invalid session
 *   - 403 — session has no installationId (can't scope the room)
 *   - 409 — subject already open (only relevant for repo-anchored
 *           types if the allowlist is widened — for `general` the
 *           subject lock is per-roomId so this can't fire)
 *   - 500 — Redis / storage failure
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const installationId = auth.session.installationId;
  if (installationId === null) {
    return NextResponse.json(
      {
        code: "no_installation",
        message:
          "Your session isn't linked to a GitHub installation, so it can't own rooms. Sign in via the GitHub App.",
      },
      { status: 403 },
    );
  }

  let body: CreateRoomBody;
  try {
    body = (await request.json()) as CreateRoomBody;
  } catch {
    return NextResponse.json(
      { code: "invalid_body", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const subjectType = body.subject_type;
  const subjectRef = body.subject_ref;

  if (typeof subjectType !== "string") {
    return NextResponse.json(
      { code: "invalid_body", message: "`subject_type` is required." },
      { status: 400 },
    );
  }
  if (!ALLOWED_MANUAL_SUBJECT_TYPES.has(subjectType as SubjectType)) {
    return NextResponse.json(
      {
        code: "subject_type_not_allowed",
        message: `Manual creation only supports: ${Array.from(ALLOWED_MANUAL_SUBJECT_TYPES).join(", ")}.`,
      },
      { status: 400 },
    );
  }
  if (typeof subjectRef !== "string" || subjectRef.length === 0) {
    return NextResponse.json(
      {
        code: "invalid_body",
        message: "`subject_ref` is required and must be a non-empty string.",
      },
      { status: 400 },
    );
  }

  const roomId = crypto.randomUUID();
  // Manager string surfaces on the room as `manager` and on the
  // room_opened event's actor_id. We use the operator's GitHub
  // login directly — the `general` subject_type already signals
  // "operator-created, not bot-created", so an extra prefix would
  // just clutter the dashboard's manager field.
  const manager = auth.session.userLogin;

  try {
    const room = await createRoom({
      installationId: String(installationId),
      roomId,
      manager,
      subject: {
        type: subjectType as SubjectType,
        ref: subjectRef,
      },
      redis: auth.redis,
    });
    return NextResponse.json(
      { roomId, room: { ...room, roomId } },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof RoomSubjectRefError) {
      return NextResponse.json(
        { code: "invalid_subject_ref", message: error.message },
        { status: 400 },
      );
    }
    if (error instanceof RoomIdFormatError || error instanceof RoomIdTakenError) {
      // Internal — we minted the roomId ourselves; format/conflict
      // here means a UUIDv4 collision (astronomically rare). Surface
      // as 500 so the caller retries instead of treating it as a
      // user-fixable input error.
      console.error("[dashboard.rooms] roomId surprise on create", { roomId, error });
      return NextResponse.json(
        { code: "create_failed", message: "Failed to create room." },
        { status: 500 },
      );
    }
    if (error instanceof RoomSubjectAlreadyOpenError) {
      return NextResponse.json(
        {
          code: "subject_already_open",
          message: error.message,
          existingRoomId: error.existingRoomId,
        },
        { status: 409 },
      );
    }
    console.error("[dashboard.rooms] Failed to create room", {
      installationId,
      subjectType,
      error,
    });
    return NextResponse.json(
      { code: "create_failed", message: "Failed to create room." },
      { status: 500 },
    );
  }
}
