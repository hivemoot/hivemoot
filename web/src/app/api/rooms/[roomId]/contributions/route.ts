/**
 * /api/rooms/:roomId/contributions — read (GET), submit (POST), and
 * withdraw (DELETE) contributions.
 *
 * GET — D.1.b-i. Capability `rooms.read_all`. Lists materialized
 *       contribution hash for the room.
 *
 * POST — D.1.b-iii. Capability `rooms.contribute`. Worker submits a
 *        contribution. Body shape:
 *          {
 *            sequenceObservedByClient: number,
 *            body: ContributionBody,    // typed (verdict, summary, findings, etc.)
 *            rawMd: string              // ≤ 32 KiB UTF-8 bytes
 *          }
 *        Server-derived: role, agent_id from envelope.
 *
 * DELETE — D.1.b-iii. Capability `rooms.contribute`. Worker withdraws
 *          a previously-submitted contribution. Body shape:
 *          { sequenceObservedByClient: number, reason?: string }
 *          Tombstone: writes `{ withdrawn: true, contributed_at }` to
 *          the contributions hash; events sorted set preserves the
 *          original audit trail.
 *
 * Errors: same shape as /present and /withdraw, plus 400 for body
 * validation failures (invalid verdict, oversized rawMd, etc.) via
 * the typed validation primitives.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { parseJsonBody } from "@/server/request-utils";
import {
  submitContribution,
  withdrawContribution,
  getRoomCore,
  getRoomContributions,
  type ContributionBody,
  RoomNotFoundError,
  RoomIdFormatError,
  RoomEventIdempotencyReplayError,
  RoomEventStatusPreconditionError,
  RoomParticipantOwnerConflictError,
  RoomParticipantNotFoundError,
  RoomParticipantStatePreconditionError,
  RoomContributionTooLargeError,
  ContributionValidationError,
} from "@/server/war-room";

// ---------------------------------------------------------------------------
// GET — read contributions hash (D.1.b-i, scoped to rooms.read_all)
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: "rooms.read_all",
  });
  if (!auth.ok) return auth.response;

  const { roomId } = await params;

  try {
    await getRoomCore({
      installationId: auth.installationId,
      roomId,
      redis: auth.redis,
    });
  } catch (err) {
    if (err instanceof RoomNotFoundError || err instanceof RoomIdFormatError) {
      return NextResponse.json(
        { code: "room_not_found", message: `Room ${roomId} not found.` },
        { status: 404 },
      );
    }
    throw err;
  }

  const contributions = await getRoomContributions({
    roomId,
    redis: auth.redis,
  });
  return NextResponse.json({ contributions, roomId }, { status: 200 });
}

// ---------------------------------------------------------------------------
// POST — submit contribution (D.1.b-iii, rooms.contribute)
// ---------------------------------------------------------------------------

interface SubmitRequestBody {
  sequenceObservedByClient?: number;
  body?: ContributionBody;
  rawMd?: string;
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
  const reqBody = parsed.body as SubmitRequestBody;

  if (
    typeof reqBody.sequenceObservedByClient !== "number" ||
    !Number.isFinite(reqBody.sequenceObservedByClient) ||
    reqBody.sequenceObservedByClient < 0
  ) {
    return NextResponse.json(
      { code: "invalid_sequence", message: "sequenceObservedByClient required (non-negative integer)." },
      { status: 400 },
    );
  }
  if (!reqBody.body || typeof reqBody.body !== "object") {
    return NextResponse.json(
      { code: "invalid_body", message: "body (ContributionBody) is required." },
      { status: 400 },
    );
  }
  if (typeof reqBody.rawMd !== "string") {
    return NextResponse.json(
      { code: "invalid_raw_md", message: "rawMd must be a string." },
      { status: 400 },
    );
  }

  try {
    const sequence = await submitContribution({
      installationId: auth.installationId,
      roomId,
      role: auth.agent_role,
      agentId: auth.name,
      sequenceObservedByClient: reqBody.sequenceObservedByClient,
      body: reqBody.body,
      rawMd: reqBody.rawMd,
      redis: auth.redis,
    });
    return NextResponse.json({ sequence }, { status: 200 });
  } catch (err) {
    return mapWriteError(err, roomId);
  }
}

// ---------------------------------------------------------------------------
// DELETE — withdraw contribution tombstone (D.1.b-iii, rooms.contribute)
// ---------------------------------------------------------------------------

interface WithdrawContributionBody {
  sequenceObservedByClient?: number;
  reason?: string;
}

export async function DELETE(
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
  const reqBody = parsed.body as WithdrawContributionBody;

  if (
    typeof reqBody.sequenceObservedByClient !== "number" ||
    !Number.isFinite(reqBody.sequenceObservedByClient) ||
    reqBody.sequenceObservedByClient < 0
  ) {
    return NextResponse.json(
      { code: "invalid_sequence", message: "sequenceObservedByClient required (non-negative integer)." },
      { status: 400 },
    );
  }
  if (reqBody.reason !== undefined && typeof reqBody.reason !== "string") {
    return NextResponse.json(
      { code: "invalid_reason", message: "reason must be a string." },
      { status: 400 },
    );
  }

  try {
    const sequence = await withdrawContribution({
      installationId: auth.installationId,
      roomId,
      role: auth.agent_role,
      agentId: auth.name,
      sequenceObservedByClient: reqBody.sequenceObservedByClient,
      reason: reqBody.reason,
      redis: auth.redis,
    });
    return NextResponse.json({ sequence }, { status: 200 });
  } catch (err) {
    return mapWriteError(err, roomId);
  }
}

// ---------------------------------------------------------------------------
// Shared write-error mapping (POST + DELETE)
// ---------------------------------------------------------------------------

function mapWriteError(err: unknown, roomId: string): NextResponse {
  if (err instanceof ContributionValidationError) {
    return NextResponse.json(
      { code: "invalid_contribution_body", message: err.message },
      { status: 400 },
    );
  }
  if (err instanceof RoomContributionTooLargeError) {
    return NextResponse.json(
      {
        code: "raw_md_too_large",
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
