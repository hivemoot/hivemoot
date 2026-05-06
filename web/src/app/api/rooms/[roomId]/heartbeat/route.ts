/**
 * POST /api/rooms/:roomId/heartbeat — pure-liveness ping from a worker
 * actively triaging the room. Bumps the participant's `rsvp_at` so
 * the watchdog `drop_threshold_secs` timeout doesn't fire on agents
 * that are still doing genuine work.
 *
 * Closes the JOB_LIFECYCLE_UNIFICATION RFC, PR A. Heartbeats are
 * **pure liveness**:
 *   - No payload (per the RFC's threat-model decision — Q3).
 *   - No sequence increment (avoids 45-second re-dispatch storms via
 *     the watcher's seen-cache).
 *   - No event log entry (would otherwise inflate the audit log
 *     proportionally to room age × participant count).
 *
 * Capability: `rooms.contribute` — the same capability that gates
 * /present and /contributions. No new capability is needed because
 * a heartbeat is a less-privileged operation than the writes it
 * accompanies; an agent that can RSVP and contribute can certainly
 * keep its own RSVP fresh.
 *
 * Body: `{}` (empty). Future fields would violate the no-payload
 * decision; if progress streaming becomes valuable, it lives on a
 * separate `on_progress` hook with its own endpoint.
 *
 * Response shapes:
 *   200 `{ rsvpAt: <iso> }` — heartbeat applied.
 *   200 `{ skipped: "non_pending", participantStatus: "<actual>" }`
 *       — benign no-op (participant already withdrew/resolved/
 *       timed_out). The worker should stop heartbeating; the
 *       response is 200, not an error, so plugin code doesn't
 *       escalate it.
 *
 * Errors:
 *   - 401 / 403 — auth / capability
 *   - 404 — room not found
 *   - 409 — room not in awaiting_contributions (queen claimed,
 *           closed, expired)
 *   - 409 — owner conflict (different agent_id holds this role's
 *           slot — subscriber-mode collision)
 *   - 404 — participant slot not found (worker never /presented)
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  heartbeatParticipant,
  RoomNotFoundError,
  RoomIdFormatError,
  RoomParticipantNotFoundError,
  RoomParticipantOwnerConflictError,
  RoomTransitionInvalidStatusError,
} from "@hivemoot/war-room";

interface HeartbeatRequestBody {
  /** Per-runner identity for the first-wins gate (G5, #522). When
   * omitted, falls back to the bearer's `name` (single-runner-per-
   * token deployments). */
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

  // Body is intentionally optional — the RFC pins heartbeats as
  // payload-free. Any client that sends one is gracefully ignored
  // beyond the optional `agentId` first-wins-gate hint.
  let body: HeartbeatRequestBody = {};
  try {
    const text = await request.text();
    if (text.length > 0) {
      body = JSON.parse(text) as HeartbeatRequestBody;
    }
  } catch {
    return NextResponse.json(
      { code: "invalid_body", message: "Body must be valid JSON or empty." },
      { status: 400 },
    );
  }

  let agentId: string;
  if (body.agentId !== undefined) {
    if (typeof body.agentId !== "string") {
      return NextResponse.json(
        { code: "invalid_agent_id", message: "agentId must be a string." },
        { status: 400 },
      );
    }
    agentId = body.agentId;
  } else {
    agentId = auth.name;
  }

  try {
    const newRsvpAt = await heartbeatParticipant({
      installationId: auth.installationId,
      roomId,
      role: auth.agent_role,
      agentId,
      redis: auth.redis,
    });

    if (newRsvpAt === null) {
      // Benign no-op: the participant already withdrew / resolved /
      // timed_out. Return 200 so the agent's plugin treats it as
      // a successful "stop heartbeating" signal rather than
      // escalating an HTTP error.
      return NextResponse.json(
        { skipped: "non_pending" },
        { status: 200 },
      );
    }

    return NextResponse.json({ rsvpAt: newRsvpAt }, { status: 200 });
  } catch (err) {
    return mapWriteError(err, roomId);
  }
}

function mapWriteError(err: unknown, roomId: string): NextResponse {
  if (err instanceof RoomNotFoundError || err instanceof RoomIdFormatError) {
    return NextResponse.json(
      { code: "room_not_found", message: `Room ${roomId} not found.` },
      { status: 404 },
    );
  }
  if (err instanceof RoomTransitionInvalidStatusError) {
    return NextResponse.json(
      {
        code: "status_precondition_failed",
        message: err.message,
        actualStatus: err.actualStatus,
      },
      { status: 409 },
    );
  }
  if (err instanceof RoomParticipantNotFoundError) {
    return NextResponse.json(
      {
        code: "participant_not_found",
        message: err.message,
        role: err.role,
      },
      { status: 404 },
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
  throw err;
}
