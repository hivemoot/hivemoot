/**
 * POST /api/rooms/:roomId/close — queen happy-path close with
 * synthesized decision. Atomic with sequence-consistency check.
 *
 * Capability: `rooms.close`. Queen-only — requires a live claim
 * acquired via `/decide`.
 *
 * Body:
 *   {
 *     expectedThroughSequence: number,   // captured at claim time
 *     decision: {
 *       synthesized_at: string,           // ISO 8601
 *       synthesis_runner: string,
 *       content: string,                  // ≤ 64 KiB UTF-8 bytes
 *       sequence_closed: number
 *     }
 *   }
 *
 * Response: `{ closedSequence: number }`
 *
 * Errors:
 *   - 400 — malformed body / decision shape
 *   - 401 / 403 — auth / capability
 *   - 404 — room not found
 *   - 409 — drift / claim_lost / through_seq_mismatch / payload_corrupt
 *
 * Subject is fetched server-side from the room hash — caller does
 * NOT need to pass it. This keeps the request body queen-focused
 * (just decision payload) and avoids subject-mismatch attacks.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { parseJsonBody } from "@/server/request-utils";
import {
  closeRoomWithDecision,
  getRoomCore,
  type RoomDecision,
  type SubjectRef,
  RoomNotFoundError,
  RoomIdFormatError,
  RoomCloseClaimLostError,
  RoomCloseClaimThroughSeqMismatchError,
  RoomCloseDriftError,
  RoomClaimPayloadCorruptError,
  RoomRunnerFormatError,
  RoomDecisionTooLargeError,
} from "@hivemoot/war-room";

interface CloseRequestBody {
  expectedThroughSequence?: number;
  decision?: Partial<RoomDecision>;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: "rooms.close",
  });
  if (!auth.ok) return auth.response;

  const { roomId } = await params;

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) {
    return NextResponse.json(
      { code: parsed.code, message: parsed.message },
      { status: 400 },
    );
  }
  const body = parsed.body as CloseRequestBody;

  if (
    typeof body.expectedThroughSequence !== "number" ||
    !Number.isFinite(body.expectedThroughSequence) ||
    body.expectedThroughSequence < 1
  ) {
    return NextResponse.json(
      {
        code: "invalid_through_sequence",
        message: "expectedThroughSequence must be a positive integer (from /decide).",
      },
      { status: 400 },
    );
  }
  if (!body.decision || typeof body.decision !== "object") {
    return NextResponse.json(
      { code: "invalid_decision", message: "Body must include `decision` object." },
      { status: 400 },
    );
  }
  const d = body.decision;
  if (
    typeof d.synthesized_at !== "string" ||
    typeof d.synthesis_runner !== "string" ||
    typeof d.content !== "string" ||
    typeof d.sequence_closed !== "number"
  ) {
    return NextResponse.json(
      {
        code: "invalid_decision_shape",
        message:
          "decision must include synthesized_at (string), synthesis_runner (string), content (string), sequence_closed (number).",
      },
      { status: 400 },
    );
  }
  const decision: RoomDecision = {
    synthesized_at: d.synthesized_at,
    synthesis_runner: d.synthesis_runner,
    content: d.content,
    sequence_closed: d.sequence_closed,
  };

  // Server-side fetch of subject from the room hash. The storage
  // primitive uses subject to compute the per-installation
  // subject-index key; pulling from the room hash means caller
  // can't induce a subject-key mismatch.
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
    const closedSequence = await closeRoomWithDecision({
      installationId: auth.installationId,
      roomId,
      expectedThroughSequence: body.expectedThroughSequence,
      decision,
      subject,
      redis: auth.redis,
    });
    return NextResponse.json({ closedSequence }, { status: 200 });
  } catch (err) {
    if (err instanceof RoomRunnerFormatError) {
      return NextResponse.json(
        { code: "invalid_synthesis_runner", message: err.message },
        { status: 400 },
      );
    }
    if (err instanceof RoomCloseDriftError) {
      return NextResponse.json(
        {
          code: "sequence_drift",
          message: err.message,
          expectedThroughSequence: err.expectedThroughSequence,
          lastSeq: err.lastSeq,
        },
        { status: 409 },
      );
    }
    if (err instanceof RoomCloseClaimLostError) {
      return NextResponse.json(
        { code: "claim_lost", message: err.message },
        { status: 409 },
      );
    }
    if (err instanceof RoomCloseClaimThroughSeqMismatchError) {
      return NextResponse.json(
        {
          code: "claim_through_seq_mismatch",
          message: err.message,
          expectedThroughSequence: err.expectedThroughSequence,
          actualThroughSequence: err.actualThroughSequence,
        },
        { status: 409 },
      );
    }
    if (err instanceof RoomClaimPayloadCorruptError) {
      return NextResponse.json(
        { code: "claim_payload_corrupt", message: err.message },
        { status: 409 },
      );
    }
    if (err instanceof RoomDecisionTooLargeError) {
      return NextResponse.json(
        {
          code: "decision_too_large",
          message: err.message,
          sizeBytes: err.sizeBytes,
        },
        { status: 400 },
      );
    }
    throw err;
  }
}
