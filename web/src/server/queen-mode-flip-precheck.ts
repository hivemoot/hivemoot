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
 * Blocks on all local-queen work that has already moved past the
 * first synthesis step. The local queen owns both the pending merge
 * window and the final `report-merge-result` call, so a flip back to
 * cloud while either state exists would strand work the cloud queen
 * cannot safely complete.
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
import { roomKey, statusIndexKey, type RoomDecision } from "@hivemoot/war-room";

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
    /** Rooms waiting out the local-queen merge override window. */
    decided_pending_action: number;
    /** Closed rooms approved for merge but not yet result-reported. */
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

function parseDecision(raw: unknown): RoomDecision | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "string") return JSON.parse(raw) as RoomDecision;
  if (typeof raw === "object") return raw as RoomDecision;
  return null;
}

async function findStrandedMergeRoomIds(args: {
  installationId: string;
  redis: Redis;
  closedIds: readonly string[];
}): Promise<string[]> {
  const candidates = await Promise.all(
    args.closedIds.map(async (roomId) => {
      const fields = await args.redis.hgetall<Record<string, unknown>>(
        roomKey(args.installationId, roomId),
      );
      if (fields === null || fields.status === undefined) return null;
      if (fields.status !== "closed") return null;

      const decision = parseDecision(fields.decision);
      if (
        decision?.decision_outcome === "merge_approved" &&
        decision.github_merge_status === "pending"
      ) {
        return roomId;
      }
      return null;
    }),
  );
  return candidates.filter((roomId): roomId is string => roomId !== null);
}

function sampleRoomIds(...groups: readonly string[][]): string[] {
  const seen = new Set<string>();
  const sample: string[] = [];
  for (const group of groups) {
    for (const roomId of group) {
      if (seen.has(roomId)) continue;
      seen.add(roomId);
      sample.push(roomId);
      if (sample.length >= SAMPLE_LIMIT) return sample;
    }
  }
  return sample;
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
 * Checks run in parallel where possible:
 *   1. Status-keyed scan of the `deciding` index (G1 — guard pass-1).
 *      The earlier `listRooms({limit: 100})` returned newest-first
 *      across ALL statuses, so a sprint-burst of 100+ awaiting rooms
 *      could page out an older deciding room from the precheck. The
 *      status-keyed scan returns ONLY `deciding` rooms — can't be
 *      paged out by unrelated activity.
 *
 *      `statusIndexKey` is a Redis **SET** (maintained via `SADD`/
 *      `SREM` in the war-room Lua scripts), so the read uses
 *      `SMEMBERS`. An earlier draft used `ZRANGE`; that returns
 *      `WRONGTYPE` against a real Redis SET. Tests passed because the
 *      mock didn't enforce key-type semantics. Ordering is irrelevant
 *      — the precheck only needs `count + bounded sample`.
 *   2. Status-keyed scan of `decided_pending_action`; any hit means
 *      local queen owns the next confirm-merge step.
 *   3. Status-keyed scan of `closed`, followed by a per-room field
 *      check for `decision_outcome=merge_approved` plus
 *      `github_merge_status=pending`; these rooms are waiting for
 *      the local queen's `report-merge-result`.
 *   4. Tick-lock probe (G2 — guard pass-1). Looks up the queen-tick's
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
  const decidedPendingKey = statusIndexKey(
    args.installationId,
    "decided_pending_action",
  );
  const closedKey = statusIndexKey(args.installationId, "closed");
  const lockKey = tickLockKey(args.installationId);

  // Parallel: SMEMBERS the status SETs + EXISTS the tick lock. These
  // independent reads do not block each other.
  // (statusIndexKey is SADD/SREM-backed, see war-room.ts:2269-2526.)
  const [decidingIds, decidedPendingIds, closedIds, tickLockHeld] =
    await Promise.all([
      args.redis.smembers(decidingKey),
      args.redis.smembers(decidedPendingKey),
      args.redis.smembers(closedKey),
      args.redis.exists(lockKey),
    ]);
  const strandedMergeIds = await findStrandedMergeRoomIds({
    installationId: args.installationId,
    redis: args.redis,
    closedIds,
  });

  const deciding = decidingIds.length;
  const decidedPendingAction = decidedPendingIds.length;
  const strandedMerge = strandedMergeIds.length;
  const tickRunning = tickLockHeld > 0 ? 1 : 0;
  const samples = sampleRoomIds(
    decidingIds,
    decidedPendingIds,
    strandedMergeIds,
  );

  if (
    deciding === 0 &&
    decidedPendingAction === 0 &&
    strandedMerge === 0 &&
    tickRunning === 0
  ) {
    return null;
  }

  return {
    blocked: {
      reason: "rooms_in_flight",
      counts: {
        deciding,
        decided_pending_action: decidedPendingAction,
        stranded_merge: strandedMerge,
        tick_running: tickRunning,
      },
      sampleRoomIds: samples,
    },
  };
}
