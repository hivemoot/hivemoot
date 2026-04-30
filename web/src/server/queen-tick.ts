/**
 * Queen tick — the war-room watchdog body.
 *
 * Driven by Vercel Cron every 60 seconds (per
 * `WAR_ROOM_DESIGN.md` §"Manager loop" L954-1101). For each
 * installation, a tick:
 *
 *   1. **Recovery scan** — for every room in `deciding` status,
 *      call `recoverDeciding` to revert rooms whose synthesis
 *      claim TTL has expired. Active claims are skipped (the
 *      script's claim-existence check protects in-flight queens).
 *
 *   2. **Expire scan** — for every open room (awaiting_rsvp /
 *      awaiting_contributions / deciding), if `now - opened_at >
 *      max_age_secs` then call `terminateRoom(reason="expired")`.
 *      A room past max_age in `deciding` is terminated too — the
 *      claim DEL'd by terminate makes the queen's mid-flight close
 *      return RoomCloseClaimLostError and abort cleanly.
 *
 *   3. **Timeout scan** — for every `awaiting_contributions` room,
 *      iterate `pending` participants. If `now - rsvp_at >
 *      contribution_deadline_secs`, call `timeoutParticipant`. The
 *      script's participant-state precondition (`["pending"]`)
 *      protects against racing a worker's `submitContribution`.
 *
 * NOT in this slice (D.1.c):
 *   - Synthesis trigger — Phase G' (queen module). When all
 *     participants in an `awaiting_contributions` room have
 *     resolved, the queen's manager loop body claims + synthesizes
 *     + closes. That code lives in `bot/api/lib/queen/`.
 *   - RSVP→contributions transition — uses the design's
 *     "rsvp_quiet_period_secs" field which isn't in the current
 *     `TimingConfig`. Tracked separately.
 *
 * This module is pure orchestration over the war-room storage
 * primitives — no side effects beyond the storage calls. The
 * cron route (`POST /api/internal/queen/tick`) handles auth + lock
 * acquisition and invokes `runQueenTick` once per installation.
 */

import {
  type Redis,
} from "@upstash/redis";
import {
  listRooms,
  getRoomParticipants,
  recoverDeciding,
  terminateRoom,
  timeoutParticipant,
  seqKey,
  installationIndexKey,
  type RoomParticipant,
  type SubjectRef,
  RoomNotFoundError,
  RoomAlreadyClosedError,
  RoomTransitionInvalidStatusError,
  RoomEventStatusPreconditionError,
  RoomParticipantNotFoundError,
  RoomParticipantStatePreconditionError,
  RoomEventIdempotencyReplayError,
} from "@hivemoot/war-room";

/**
 * Watchdog actor sentinels — distinct pairs per emitted event
 * type, matching the `RoomEvent` JSDoc spec at
 * `web/src/server/war-room.ts:307-310`. Closes #524 guard B1: the
 * prior single pair collapsed terminate into the queen-driven
 * `manager` lane and lost the `watchdog` correlation key on
 * timeout, breaking forensic filtering.
 *
 * Two pairs:
 *   - **TERMINATE** (`actor_role="system"`, `actor_id="vercel-cron"`):
 *     cron-fired expiry. The "system" role distinguishes
 *     watchdog-driven terminate from the queen's `rooms.close`
 *     happy-path close (which uses `actor_role="manager"`).
 *   - **TIMEOUT** (`actor_role="manager"`, `actor_id="watchdog"`):
 *     watchdog-triggered `participant_timed_out`. Same as the
 *     `room_recovered` event the recovery script hardcodes.
 *
 * Recovery events use the script-internal sentinels
 * (`actor_role="manager"`, `actor_id="watchdog"`) baked into
 * `ROOM_RECOVER_DECIDING_SCRIPT` — no caller-side configuration
 * needed.
 */
export const WATCHDOG_TERMINATE_ACTOR = {
  role: "system",
  id: "vercel-cron",
} as const;

export const WATCHDOG_TIMEOUT_ACTOR = {
  role: "manager",
  id: "watchdog",
} as const;

/**
 * Outcome counts emitted by `runQueenTick`. Each counter is
 * advanced once per relevant primitive call. Surface in the cron
 * route's response for operator dashboards + alerts.
 */
export interface QueenTickResult {
  scannedDeciding: number;
  recovered: number;
  scannedOpen: number;
  expired: number;
  scannedAwaitingContributions: number;
  timedOutParticipants: number;
  errors: number;
  /**
   * Count of rooms in the installation index that the tick did NOT
   * read this cycle. Closes #524 guard N2 + builder R1 escalation:
   * `listRooms` returns newest-first capped at `maxRoomsPerTick`,
   * so under backlog (>maxRoomsPerTick open rooms) the OLDEST
   * rooms — exactly the ones expire/timeout scans care about —
   * are skipped. Surfacing this count lets ops alert on
   * `rooms_unscanned > 0` so degradation is observable rather than
   * silent. Steady state (≤ cap rooms): always 0.
   *
   * Note: this counts rooms in the installation INDEX (sorted set),
   * not just open rooms. Closed rooms in the retention window count
   * too. Tighter "open rooms unscanned" requires a separate ZCARD on
   * each status set — deferred to V1.1 if alerting on this metric
   * shows false positives.
   */
  roomsUnscanned: number;
}

interface QueenTickArgs {
  installationId: string;
  redis: Redis;
  /** Now in ms since epoch. Defaults to `Date.now()`. Tests pass a
   * fixed value for deterministic deadline arithmetic. */
  nowMs?: number;
  /** Cap on rooms processed per tick (defensive, prevents a single
   * installation with many open rooms from exceeding the Vercel
   * function timeout). Default 100 — matches the soft cap in
   * `/api/rooms/watching`. Operators with > 100 open rooms are
   * already in a degraded state and need triage; the watchdog
   * processes the newest-first slice and the next tick handles
   * the rest. */
  maxRoomsPerTick?: number;
}

const DEFAULT_MAX_ROOMS_PER_TICK = 100;

/**
 * Run one watchdog tick for an installation. Returns aggregate
 * counters; per-room errors are logged-and-continue (one bad room
 * doesn't stall the rest).
 *
 * Idempotent across overlapping fires: each underlying primitive's
 * idempotency key + status precondition makes a re-tick harmless.
 * The cron route still serializes via per-installation lock to
 * avoid wasted work.
 */
export async function runQueenTick(args: QueenTickArgs): Promise<QueenTickResult> {
  const nowMs = args.nowMs ?? Date.now();
  const maxRooms = args.maxRoomsPerTick ?? DEFAULT_MAX_ROOMS_PER_TICK;

  const result: QueenTickResult = {
    scannedDeciding: 0,
    recovered: 0,
    scannedOpen: 0,
    expired: 0,
    scannedAwaitingContributions: 0,
    timedOutParticipants: 0,
    errors: 0,
    roomsUnscanned: 0,
  };

  // ZCARD on the installation index in parallel with listRooms.
  // Closes #524 guard N2 + builder R1 escalation: under backlog
  // (>maxRoomsPerTick rooms), `listRooms` returns the newest slice
  // and the OLDEST rooms — exactly the ones expire/timeout scans
  // need — are skipped. Surfacing the unscanned count here lets
  // ops alert on `rooms_unscanned > 0` so the degradation is
  // observable, not silent.
  //
  // listRooms returns ALL rooms newest-first (status-mixed). Filter
  // on the result so the watchdog never reads more than it needs.
  // This costs N HGETALL on the room hash which is unavoidable —
  // the alternative (status-set SMEMBERS + HMGET) doesn't improve
  // the round-trip count meaningfully and adds a code path.
  const indexKey = installationIndexKey(args.installationId);
  const [rooms, totalIndexed] = await Promise.all([
    listRooms({
      installationId: args.installationId,
      redis: args.redis,
      limit: maxRooms,
    }),
    args.redis.zcard(indexKey).catch(() => 0),
  ]);
  result.roomsUnscanned = Math.max(0, totalIndexed - rooms.length);

  // 1. Recovery scan — every `deciding` room.
  for (const room of rooms) {
    if (room.status !== "deciding") continue;
    result.scannedDeciding += 1;
    try {
      const r = await recoverDeciding({
        installationId: args.installationId,
        roomId: room.roomId,
        redis: args.redis,
        nowMs,
      });
      if (r.recovered) result.recovered += 1;
      // r.recovered === false means claim still active; skip.
    } catch (err) {
      // Status changed mid-tick (room moved out of deciding) →
      // benign skip. Other errors → count and continue.
      if (err instanceof RoomTransitionInvalidStatusError) continue;
      if (err instanceof RoomNotFoundError) continue;
      // Idempotency replay is benign too — defensive consistency
      // with the timeout catch (closes #524 guard N3). Recovery
      // shouldn't normally hit this since each tick generates a
      // fresh idemKey, but a runner crash between EVAL-success
      // and route-return could.
      if (err instanceof RoomEventIdempotencyReplayError) continue;
      result.errors += 1;
      // Best-effort log to stderr — production observability lives
      // in Vercel logs (the cron route wraps this and emits a
      // structured summary at completion).
      console.warn(
        `[queen-tick] recovery error room=${room.roomId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // 2. Expire scan — every open room past max_age_secs.
  // Plus 3. Timeout scan — every awaiting_contributions room.
  // Combined into a single iteration to avoid double-traversing
  // the room list. The two responsibilities don't conflict:
  // expire-then-timeout means a stale room is closed first,
  // saving the timeout-scan cost.
  for (const room of rooms) {
    const isOpen =
      room.status === "awaiting_rsvp" ||
      room.status === "awaiting_contributions" ||
      room.status === "deciding";
    if (!isOpen) continue;
    result.scannedOpen += 1;

    const openedAtMs = Date.parse(room.opened_at);
    if (Number.isFinite(openedAtMs)) {
      const ageSecs = (nowMs - openedAtMs) / 1000;
      if (ageSecs > room.timing_config.max_age_secs) {
        try {
          const subject: SubjectRef = {
            type: room.subject_type,
            ref: room.subject_ref,
          };
          await terminateRoom({
            installationId: args.installationId,
            roomId: room.roomId,
            reason: "expired",
            subject,
            actorRole: WATCHDOG_TERMINATE_ACTOR.role,
            actorId: WATCHDOG_TERMINATE_ACTOR.id,
            redis: args.redis,
            nowMs,
          });
          result.expired += 1;
          continue; // Don't run timeout scan on a just-expired room.
        } catch (err) {
          if (err instanceof RoomAlreadyClosedError) {
            // Race: another caller force-closed this tick. Benign.
            continue;
          }
          if (err instanceof RoomNotFoundError) continue;
          result.errors += 1;
          console.warn(
            `[queen-tick] expire error room=${room.roomId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
        }
      }
    }

    // Timeout scan — only for awaiting_contributions rooms (per
    // design L1055, `pending` participants are timed out by the
    // watchdog when their contribution deadline elapsed).
    if (room.status !== "awaiting_contributions") continue;
    result.scannedAwaitingContributions += 1;

    let participants: Record<string, RoomParticipant>;
    try {
      participants = await getRoomParticipants({
        roomId: room.roomId,
        redis: args.redis,
      });
    } catch (err) {
      result.errors += 1;
      console.warn(
        `[queen-tick] participants read error room=${room.roomId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    // Need the room's current sequence to derive a stable
    // idempotency key for the timeout (per
    // deriveIdempotencyKey contract). Watcher's tick observes
    // a sequence; if a fresh contribution lands between
    // observation and EVAL, the storage primitive's
    // participant-state precondition (`["pending"]`) returns 409
    // and we re-scan next tick (no effect on the resolved slot).
    // The cron tick reads `seq` separately for each room — one
    // small extra round-trip but keeps the timeout-vs-resolve race
    // resolution in the storage layer where it belongs.
    let currentSequence = 0;
    try {
      // Use the war-room.ts key helper instead of an inline string —
      // closes #524 guard N1: hardcoded key conventions silently
      // drift from the storage module if anyone refactors the prefix.
      const seqRaw = await args.redis.get<string | number>(seqKey(room.roomId));
      currentSequence =
        typeof seqRaw === "number"
          ? seqRaw
          : typeof seqRaw === "string"
            ? Number.parseInt(seqRaw, 10)
            : 0;
    } catch (err) {
      result.errors += 1;
      console.warn(
        `[queen-tick] seq read error room=${room.roomId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    for (const [role, p] of Object.entries(participants)) {
      if (p.status !== "pending") continue;
      const rsvpAtMs = Date.parse(p.rsvp_at);
      if (!Number.isFinite(rsvpAtMs)) continue;
      const waitedSecs = (nowMs - rsvpAtMs) / 1000;
      if (waitedSecs <= room.timing_config.contribution_deadline_secs) {
        continue;
      }

      try {
        await timeoutParticipant({
          installationId: args.installationId,
          roomId: room.roomId,
          subjectRole: role,
          watchdogRole: WATCHDOG_TIMEOUT_ACTOR.role,
          watchdogAgentId: WATCHDOG_TIMEOUT_ACTOR.id,
          sequenceObservedByClient: currentSequence,
          redis: args.redis,
          nowMs,
        });
        result.timedOutParticipants += 1;
      } catch (err) {
        // Expected race outcomes — the worker resolved or moved
        // the room status between scan and EVAL. Don't count as
        // errors; re-scan handles it on the next tick.
        if (
          err instanceof RoomParticipantStatePreconditionError ||
          err instanceof RoomEventStatusPreconditionError ||
          err instanceof RoomParticipantNotFoundError ||
          err instanceof RoomEventIdempotencyReplayError ||
          err instanceof RoomNotFoundError
        ) {
          continue;
        }
        result.errors += 1;
        console.warn(
          `[queen-tick] timeout error room=${room.roomId} role=${role}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  return result;
}

/**
 * Compare-and-DEL release for the per-installation cron lock.
 * Avoids the JS-level "if get === runnerId then del" anti-pattern
 * that closes #519 guard's reference to the design's R3 B6 callout
 * (the SET ... NX returns "OK"/null, NOT the stored value, so a
 * naive compare always fails).
 *
 * Returns 1 if THIS runner held the lock and DEL'd it; 0 if the
 * lock had been TTL'd and re-acquired by another runner (in which
 * case we must NOT delete — that's another runner's lock).
 *
 * KEYS:
 *   [1] lockKey
 * ARGV:
 *   [1] runnerId — must match the value SET at acquisition
 */
export const QUEEN_TICK_LOCK_RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/** Per-installation cron-tick lock key. Distinct from the per-room
 * lock prefix used by individual storage primitives. */
export function queenTickLockKey(installationId: string): string {
  return `hive:v1:lock:queen-tick:${installationId}`;
}

/** Cron lock TTL — design L1016 specifies 55s (just under the 60s
 * cron interval), so a crashed runner's lock auto-releases before
 * the next fire. */
export const QUEEN_TICK_LOCK_TTL_SECS = 55;
