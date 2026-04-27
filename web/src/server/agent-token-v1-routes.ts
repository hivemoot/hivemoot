/**
 * Shared helpers for the V1 agent-token route handlers under
 * `/api/agent-tokens/*` (Phase B.1.d-ii).
 *
 * The handlers themselves are thin shells: authenticate via
 * `authenticateAgentRequestV1`, validate input, call the storage
 * layer with an `auditEntry`, project the result onto the wire shape.
 * Everything reusable across endpoints lives here.
 *
 * **Wire-shape convention** matches `/api/whoami` (B.1.d-i): camelCase
 * on the public surface, snake_case in storage. The handler is the
 * translation layer in BOTH directions:
 *   - `parseV1RequestPolicy()` translates request `allowedRepos` →
 *     storage `allowed_repos` so we can pass straight into
 *     `issueAgentToken`/`setAgentTokenCapabilities`.
 *   - `projectV1ResponsePolicy()` translates the stored snake_case
 *     back to camelCase for the response — same projection /whoami uses.
 *
 * **Audit-entry construction** moved INTO the storage layer
 * (`agent-token-v1.ts`) so entries are built using the LOCKED envelope
 * state — `from` lists in `set_capabilities` audits, `fingerprint_revoked`
 * in revoke audits, and `created_fingerprint` in issue audits are all
 * accurate to the moment the mutation lands. Closes #506 builder R1 #3.
 * Endpoints just pass an `auditContext` (operator fingerprint + name).
 *
 * **Error mapping** centralizes the storage-error → HTTP-status
 * translation. The route handler catches any error and lets
 * `mapV1StorageErrorToResponse` decide the response — keeps each
 * route's catch block down to one line.
 */

import { NextResponse } from "next/server";
import {
  TokenNameTakenError,
  TokenNotFoundError,
  TokenLimitReachedError,
  TokenExpiredForMutationError,
  InvalidExpiresAtError,
  type AgentTokenSummaryV1,
} from "@/server/agent-token-v1";
import { CapabilityValidationError } from "@/server/agent-token-capabilities";
import { LockTimeoutError } from "@/server/redis-lock";
// Audit-entry construction lives in the storage layer now (see header).
// Endpoints just pass an `AuditMutationContext` from `agent-token-v1.ts`.
import type { AgentTokenPolicy } from "@/server/agent-token";

// ---------------------------------------------------------------------------
// Request-body helpers
// ---------------------------------------------------------------------------

/**
 * `expiresIn` request shape mirrors the legacy `/api/agent-token`
 * endpoint (`90d` / `12h` / `30m`) so operators don't have to learn
 * a new vocabulary. Capped at 365d to avoid accidental "infinite"
 * tokens that bypass the deliberate-no-expiry path (`expiresIn:
 * null`, which the V1 envelope explicitly supports).
 */
const EXPIRES_IN_PATTERN = /^([1-9]\d*)([mhd])$/;
const EXPIRES_IN_UNITS_MS = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
} as const;
const MAX_EXPIRES_IN_MS = 365 * EXPIRES_IN_UNITS_MS.d;

export type ParsedExpiresIn =
  | { ok: true; expiresAt: string | null }
  | { ok: false; message: string };

/**
 * Translate an `expiresIn` request value (`"30d"`, `"12h"`, `"30m"`,
 * `null`, or absent) into an absolute ISO 8601 timestamp.
 *
 * Returns `expiresAt: null` for absent/null inputs (no-expiry token,
 * supported per the design). `null` means the operator deliberately
 * chose no expiry — distinct from the legacy fallback. Storage
 * layer (`issueAgentToken`) rejects past timestamps via
 * `InvalidExpiresAtError`, so this helper only validates the
 * request-side shape.
 */
export function parseExpiresIn(input: unknown): ParsedExpiresIn {
  if (input == null) return { ok: true, expiresAt: null };
  if (typeof input !== "string") {
    return {
      ok: false,
      message: "expiresIn must be a duration string like '30d', '12h', '60m', or null for no expiry.",
    };
  }
  const match = input.trim().toLowerCase().match(EXPIRES_IN_PATTERN);
  if (!match) {
    return {
      ok: false,
      message: "expiresIn must be a positive integer plus 'm', 'h', or 'd' (e.g. '30d').",
    };
  }
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof EXPIRES_IN_UNITS_MS;
  const durationMs = amount * EXPIRES_IN_UNITS_MS[unit];
  if (!Number.isSafeInteger(durationMs) || durationMs > MAX_EXPIRES_IN_MS) {
    return {
      ok: false,
      message: "expiresIn must be no more than 365 days.",
    };
  }
  return {
    ok: true,
    expiresAt: new Date(Date.now() + durationMs).toISOString(),
  };
}

/**
 * Wire-shape policy on the request body — `allowedRepos` (camelCase)
 * to match the response shape used by `/api/whoami`. Both fields
 * optional in the wire schema; absent = no narrowing applied to that
 * dimension. Translated to snake_case `AgentTokenPolicy` for storage
 * via `parseV1RequestPolicy`.
 */
interface RequestPolicyView {
  allowedRepos?: unknown;
  allowedPermissions?: unknown;
}

export type ParsedRequestPolicy =
  | { ok: true; policy: AgentTokenPolicy | undefined }
  | { ok: false; message: string };

const ALLOWED_PERMISSION_LEVELS = new Set(["read", "write", "admin"]);

/**
 * Validate + translate a request-body `policy` from camelCase wire
 * shape to the snake_case `AgentTokenPolicy` storage shape. Returns
 * `policy: undefined` when the field is absent (no policy on the
 * envelope = legacy permissive). Returns a structured policy when
 * present.
 *
 * Validation:
 *   - `allowedRepos` must be string[] when present (empty [] is OK
 *     per the design — intentional reject-all marker)
 *   - `allowedPermissions` must be Record<string, "read"|"write"|"admin">
 *     when present
 *
 * If the operator sends `policy: null` or omits the key entirely,
 * the storage envelope simply has no policy field. If they send
 * `policy: {}` (empty object), we still need to materialize an
 * `AgentTokenPolicy` — but `allowed_repos` is required there, so
 * we reject empty-object policies as ambiguous.
 */
export function parseV1RequestPolicy(input: unknown): ParsedRequestPolicy {
  if (input == null) return { ok: true, policy: undefined };
  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      message: "policy must be an object with allowedRepos and/or allowedPermissions.",
    };
  }
  const view = input as RequestPolicyView;
  const hasRepos = view.allowedRepos !== undefined;
  const hasPermissions = view.allowedPermissions !== undefined;

  if (!hasRepos && !hasPermissions) {
    return {
      ok: false,
      message:
        "policy is empty — set allowedRepos (string[], possibly empty for reject-all) and/or allowedPermissions, or omit the policy field entirely for legacy-permissive.",
    };
  }

  if (!hasRepos) {
    // Storage type requires allowed_repos when policy is set —
    // intentionally rejecting V1.6-only-policy requests at the
    // boundary, matching the design's stance (V1.6 is purely
    // additive over V1.5; an `allowed_permissions`-only token still
    // has to declare its repo scope).
    return {
      ok: false,
      message:
        "policy.allowedRepos is required when policy is set (use [] for intentional reject-all).",
    };
  }

  if (!Array.isArray(view.allowedRepos)) {
    return {
      ok: false,
      message: "policy.allowedRepos must be an array of 'owner/name' strings.",
    };
  }
  for (const r of view.allowedRepos) {
    if (typeof r !== "string") {
      return {
        ok: false,
        message: "policy.allowedRepos entries must be strings.",
      };
    }
  }

  let allowedPermissions: Record<string, "read" | "write" | "admin"> | undefined;
  if (hasPermissions) {
    if (
      typeof view.allowedPermissions !== "object" ||
      view.allowedPermissions === null ||
      Array.isArray(view.allowedPermissions)
    ) {
      return {
        ok: false,
        message:
          "policy.allowedPermissions must be a map of permission name → 'read' | 'write' | 'admin'.",
      };
    }
    allowedPermissions = {};
    for (const [k, v] of Object.entries(
      view.allowedPermissions as Record<string, unknown>,
    )) {
      if (typeof v !== "string" || !ALLOWED_PERMISSION_LEVELS.has(v)) {
        return {
          ok: false,
          message: `policy.allowedPermissions.${k} must be 'read', 'write', or 'admin' (got ${JSON.stringify(v)}).`,
        };
      }
      allowedPermissions[k] = v as "read" | "write" | "admin";
    }
  }

  return {
    ok: true,
    policy: {
      allowed_repos: view.allowedRepos as string[],
      ...(allowedPermissions !== undefined ? { allowed_permissions: allowedPermissions } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Response-shape helpers
// ---------------------------------------------------------------------------

/**
 * Wire-shape policy on responses — camelCase per design doc, matches
 * `/api/whoami`. Local interface (not imported from AgentTokenPolicy)
 * for the same auto-leak-defense reason as `WhoamiPolicyView`: future
 * additions to the storage type can't silently appear on the wire.
 */
export interface V1ResponsePolicyView {
  allowedRepos: string[];
  allowedPermissions?: Record<string, "read" | "write" | "admin">;
}

/**
 * Sanitized response-side policy projection. Returns `null` when the
 * envelope has no policy (legacy / V1.5-pre); otherwise a camelCase
 * projection that's identical in shape to /whoami's. Only copies
 * known V1.5/V1.6 fields — never spreads the storage type wholesale.
 */
export function projectV1ResponsePolicy(
  storage: AgentTokenPolicy | undefined | null,
): V1ResponsePolicyView | null {
  if (!storage) return null;
  return {
    allowedRepos: storage.allowed_repos,
    ...(storage.allowed_permissions !== undefined
      ? { allowedPermissions: storage.allowed_permissions }
      : {}),
  };
}

/** Wire-shape summary returned by GET list / GET show. Mirrors
 * `AgentTokenSummaryV1` but with camelCase policy. */
export interface V1TokenSummaryView {
  name: string;
  agent_role: string;
  capabilities: string[];
  fingerprint: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
  policy: V1ResponsePolicyView | null;
}

export function projectV1TokenSummary(
  summary: AgentTokenSummaryV1,
): V1TokenSummaryView {
  return {
    name: summary.name,
    agent_role: summary.agent_role,
    capabilities: summary.capabilities,
    fingerprint: summary.fingerprint,
    createdAt: summary.createdAt,
    createdBy: summary.createdBy,
    expiresAt: summary.expiresAt,
    policy: projectV1ResponsePolicy(summary.policy ?? null),
  };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Stable wire-error codes for the V1 endpoints' domain errors.
 * Distinct from `AGENT_AUTH_V1_ERROR` (those are auth-layer codes).
 */
export const AGENT_TOKENS_V1_ERROR = {
  INVALID_BODY: "agent_tokens_v1_invalid_body",
  INVALID_NAME: "agent_tokens_v1_invalid_name",
  INVALID_AGENT_ROLE: "agent_tokens_v1_invalid_agent_role",
  INVALID_CAPABILITIES: "agent_tokens_v1_invalid_capabilities",
  INVALID_PRESET: "agent_tokens_v1_invalid_preset",
  INVALID_EXPIRES_IN: "agent_tokens_v1_invalid_expires_in",
  INVALID_POLICY: "agent_tokens_v1_invalid_policy",
  WILDCARD_NOT_ALLOWED: "agent_tokens_v1_wildcard_not_allowed",
  NAME_TAKEN: "agent_tokens_v1_name_taken",
  TOKEN_NOT_FOUND: "agent_tokens_v1_token_not_found",
  TOKEN_LIMIT_REACHED: "agent_tokens_v1_token_limit_reached",
  /** Caller tried to mutate (set-capabilities or rotate) a token whose
   * expiresAt has already passed — refused at the storage boundary so
   * the mutation can't resurrect a dying envelope. Closes #506
   * builder R1 #1 (TTL cleanup invariant). */
  TOKEN_EXPIRED_FOR_MUTATION: "agent_tokens_v1_token_expired_for_mutation",
  LOCK_TIMEOUT: "agent_tokens_v1_lock_timeout",
  /** Caller tried to revoke / rotate / set-capabilities on the bearer
   * they're authenticated with — would lock them out mid-flight. */
  SELF_OP_REFUSED: "agent_tokens_v1_self_op_refused",
  SERVER_ERROR: "agent_tokens_v1_server_error",
} as const;

export type AgentTokensV1ErrorCode =
  (typeof AGENT_TOKENS_V1_ERROR)[keyof typeof AGENT_TOKENS_V1_ERROR];

export function v1Error(
  code: AgentTokensV1ErrorCode,
  message: string,
  status: number,
  details?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ code, message, ...(details ?? {}) }, { status });
}

/**
 * Catch-all storage error → HTTP response mapper. Each route's catch
 * block delegates here so the mapping is consistent across endpoints.
 *
 *   - `TokenNameTakenError` → 409 (issue with duplicate name)
 *   - `TokenNotFoundError` → 404 (revoke/set/rotate of unknown name)
 *   - `TokenLimitReachedError` → 422 (per-installation cap reached)
 *   - `InvalidExpiresAtError` → 400 (caller-supplied bad timestamp)
 *   - `CapabilityValidationError` → 400 (caller-supplied bad string)
 *   - `LockTimeoutError` → 503 (concurrent op on same token)
 *   - anything else → 500 (logged as unexpected; opaque to client)
 *
 * Safe-by-default: never echoes raw error message to clients (could
 * leak internal state); just maps to a structured code + a stable
 * operator-facing message. The actual error gets logged for ops.
 */
export function mapV1StorageErrorToResponse(
  err: unknown,
  context: { route: string; installationId: string; name?: string },
): NextResponse {
  if (err instanceof TokenNameTakenError) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.NAME_TAKEN,
      err.message,
      409,
      context.name ? { name: context.name } : undefined,
    );
  }
  if (err instanceof TokenNotFoundError) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.TOKEN_NOT_FOUND,
      err.message,
      404,
      context.name ? { name: context.name } : undefined,
    );
  }
  if (err instanceof TokenLimitReachedError) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.TOKEN_LIMIT_REACHED,
      err.message,
      422,
    );
  }
  if (err instanceof TokenExpiredForMutationError) {
    // 410 Gone — the resource exists but has reached the end of
    // its lifecycle and won't be accepting further mutations.
    // Distinct from 404 (token doesn't exist) and 422 (request
    // would violate domain rules). Operators reading the response
    // see expiredAt + the canonical message ("issue a successor
    // instead of mutating an expired one") so the recovery path
    // is obvious.
    return v1Error(
      AGENT_TOKENS_V1_ERROR.TOKEN_EXPIRED_FOR_MUTATION,
      err.message,
      410,
      { name: err.tokenName, expiredAt: err.expiredAt },
    );
  }
  if (err instanceof InvalidExpiresAtError) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.INVALID_EXPIRES_IN,
      err.message,
      400,
    );
  }
  if (err instanceof CapabilityValidationError) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.INVALID_CAPABILITIES,
      err.message,
      400,
      { field: err.field, value: err.value },
    );
  }
  if (err instanceof LockTimeoutError) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.LOCK_TIMEOUT,
      "Another token operation is in progress for this name. Retry in a moment.",
      503,
    );
  }
  // Unexpected — log + opaque 500 (don't leak the error message).
  console.error("[agent-tokens-v1] unexpected error", {
    route: context.route,
    installationId: context.installationId,
    name: context.name,
    error: err,
  });
  return v1Error(
    AGENT_TOKENS_V1_ERROR.SERVER_ERROR,
    "Internal server error.",
    500,
  );
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

export type ReadJsonObjectResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: NextResponse };

/** Parse a JSON request body that MUST be a non-array object.
 * Returns a structured error response on bad JSON / non-object so
 * route handlers can early-return. Empty body → empty object. */
export async function readJsonObject(
  request: Request,
): Promise<ReadJsonObjectResult> {
  if (request.body === null) return { ok: true, body: {} };
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      ok: false,
      response: v1Error(
        AGENT_TOKENS_V1_ERROR.INVALID_BODY,
        "Request body must be valid JSON.",
        400,
      ),
    };
  }
  if (body == null) return { ok: true, body: {} };
  if (typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      response: v1Error(
        AGENT_TOKENS_V1_ERROR.INVALID_BODY,
        "Request body must be a JSON object.",
        400,
      ),
    };
  }
  return { ok: true, body: body as Record<string, unknown> };
}
