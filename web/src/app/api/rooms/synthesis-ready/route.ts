/**
 * GET /api/rooms/synthesis-ready — list rooms in
 * `awaiting_contributions` ready for synthesis claim. Required by
 * the local queen's polling loop (RFC PR 4).
 *
 * Capability: `rooms.synthesize` (RFC D14, the cap PR 645 added).
 * Cross-installation isolation: the bearer's `installationId` is the
 * canonical scope.
 *
 * # What "ready" means
 *
 * Per the RFC, a room is synthesis-ready when:
 *   - status = `awaiting_contributions`
 *   - all participants are resolved
 *   - quiet-period gate has elapsed (≥60s since last transition)
 *
 * **PR 3c slice (this commit) returns the status filter only** —
 * eligibility checks (participants resolved, quiet period elapsed)
 * stay in the local queen's trigger loop where they're already
 * implemented for the cloud queen-tick. Server-side filtering would
 * require fan-out reads (participants per room) and the local queen
 * already does the per-room re-fetch via `claim-synthesis`'s
 * post-claim re-validation (D5). Adding it here would be redundant.
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
  RoomNotFoundError,
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
    const indexKey = statusIndexKey(auth.installationId, "awaiting_contributions");
    // `statusIndexKey` is a Redis SET (SADD/SREM in war-room.ts:
    // 2269-2526). Reading via SMEMBERS is the only key-type-safe
    // option; ZRANGE returns WRONGTYPE against a SET in real Redis
    // (guard pass-1 G1). Newest-first ordering is a property of the
    // *response*, not the index — we sort the hydrated cores by
    // `opened_at` post-hoc.
    const roomIds = await auth.redis.smembers(indexKey);

    // Hydrate room cores in parallel. A room can transition out of
    // awaiting_contributions between the index read and the core
    // read; the caller's claim-synthesis call re-validates status,
    // so a stale entry here is harmless (just one wasted attempt).
    //
    // Builder pass-2 fix: only swallow `RoomNotFoundError` (the
    // expected stale-index race). Rethrow every other failure so the
    // outer `storage_failure` 500 branch runs — a Redis connection
    // failure must NOT silently look like "no rooms ready" to the
    // local queen, which would treat it as "idle" and skip the work
    // it should have retried.
    const cores = await Promise.all(
      roomIds.map(async (roomId) => {
        try {
          const core = await getRoomCore({
            installationId: auth.installationId,
            roomId,
            redis: auth.redis,
          });
          return { roomId, ...core } as RoomCoreWithId;
        } catch (err) {
          if (err instanceof RoomNotFoundError) {
            // Stale index entry — the room was terminated/closed
            // between the SMEMBERS read and the hash read. Skip.
            return null;
          }
          throw err;
        }
      }),
    );

    const rooms = cores
      .filter(
        (r): r is RoomCoreWithId =>
          r !== null && r.status === "awaiting_contributions",
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
    console.error("[rooms.synthesis-ready] storage failure", {
      installationId: auth.installationId,
      error,
    });
    return NextResponse.json(
      { code: "storage_failure", message: "Failed to list synthesis-ready rooms." },
      { status: 500 },
    );
  }
}
