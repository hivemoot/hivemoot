/**
 * In-flight precheck for the mode-flip endpoint (D9).
 *
 * Runs INSIDE PR 1's `setQueenSettings` lock so the check + write
 * is one atomic step. Without the lock, the cloud queen-tick could
 * claim a room AFTER the check returned "no rooms in flight" and
 * BEFORE the mode write committed — the operator would think the
 * flip was clean while a synthesis was actually mid-LLM.
 *
 * D9 says block on:
 *   - any room in `deciding` with non-expired claim
 *   - any room in `decided_pending_action` (PR 3 adds this state)
 *
 * G37 extends the block to:
 *   - any room in `closed + decision_outcome: merge_approved +
 *     github_merge_status: pending` (the stranded-merge state PR 3's
 *     reconciler resolves)
 *
 * **PR 2 only checks `deciding` today.** `decided_pending_action`
 * and the stranded-merge audit fields don't exist yet (PR 3 ships
 * the new RoomStatus + audit shape). The precheck is structured so
 * PR 3 can extend `BlockedReason` without breaking callers — the
 * `details` field is intentionally a sum type rather than a union
 * of disjoint shapes.
 *
 * Force-flip escape valve: G6 says operators can force-expire the
 * blocking rooms via the dashboard with a confirmation modal +
 * audit event. PR 5 (dashboard) wires the operator UI; the backend
 * uses the existing `terminate-room` API path with `reason=force_close`.
 * This precheck does NOT bypass on a force flag — operators must
 * resolve the rooms FIRST, then re-attempt the flip. Keeps the
 * mode flip's "no in-flight work" invariant unconditional.
 */

import { type Redis } from "@upstash/redis";
import { listRooms, type RoomCoreWithId } from "@hivemoot/war-room";

export interface BlockedReason {
  reason: "rooms_in_flight";
  /**
   * Per-state counts so the dashboard can render a tight "X rooms
   * in deciding, Y in decided_pending_action" summary.
   */
  counts: {
    deciding: number;
    /** Reserved for PR 3 — always 0 today since the state doesn't exist. */
    decided_pending_action: number;
    /** Reserved for PR 3+G37 — stranded-merge rooms. Always 0 today. */
    stranded_merge: number;
  };
  /**
   * Up to N representative room IDs per blocking category. Lets
   * the dashboard link to the specific rooms without paginating
   * through the full installation room list.
   */
  sampleRoomIds: string[];
}

const SAMPLE_LIMIT = 5;

interface PrecheckArgs {
  installationId: string;
  redis: Redis;
  /** Now in ms since epoch — defaults to `Date.now()`. Test seam. */
  nowMs?: number;
}

/**
 * Returns `null` when the flip is safe to proceed. Returns a
 * `{ blocked: BlockedReason }` envelope (matching `setQueenSettings`'
 * precheck contract) when in-flight work blocks the flip.
 *
 * Errors during the room list bubble up — `setQueenSettings` will
 * release the lock and the operator sees a 500 storage_failure
 * (not a silent flip).
 */
export async function checkInFlightForFlip(
  args: PrecheckArgs,
): Promise<{ blocked: BlockedReason } | null> {
  const rooms: RoomCoreWithId[] = await listRooms({
    installationId: args.installationId,
    redis: args.redis,
    // 100 mirrors the queen-tick scan cap — in steady state an
    // installation should have many fewer than this in flight at
    // once. If an operator somehow has > 100 deciding rooms they
    // are deeply degraded and shouldn't be flipping mode anyway.
    limit: 100,
  });

  let deciding = 0;
  const sampleRoomIds: string[] = [];

  for (const room of rooms) {
    if (room.status === "deciding") {
      deciding += 1;
      if (sampleRoomIds.length < SAMPLE_LIMIT) sampleRoomIds.push(room.roomId);
    }
    // PR 3: room.status === "decided_pending_action" → counts.decided_pending_action++
    // PR 3+G37: room with decision_outcome=merge_approved + github_merge_status=pending →
    //   counts.stranded_merge++
  }

  if (deciding === 0) return null;

  return {
    blocked: {
      reason: "rooms_in_flight",
      counts: {
        deciding,
        decided_pending_action: 0,
        stranded_merge: 0,
      },
      sampleRoomIds,
    },
  };
}
