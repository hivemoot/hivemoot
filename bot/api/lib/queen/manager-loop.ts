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
import type { DecisionPoster } from "./decision-poster.js";
import type { Synthesizer } from "./synthesizer.js";

const DEFAULT_MAX_ROOMS_PER_TICK = 100;

/** Wire codes the loop treats as benign 409 conflict modes (skip +
 * count, do not error). The list is closed; any other 409 code is
 * counted as an error so an unfamiliar conflict surfaces to ops.
 *
 * Documented benign 409 codes from the route layer:
 *   - `claim_already_held` (`/decide`): another queen runner won the
 *     race to claim this room.
 *   - `invalid_status_for_claim` (`/decide`): the room flipped to a
 *     non-`awaiting_contributions` status between this loop's
 *     `listRooms` and `claimSynthesis` — most commonly the watchdog
 *     terminating an `awaiting_contributions` room past `max_age` or
 *     an operator force-close. Routine ops, NOT an error condition.
 *   - `sequence_drift` (`/close`): new events landed mid-synthesis;
 *     watchdog or next tick re-surfaces.
 *   - `claim_lost` (`/close`): force-close raced.
 *   - `claim_through_seq_mismatch` (`/close`): another runner
 *     re-claimed during synthesis.
 *
 * Closes #536 guard B1: `invalid_status_for_claim` was missing,
 * causing routine watchdog activity to alert under G'.5. */
const BENIGN_CONFLICT_CODES: ReadonlySet<string> = new Set([
  "claim_already_held",
  "invalid_status_for_claim",
  "sequence_drift",
  "claim_lost",
  "claim_through_seq_mismatch",
]);

export interface QueenManagerLoopArgs {
  client: WarRoomClient;
  synthesizer: Synthesizer;
  /** Optional decision poster (G'.4). When provided, the loop calls
   * `poster.postDecision(...)` after a successful `closeRoom` so the
   * synthesized markdown lands on the GitHub PR thread. Failures
   * count as `postsFailed` and DO NOT undo the room close — the
   * decision is durably stored on the room either way. When omitted
   * (e.g. in unit tests, or pre-G'.5 deployments without an
   * Octokit), close path runs unchanged and post counters stay 0. */
  decisionPoster?: DecisionPoster;
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
  /** Claims that succeeded but were abandoned (no `closeRoom` issued)
   * because post-claim re-validation showed a `withdrew` participant
   * is now re-eligible per the worker's `/watching` contract — i.e.
   * `withdrew_at_sequence < throughSequence`. The watchdog's
   * `recoverDeciding` scan reverts the room after the claim TTL
   * (~5min default) and the role gets surfaced again to workers.
   * Closes #536 builder R1: prior code unconditionally treated
   * `withdrew` as synthesis-permitting, racing the re-RSVP path. */
  staleClaimsAbandoned: number;
  /** Decisions successfully posted to GitHub via `decisionPoster`.
   * Set to 0 when no poster configured. Closes #538 follow-on G'.4. */
  postsSucceeded: number;
  /** Post attempts that threw. The room close already succeeded; the
   * decision is stored. V1 logs + counts; V1.1 may add retry. */
  postsFailed: number;
  /** Posts intentionally skipped (subject_type not yet supported in
   * V1). Tracked separately from postsSucceeded so ops can alert on
   * `mentions / triages reaching the queen` independently. */
  postsSkipped: number;
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
    staleClaimsAbandoned: 0,
    postsSucceeded: 0,
    postsFailed: 0,
    postsSkipped: 0,
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
        decisionPoster: args.decisionPoster,
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
 * Process a single `awaiting_contributions` room.
 *
 * State machine (mutates `result`):
 *
 *   1. **Pre-claim eligibility.** Read participants. Skip if any are
 *      `pending` OR if there's no `resolved` participant at all
 *      (synthesis on all-withdrew/all-timed_out is meaningless —
 *      let the watchdog `expired` path handle it).
 *   2. **Claim.** `claimSynthesis` → `throughSequence`. Benign 409
 *      (claim_already_held, invalid_status_for_claim) → conflicts++.
 *   3. **Post-claim withdraw validation.** Re-read participants. For
 *      each `withdrew`, check `withdrew_at_sequence >= throughSequence`.
 *      A withdrew participant whose seq is LESS THAN the claim's
 *      throughSequence is re-eligible per the worker `/watching`
 *      contract (`canRoleRsvpToRoom`) — closing now would race the
 *      worker's re-RSVP. Abandon: return without `closeRoom`. The
 *      watchdog's `recoverDeciding` reverts the claim after TTL.
 *      Closes #536 builder B1.
 *   4. **Synthesize.** Fetch contributions, hand to synthesizer.
 *      Either I/O failure logs as `contributions_read_failed`, the
 *      synthesizer's own throw logs as `synthesize_failed` (closes
 *      #536 guard NB3 — distinct keys for ops triage).
 *   5. **Close.** Pass `expectedThroughSequence` from the claim;
 *      server enforces drift detection. Benign 409s map to
 *      conflicts++, anything else to errors++.
 *
 * 404 `room_not_found` from any read step is treated as a benign
 * conflict (room GC'd between `listRooms` and the read — closes
 * #536 guard NB2).
 */
async function processOneRoom(args: {
  room: RoomListEntry;
  client: WarRoomClient;
  synthesizer: Synthesizer;
  decisionPoster: DecisionPoster | undefined;
  runnerId: string;
  nowMs: number;
  log: ManagerLoopLogger;
  result: QueenManagerLoopResult;
}): Promise<void> {
  const { room, client, synthesizer, decisionPoster, runnerId, nowMs, log, result } = args;

  // 1. Pre-claim eligibility.
  let participantsResp;
  try {
    participantsResp = await client.getRoomParticipants(room.roomId);
  } catch (err) {
    if (isRoomGone(err)) {
      result.conflicts += 1;
      log.info("queen.manager_loop.room_gc_pre_claim", {
        roomId: room.roomId,
      });
      return;
    }
    throw err;
  }
  if (!isSynthesisEligible(participantsResp.participants)) {
    log.info("queen.manager_loop.room_not_ready", {
      roomId: room.roomId,
      ...participantStatusBreakdown(participantsResp.participants),
    });
    return;
  }
  result.eligible += 1;

  // 2. Claim.
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

  // 3. Post-claim re-validate participants. Two distinct races we
  //    have to catch:
  //
  //    a. Re-RSVP between pre-claim read and `claimSynthesis`. The
  //       `presentParticipant` script (war-room.ts:2718, :2754)
  //       rewrites the slot to `pending` and clears
  //       `withdrew_at_sequence` — so the post-claim read shows
  //       `pending`, NOT `withdrew`. `withdrawalsAreFinal` alone
  //       wouldn't catch this. Closes #536 builder R2.
  //    b. The withdraw is no longer final (events past
  //       `withdrew_at_sequence`). The participant can re-RSVP per
  //       the worker `/watching` contract; closing now races.
  //       Closes #536 builder B1.
  //
  //    Both abandon the claim — return without `closeRoom`. The
  //    watchdog's `recoverDeciding` reverts the claim after TTL.
  let postClaimParticipants;
  try {
    postClaimParticipants = await client.getRoomParticipants(room.roomId);
  } catch (err) {
    if (isRoomGone(err)) {
      result.conflicts += 1;
      log.info("queen.manager_loop.room_gc_post_claim", {
        roomId: room.roomId,
      });
      return;
    }
    throw err;
  }
  if (!isSynthesisEligible(postClaimParticipants.participants)) {
    result.staleClaimsAbandoned += 1;
    log.info("queen.manager_loop.claim_abandoned_post_claim_re_rsvp", {
      roomId: room.roomId,
      throughSequence,
      ...participantStatusBreakdown(postClaimParticipants.participants),
    });
    return;
  }
  if (!withdrawalsAreFinal(postClaimParticipants.participants, throughSequence)) {
    result.staleClaimsAbandoned += 1;
    log.info("queen.manager_loop.claim_abandoned_stale_withdraw", {
      roomId: room.roomId,
      throughSequence,
    });
    return;
  }

  // 4a. Read contributions for synthesis.
  let contributionsResp;
  try {
    contributionsResp = await client.getRoomContributions(room.roomId);
  } catch (err) {
    if (isRoomGone(err)) {
      result.conflicts += 1;
      log.info("queen.manager_loop.room_gc_pre_synthesis", {
        roomId: room.roomId,
      });
      return;
    }
    log.error("queen.manager_loop.contributions_read_failed", {
      roomId: room.roomId,
      error: errMeta(err),
    });
    result.errors += 1;
    return;
  }

  // 4b. Synthesize.
  let content: string;
  try {
    const synthesis = await synthesizer.synthesize({
      roomId: room.roomId,
      room: stripRoomId(room),
      participants: postClaimParticipants.participants,
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
    return;
  }

  // 5. Close.
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
    return;
  }

  // 6. Post the decision to GitHub (G'.4). Failure does NOT undo the
  //    close — the decision is durably stored. Counted separately so
  //    ops can alert on post-only failures without conflating with
  //    storage errors.
  if (decisionPoster === undefined) {
    return;
  }
  try {
    const postResult = await decisionPoster.postDecision({
      subjectType: room.subject_type,
      subjectRef: room.subject_ref,
      content,
      roomId: room.roomId,
    });
    if (postResult.attempted) {
      result.postsSucceeded += 1;
    } else {
      result.postsSkipped += 1;
    }
  } catch (err) {
    result.postsFailed += 1;
    log.error("queen.manager_loop.post_failed", {
      roomId: room.roomId,
      subjectRef: room.subject_ref,
      error: errMeta(err),
    });
  }
}

/**
 * Pre-claim eligibility predicate. The room is eligible for synthesis
 * when:
 *   1. There's at least one participant.
 *   2. NO participant is `pending` (still working).
 *   3. At LEAST one participant is `resolved` (has actual input —
 *      otherwise the synthesizer is producing a decision out of all-
 *      withdrew/all-timed_out, which is meaningless. Closes #536
 *      guard NB4. Watchdog's `expired` terminate path handles those
 *      rooms via `max_age_secs`).
 */
function isSynthesisEligible(
  participants: Record<string, RoomParticipant>,
): boolean {
  const entries = Object.values(participants);
  if (entries.length === 0) return false;
  let hasResolved = false;
  for (const p of entries) {
    if (p.status === "pending") return false;
    if (p.status === "resolved") hasResolved = true;
  }
  return hasResolved;
}

/**
 * Post-claim withdraw-finality predicate. Closes #536 builder B1.
 *
 * The worker's `/watching` endpoint re-includes a withdrawn role
 * when the room has events past `withdrew_at_sequence` — meaning
 * the role can re-RSVP and contribute again. Synthesizing in that
 * window races the re-RSVP path.
 *
 * After `claimSynthesis` succeeds, the claim's `throughSequence` is
 * the latest event seq at claim time. For each `withdrew`
 * participant, compare `withdrew_at_sequence` against `throughSequence`:
 *
 *   - `withdrew_at_sequence >= throughSequence` → withdrawal is final
 *     (no events past it). Permits close.
 *   - `withdrew_at_sequence < throughSequence` → events have advanced
 *     past the withdraw point; participant is re-eligible per the
 *     worker contract. Block close.
 *   - `withdrew_at_sequence` undefined → defensive block (we can't
 *     prove finality without the seq).
 *
 * "Block" here means abandon the claim — return without `closeRoom`.
 * The watchdog's `recoverDeciding` reverts the claim after TTL,
 * surfacing the room to workers + queen on the next pass.
 */
function withdrawalsAreFinal(
  participants: Record<string, RoomParticipant>,
  throughSequence: number,
): boolean {
  for (const p of Object.values(participants)) {
    if (p.status !== "withdrew") continue;
    if (p.withdrew_at_sequence === undefined) return false;
    if (p.withdrew_at_sequence < throughSequence) return false;
  }
  return true;
}

function participantStatusBreakdown(
  participants: Record<string, RoomParticipant>,
): { pending: number; resolved: number; withdrew: number; timed_out: number } {
  const counts = { pending: 0, resolved: 0, withdrew: 0, timed_out: 0 };
  for (const p of Object.values(participants)) {
    counts[p.status] += 1;
  }
  return counts;
}

function isRoomGone(err: unknown): err is WarRoomApiError {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    "code" in err &&
    (err as WarRoomApiError).status === 404 &&
    (err as WarRoomApiError).code === "room_not_found"
  );
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
