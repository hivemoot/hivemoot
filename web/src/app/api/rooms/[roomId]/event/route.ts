/**
 * POST /api/rooms/:roomId/event — append a queen meta-event to the
 * room's append-only event log.
 *
 * Capability: `rooms.update`. Bot/queen-only. The event surface this
 * endpoint exposes is intentionally narrow — only queen meta-events
 * (`subject_updated`, `queen_question`) are accepted. Other event
 * types (lifecycle: `room_opened`, `participant_*`, `contribution_*`,
 * `room_decided`, `room_terminated`, `room_recovered`) are emitted
 * by their own dedicated endpoints atomically with state changes,
 * NEVER through this generic surface.
 *
 * Why the whitelist: the lifecycle events have invariants the
 * dedicated endpoints enforce (status transition + materialized
 * hash writes + sibling cleanup). Letting this endpoint emit them
 * would let a misbehaving caller drive status transitions without
 * the atomic sibling effects, breaking the state machine.
 *
 * Body:
 *   {
 *     event_type: "subject_updated" | "queen_question",
 *     body: Record<string, unknown>,    // ≤ 8 KiB serialized
 *     idempotencyKey?: string           // caller-derived; if omitted,
 *                                       // server derives from sequenceObservedByClient
 *     sequenceObservedByClient?: number // for server-side idem derivation
 *   }
 *
 * Response: `{ sequence: number }`
 *
 * Errors:
 *   - 400 — invalid event_type / oversized body / missing idempotency input
 *   - 401 / 403 — auth / capability
 *   - 404 — room not found
 *   - 409 — idempotency replay / status precondition / owner conflict
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { parseJsonBody } from "@/server/request-utils";
import {
  appendRoomEvent,
  deriveIdempotencyKey,
  type RoomEventAction,
  type RoomEventType,
  RoomNotFoundError,
  RoomIdFormatError,
  RoomEventIdempotencyReplayError,
  RoomEventStatusPreconditionError,
  RoomEventBodyTooLargeError,
} from "@hivemoot/war-room";

// Whitelist for /event — keep narrow per the docstring.
const ALLOWED_META_EVENT_TYPES: ReadonlySet<RoomEventType> = new Set<RoomEventType>([
  "subject_updated",
  "queen_question",
]);

// Maps allowed event types to their canonical action key for
// `deriveIdempotencyKey`. Keep in sync with RoomEventAction in
// war-room.ts.
const EVENT_TYPE_TO_ACTION: Record<string, RoomEventAction> = {
  subject_updated: "subject_updated",
  queen_question: "queen_question",
};

interface EventRequestBody {
  event_type?: string;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
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
  const body = parsed.body as EventRequestBody;

  if (
    typeof body.event_type !== "string" ||
    !ALLOWED_META_EVENT_TYPES.has(body.event_type as RoomEventType)
  ) {
    return NextResponse.json(
      {
        code: "invalid_event_type",
        message: `event_type must be one of: ${Array.from(ALLOWED_META_EVENT_TYPES).join(", ")}`,
      },
      { status: 400 },
    );
  }
  if (!body.body || typeof body.body !== "object") {
    return NextResponse.json(
      { code: "invalid_event_body", message: "Body must include `body` object." },
      { status: 400 },
    );
  }

  // Idempotency: prefer caller-supplied key; otherwise derive from
  // observed sequence + role + action. Either path requires SOME
  // input — server can't synthesize a stable key from request alone.
  let idempotencyKey: string;
  if (typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 0) {
    idempotencyKey = body.idempotencyKey;
  } else if (
    typeof body.sequenceObservedByClient === "number" &&
    Number.isFinite(body.sequenceObservedByClient)
  ) {
    idempotencyKey = deriveIdempotencyKey({
      roomId,
      role: auth.agent_role,
      action: EVENT_TYPE_TO_ACTION[body.event_type as RoomEventType],
      sequenceObservedByClient: body.sequenceObservedByClient,
    });
  } else {
    return NextResponse.json(
      {
        code: "missing_idempotency",
        message:
          "Provide either `idempotencyKey` (string) or `sequenceObservedByClient` (number) for replay protection.",
      },
      { status: 400 },
    );
  }

  const nowIso = new Date().toISOString();

  try {
    const sequence = await appendRoomEvent({
      installationId: auth.installationId,
      roomId,
      event: {
        timestamp: nowIso,
        event_type: body.event_type as RoomEventType,
        actor_role: auth.agent_role,
        actor_id: auth.name,
        body: body.body,
      },
      idempotencyKey,
      // Closes #519 guard B1 (BLOCKER): the script's status gate
      // only fires when allowedStatuses is non-empty. Without it,
      // `subject_updated` and `queen_question` events would land on:
      //   - `deciding` rooms — breaking the bot's
      //     webhook-on-deciding deferral mechanism (design L919-932)
      //   - `closed` / terminated rooms — polluting the audit log
      //     for the entire retention window AND resurfacing dead
      //     rooms on `/api/rooms/watching`
      // Both `awaiting_rsvp` and `awaiting_contributions` accept
      // bot meta-events; status-precondition failure → 409
      // `status_precondition_failed` so the bot enqueues into its
      // webhook-buffer and re-tries after the queen releases.
      allowedStatuses: ["awaiting_rsvp", "awaiting_contributions"],
      redis: auth.redis,
    });
    return NextResponse.json({ sequence }, { status: 200 });
  } catch (err) {
    if (err instanceof RoomNotFoundError || err instanceof RoomIdFormatError) {
      return NextResponse.json(
        { code: "room_not_found", message: `Room ${roomId} not found.` },
        { status: 404 },
      );
    }
    if (err instanceof RoomEventBodyTooLargeError) {
      return NextResponse.json(
        { code: "event_body_too_large", message: err.message },
        { status: 400 },
      );
    }
    if (err instanceof RoomEventIdempotencyReplayError) {
      // Replay is benign — the prior write already landed. Return 200
      // with the prior sequence so the caller treats it as success
      // (matches the design's "treat as success" instruction in the
      // error message itself).
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
    throw err;
  }
}
