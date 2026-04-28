/**
 * POST /api/rooms/:roomId/decide — atomically claim the synthesis
 * lane for a room.
 *
 * Capability: `rooms.decide`. Queen-only operation; the queen
 * runner identity is captured in the claim record so that observers
 * (operators, watchdog) know who holds it.
 *
 * Body: `{ queenRunner: string, claimTtlSecs?: number }`
 *
 * Response: `{ throughSequence, claimTtlSecs }`. The caller passes
 * `throughSequence` back on `/close` to detect drift (events that
 * arrived during synthesis); the queen runtime reads `claimTtlSecs`
 * to decide when to refresh.
 *
 * Errors:
 *   - 401 / 403 — auth / capability
 *   - 400 — malformed body, invalid queenRunner format
 *   - 404 — room not found in this installation
 *   - 409 — claim already held / wrong status / payload corrupt
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  claimSynthesis,
  RoomNotFoundError,
  RoomIdFormatError,
  RoomClaimAlreadyHeldError,
  RoomTransitionInvalidStatusError,
  RoomClaimPayloadCorruptError,
  RoomRunnerFormatError,
} from "@/server/war-room";

interface DecideRequestBody {
  queenRunner?: string;
  claimTtlSecs?: number;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: "rooms.decide",
  });
  if (!auth.ok) return auth.response;

  const { roomId } = await params;

  let body: DecideRequestBody;
  try {
    body = (await request.json()) as DecideRequestBody;
  } catch {
    return NextResponse.json(
      { code: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  if (typeof body.queenRunner !== "string" || body.queenRunner.length === 0) {
    return NextResponse.json(
      {
        code: "invalid_queen_runner",
        message: "Body must include `queenRunner` as a non-empty string.",
      },
      { status: 400 },
    );
  }
  if (
    body.claimTtlSecs !== undefined &&
    (typeof body.claimTtlSecs !== "number" ||
      !Number.isFinite(body.claimTtlSecs) ||
      body.claimTtlSecs <= 0)
  ) {
    return NextResponse.json(
      {
        code: "invalid_claim_ttl",
        message: "claimTtlSecs must be a positive finite number.",
      },
      { status: 400 },
    );
  }

  try {
    const result = await claimSynthesis({
      installationId: auth.installationId,
      roomId,
      queenRunner: body.queenRunner,
      claimTtlSecs: body.claimTtlSecs,
      redis: auth.redis,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof RoomRunnerFormatError) {
      return NextResponse.json(
        { code: "invalid_queen_runner", message: err.message },
        { status: 400 },
      );
    }
    if (err instanceof RoomNotFoundError || err instanceof RoomIdFormatError) {
      return NextResponse.json(
        { code: "room_not_found", message: `Room ${roomId} not found.` },
        { status: 404 },
      );
    }
    if (err instanceof RoomClaimAlreadyHeldError) {
      return NextResponse.json(
        {
          code: "claim_already_held",
          message: err.message,
          heldByRunner: err.heldByRunner,
          throughSequence: err.throughSequence,
        },
        { status: 409 },
      );
    }
    if (err instanceof RoomTransitionInvalidStatusError) {
      return NextResponse.json(
        {
          code: "invalid_status_for_claim",
          message: err.message,
          actualStatus: err.actualStatus,
          expectedStatuses: err.expectedStatuses,
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
    throw err;
  }
}
