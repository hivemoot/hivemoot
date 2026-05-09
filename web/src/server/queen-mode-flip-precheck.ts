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
import { statusIndexKey } from "@hivemoot/war-room";

const TICK_LOCK_PREFIX = "hive:v1:lock:queen-tick:";

function tickLockKey(installationId: string): string {
  return `${TICK_LOCK_PREFIX}${installationId}`;
}

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
    /**
     * 1 when a queen-tick is mid-flight (its per-installation lock
     * is held), 0 otherwise. Guard pass-1 G2 — without this signal,
     * a tick that started in `cloud` mode and is mid-`listRooms`
     * keeps running cloud synthesis through the flip because the
     * manager loop only reads queen-mode once at the top.
     */
    tick_running: number;
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
 *
 * Two checks run in parallel:
 *   1. Status-keyed scan of the `deciding` index (G1 — guard pass-1).
 *      The earlier `listRooms({limit: 100})` returned newest-first
 *      across ALL statuses, so a sprint-burst of 100+ awaiting rooms
 *      could page out an older deciding room from the precheck. The
 *      status-keyed sorted-set scan returns ONLY `deciding` rooms —
 *      can't be paged out by unrelated activity.
 *   2. Tick-lock probe (G2 — guard pass-1). Looks up the queen-tick's
 *      per-installation lock; if held, a tick is mid-flight and its
 *      manager-loop won't re-read the mode until the next fire. We
 *      surface this as `tick_running: 1` so the dashboard tells the
 *      operator to wait for the in-flight tick to complete (~30s) —
 *      otherwise the flip would commit while a synthesis is mid-LLM.
 */
export async function checkInFlightForFlip(
  args: PrecheckArgs,
): Promise<{ blocked: BlockedReason } | null> {
  const decidingKey = statusIndexKey(args.installationId, "deciding");
  const lockKey = tickLockKey(args.installationId);

  // Parallel: ZRANGE the deciding-status sorted set + EXISTS the
  // tick lock. Two independent reads, neither blocks the other.
  const [decidingIds, tickLockHeld] = await Promise.all([
    args.redis.zrange<string[]>(decidingKey, 0, -1),
    args.redis.exists(lockKey),
  ]);

  const deciding = decidingIds.length;
  const tickRunning = tickLockHeld > 0 ? 1 : 0;
  const sampleRoomIds = decidingIds.slice(0, SAMPLE_LIMIT);

  if (deciding === 0 && tickRunning === 0) return null;

  return {
    blocked: {
      reason: "rooms_in_flight",
      counts: {
        deciding,
        decided_pending_action: 0,
        stranded_merge: 0,
        tick_running: tickRunning,
      },
      sampleRoomIds,
    },
  };
}
