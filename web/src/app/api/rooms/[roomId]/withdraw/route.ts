/**
 * POST /api/rooms/:roomId/withdraw — worker explicitly withdraws
 * their RSVP.
 *
 * Capability: `rooms.contribute`. Role + agent_id are server-derived
 * from the bearer; idempotent on already-withdrawn rooms via the
 * idempotency key derivation.
 *
 * Body: `{ sequenceObservedByClient: number, reason?: string }`
 *
 * Response: `{ sequence: number }`
 *
 * Errors: same shape as /present plus 409 participant_state_precondition
 * (worker tries to withdraw without first /presenting, or after
 * already resolved/withdrew/timed_out).
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { parseJsonBody } from "@/server/request-utils";
import {
  withdrawParticipant,
  RoomNotFoundError,
  RoomIdFormatError,
  RoomEventIdempotencyReplayError,
  RoomEventStatusPreconditionError,
  RoomEventBodyTooLargeError,
  RoomParticipantOwnerConflictError,
  RoomParticipantNotFoundError,
  RoomParticipantStatePreconditionError,
} from "@/server/war-room";

interface WithdrawRequestBody {
  sequenceObservedByClient?: number;
  reason?: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: "rooms.contribute",
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
  const body = parsed.body as WithdrawRequestBody;

  if (
    typeof body.sequenceObservedByClient !== "number" ||
    !Number.isFinite(body.sequenceObservedByClient) ||
    body.sequenceObservedByClient < 0
  ) {
    return NextResponse.json(
      { code: "invalid_sequence", message: "sequenceObservedByClient must be a non-negative integer." },
      { status: 400 },
    );
  }
  if (body.reason !== undefined && typeof body.reason !== "string") {
    return NextResponse.json(
      { code: "invalid_reason", message: "reason must be a string." },
      { status: 400 },
    );
  }

  try {
    const sequence = await withdrawParticipant({
      installationId: auth.installationId,
      roomId,
      role: auth.agent_role,
      agentId: auth.name,
      sequenceObservedByClient: body.sequenceObservedByClient,
      reason: body.reason,
      redis: auth.redis,
    });
    return NextResponse.json({ sequence }, { status: 200 });
  } catch (err) {
    if (err instanceof RoomEventBodyTooLargeError) {
      return NextResponse.json(
        { code: "event_body_too_large", message: err.message, sizeBytes: err.sizeBytes },
        { status: 400 },
      );
    }
    if (err instanceof RoomNotFoundError || err instanceof RoomIdFormatError) {
      return NextResponse.json(
        { code: "room_not_found", message: `Room ${roomId} not found.` },
        { status: 404 },
      );
    }
    if (err instanceof RoomEventIdempotencyReplayError) {
      return NextResponse.json(
        { sequence: err.existingSequence, replay: true },
        { status: 200 },
      );
    }
    if (err instanceof RoomParticipantNotFoundError) {
      return NextResponse.json(
        {
          code: "participant_not_found",
          message: err.message,
        },
        { status: 409 },
      );
    }
    if (err instanceof RoomParticipantStatePreconditionError) {
      return NextResponse.json(
        {
          code: "participant_state_precondition",
          message: err.message,
          actualState: err.actualState,
          allowedStates: err.allowedStates,
        },
        { status: 409 },
      );
    }
    if (err instanceof RoomEventStatusPreconditionError) {
      return NextResponse.json(
        { code: "status_precondition_failed", message: err.message, actualStatus: err.actualStatus },
        { status: 409 },
      );
    }
    if (err instanceof RoomParticipantOwnerConflictError) {
      return NextResponse.json(
        { code: "owner_conflict", message: err.message, existingAgentId: err.existingAgentId },
        { status: 409 },
      );
    }
    throw err;
  }
}
