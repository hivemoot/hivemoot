/**
 * POST /api/rooms/:roomId/timeout — watchdog times out a participant.
 *
 * Capability: `rooms.update`. The bot/queen module's manager loop
 * is the canonical caller, NOT workers — `actor_role` and `actor_id`
 * are the watchdog's identity (server-derived from the bearer
 * envelope), and `subjectRole` (the role being timed out) comes
 * from the request body.
 *
 * Body: `{ subjectRole: string, sequenceObservedByClient: number }`
 *
 * Status precondition: only fires while the room is still in
 * `awaiting_contributions`. If the queen has already moved status
 * to `deciding`, this returns 409 — the watchdog re-scans next tick.
 *
 * Participant-state precondition: only times out `pending`. Re-reads
 * are protected against racing a worker's resolve.
 *
 * Response: `{ sequence: number }`
 *
 * Errors: 400 (validation), 401/403, 404, 409.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { parseJsonBody } from "@/server/request-utils";
import {
  timeoutParticipant,
  validateRoleFormat,
  RoomNotFoundError,
  RoomIdFormatError,
  RoomEventIdempotencyReplayError,
  RoomEventStatusPreconditionError,
  RoomEventBodyTooLargeError,
  RoomParticipantNotFoundError,
  RoomParticipantStatePreconditionError,
  RoomRoleFormatError,
} from "@hivemoot/war-room";

interface TimeoutRequestBody {
  subjectRole?: string;
  sequenceObservedByClient?: number;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: "rooms.update",
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
  const body = parsed.body as TimeoutRequestBody;

  if (typeof body.subjectRole !== "string" || body.subjectRole.length === 0) {
    return NextResponse.json(
      {
        code: "invalid_subject_role",
        message: "subjectRole (the role being timed out) is required.",
      },
      { status: 400 },
    );
  }
  // Format validation at the route boundary (closes #521 builder R1
  // #3). Without this, a malformed subjectRole would reach
  // timeoutParticipant's internal assertRoleFormat which throws a
  // plain Error → unhandled 500.
  try {
    validateRoleFormat(body.subjectRole);
  } catch (err) {
    if (err instanceof RoomRoleFormatError) {
      return NextResponse.json(
        { code: "invalid_subject_role", message: err.message },
        { status: 400 },
      );
    }
    throw err;
  }
  if (
    typeof body.sequenceObservedByClient !== "number" ||
    !Number.isFinite(body.sequenceObservedByClient) ||
    body.sequenceObservedByClient < 0
  ) {
    return NextResponse.json(
      { code: "invalid_sequence", message: "sequenceObservedByClient required (non-negative integer)." },
      { status: 400 },
    );
  }

  try {
    const sequence = await timeoutParticipant({
      installationId: auth.installationId,
      roomId,
      subjectRole: body.subjectRole,
      // Watchdog identity comes from the bearer — same pattern as
      // /event's actor_role/actor_id derivation. The bot's manager
      // loop has a `rooms.update` token; operator UI also reaches
      // here for manual timeouts (rare).
      watchdogRole: auth.agent_role,
      watchdogAgentId: auth.name,
      sequenceObservedByClient: body.sequenceObservedByClient,
      redis: auth.redis,
    });
    return NextResponse.json({ sequence }, { status: 200 });
  } catch (err) {
    if (err instanceof RoomEventBodyTooLargeError) {
      // Closes #521 builder R1 #2 for /timeout — body holds
      // subject_role inline so an unusually long role (defensive
      // path) could push the event over 8 KiB.
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
        { code: "participant_not_found", message: err.message },
        { status: 409 },
      );
    }
    if (err instanceof RoomParticipantStatePreconditionError) {
      // Per design L1055, only `pending` is valid for timeout. A
      // stale watchdog tick that read `pending` BEFORE a worker's
      // resolve will land here — caller logs and re-scans.
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
        {
          code: "status_precondition_failed",
          message: err.message,
          actualStatus: err.actualStatus,
        },
        { status: 409 },
      );
    }
    throw err;
  }
}
