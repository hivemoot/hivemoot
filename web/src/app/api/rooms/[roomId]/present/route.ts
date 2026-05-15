/**
 * POST /api/rooms/:roomId/present — worker RSVPs to a room.
 *
 * Capability: `rooms.contribute`. The role and agent_id are
 * server-derived from the bearer envelope; clients cannot
 * impersonate another role's RSVP.
 *
 * Body: `{ sequenceObservedByClient: number, intentHint?: string }`
 *
 * Response: `{ sequence: number }` — the participant_presented event's seq.
 *
 * Errors:
 *   - 400 — malformed body / missing sequenceObservedByClient
 *   - 401 / 403 — auth / capability
 *   - 404 — room not found
 *   - 409 — owner conflict (different agent already holds this role's
 *     slot), idempotency replay (returns 200 with replay flag),
 *     status precondition (room not in awaiting_contributions)
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { parseJsonBody } from "@/server/request-utils";
import {
  presentParticipant,
  RoomNotFoundError,
  RoomIdFormatError,
  RoomEventIdempotencyReplayError,
  RoomEventStatusPreconditionError,
  RoomEventBodyTooLargeError,
  RoomParticipantOwnerConflictError,
  RoomParticipantStatePreconditionError,
  RoomRunnerFormatError,
  validateRunnerFormat,
} from "@hivemoot/war-room";

interface PresentRequestBody {
  sequenceObservedByClient?: number;
  intentHint?: string;
  /** Per-runner identity for the first-wins gate (G5, #522). When
   * omitted, falls back to the bearer's `name` (single-runner-per-
   * token deployments — current Hive fleet model). Subscriber-mode
   * fleets sharing one token MUST send a distinct value per runner. */
  agentId?: string;
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
  const body = parsed.body as PresentRequestBody;

  if (
    typeof body.sequenceObservedByClient !== "number" ||
    !Number.isFinite(body.sequenceObservedByClient) ||
    body.sequenceObservedByClient < 0
  ) {
    return NextResponse.json(
      {
        code: "invalid_sequence",
        message:
          "sequenceObservedByClient must be a non-negative integer (the seq the watcher observed when it decided to RSVP).",
      },
      { status: 400 },
    );
  }
  if (
    body.intentHint !== undefined &&
    typeof body.intentHint !== "string"
  ) {
    return NextResponse.json(
      { code: "invalid_intent_hint", message: "intentHint must be a string." },
      { status: 400 },
    );
  }

  // Body-supplied agentId for subscriber-mode first-wins gate (#522).
  // Optional: when omitted, fall back to bearer name so single-runner-
  // per-token deployments (drone pilot) work unchanged.
  let agentId: string;
  if (body.agentId !== undefined) {
    if (typeof body.agentId !== "string") {
      return NextResponse.json(
        { code: "invalid_agent_id", message: "agentId must be a string." },
        { status: 400 },
      );
    }
    try {
      validateRunnerFormat(body.agentId);
    } catch (err) {
      if (err instanceof RoomRunnerFormatError) {
        return NextResponse.json(
          { code: "invalid_agent_id", message: err.message },
          { status: 400 },
        );
      }
      throw err;
    }
    agentId = body.agentId;
  } else {
    agentId = auth.name;
  }

  try {
    const sequence = await presentParticipant({
      installationId: auth.installationId,
      roomId,
      role: auth.agent_role,
      agentId,
      actorId: auth.name,
      sequenceObservedByClient: body.sequenceObservedByClient,
      intentHint: body.intentHint,
      redis: auth.redis,
    });
    return NextResponse.json({ sequence }, { status: 200 });
  } catch (err) {
    return mapWriteError(err, roomId);
  }
}

function mapWriteError(err: unknown, roomId: string): NextResponse {
  if (err instanceof RoomEventBodyTooLargeError) {
    // Closes #521 builder R1 #2: a large intentHint (or other
    // body field) would otherwise bubble out as an unhandled 500.
    // assertEventBodySize fires for serialized event bodies > 8 KiB.
    return NextResponse.json(
      {
        code: "event_body_too_large",
        message: err.message,
        sizeBytes: err.sizeBytes,
      },
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
    // Same convention as /event: replay is benign, return 200 with
    // the prior sequence so the worker treats it as success.
    return NextResponse.json(
      { sequence: err.existingSequence, replay: true },
      { status: 200 },
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
  if (err instanceof RoomParticipantOwnerConflictError) {
    return NextResponse.json(
      {
        code: "owner_conflict",
        message: err.message,
        existingAgentId: err.existingAgentId,
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
      },
      { status: 409 },
    );
  }
  throw err;
}
