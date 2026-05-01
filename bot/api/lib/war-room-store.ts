/**
 * War-room store — a thin per-installation adapter over the shared
 * `@hivemoot/war-room` storage layer. Replaces `WarRoomClient`
 * (HTTP-via-bearer) for callers that live colocated with Redis (the
 * bot's webhook handlers + cron tick).
 *
 * Why this exists:
 *   The bot is a multi-tenant Vercel deployment (one install of the
 *   GitHub App serves many GitHub installations). V1 capability
 *   bearers are scoped to ONE installation (envelope.installationId
 *   is stored, not provided per-call), so a single
 *   `HIVEMOOT_BOT_AGENT_TOKEN` env var couldn't authorize cross-tenant
 *   work — and the previous `WarRoomClient`'s bearer-auth path forced
 *   exactly that anti-pattern. The bot already shares the same Redis
 *   as the web app (it's already wired up for BYOK envelope lookup
 *   at `bot/api/lib/llm/byok.ts`), so direct calls to the same
 *   storage layer are the natural fit. Per-tenant scoping comes from
 *   the webhook payload (creates) or from iterating an installation
 *   index in Redis (cron tick).
 *
 * Construction model: caller instantiates ONE store per installation
 * per request — webhook handlers build it from `payload.installation.id`,
 * the cron tick iterates `app.eachInstallation()` and constructs one
 * per loop iteration. No env-var auth; the bot's own GitHub App
 * identity is the load-bearing trust boundary.
 *
 * Error shape: methods throw `WarRoomApiError` with the same `code`
 * field the HTTP route handlers used (`subject_already_open`,
 * `room_not_found`, `claim_already_held`, etc.) so existing caller
 * code branching on `err.code` keeps working unchanged.
 */

import {
  // Subject + room types
  type SubjectRef,
  type SubjectType,
  type TimingConfig,
  type RoomCore,
  type RoomCoreWithId,
  type RoomEvent,
  type RoomParticipant,
  type RoomContribution,
  type RoomDecision,
  // Mutation primitives
  createRoom as sharedCreateRoom,
  appendRoomEvent as sharedAppendRoomEvent,
  claimSynthesis as sharedClaimSynthesis,
  closeRoomWithDecision as sharedCloseRoomWithDecision,
  // Read primitives
  getRoomCore as sharedGetRoomCore,
  listRooms as sharedListRooms,
  listRoomEvents as sharedListRoomEvents,
  getRoomParticipants as sharedGetRoomParticipants,
  getRoomContributions as sharedGetRoomContributions,
  // Shared exception classes — converted to WarRoomApiError below
  RoomSubjectAlreadyOpenError,
  RoomNotFoundError,
  RoomSubjectRefError,
  RoomIdFormatError,
  RoomIdTakenError,
  RoomEventStatusPreconditionError,
  RoomEventIdempotencyReplayError,
  RoomEventBodyTooLargeError,
  RoomClaimAlreadyHeldError,
  RoomTransitionInvalidStatusError,
  RoomCloseClaimLostError,
  RoomCloseClaimThroughSeqMismatchError,
  RoomCloseDriftError,
  RoomAlreadyClosedError,
  RoomDecisionTooLargeError,
} from "@hivemoot/war-room";
import type { Redis } from "@upstash/redis";
import type { Logger } from "pino";

// Re-export the shared types under their old names so existing
// imports from `./war-room-client.js` keep typechecking until PR 3
// renames the import sites.
export type {
  SubjectRef,
  SubjectType,
  TimingConfig,
  RoomCore,
  RoomCoreWithId,
  RoomEvent,
  RoomParticipant,
  RoomContribution,
  RoomDecision,
};
export type WarRoomSubjectType = SubjectType;
export type WarRoomSubjectRef = SubjectRef;
export type WarRoomTimingConfig = TimingConfig;
export type RoomCoreResponse = RoomCore;
export type RoomListEntry = RoomCoreWithId;

/**
 * Error class mirroring the shape `WarRoomClient` threw for HTTP 4xx
 * responses. Callers branch on `err.code`; preserving the shape here
 * means existing handlers in `war-room-routing.ts` and the queen's
 * manager loop continue to work without changes.
 */
export class WarRoomApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly response: Record<string, unknown>;
  constructor(
    status: number,
    code: string,
    message: string,
    response: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WarRoomApiError";
    this.status = status;
    this.code = code;
    this.response = response;
  }
}

/**
 * Translate shared library exceptions to `WarRoomApiError` codes that
 * match what the HTTP route handlers used. Order matters — more
 * specific exception classes go first.
 */
function toApiError(err: unknown): WarRoomApiError | null {
  if (err instanceof RoomSubjectAlreadyOpenError) {
    return new WarRoomApiError(409, "subject_already_open", err.message, {
      existingRoomId: err.existingRoomId,
    });
  }
  if (err instanceof RoomNotFoundError) {
    return new WarRoomApiError(404, "room_not_found", err.message);
  }
  if (err instanceof RoomSubjectRefError) {
    return new WarRoomApiError(400, "invalid_subject_ref", err.message);
  }
  if (err instanceof RoomIdFormatError) {
    return new WarRoomApiError(400, "invalid_room_id", err.message);
  }
  if (err instanceof RoomIdTakenError) {
    return new WarRoomApiError(409, "room_id_taken", err.message);
  }
  if (err instanceof RoomEventStatusPreconditionError) {
    return new WarRoomApiError(409, "status_precondition_failed", err.message);
  }
  // RoomEventIdempotencyReplayError is intentionally NOT mapped here
  // — the only call site (`appendEvent`) catches it BEFORE calling
  // `rethrowAsApi` and converts it to a `{sequence, replay: true}`
  // success shape that matches the HTTP route's contract. Mapping
  // it here would create dead code reachable only by a refactor
  // that bypassed the wrapper.
  if (err instanceof RoomEventBodyTooLargeError) {
    return new WarRoomApiError(413, "event_body_too_large", err.message);
  }
  if (err instanceof RoomClaimAlreadyHeldError) {
    return new WarRoomApiError(409, "claim_already_held", err.message);
  }
  if (err instanceof RoomTransitionInvalidStatusError) {
    return new WarRoomApiError(409, "invalid_status_for_transition", err.message);
  }
  if (err instanceof RoomCloseClaimLostError) {
    return new WarRoomApiError(409, "claim_lost", err.message);
  }
  if (err instanceof RoomCloseClaimThroughSeqMismatchError) {
    return new WarRoomApiError(409, "claim_through_seq_mismatch", err.message);
  }
  if (err instanceof RoomCloseDriftError) {
    return new WarRoomApiError(409, "sequence_drift", err.message);
  }
  if (err instanceof RoomAlreadyClosedError) {
    return new WarRoomApiError(409, "room_already_closed", err.message);
  }
  if (err instanceof RoomDecisionTooLargeError) {
    return new WarRoomApiError(400, "decision_too_large", err.message);
  }
  return null;
}

function rethrowAsApi(err: unknown): never {
  const mapped = toApiError(err);
  if (mapped) throw mapped;
  throw err; // unrecognized — propagate as-is
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract `prSubjectRef` from a PR payload — kept for parity with
 * `war-room-client.ts:prSubjectRef`. Re-exported so callers don't
 * need to update the import. */
export function prSubjectRef(args: {
  owner: string;
  repo: string;
  prNumber: number;
}): SubjectRef {
  return {
    type: "pr_review",
    ref: `${args.owner}/${args.repo}#${args.prNumber}`,
  };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface WarRoomStoreOptions {
  /** GitHub App installation id this store acts on behalf of. Every
   * mutation is scoped to this installation; cross-tenant work
   * requires a separate store instance. */
  installationId: string;
  /** Initialised `@upstash/redis` client. Bot creates one per request
   * (or per cron iteration) — do NOT share across installations. */
  redis: Redis;
  /** Default `manager` field for newly-created rooms. The HTTP
   * client previously defaulted to the bearer's name; for the bot's
   * direct-Redis path this is a fixed string identifying the bot
   * (e.g. `"hivemoot-bot"`). Caller can override per-`createRoom`
   * call by passing `args.manager`. */
  manager?: string;
  /** Optional logger (Probot context.log shape). */
  log?: Pick<Logger, "info" | "warn" | "error">;
}

/** Numeric, non-zero — defense-in-depth for the constructor. Webhook
 * payloads can technically arrive without `installation.id`, and a
 * `0` fallback would reach the storage layer as the literal string
 * `"0"` which keys real Redis writes under a phantom tenant
 * namespace shared across installations. Reject at the boundary. */
const INSTALLATION_ID_REGEX = /^[1-9][0-9]*$/;

/**
 * Per-installation war-room operations backed by direct Redis calls
 * via `@hivemoot/war-room`. Drop-in replacement for `WarRoomClient`
 * (HTTP) for callers running colocated with Redis.
 */
export class WarRoomStore {
  private readonly installationId: string;
  private readonly redis: Redis;
  private readonly defaultManager: string;
  private readonly log: Pick<Logger, "info" | "warn" | "error">;

  constructor(options: WarRoomStoreOptions) {
    // Strict validation closes #581 guard B1: a falsy fallback like
    // `?? 0` in callers would survive the prior `!options.installationId`
    // check (`String(0)` is `"0"`, truthy) and write to a phantom
    // tenant namespace shared across any installation that lacks a
    // payload installation id. Reject anything that isn't a non-zero
    // numeric string at the storage boundary so the bug can't
    // re-emerge silently.
    if (typeof options.installationId !== "string" || !INSTALLATION_ID_REGEX.test(options.installationId)) {
      throw new Error(
        `WarRoomStore requires \`installationId\` to be a non-zero numeric string (got ${JSON.stringify(options.installationId)}). ` +
          "If the webhook payload didn't include an installation id, skip the war-room call instead of constructing a store.",
      );
    }
    this.installationId = options.installationId;
    this.redis = options.redis;
    this.defaultManager = options.manager ?? "hivemoot-bot";
    this.log = options.log ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  // ─── Webhook-side writes (war-room-routing) ─────────────────────────

  async createRoom(args: {
    subject: SubjectRef;
    manager?: string;
    timing?: Partial<TimingConfig>;
    roomId?: string;
  }): Promise<RoomCore> {
    const roomId = args.roomId ?? crypto.randomUUID();
    try {
      return await sharedCreateRoom({
        installationId: this.installationId,
        roomId,
        manager: args.manager ?? this.defaultManager,
        subject: args.subject,
        timing: args.timing,
        redis: this.redis,
      });
    } catch (err) {
      rethrowAsApi(err);
    }
  }

  async appendEvent(args: {
    roomId: string;
    eventType: "subject_updated" | "queen_question";
    body: Record<string, unknown>;
    /** Caller-derived idempotency key. Required — the HTTP route also
     * accepted server-side derivation via `sequenceObservedByClient`,
     * but the bot's webhook layer always pre-derives the key from a
     * stable hash of `(roomId, action, payload-fingerprint)`. */
    idempotencyKey: string;
  }): Promise<{ sequence: number; replay?: boolean }> {
    try {
      const sequence = await sharedAppendRoomEvent({
        installationId: this.installationId,
        roomId: args.roomId,
        event: {
          timestamp: new Date().toISOString(),
          event_type: args.eventType,
          actor_role: this.defaultManager,
          actor_id: this.defaultManager,
          body: args.body,
        },
        idempotencyKey: args.idempotencyKey,
        redis: this.redis,
      });
      return { sequence };
    } catch (err) {
      // Idempotency replay is a SUCCESS in the HTTP shape — surface
      // it as `{sequence, replay: true}` instead of throwing.
      if (err instanceof RoomEventIdempotencyReplayError) {
        return { sequence: err.existingSequence, replay: true };
      }
      rethrowAsApi(err);
    }
  }

  // ─── Queen-side reads (manager loop) ────────────────────────────────

  async listRooms(args: { limit?: number } = {}): Promise<RoomCoreWithId[]> {
    try {
      return await sharedListRooms({
        installationId: this.installationId,
        limit: args.limit,
        redis: this.redis,
      });
    } catch (err) {
      rethrowAsApi(err);
    }
  }

  async getRoomCore(roomId: string): Promise<RoomCore> {
    try {
      return await sharedGetRoomCore({
        installationId: this.installationId,
        roomId,
        redis: this.redis,
      });
    } catch (err) {
      rethrowAsApi(err);
    }
  }

  async listRoomEvents(args: {
    roomId: string;
    since?: number;
    limit?: number;
  }): Promise<{ events: RoomEvent[]; roomId: string }> {
    try {
      const events = await sharedListRoomEvents({
        roomId: args.roomId,
        since: args.since,
        limit: args.limit,
        redis: this.redis,
      });
      return { events, roomId: args.roomId };
    } catch (err) {
      rethrowAsApi(err);
    }
  }

  async getRoomParticipants(
    roomId: string,
  ): Promise<{ participants: Record<string, RoomParticipant>; roomId: string }> {
    try {
      const participants = await sharedGetRoomParticipants({
        roomId,
        redis: this.redis,
      });
      return { participants, roomId };
    } catch (err) {
      rethrowAsApi(err);
    }
  }

  async getRoomContributions(
    roomId: string,
  ): Promise<{ contributions: Record<string, RoomContribution>; roomId: string }> {
    try {
      const contributions = await sharedGetRoomContributions({
        roomId,
        redis: this.redis,
      });
      return { contributions, roomId };
    } catch (err) {
      rethrowAsApi(err);
    }
  }

  // ─── Queen-side writes (claim + close) ───────────────────────────────

  async claimSynthesis(args: {
    roomId: string;
    queenRunner: string;
    claimTtlSecs?: number;
  }): Promise<{ throughSequence: number; claimTtlSecs: number }> {
    try {
      const result = await sharedClaimSynthesis({
        installationId: this.installationId,
        roomId: args.roomId,
        queenRunner: args.queenRunner,
        claimTtlSecs: args.claimTtlSecs,
        redis: this.redis,
      });
      return {
        throughSequence: result.throughSequence,
        claimTtlSecs: result.claimTtlSecs,
      };
    } catch (err) {
      rethrowAsApi(err);
    }
  }

  async closeRoom(args: {
    roomId: string;
    expectedThroughSequence: number;
    decision: RoomDecision;
  }): Promise<{ closedSequence: number }> {
    // closeRoomWithDecision needs the room's subject for index
    // bookkeeping; fetch it via the same connection. The HTTP route
    // did this implicitly by reading the room core inside the route
    // handler.
    let core: RoomCore;
    try {
      core = await sharedGetRoomCore({
        installationId: this.installationId,
        roomId: args.roomId,
        redis: this.redis,
      });
    } catch (err) {
      rethrowAsApi(err);
    }

    const subject: SubjectRef = {
      type: core.subject_type,
      ref: core.subject_ref,
    };

    try {
      const closedSequence = await sharedCloseRoomWithDecision({
        installationId: this.installationId,
        roomId: args.roomId,
        expectedThroughSequence: args.expectedThroughSequence,
        decision: args.decision,
        subject,
        redis: this.redis,
      });
      return { closedSequence };
    } catch (err) {
      rethrowAsApi(err);
    }
  }
}
