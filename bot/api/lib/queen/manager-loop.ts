/**
 * Queen manager loop — the bot-side body of the war-room synthesis
 * cycle.
 *
 * Driven by Vercel Cron (G'.5) every ~60s. Per tick:
 *
 *   1. **List rooms** for the bearer's installation.
 *   2. **Filter** to status `awaiting_contributions`. Rooms in
 *      `awaiting_rsvp` aren't ready (no contributions to synthesize);
 *      rooms in `deciding` are owned by another runner OR by the
 *      watchdog's recovery path; `closed` / `expired` are terminal.
 *   3. **Eligibility check** per candidate room: fetch the
 *      materialized participants, confirm every entry's status is
 *      `resolved`. Pending / withdrew / timed_out are not synthesis-
 *      eligible (a withdrew/timed_out is fine if every OTHER
 *      participant is resolved — only `pending` blocks).
 *   4. **Claim** the synthesis lane via `claimSynthesis`. Returns a
 *      `throughSequence` cutoff. 409 `claim_already_held` is a
 *      benign race (another queen runner won it) → skip + count.
 *   5. **Synthesize** by handing the room state to the configured
 *      `Synthesizer`. The synthesizer is dependency-injected so
 *      G'.3 swaps in the real LLM without touching this loop.
 *   6. **Close** with the synthesis content + the claim's
 *      `throughSequence`. The server compares against the live seq
 *      and returns 409 `sequence_drift` if new events landed mid-
 *      synthesis (the watchdog's recovery path will surface the
 *      room next tick). 409 `claim_lost` (force-close raced) and
 *      `claim_through_seq_mismatch` (re-claimed) are also benign
 *      conflict modes the loop counts and skips.
 *
 * Errors that aren't benign 409s (synthesizer threw, wire/network
 * failures, decision_too_large 400) increment `errors` and the loop
 * continues to the next room — one bad room never stalls the
 * fleet's synthesis pipeline.
 *
 * Idempotency / safety:
 *   - The claim primitive is server-side atomic (DECIDE_CLAIM Lua).
 *     Two cron firings overlapping is fine: the second sees
 *     `claim_already_held` and skips.
 *   - Close is sequence-pinned, so re-running synthesis on the same
 *     room never double-applies a decision.
 *   - The watchdog's recovery scan reverts orphaned `deciding` rooms
 *     when a queen runner crashes between claim and close — this
 *     loop doesn't need to handle that itself.
 *
 * NOT in this slice (G'.2):
 *   - The Vercel cron route + auth + bearer wiring (G'.5).
 *   - Real LLM synthesis (G'.3 — wires `AiSdkSynthesizer`).
 *   - GitHub posting of the decision (G'.4 — post the markdown to
 *     the PR thread once the room closes).
 */

import type {
  RoomCoreResponse,
  RoomListEntry,
  RoomParticipant,
  WarRoomClient,
  WarRoomApiError,
} from "../war-room-client.js";
import type { Synthesizer } from "./synthesizer.js";

const DEFAULT_MAX_ROOMS_PER_TICK = 100;

/** Wire codes the loop treats as benign 409 conflict modes (skip +
 * count, do not error). The list is closed; any other 409 code is
 * counted as an error so an unfamiliar conflict surfaces to ops. */
const BENIGN_CONFLICT_CODES: ReadonlySet<string> = new Set([
  "claim_already_held",
  "sequence_drift",
  "claim_lost",
  "claim_through_seq_mismatch",
]);

export interface QueenManagerLoopArgs {
  client: WarRoomClient;
  synthesizer: Synthesizer;
  /** Stable runner identity (passed as `queenRunner` on
   * `claimSynthesis` and folded into the decision payload's
   * `synthesis_runner` field). Operator-set; e.g.
   * `"queen-vercel-{deploymentId}"`. Used by the watchdog's
   * recovery path to attribute orphaned claims. */
  runnerId: string;
  /** Cap on rooms processed per tick (defensive). The Vercel
   * function timeout is the real constraint; this is a back-stop.
   * Default 100 — matches the watchdog's `maxRoomsPerTick`. */
  maxRoomsPerTick?: number;
  /** Now in ms since epoch. Defaults to `Date.now()`. Tests pass a
   * fixed value for determinism. */
  nowMs?: number;
  /** Optional logger. Falls back to no-op. */
  log?: ManagerLoopLogger;
}

export interface ManagerLoopLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Outcome counts emitted by `runQueenManagerLoop`. The Vercel route
 * (G'.5) surfaces these in its JSON response so operators can alert
 * on `errors > 0` or correlate `closed` against PR-comment posting.
 */
export interface QueenManagerLoopResult {
  /** Total rooms returned by `listRooms` this tick (capped at
   * maxRoomsPerTick). */
  totalRoomsScanned: number;
  /** Subset in `awaiting_contributions`. */
  scannedAwaitingContributions: number;
  /** Subset where every participant resolved (synthesis-eligible). */
  eligible: number;
  /** Eligible rooms where claim succeeded (drives synthesis call). */
  claimed: number;
  /** Rooms successfully closed with a synthesis decision. */
  closed: number;
  /** Benign races: `claim_already_held` (claim phase),
   * `sequence_drift` / `claim_lost` / `claim_through_seq_mismatch`
   * (close phase). */
  conflicts: number;
  /** Non-benign errors: synthesizer threw, decision_too_large 400,
   * wire failure, unfamiliar 409 code. Loop continues; ops alert. */
  errors: number;
}

/**
 * Run one queen manager-loop tick. Returns aggregate counters; per-
 * room errors are logged-and-continue.
 */
export async function runQueenManagerLoop(
  args: QueenManagerLoopArgs,
): Promise<QueenManagerLoopResult> {
  const log = args.log ?? noopLogger();
  const maxRooms = args.maxRoomsPerTick ?? DEFAULT_MAX_ROOMS_PER_TICK;

  const result: QueenManagerLoopResult = {
    totalRoomsScanned: 0,
    scannedAwaitingContributions: 0,
    eligible: 0,
    claimed: 0,
    closed: 0,
    conflicts: 0,
    errors: 0,
  };

  let rooms: RoomListEntry[];
  try {
    rooms = await args.client.listRooms({ limit: maxRooms });
  } catch (err) {
    // List failure is loop-fatal for this tick (no rooms to process)
    // but not session-fatal — next cron firing retries.
    log.error("queen.manager_loop.list_rooms_failed", { error: errMeta(err) });
    result.errors += 1;
    return result;
  }
  result.totalRoomsScanned = rooms.length;

  for (const room of rooms) {
    if (room.status !== "awaiting_contributions") continue;
    result.scannedAwaitingContributions += 1;

    try {
      await processOneRoom({
        room,
        client: args.client,
        synthesizer: args.synthesizer,
        runnerId: args.runnerId,
        nowMs: args.nowMs ?? Date.now(),
        log,
        result,
      });
    } catch (err) {
      // Belt-and-suspenders: processOneRoom swallows expected
      // conflict modes. Anything reaching here is unexpected.
      log.error("queen.manager_loop.unexpected_error", {
        roomId: room.roomId,
        error: errMeta(err),
      });
      result.errors += 1;
    }
  }

  log.info("queen.manager_loop.tick_complete", { ...result });
  return result;
}

/**
 * Process a single `awaiting_contributions` room. Outcomes (mutates
 * `result`):
 *   - eligibility-fail (any participant pending) → no counter change
 *   - claim succeeds + synthesize + close → eligible++, claimed++,
 *     closed++
 *   - claim conflict (already held) → eligible++, conflicts++
 *   - close conflict (sequence_drift / claim_lost / mismatch) →
 *     eligible++, claimed++, conflicts++
 *   - synthesizer error / decision_too_large / wire fail →
 *     eligible++ (and claimed++ if claim succeeded), errors++
 */
async function processOneRoom(args: {
  room: RoomListEntry;
  client: WarRoomClient;
  synthesizer: Synthesizer;
  runnerId: string;
  nowMs: number;
  log: ManagerLoopLogger;
  result: QueenManagerLoopResult;
}): Promise<void> {
  const { room, client, synthesizer, runnerId, nowMs, log, result } = args;

  const participantsResp = await client.getRoomParticipants(room.roomId);
  if (!allParticipantsResolved(participantsResp.participants)) {
    log.info("queen.manager_loop.room_not_ready", {
      roomId: room.roomId,
      pending: countPending(participantsResp.participants),
    });
    return;
  }
  result.eligible += 1;

  // Claim phase.
  let throughSequence: number;
  try {
    const claim = await client.claimSynthesis({
      roomId: room.roomId,
      queenRunner: runnerId,
    });
    throughSequence = claim.throughSequence;
    result.claimed += 1;
  } catch (err) {
    if (isBenignConflict(err)) {
      result.conflicts += 1;
      log.info("queen.manager_loop.claim_conflict", {
        roomId: room.roomId,
        code: (err as WarRoomApiError).code,
      });
      return;
    }
    log.error("queen.manager_loop.claim_failed", {
      roomId: room.roomId,
      error: errMeta(err),
    });
    result.errors += 1;
    return;
  }

  // Synthesize.
  let content: string;
  try {
    const contributionsResp = await client.getRoomContributions(room.roomId);
    const synthesis = await synthesizer.synthesize({
      roomId: room.roomId,
      room: stripRoomId(room),
      participants: participantsResp.participants,
      contributions: contributionsResp.contributions,
      throughSequence,
    });
    content = synthesis.content;
  } catch (err) {
    log.error("queen.manager_loop.synthesize_failed", {
      roomId: room.roomId,
      error: errMeta(err),
    });
    result.errors += 1;
    // Note: leaving the claim outstanding. The watchdog's
    // recoverDeciding scan will revert it after the claim TTL
    // (~5min default per storage spec). V1.1 may add an explicit
    // `failed_synthesis` terminate path here.
    return;
  }

  // Close.
  try {
    await client.closeRoom({
      roomId: room.roomId,
      expectedThroughSequence: throughSequence,
      decision: {
        synthesized_at: new Date(nowMs).toISOString(),
        synthesis_runner: runnerId,
        content,
        sequence_closed: throughSequence,
      },
    });
    result.closed += 1;
    log.info("queen.manager_loop.room_closed", {
      roomId: room.roomId,
      throughSequence,
    });
  } catch (err) {
    if (isBenignConflict(err)) {
      result.conflicts += 1;
      log.info("queen.manager_loop.close_conflict", {
        roomId: room.roomId,
        code: (err as WarRoomApiError).code,
      });
      return;
    }
    log.error("queen.manager_loop.close_failed", {
      roomId: room.roomId,
      error: errMeta(err),
    });
    result.errors += 1;
  }
}

function allParticipantsResolved(
  participants: Record<string, RoomParticipant>,
): boolean {
  // Empty hash → not eligible (no one RSVP'd, nothing to synthesize).
  // Pending → blocks. resolved / withdrew / timed_out → permits.
  const entries = Object.values(participants);
  if (entries.length === 0) return false;
  return entries.every((p) => p.status !== "pending");
}

function countPending(participants: Record<string, RoomParticipant>): number {
  return Object.values(participants).filter((p) => p.status === "pending").length;
}

/** Extract the bare `RoomCoreResponse` from a `RoomListEntry` for
 * synthesizer input. Drops the `roomId` (synthesizer gets it as a
 * top-level input field) so the type matches the wire shape returned
 * by `getRoomCore`. */
function stripRoomId(room: RoomListEntry): RoomCoreResponse {
  const { roomId: _ignored, ...rest } = room;
  void _ignored;
  return rest;
}

function isBenignConflict(err: unknown): err is WarRoomApiError {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    "code" in err &&
    (err as WarRoomApiError).status === 409 &&
    BENIGN_CONFLICT_CODES.has((err as WarRoomApiError).code)
  );
}

function errMeta(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { value: String(err) };
}

function noopLogger(): ManagerLoopLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}
