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
 *   - `HIVEMOOT_BOT_AGENT_TOKEN` — V1 capability bearer (must hold
 *     `rooms.create`, `rooms.update`, `rooms.close`, `rooms.read_all`
 *     for full bot operation; a `rooms.create`-only token is
 *     sufficient for E.1)
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

export interface RoomCoreResponse {
  manager: string;
  subject_type: WarRoomSubjectType;
  subject_ref: string;
  status: "awaiting_rsvp" | "awaiting_contributions" | "deciding" | "closed";
  opened_at: string;
  // Server may return additional fields; this is the minimum the
  // bot needs. Extending the response type is non-breaking.
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
    // `code`. The 409 `subject_already_open` path is idempotent.
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON error body — fall through with empty parsed.
    }
    const code = typeof parsed.code === "string" ? parsed.code : "unknown";
    const message =
      typeof parsed.message === "string"
        ? parsed.message
        : `War-room API ${response.status} (${code})`;
    throw new WarRoomApiError(response.status, code, message, parsed);
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
