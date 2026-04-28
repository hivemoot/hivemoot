/**
 * War-room HTTP client — wraps the hivemoot.dev war-room API
 * (`/api/rooms/*`) for the bot's webhook handlers.
 *
 * Bot integration model: GitHub webhook → routing logic in
 * `bot/api/github/webhooks/index.ts` → `WarRoomClient.createRoom`
 * (and similar) → 201 with `roomId`. Workers and the queen module
 * pick up from there.
 *
 * Configuration (env-driven, evaluated at construction time):
 *   - `HIVEMOOT_API_BASE_URL` — default `https://www.hivemoot.dev`
 *   - `HIVEMOOT_BOT_AGENT_TOKEN` — V1 capability bearer. Required
 *     capability set depends on which methods the caller invokes:
 *       - E.1/E.2 (webhook routing): `rooms.create`, `rooms.update`
 *       - G'.1+ (queen module): `rooms.read_all`, `rooms.decide`,
 *         `rooms.close` (the queen preset already grants all of
 *         these; see `agent-token-capabilities.ts`)
 *
 * Error model: thrown errors carry the wire `code` field from the
 * server's JSON body so handlers can distinguish:
 *   - `subject_already_open` (idempotent re-delivery) — caller
 *     swallows + uses the existingRoomId
 *   - validation 400s — config/programmer error, log + skip
 *   - 5xx — transient, caller may retry on next webhook
 *
 * Out of scope for E.1 (lands in subsequent slices):
 *   - subject_updated event emission on PR synchronize
 *   - terminateRoom on PR closed/merged
 *   - mention_response room creation
 *   - retry/backoff (start simple; webhook re-delivery handles it)
 */

import type { Logger } from "pino";

/** Subject types supported by the war-room storage layer. Mirrors
 * the V1 contract from `web/src/server/war-room.ts:SubjectType`. */
export type WarRoomSubjectType =
  | "pr_review"
  | "mention_response"
  | "issue_triage";

export interface WarRoomSubjectRef {
  type: WarRoomSubjectType;
  /** Format depends on type — see WAR_ROOM_DESIGN.md L165-167.
   *   - pr_review: `{owner}/{repo}#{prNumber}`
   *   - mention_response: `{owner}/{repo}#{issueOrPrNumber}`
   *   - issue_triage: `{owner}/{repo}#{issueNumber}` */
  ref: string;
}

export interface WarRoomTimingConfig {
  max_age_secs?: number;
  rsvp_deadline_secs?: number;
  contribution_deadline_secs?: number;
}

export interface CreateRoomArgs {
  subject: WarRoomSubjectRef;
  manager?: string;
  timing?: WarRoomTimingConfig;
  /** Optional caller-supplied roomId (UUIDv4 lowercase). When
   * omitted, the server mints one. The bot typically lets the
   * server mint so PR comments can reference whatever roomId came
   * back. */
  roomId?: string;
}

/**
 * Canonical wire shape for a room's core record. Mirrors the storage
 * layer's `RoomCore` type — the immutable RoomCoreData fields plus
 * the optional mutable transition fields that progress with the
 * room's lifecycle.
 *
 * `roomId` is intentionally absent: the server's `GET /api/rooms/:id`
 * route returns the bare `RoomCore` (war-room.ts:242-259, the route
 * at `web/src/app/api/rooms/[roomId]/route.ts:45`). For `listRooms`
 * which DOES include the id, see `RoomListEntry`.
 */
export interface RoomCoreResponse {
  manager: string;
  subject_type: WarRoomSubjectType;
  subject_ref: string;
  status:
    | "awaiting_rsvp"
    | "awaiting_contributions"
    | "deciding"
    | "closed"
    | "expired";
  opened_at: string;
  timing_config?: WarRoomTimingConfig;
  /** Set when the room reaches a terminal state (closed | expired). */
  closed_at?: string;
  /** Set ONLY by `ROOM_TERMINATE_SCRIPT`. The queen's happy-path
   * close sets `decision` instead. */
  closed_reason?: "expired" | "failed_synthesis" | "force_close" | "manual";
  /** Set by claim, verified by close to detect drift. */
  deciding_through_sequence?: number;
  /** Set ONLY by happy-path close. */
  decision?: RoomDecision;
}

/**
 * Room entry from `GET /api/rooms` — matches the storage layer's
 * `RoomCoreWithId` type added in D.1.b-iii. Distinct from
 * `RoomCoreResponse` (the bare core shape returned by createRoom 201
 * AND `GET /api/rooms/:id`) which omits `roomId`.
 */
export interface RoomListEntry extends RoomCoreResponse {
  roomId: string;
}

/**
 * One event from a room's append-only log. Matches the storage
 * layer's `RoomEvent` shape.
 */
export interface RoomEvent {
  seq: number;
  timestamp: string;
  event_type: string;
  actor_role: string;
  actor_id: string;
  body: Record<string, unknown>;
}

/**
 * Materialized participant entry (latest-state-wins per role).
 * Matches storage's `RoomParticipant`.
 */
export interface RoomParticipant {
  agent_id: string;
  role: string;
  status: "pending" | "resolved" | "withdrew" | "timed_out";
  rsvp_at: string;
  resolved_at?: string;
  withdrew_at_sequence?: number;
}

/**
 * Materialized contribution entry. Mirrors the storage layer's
 * write at `war-room.ts:2855-2859` — submitContribution writes
 * `{body, raw_md, contributed_at}` for present contributions and
 * `{withdrawn: true, contributed_at}` for tombstones. The contributor
 * agent_id/role are NOT part of this payload — callers correlate
 * via the hash key (the role) which `getRoomContributions` returns
 * as `Record<string, RoomContribution>`.
 */
export interface RoomContribution {
  body?: Record<string, unknown>;
  raw_md?: string;
  contributed_at?: string;
  withdrawn?: boolean;
}

/**
 * Decision payload passed on `/close` — what the queen synthesized.
 * Mirrors the storage layer's `RoomDecision` type.
 */
export interface RoomDecision {
  synthesized_at: string;
  synthesis_runner: string;
  /** Synthesis body (markdown). ≤ 64 KiB UTF-8 bytes per server cap. */
  content: string;
  /** Sequence the queen synthesized through (= throughSequence from
   * the claim response). Server compares against the live seq at
   * close time to detect drift. */
  sequence_closed: number;
}

/**
 * Thrown when the API returns a 4xx/5xx with a structured error
 * body. `code` matches the server's wire `code` field.
 */
export class WarRoomApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly response: Record<string, unknown>;
  constructor(
    status: number,
    code: string,
    message: string,
    response: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WarRoomApiError";
    this.status = status;
    this.code = code;
    this.response = response;
  }
}

export interface WarRoomClientOptions {
  baseUrl?: string;
  agentToken?: string;
  /** Hard timeout per request in ms. Default 5000 — webhook
   * handlers shouldn't block longer; a hung API call would stall
   * the bot's queue. */
  timeoutMs?: number;
  /** Optional logger (Probot context.log shape — uses
   * `info`/`warn`/`error`). Defaults to console for tests. */
  log?: Pick<Logger, "info" | "warn" | "error">;
  /** Override fetch (for tests). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

/**
 * Construct a client. Throws at construction time if required env
 * vars are missing — fails loud rather than at first webhook call.
 */
export class WarRoomClient {
  private readonly baseUrl: string;
  private readonly agentToken: string;
  private readonly timeoutMs: number;
  private readonly log: Pick<Logger, "info" | "warn" | "error">;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WarRoomClientOptions = {}) {
    const baseUrl =
      options.baseUrl ??
      process.env.HIVEMOOT_API_BASE_URL ??
      "https://www.hivemoot.dev";
    const agentToken =
      options.agentToken ?? process.env.HIVEMOOT_BOT_AGENT_TOKEN ?? "";

    if (agentToken.length === 0) {
      throw new Error(
        "WarRoomClient requires HIVEMOOT_BOT_AGENT_TOKEN env var (or `agentToken` option). Provision a V1 capability bearer with `rooms.create` (queen preset) via /api/agent-tokens.",
      );
    }
    if (!/^https?:\/\//.test(baseUrl)) {
      throw new Error(
        `WarRoomClient baseUrl ${JSON.stringify(baseUrl)} must start with http:// or https://.`,
      );
    }

    this.baseUrl = baseUrl.replace(/\/$/, ""); // strip trailing slash
    this.agentToken = agentToken;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.log = options.log ?? consoleLogger();
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /**
   * Create a war room for a subject (PR / issue / mention). Returns
   * the room core record on success. On `subject_already_open` the
   * server returns 409 with `existingRoomId` in the body — this
   * client surfaces that as `WarRoomApiError(code="subject_already_open")`
   * so the caller can extract `error.response.existingRoomId` and
   * treat the call as idempotent (the bot's webhook re-delivery
   * path).
   *
   * Network/5xx errors throw plain `Error` — the bot's webhook
   * handler should log + return; GitHub will re-deliver on its own
   * cadence.
   */
  async createRoom(args: CreateRoomArgs): Promise<RoomCoreResponse> {
    const body: Record<string, unknown> = { subject: args.subject };
    if (args.manager !== undefined) body.manager = args.manager;
    if (args.timing !== undefined) body.timing = args.timing;
    if (args.roomId !== undefined) body.roomId = args.roomId;

    const response = await this.request("POST", "/api/rooms", body);

    if (response.ok) {
      return (await response.json()) as RoomCoreResponse;
    }

    // Structured error → WarRoomApiError so callers can branch on
    // `code`. The 409 `subject_already_open` path is idempotent —
    // caller extracts `error.response.existingRoomId`.
    throw await this._toApiError(response);
  }

  /**
   * Append a meta-event to a room's event log. Used by the bot's
   * webhook routing for `subject_updated` (PR rebased / new
   * commits) and `queen_question` events. The route's whitelist
   * enforces these are the only event types accepted via this
   * generic surface (lifecycle events go through their dedicated
   * endpoints).
   *
   * Idempotency: the route accepts either a caller-supplied
   * `idempotencyKey` OR a `sequenceObservedByClient` for server-side
   * derivation. The bot doesn't track sequence numbers, so it
   * passes a stable hash-derived key per (roomId, action, payload-fingerprint).
   *
   * Returns the event's sequence on success. On replay (server
   * already processed this idempotency key), the route returns
   * `{ sequence, replay: true }` — both shapes deserialize cleanly.
   */
  async appendEvent(args: {
    roomId: string;
    eventType: "subject_updated" | "queen_question";
    body: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ sequence: number; replay?: boolean }> {
    const response = await this.request(
      "POST",
      `/api/rooms/${encodeURIComponent(args.roomId)}/event`,
      {
        event_type: args.eventType,
        body: args.body,
        idempotencyKey: args.idempotencyKey,
      },
    );

    if (response.ok) {
      return (await response.json()) as { sequence: number; replay?: boolean };
    }

    throw await this._toApiError(response);
  }

  // ─── Queen-side reads (G'.1) ─────────────────────────────────────────

  /**
   * GET /api/rooms — list rooms for the bearer's installation.
   * Used by the queen's manager loop to find rooms eligible for
   * synthesis. Capability: `rooms.read_all` (queen preset).
   *
   * Returns the array as serialized; caller filters by status +
   * participant resolution to identify synthesis candidates. Wire
   * shape uses `RoomCoreWithId` (D.1.b-iii) so each room has a
   * top-level `roomId` field — distinct from createRoom's 201
   * which uses `RoomCore` without roomId.
   */
  async listRooms(args: { limit?: number } = {}): Promise<RoomListEntry[]> {
    const query = args.limit !== undefined ? `?limit=${args.limit}` : "";
    const response = await this.request("GET", `/api/rooms${query}`);
    if (!response.ok) {
      throw await this._toApiError(response);
    }
    const body = (await response.json()) as { rooms?: RoomListEntry[] };
    return Array.isArray(body.rooms) ? body.rooms : [];
  }

  /**
   * GET /api/rooms/:roomId — fetch one room's core record.
   * Capability: `rooms.read_all` (queen preset).
   *
   * Returns `RoomCoreResponse` WITHOUT `roomId`: the server route
   * intentionally serializes the bare `RoomCore` (war-room.ts:264-267
   * — "the room hash key is the roomId, so it's redundant — the
   * caller already knows it"). Callers correlate by the roomId they
   * passed in.
   *
   * 404 → `WarRoomApiError(code: "room_not_found")`.
   */
  async getRoomCore(roomId: string): Promise<RoomCoreResponse> {
    const response = await this.request(
      "GET",
      `/api/rooms/${encodeURIComponent(roomId)}`,
    );
    if (!response.ok) {
      throw await this._toApiError(response);
    }
    return (await response.json()) as RoomCoreResponse;
  }

  /**
   * GET /api/rooms/:roomId/events — append-only event log slice.
   * Capability: `rooms.read_all`. `since` is the last seq the caller
   * observed; events with `seq > since` are returned (default 0 = all).
   */
  async listRoomEvents(args: {
    roomId: string;
    since?: number;
    limit?: number;
  }): Promise<{ events: RoomEvent[]; roomId: string }> {
    const params = new URLSearchParams();
    if (args.since !== undefined) params.set("since", String(args.since));
    if (args.limit !== undefined) params.set("limit", String(args.limit));
    const qs = params.toString();
    const path =
      `/api/rooms/${encodeURIComponent(args.roomId)}/events` +
      (qs ? `?${qs}` : "");
    const response = await this.request("GET", path);
    if (!response.ok) {
      throw await this._toApiError(response);
    }
    return (await response.json()) as { events: RoomEvent[]; roomId: string };
  }

  /**
   * GET /api/rooms/:roomId/contributions — materialized contribution
   * hash. Capability: `rooms.read_all`. The queen's synthesis prompt
   * uses this.
   */
  async getRoomContributions(
    roomId: string,
  ): Promise<{ contributions: Record<string, RoomContribution>; roomId: string }> {
    const response = await this.request(
      "GET",
      `/api/rooms/${encodeURIComponent(roomId)}/contributions`,
    );
    if (!response.ok) {
      throw await this._toApiError(response);
    }
    return (await response.json()) as {
      contributions: Record<string, RoomContribution>;
      roomId: string;
    };
  }

  /**
   * GET /api/rooms/:roomId/participants — materialized RSVP hash.
   * Capability: `rooms.read_all`. The queen reads this to confirm
   * "all participants resolved" before claiming synthesis.
   */
  async getRoomParticipants(
    roomId: string,
  ): Promise<{ participants: Record<string, RoomParticipant>; roomId: string }> {
    const response = await this.request(
      "GET",
      `/api/rooms/${encodeURIComponent(roomId)}/participants`,
    );
    if (!response.ok) {
      throw await this._toApiError(response);
    }
    return (await response.json()) as {
      participants: Record<string, RoomParticipant>;
      roomId: string;
    };
  }

  // ─── Queen-side writes (G'.1) ────────────────────────────────────────

  /**
   * POST /api/rooms/:roomId/decide — atomically claim the synthesis
   * lane. Capability: `rooms.decide`. Returns `{throughSequence,
   * claimTtlSecs}`; the queen passes `throughSequence` back on
   * `/close` for drift detection.
   *
   * 409 with code `claim_already_held` is the benign-conflict path
   * (another queen runner won the race). Caller should log + skip
   * — the manager loop's next tick will re-check.
   */
  async claimSynthesis(args: {
    roomId: string;
    queenRunner: string;
    claimTtlSecs?: number;
  }): Promise<{ throughSequence: number; claimTtlSecs: number }> {
    const body: Record<string, unknown> = {
      queenRunner: args.queenRunner,
    };
    if (args.claimTtlSecs !== undefined) {
      body.claimTtlSecs = args.claimTtlSecs;
    }
    const response = await this.request(
      "POST",
      `/api/rooms/${encodeURIComponent(args.roomId)}/decide`,
      body,
    );
    if (!response.ok) {
      throw await this._toApiError(response);
    }
    return (await response.json()) as {
      throughSequence: number;
      claimTtlSecs: number;
    };
  }

  /**
   * POST /api/rooms/:roomId/close — happy-path close with the
   * queen's synthesized decision. Capability: `rooms.close`.
   *
   * Failure modes:
   *   - 409 `sequence_drift`: new events landed since claim; queen
   *     aborts GitHub post, manager loop re-claims on next tick
   *   - 409 `claim_lost`: force-close raced; abort
   *   - 409 `claim_through_seq_mismatch`: another runner re-claimed;
   *     abort
   *   - 400 `decision_too_large`: synthesis content exceeded 64 KiB
   */
  async closeRoom(args: {
    roomId: string;
    expectedThroughSequence: number;
    decision: RoomDecision;
  }): Promise<{ closedSequence: number }> {
    const body = {
      expectedThroughSequence: args.expectedThroughSequence,
      decision: args.decision,
    };
    const response = await this.request(
      "POST",
      `/api/rooms/${encodeURIComponent(args.roomId)}/close`,
      body,
    );
    if (!response.ok) {
      throw await this._toApiError(response);
    }
    return (await response.json()) as { closedSequence: number };
  }

  /**
   * Helper: convert a non-2xx Response into a `WarRoomApiError`.
   * Mirrors the pattern used inline in createRoom/appendEvent;
   * extracted here to keep the new G'.1 methods short.
   */
  private async _toApiError(response: Response): Promise<WarRoomApiError> {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON body — fall through.
    }
    const code = typeof parsed.code === "string" ? parsed.code : "unknown";
    const message =
      typeof parsed.message === "string"
        ? parsed.message
        : `War-room API ${response.status} (${code})`;
    return new WarRoomApiError(response.status, code, message, parsed);
  }

  /** Internal: shared request shape. */
  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.agentToken}`,
      };
      // Only send Content-Type when there's a body — closes #526
      // guard N2 (the prior ternary `body ? json : json` was a
      // dead-code refactor leftover).
      if (body) headers["content-type"] = "application/json";
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      return response;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `War-room API ${method} ${path} timed out after ${this.timeoutMs}ms.`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

function consoleLogger(): Pick<Logger, "info" | "warn" | "error"> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return {
    info: ((..._args: any[]) => undefined) as Logger["info"],
    warn: ((..._args: any[]) => undefined) as Logger["warn"],
    error: ((..._args: any[]) => undefined) as Logger["error"],
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Build the canonical `subject_ref` for a PR. Use this everywhere
 * a PR's identity needs to be passed to the war-room API — keeps
 * the `{owner}/{repo}#{prNumber}` format centrally enforced (it
 * MUST match the storage layer's regex at `repoFromSubjectRef`).
 */
export function prSubjectRef(args: {
  owner: string;
  repo: string;
  prNumber: number;
}): WarRoomSubjectRef {
  return {
    type: "pr_review",
    ref: `${args.owner}/${args.repo}#${args.prNumber}`,
  };
}
