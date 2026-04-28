/**
 * POST /api/rooms/:roomId/force-close — operator-initiated terminal
 * close. Atomic across all status sets + claim DEL + index cleanup.
 *
 * Capability: `rooms.force_close`. Admin-only — distinct from the
 * queen's happy-path `/close` (which requires a live claim AND
 * sequence consistency). Force-close races the queen by DELing the
 * claim; queen's mid-flight `/close` then returns
 * `RoomCloseClaimLostError` and aborts the GitHub post.
 *
 * Body: `{ reason?: TerminalReason }` — defaults to `"force_close"`
 *       if omitted. Other valid reasons (operator-driven):
 *       `"manual"`, `"expired"`, `"failed_synthesis"` (rare).
 *
 * Subject is fetched from the room hash server-side — same pattern
 * as `/close`, no subject-mismatch attacks.
 *
 * Response: `{ sequence: number }` — the terminating event's seq.
 *
 * Errors:
 *   - 401 / 403 — auth / capability
 *   - 400 — invalid reason
 *   - 404 — room not found
 *   - 409 — already closed (operator double-tap)
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { parseOptionalJsonObjectBody } from "@/server/request-utils";
import {
  terminateRoom,
  getRoomCore,
  type SubjectRef,
  type TerminalReason,
  RoomNotFoundError,
  RoomIdFormatError,
  RoomAlreadyClosedError,
} from "@/server/war-room";

const VALID_REASONS: ReadonlySet<TerminalReason> = new Set<TerminalReason>([
  "expired",
  "failed_synthesis",
  "force_close",
  "manual",
]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: "rooms.force_close",
  });
  if (!auth.ok) return auth.response;

  const { roomId } = await params;

  // Body is optional — empty body defaults reason to "force_close".
  // Two requirements that conflict if you naively `request.json()`:
  //   1. Closes #519 builder R1: malformed JSON MUST fail-loud
  //      (returns 400, terminateRoom NEVER called) so a bad/truncated
  //      operator payload doesn't silently force-close with the
  //      default reason.
  //   2. Closes #519 builder R3: a valid empty POST (`curl -X POST`
  //      with no `-d`) sends NO `Content-Length` header at all —
  //      `request.json()` throws on empty body, which the prior
  //      heuristic (`content-length === "0"` skip) didn't cover.
  // `parseOptionalJsonObjectBody` reads body as text first, treats
  // empty as `{}` (defaults), and JSON-parses non-empty (fail loud
  // on bad payload). Both requirements satisfied by one helper.
  const parsed = await parseOptionalJsonObjectBody(request);
  if (!parsed.ok) {
    return NextResponse.json(
      { code: parsed.code, message: parsed.message },
      { status: 400 },
    );
  }
  const body = parsed.body;
  const rawReason = body.reason;
  if (rawReason !== undefined && typeof rawReason !== "string") {
    return NextResponse.json(
      { code: "invalid_reason", message: "reason must be a string." },
      { status: 400 },
    );
  }
  if (
    rawReason !== undefined &&
    !VALID_REASONS.has(rawReason as TerminalReason)
  ) {
    return NextResponse.json(
      {
        code: "invalid_reason",
        message: `reason must be one of: ${Array.from(VALID_REASONS).join(", ")}`,
      },
      { status: 400 },
    );
  }
  const reason: TerminalReason =
    rawReason !== undefined ? (rawReason as TerminalReason) : "force_close";

  let subject: SubjectRef;
  try {
    const room = await getRoomCore({
      installationId: auth.installationId,
      roomId,
      redis: auth.redis,
    });
    subject = { type: room.subject_type, ref: room.subject_ref };
  } catch (err) {
    if (err instanceof RoomNotFoundError || err instanceof RoomIdFormatError) {
      return NextResponse.json(
        { code: "room_not_found", message: `Room ${roomId} not found.` },
        { status: 404 },
      );
    }
    throw err;
  }

  try {
    const sequence = await terminateRoom({
      installationId: auth.installationId,
      roomId,
      reason,
      subject,
      // Operator-driven: actor is the bearer's role + name. The
      // event log preserves WHO force-closed for forensic trail.
      actorRole: auth.agent_role,
      actorId: auth.name,
      redis: auth.redis,
    });
    return NextResponse.json({ sequence, reason }, { status: 200 });
  } catch (err) {
    if (err instanceof RoomNotFoundError || err instanceof RoomIdFormatError) {
      return NextResponse.json(
        { code: "room_not_found", message: `Room ${roomId} not found.` },
        { status: 404 },
      );
    }
    if (err instanceof RoomAlreadyClosedError) {
      return NextResponse.json(
        {
          code: "room_already_closed",
          message: err.message,
          status: err.status,
        },
        { status: 409 },
      );
    }
    throw err;
  }
}
