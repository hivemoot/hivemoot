/**
 * /api/rooms — list (GET) and create (POST) war rooms.
 *
 * GET — list rooms for the bearer's installation. Capability:
 *       `rooms.read_all`. See file-level docstring on each handler.
 *
 * POST — create a new war room for the bearer's installation.
 *        Capability: `rooms.create`. The bot's queen module is the
 *        primary caller (driven by GitHub webhook events); operator
 *        UI may also create rooms in the future.
 *
 * Cross-installation isolation: the bearer's `installationId` from
 * the envelope is the canonical scope. A client cannot create or
 * list rooms in another installation regardless of body / query.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  listRooms,
  createRoom,
  type SubjectRef,
  type SubjectType,
  type TimingConfig,
  RoomSubjectAlreadyOpenError,
  RoomSubjectRefError,
  RoomIdFormatError,
  RoomIdTakenError,
} from "@/server/war-room";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const SUBJECT_TYPES: ReadonlySet<SubjectType> = new Set<SubjectType>([
  "pr_review",
  "mention_response",
  "issue_triage",
]);

interface CreateRoomRequestBody {
  subject?: { type?: string; ref?: string };
  manager?: string;
  timing?: Partial<TimingConfig>;
  /** Optional caller-supplied roomId. UUIDv4 lowercase. If omitted,
   * the server mints one via crypto.randomUUID(). */
  roomId?: string;
}

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

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: "rooms.create",
  });
  if (!auth.ok) return auth.response;

  let body: CreateRoomRequestBody;
  try {
    body = (await request.json()) as CreateRoomRequestBody;
  } catch {
    return NextResponse.json(
      { code: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  // Subject is required and must conform to the SubjectRef shape.
  // Boundary validation happens here; the storage primitive does
  // the format-regex check on `ref` itself.
  if (
    !body.subject ||
    typeof body.subject.type !== "string" ||
    typeof body.subject.ref !== "string"
  ) {
    return NextResponse.json(
      {
        code: "invalid_subject",
        message: "Body must include `subject: { type, ref }` with string values.",
      },
      { status: 400 },
    );
  }
  if (!SUBJECT_TYPES.has(body.subject.type as SubjectType)) {
    return NextResponse.json(
      {
        code: "invalid_subject_type",
        message: `subject.type must be one of: ${Array.from(SUBJECT_TYPES).join(", ")}`,
      },
      { status: 400 },
    );
  }
  const subject: SubjectRef = {
    type: body.subject.type as SubjectType,
    ref: body.subject.ref,
  };

  // Manager defaults to the bearer's name (typically "bot-queen" for
  // the queen module). Caller can override for system-driven rooms
  // opened by other internal modules.
  const manager = body.manager ?? auth.name;

  // Mint roomId server-side if absent. UUIDv4 from crypto for both
  // randomness and the lowercase format the storage layer enforces.
  const roomId = body.roomId ?? crypto.randomUUID();

  try {
    const room = await createRoom({
      installationId: auth.installationId,
      roomId,
      manager,
      subject,
      timing: body.timing,
      redis: auth.redis,
    });
    return NextResponse.json(room, { status: 201 });
  } catch (err) {
    if (err instanceof RoomIdFormatError) {
      return NextResponse.json(
        {
          code: "invalid_room_id",
          message: "roomId must be RFC 4122 UUIDv4 lowercase.",
        },
        { status: 400 },
      );
    }
    if (err instanceof RoomSubjectRefError) {
      return NextResponse.json(
        { code: "invalid_subject_ref", message: err.message },
        { status: 400 },
      );
    }
    if (err instanceof RoomSubjectAlreadyOpenError) {
      return NextResponse.json(
        {
          code: "subject_already_open",
          message: err.message,
          existingRoomId: err.existingRoomId,
        },
        { status: 409 },
      );
    }
    if (err instanceof RoomIdTakenError) {
      return NextResponse.json(
        {
          code: "room_id_taken",
          message: err.message,
        },
        { status: 409 },
      );
    }
    throw err;
  }
}
