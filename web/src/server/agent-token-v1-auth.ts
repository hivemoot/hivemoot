/**
 * V1 agent-token Bearer authentication middleware (Phase B.1.c).
 *
 * Wraps the storage-layer `resolveBearerToEnvelope` (B.1.b) into a
 * Next.js route helper that:
 *
 *   1. Pulls the Bearer token off the Authorization header.
 *   2. Resolves it to a typed envelope via the single-RTT
 *      `RESOLVE_BEARER_SCRIPT` (closes the bearer-resurrection
 *      invariant from B.1.b: stale-bearer / envelope-missing /
 *      unknown-bearer all map to 401 with distinct codes).
 *   3. Checks `expiresAt` against the wall clock (the envelope-side
 *      check is the user-visible gate per CAPABILITIES_DESIGN.md
 *      §"Latency + bearer-resurrection"; Redis TTL is the
 *      eventually-consistent sweep).
 *   4. Validates the bearer holds the endpoint's `requires`
 *      capability via `bearerHasCapability` (wildcard expansion
 *      against `KNOWN_CAPABILITIES`, with the admin-class
 *      carve-out from B.1.a).
 *   5. Best-effort, debounced 60s update of `lastUsedAt` on the
 *      separate `:meta` key so the auth hot path stays one Redis
 *      RTT and the envelope key stays read-only.
 *   6. Returns a typed `AgentAuthResultV1` carrying everything the
 *      route handler needs — installationId, name, agent_role,
 *      capabilities, envelope (for policy access), redis client.
 *
 * This is the only middleware. The legacy `agent-health-auth.ts` /
 * `task-executor-auth.ts` middlewares were deleted in the B.1.e
 * cutover; all routes that previously used them now require an
 * explicit `requires` capability and resolve V1 envelopes here.
 */

import { type Redis } from "@upstash/redis";
import { NextRequest, NextResponse } from "next/server";
import { validateEnv } from "@/server/env";
import { getRedisClient } from "@/server/redis";
import { parseKeyring } from "@/server/crypto";
import {
  bearerHasCapability,
} from "@/server/agent-token-capabilities";
import {
  resolveBearerToEnvelope,
  envelopeMetaKey,
  type AgentTokenEnvelopeV1,
  type ResolveBearerResult,
} from "@/server/agent-token-v1";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Debounce window for `lastUsedAt` writes. Per
 * CAPABILITIES_DESIGN.md §`lastUsedAt` write strategy: skip the
 * write when the existing value is within this window. Keeps the
 * envelope key read-only on the auth hot path; only the
 * separate `:meta` hash gets touched, fire-and-forget.
 */
export const LAST_USED_AT_DEBOUNCE_SECONDS = 60;

// ---------------------------------------------------------------------------
// Error vocabulary
// ---------------------------------------------------------------------------

/**
 * Stable wire-error codes for the V1 auth middleware. The legacy
 * `AGENT_HEALTH_ERROR` codes used by the deleted singular auth path
 * are gone; this is the only error vocabulary now.
 */
export const AGENT_AUTH_V1_ERROR = {
  /** `Authorization: Bearer <token>` header missing or malformed. */
  MISSING_BEARER: "agent_auth_v1_missing_bearer",
  /** Bearer's hash index has no entry — never issued or fully revoked. */
  UNKNOWN_BEARER: "agent_auth_v1_unknown_bearer",
  /** Bearer's expiresAt is in the past per the envelope's wall-clock check. */
  TOKEN_EXPIRED: "agent_auth_v1_token_expired",
  /** Bearer holds a valid envelope but lacks the route's required capability. */
  MISSING_CAPABILITY: "agent_auth_v1_missing_capability",
  /** Server-side env / Redis misconfiguration. */
  SERVER_MISCONFIGURATION: "agent_auth_v1_server_misconfiguration",
} as const;

export type AgentAuthV1ErrorCode =
  (typeof AGENT_AUTH_V1_ERROR)[keyof typeof AGENT_AUTH_V1_ERROR];

function authV1Error(
  code: AgentAuthV1ErrorCode,
  message: string,
  status: number,
  details?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ code, message, ...(details ?? {}) }, { status });
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface AgentAuthSuccessV1 {
  ok: true;
  installationId: string;
  name: string;
  agent_role: string;
  capabilities: string[];
  /**
   * Full envelope for handlers that need policy fields
   * (`allowed_repos`, `allowed_permissions`) or other metadata.
   * Carries the encrypted ciphertext fields — handlers MUST NOT
   * log it verbatim (the audit-stream contract says fingerprint,
   * never raw bearer; logging the envelope object would defeat
   * that since the ciphertext is the encrypted bearer).
   */
  envelope: AgentTokenEnvelopeV1;
  redis: Redis;
}

export interface AgentAuthFailureV1 {
  ok: false;
  response: NextResponse;
}

export type AgentAuthResultV1 = AgentAuthSuccessV1 | AgentAuthFailureV1;

export interface AuthenticateAgentRequestV1Options {
  /**
   * REQUIRED capability the bearer must hold to access this route.
   * Wildcard expansion (`*`, `tasks.*`, etc.) per
   * `expandCapabilities` from `agent-token-capabilities.ts`.
   *
   * Pass `null` ONLY for routes that intentionally accept any
   * authenticated bearer regardless of capabilities (e.g.
   * `/api/whoami` introspection — implementer notes in B.1.d
   * cover the snapshot-vs-enforcement distinction).
   */
  requires: string | null;

  /**
   * When true, skip the `lastUsedAt` debounced write entirely.
   * Used by `/api/whoami` so introspection doesn't have a side
   * effect (closes hivemoot reviewer R2 #2-issue-4 from the
   * design doc — a snapshot endpoint shouldn't bump usage state).
   *
   * Defaults to false (write is debounced + fire-and-forget).
   */
  skipLastUsedAtWrite?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractBearer(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  // RFC 6750: scheme matching is case-insensitive ("Bearer", "bearer",
  // "BEARER" all valid). Most clients send "Bearer " — but pin the
  // case-insensitive contract so a misbehaving client doesn't get
  // surprising 401s.
  const match = header.match(/^bearer\s+(\S.*)$/i);
  if (!match) return null;
  const raw = match[1].trim();
  return raw.length > 0 ? raw : null;
}

/**
 * Apply the wall-clock `expiresAt` check from the envelope. Returns
 * true when the envelope is currently within its lifetime, false
 * when expired.
 *
 * Per CAPABILITIES_DESIGN.md: this envelope-side check is the
 * canonical user-visible gate; Redis TTL is the eventually-
 * consistent sweep that fires AFTER the +300s clock-skew margin
 * past the envelope's actual `expiresAt`.
 */
function envelopeStillValid(
  envelope: AgentTokenEnvelopeV1,
  nowMs: number,
): boolean {
  if (envelope.expiresAt === null) return true;
  const expiresAtMs = new Date(envelope.expiresAt).getTime();
  if (Number.isNaN(expiresAtMs)) {
    // Defensive: a corrupted expiresAt string fails closed.
    return false;
  }
  return expiresAtMs > nowMs;
}

/**
 * Best-effort debounced write of `lastUsedAt` to the separate
 * `:meta` hash. Keeps the envelope key read-only on the auth hot
 * path. Errors are swallowed (logged) — auth result is what
 * matters; meta is observability.
 *
 * Algorithm:
 *   1. HGET `:meta` `lastUsedAt`
 *   2. If parsed > nowMs - LAST_USED_AT_DEBOUNCE_SECONDS, skip
 *      (write is recent enough)
 *   3. Otherwise HSET `:meta` `lastUsedAt` to ISO of nowMs
 *
 * Two Redis RTTs in the worst case (HGET then HSET); the HSET is
 * skipped on the common path (within debounce window). Fire-and-
 * forget — the calling handler does NOT await this.
 *
 * **Serverless reliability caveat** (closes guard R1 PR #504
 * non-blocking #2): on Vercel functions the runtime can suspend
 * the function instance immediately after the response flushes;
 * a fire-and-forget HSET kicked off but not awaited may never
 * reach Redis. `lastUsedAt` is observability state, not security
 * state, so the loss is acceptable for V1. If `lastUsedAt`
 * becomes load-bearing for an operator workflow (e.g. unused-
 * token cleanup), upgrade callers to wrap this in
 * `request.waitUntil()` so Vercel keeps the instance alive
 * through the write.
 */
async function maybeUpdateLastUsedAt(
  redis: Redis,
  installationId: string,
  name: string,
  nowMs: number,
): Promise<void> {
  try {
    const metaKey = envelopeMetaKey(installationId, name);
    const existing = await redis.hget<string>(metaKey, "lastUsedAt");
    if (existing) {
      const lastMs = new Date(existing).getTime();
      if (
        !Number.isNaN(lastMs) &&
        lastMs > nowMs - LAST_USED_AT_DEBOUNCE_SECONDS * 1000
      ) {
        return;
      }
    }
    await redis.hset(metaKey, { lastUsedAt: new Date(nowMs).toISOString() });
  } catch (err) {
    console.warn(
      `[agent-token-v1-auth] lastUsedAt write failed for ${installationId}:${name}`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Public middleware
// ---------------------------------------------------------------------------

/**
 * Authenticate an incoming agent request via Bearer token + check
 * the `requires` capability. Returns a typed result that handlers
 * either surface as a 401/403 response (failure) or destructure for
 * the authenticated identity (success).
 *
 * Usage:
 *
 * ```typescript
 * export async function POST(request: NextRequest) {
 *   const auth = await authenticateAgentRequestV1(request, {
 *     requires: "tasks.create",
 *   });
 *   if (!auth.ok) return auth.response;
 *   // auth.installationId, auth.name, auth.agent_role,
 *   // auth.capabilities, auth.envelope, auth.redis are in scope.
 * }
 * ```
 */
export async function authenticateAgentRequestV1(
  request: NextRequest,
  options: AuthenticateAgentRequestV1Options,
): Promise<AgentAuthResultV1> {
  const env = validateEnv();
  if (!env.ok) {
    return {
      ok: false,
      response: authV1Error(
        AGENT_AUTH_V1_ERROR.SERVER_MISCONFIGURATION,
        "Server misconfiguration",
        503,
      ),
    };
  }

  const { redisRestUrl, redisRestToken } = env.config;
  if (!redisRestUrl || !redisRestToken) {
    return {
      ok: false,
      response: authV1Error(
        AGENT_AUTH_V1_ERROR.SERVER_MISCONFIGURATION,
        "Redis not configured",
        503,
      ),
    };
  }

  const rawBearer = extractBearer(request);
  if (rawBearer === null) {
    return {
      ok: false,
      response: authV1Error(
        AGENT_AUTH_V1_ERROR.MISSING_BEARER,
        "Missing or malformed Authorization: Bearer header",
        401,
      ),
    };
  }

  const redis = getRedisClient(redisRestUrl, redisRestToken);

  let resolved: ResolveBearerResult;
  try {
    resolved = await resolveBearerToEnvelope({ rawBearer, redis });
  } catch (err) {
    console.error("[agent-token-v1-auth] resolveBearerToEnvelope threw", err);
    return {
      ok: false,
      response: authV1Error(
        AGENT_AUTH_V1_ERROR.SERVER_MISCONFIGURATION,
        "Auth resolution failed",
        503,
      ),
    };
  }

  if (!resolved.ok) {
    // Three failure modes, two HTTP responses:
    //
    //   unknown_bearer    → 401 UNKNOWN_BEARER. Hash index has no
    //                       entry: bearer was never issued, OR was
    //                       revoked (REVOKE_TOKEN_SCRIPT DELs the
    //                       hash index alongside the envelope).
    //
    //   envelope_missing  → 401 TOKEN_EXPIRED. Hash record EXISTS
    //                       but envelope is gone. Most likely cause:
    //                       Redis swept the explicit-expiry envelope
    //                       past the +300s clock-skew margin. Hash
    //                       index is intentionally NOT TTL'd (per
    //                       CAPABILITIES_DESIGN.md "Latency +
    //                       bearer-resurrection" — TTLing it risks
    //                       dropping the index slightly before the
    //                       envelope under clock skew). Less common:
    //                       Upstash maxmemory eviction picking the
    //                       larger envelope key over the small hash
    //                       record. Either way, telling the operator
    //                       "TOKEN_EXPIRED" is the truthful cause —
    //                       NOT "unknown bearer" which would imply
    //                       the bearer was never issued. (Closes
    //                       guard R1 G2 on PR #504.)
    //
    //   stale_bearer      → 401 TOKEN_EXPIRED. Bearer-resurrection:
    //                       envelope.tokenHash differs from the
    //                       presented bearer's hash. The bearer's
    //                       name was reissued; from the holder's POV
    //                       the bearer no longer maps to its
    //                       identity (semantically equivalent to an
    //                       expiry).
    if (resolved.code === "envelope_missing" || resolved.code === "stale_bearer") {
      return {
        ok: false,
        response: authV1Error(
          AGENT_AUTH_V1_ERROR.TOKEN_EXPIRED,
          "Token expired or superseded — re-authenticate with a fresh bearer",
          401,
        ),
      };
    }
    return {
      ok: false,
      response: authV1Error(
        AGENT_AUTH_V1_ERROR.UNKNOWN_BEARER,
        "Invalid or unknown bearer",
        401,
      ),
    };
  }

  const envelope = resolved.envelope;
  const nowMs = Date.now();

  if (!envelopeStillValid(envelope, nowMs)) {
    return {
      ok: false,
      response: authV1Error(
        AGENT_AUTH_V1_ERROR.TOKEN_EXPIRED,
        "Token expired",
        401,
      ),
    };
  }

  // Capability check (only when caller declared a `requires`).
  if (options.requires !== null) {
    if (!bearerHasCapability(envelope.capabilities, options.requires)) {
      return {
        ok: false,
        response: authV1Error(
          AGENT_AUTH_V1_ERROR.MISSING_CAPABILITY,
          `Token '${envelope.name}' on installation ${resolved.installationId} cannot ${options.requires} — needed capability: ${options.requires}`,
          403,
          {
            required: options.requires,
            granted: envelope.capabilities,
          },
        ),
      };
    }
  }

  // Best-effort, fire-and-forget lastUsedAt write. NEVER awaited —
  // a slow Redis HSET shouldn't extend auth latency. /whoami opts
  // out via skipLastUsedAtWrite=true so introspection has no side
  // effect.
  if (!options.skipLastUsedAtWrite) {
    void maybeUpdateLastUsedAt(
      redis,
      resolved.installationId,
      envelope.name,
      nowMs,
    );
  }

  return {
    ok: true,
    installationId: resolved.installationId,
    name: envelope.name,
    agent_role: envelope.agent_role,
    capabilities: [...envelope.capabilities],
    envelope,
    redis,
  };
}

// ---------------------------------------------------------------------------
// Keyring loader (for issue / rotate endpoints — anything that mints
// new envelopes needs the active master key)
// ---------------------------------------------------------------------------

export type LoadV1MintKeyringResult =
  | { ok: true; keyring: Map<string, Buffer>; keyVersion: string }
  | { ok: false; response: NextResponse };

/**
 * Load the active keyring + its version for V1 mutation endpoints
 * that mint envelopes (issue + rotate). Read endpoints don't need
 * this — they only `get` from Redis. Bootstrap (B.1.d-iv) reuses
 * this same loader.
 *
 * Returns a 503 NextResponse when env config is missing or the
 * active key version isn't in the keyring. Mirrors the BYOK auth
 * pattern (`byok-auth.ts:loadRuntimeConfig`) but is scoped to the
 * V1 endpoints' needs — we don't need the cookie-session storage
 * here, only the keyring.
 *
 * Per CLAUDE.md fail-closed principle: when the keyring is
 * misconfigured we return 503 rather than letting the endpoint
 * try to encrypt with an undefined key.
 */
export function loadV1MintKeyring(): LoadV1MintKeyringResult {
  const env = validateEnv();
  if (!env.ok) {
    console.error(
      "[agent-token-v1-auth] mint keyring load failed: env validation failed",
      { missing: env.missing },
    );
    return {
      ok: false,
      response: authV1Error(
        AGENT_AUTH_V1_ERROR.SERVER_MISCONFIGURATION,
        "Server misconfiguration",
        503,
      ),
    };
  }

  const { byokActiveKeyVersion, byokMasterKeysJson } = env.config;

  if (!byokActiveKeyVersion || !byokMasterKeysJson) {
    console.error(
      "[agent-token-v1-auth] mint keyring load failed: BYOK_ACTIVE_KEY_VERSION or BYOK_MASTER_KEYS missing",
    );
    return {
      ok: false,
      response: authV1Error(
        AGENT_AUTH_V1_ERROR.SERVER_MISCONFIGURATION,
        "Encryption is not configured",
        503,
      ),
    };
  }

  let keyring: Map<string, Buffer>;
  try {
    keyring = parseKeyring(byokMasterKeysJson);
  } catch (err) {
    console.error(
      "[agent-token-v1-auth] mint keyring load failed: parseKeyring threw",
      { error: err },
    );
    return {
      ok: false,
      response: authV1Error(
        AGENT_AUTH_V1_ERROR.SERVER_MISCONFIGURATION,
        "Invalid encryption configuration",
        503,
      ),
    };
  }

  if (!keyring.has(byokActiveKeyVersion)) {
    console.error(
      "[agent-token-v1-auth] mint keyring load failed: active key version not in keyring",
      { activeKeyVersion: byokActiveKeyVersion },
    );
    return {
      ok: false,
      response: authV1Error(
        AGENT_AUTH_V1_ERROR.SERVER_MISCONFIGURATION,
        "Active key version not in keyring",
        503,
      ),
    };
  }

  return { ok: true, keyring, keyVersion: byokActiveKeyVersion };
}
