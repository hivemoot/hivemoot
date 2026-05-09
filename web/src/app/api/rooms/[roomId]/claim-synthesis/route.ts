/**
 * POST /api/rooms/:roomId/claim-synthesis — claim the synthesis
 * lane AND return the composite payload the local queen needs to
 * run its prompt (RFC builder pass-9 §2).
 *
 * Capability: `rooms.synthesize` (RFC D14, the local-queen-side
 * cap; cloud queen continues to use `/decide` + `rooms.decide`).
 *
 * # Why this exists when /decide already does the claim
 *
 * The cloud queen's manager loop runs in-process and reads the
 * room state via the war-room library directly. The local queen
 * runs in a hive container and goes over HTTP — without this
 * composite endpoint it would need 3 sequential roundtrips after
 * the claim:
 *
 *   POST /decide                  ← claim
 *   GET /api/rooms/:id            ← room core
 *   GET /api/rooms/:id/participants
 *   GET /api/rooms/:id/contributions
 *
 * Builder pass-9 §2 specifically called out this fan-out as a
 * latency tax + race surface. claim-synthesis bundles the four
 * reads under a single auth check + the claim's atomic semantics:
 * the participants and contributions snapshot ships at the same
 * `throughSequence` cutoff the claim itself returns, so the local
 * queen's verdict prompt can't accidentally mix a fresh contribution
 * with a stale claim.
 *
 * Body: `{ queenRunner: string, claimTtlSecs?: number }` — same
 * shape as /decide for stability.
 *
 * Response: `{ claim: { throughSequence, claimTtlSecs },
 *              room: RoomCore,
 *              participants: Record<actor_role, RoomParticipant>,
 *              contributions: Record<actor_role, RoomContribution> }`
 *
 * Errors:
 *   - 401 / 403 — auth / capability
 *   - 400 — malformed body
 *   - 404 — room not found in this installation
 *   - 409 — claim_already_held / invalid_status_for_claim /
 *           sequence_drift (D5 benign-409 set)
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { parseJsonBody } from "@/server/request-utils";
import {
  claimSynthesis,
  getRoomCore,
  getRoomParticipants,
  getRoomContributions,
  RoomNotFoundError,
  RoomIdFormatError,
  RoomClaimAlreadyHeldError,
  RoomTransitionInvalidStatusError,
  RoomClaimPayloadCorruptError,
  RoomRunnerFormatError,
} from "@hivemoot/war-room";

interface ClaimSynthesisBody {
  queenRunner?: string;
  claimTtlSecs?: number;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: "rooms.synthesize",
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
  const body = parsed.body as ClaimSynthesisBody;

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

  let claim;
  try {
    claim = await claimSynthesis({
      installationId: auth.installationId,
      roomId,
      queenRunner: body.queenRunner,
      claimTtlSecs: body.claimTtlSecs,
      redis: auth.redis,
    });
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
    console.error("[rooms.claim-synthesis] claim primitive failure", {
      installationId: auth.installationId,
      roomId,
      error: err,
    });
    return NextResponse.json(
      { code: "storage_failure", message: "Claim attempt failed." },
      { status: 500 },
    );
  }

  // Claim succeeded — fan out the three reads in parallel. Any
  // single-read failure here is unexpected (we just held a claim
  // on the room so it exists), and we swallow into 500 so the
  // caller knows to retry. The claim TTL ensures the held lock
  // releases either way.
  try {
    const [room, participants, contributions] = await Promise.all([
      getRoomCore({
        installationId: auth.installationId,
        roomId,
        redis: auth.redis,
      }),
      getRoomParticipants({ roomId, redis: auth.redis }),
      getRoomContributions({ roomId, redis: auth.redis }),
    ]);

    return NextResponse.json(
      {
        claim,
        room,
        participants,
        contributions,
      },
      { status: 200 },
    );
  } catch (err) {
    console.error("[rooms.claim-synthesis] composite hydrate failure", {
      installationId: auth.installationId,
      roomId,
      error: err,
    });
    return NextResponse.json(
      {
        code: "storage_failure",
        message:
          "Claim succeeded but composite hydration failed; retry — claim TTL " +
          "will release the lock.",
      },
      { status: 500 },
    );
  }
}
