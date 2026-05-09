/**
 * GET /api/rooms/decided-pending-ready — list rooms in
 * `decided_pending_action` ready for the local queen's tick-N+1
 * confirm-merge call (RFC G27).
 *
 * Capability: `rooms.synthesize` (same as synthesis-ready — local
 * queen polls both endpoints).
 *
 * # What "ready" means
 *
 * Per the RFC, a room is confirm-merge-ready when:
 *   - status = `decided_pending_action`
 *   - sealed at tick N ≥60s ago (G13 operator-override window
 *     elapsed)
 *   - sealed at tick N ≤15min ago (G4 TTL — older rooms are the
 *     reconciler's job, G32)
 *
 * **PR 3c slice (this commit) returns the status filter only** —
 * the ≥60s and ≤15min checks are applied by the local queen's
 * confirm-merge call site (it knows the seal timestamp from its
 * audit row) and by the reconciler (G32). Server-side enforcement
 * here would require reading a per-room timestamp, which is fine
 * but better folded into the confirm-merge endpoint's invariant
 * check rather than duplicated in this list endpoint.
 *
 * **Today this endpoint returns an empty list in steady state**
 * because no code path SADDs to the `decided_pending_action` status
 * index until seal-decision lands (PR 3c slice 2). This PR exists
 * now to:
 *   - establish the route surface area + capability gating
 *   - let PR 4's hive queen plugin compile against the right
 *     interface
 *   - get the auth contract reviewed in isolation
 *
 * Response shape:
 *   { rooms: RoomCoreWithId[], count: number }
 *
 * Errors:
 *   - 401 not_authenticated — missing / invalid bearer
 *   - 403 capability_denied — bearer lacks `rooms.synthesize`
 *   - 500 storage_failure
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  getRoomCore,
  statusIndexKey,
  type RoomCoreWithId,
} from "@hivemoot/war-room";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: "rooms.synthesize",
  });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (Number.isFinite(parsed)) {
      limit = Math.min(MAX_LIMIT, Math.max(1, parsed));
    }
  }

  try {
    const indexKey = statusIndexKey(auth.installationId, "decided_pending_action");
    // `statusIndexKey` is a Redis SET (SADD/SREM in war-room.ts:
    // 2269-2526). SMEMBERS is the only key-type-safe read; ZRANGE
    // returns WRONGTYPE against a SET in real Redis (guard pass-1
    // G1). Newest-first is applied post-hoc on hydrated cores.
    const roomIds = await auth.redis.smembers(indexKey);

    const cores = await Promise.all(
      roomIds.map(async (roomId) => {
        try {
          const core = await getRoomCore({
            installationId: auth.installationId,
            roomId,
            redis: auth.redis,
          });
          return { roomId, ...core } as RoomCoreWithId;
        } catch {
          return null;
        }
      }),
    );

    const rooms = cores
      .filter(
        (r): r is RoomCoreWithId =>
          r !== null && r.status === "decided_pending_action",
      )
      // Newest-first by opened_at (descending). opened_at is an ISO
      // 8601 string with a consistent timezone, so lex sort gives
      // chronological order. Stable on ties via roomId.
      .sort((a, b) => {
        if (b.opened_at !== a.opened_at) return b.opened_at < a.opened_at ? -1 : 1;
        return a.roomId < b.roomId ? -1 : 1;
      })
      .slice(0, limit);

    return NextResponse.json({ rooms, count: rooms.length }, { status: 200 });
  } catch (error) {
    console.error("[rooms.decided-pending-ready] storage failure", {
      installationId: auth.installationId,
      error,
    });
    return NextResponse.json(
      {
        code: "storage_failure",
        message: "Failed to list decided-pending rooms.",
      },
      { status: 500 },
    );
  }
}
