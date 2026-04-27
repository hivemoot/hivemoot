/**
 * V1 agent-token storage layer (Phase B.1.b).
 *
 * Implements the storage primitives for the per-key capability
 * system from `docs/architecture/CAPABILITIES_DESIGN.md` alongside
 * the legacy single-token-per-installation primitives in
 * `agent-token.ts`. NEW callers should use this module; legacy
 * callers stay on `agent-token.ts` until the cutover (B.1.e) flips
 * the middleware over.
 *
 * BEARER-RESURRECTION INVARIANT (load-bearing for B.1.c middleware)
 * ----------------------------------------------------------------
 * The hash index is intentionally NOT TTL'd (per CAPABILITIES_DESIGN.md
 * — middleware verifies envelope expiry; TTLing the hash index too
 * risks dropping it before the envelope under clock skew). That
 * design decision creates a same-name-reuse failure mode at the
 * storage layer: if an explicit-expiry envelope gets TTL'd by Redis
 * AND the operator reissues a NEW token under the SAME name (now
 * permitted because pruneOrphanedIndexEntries cleared the
 * sorted-set entry), the OLD bearer's hash index still points at
 * `{installationId, name}` and would resolve to the NEW envelope.
 *
 * The middleware MUST close this by comparing
 *   sha256(presentedBearer) === envelope.tokenHash
 * and rejecting on mismatch. This module does NOT enforce that
 * check (it's middleware-side); B.1.c implements it. The fact
 * that this module's storage shape REQUIRES that check is the
 * load-bearing contract — any future refactor that drops the
 * check would silently allow old-bearer-resurrection.
 *
 * See `agent-token-v1.test.ts` "bearer-resurrection invariant"
 * test for the storage-state demonstration.
 *
 * Storage layout (per `docs/architecture/REDIS_KEY_CONVENTION.md`):
 *
 *   hive:v1:agent-token:{installationId}:{name}            string (envelope JSON)
 *   hive:v1:idx:agent-token:hash:{tokenHash}               string (hash record JSON)
 *   hive:v1:idx:agent-token:installation:{installationId}  sorted set (token names by createdAt)
 *   hive:v1:agent-token:{installationId}:{name}:meta       hash (lastUsedAt, callCount)
 *   hive:v1:agent-token:{installationId}:audit             stream (mutations)
 *   hive:v1:agent-token:{installationId}:auth              stream (auth events)
 *   hive:v1:lock:agent-token:{installationId}:{name}       string (issue/revoke/setCaps lock)
 *
 * Atomicity is via 4 Lua scripts (ISSUE, REVOKE, SET_CAPABILITIES,
 * ROTATE) with the return-shape convention from REDIS_KEY_CONVENTION.md.
 *
 * What this module DOESN'T do (deferred to later B.1 PRs):
 *   - middleware integration (B.1.c) — `resolveTokenToInstallation`
 *     extension to read these envelopes
 *   - HTTP endpoints (B.1.d) — `/api/agent-tokens/*` CRUD,
 *     `/api/whoami`, `/api/agent-tokens/bootstrap`
 *   - lastUsedAt write strategy (debounced 60s) — B.1.c with the
 *     middleware that writes it
 *   - audit-stream emit (`auditAppend`) — wired into the same
 *     middleware/endpoint PRs
 *   - cleanup script for legacy keys (B.1.e cutover)
 */

import { createHash, randomBytes } from "crypto";
import { type Redis } from "@upstash/redis";
import { encrypt, type EncryptedEnvelope } from "@/server/crypto";
import { withRedisLock } from "@/server/redis-lock";
import {
  validateName,
  validateAgentRole,
  validateCapabilityString,
} from "@/server/agent-token-capabilities";
import type {
  AgentTokenPolicy,
  GitHubPermissionLevel,
} from "@/server/agent-token";
// `auditStreamKey` is owned by the audit module (where its sibling
// `authStreamKey` lives, and where stream MAXLEN constants are
// declared). Storage scripts in this file pass the stream key as a
// KEYS slot to the Lua audit-emit guard. Cycle is safe: the audit
// module's `auditStreamKey` reads `ENVELOPE_PREFIX` only at function
// CALL time (live ESM binding), and this module's reverse import
// reads `auditStreamKey` only at function CALL time too — neither
// touches the cycled symbol at module init. Closes #505 guard R1
// carry-forward #1 (drift risk between two definitions).
import {
  auditStreamKey,
  type AuditMutationEntry,
} from "@/server/agent-token-v1-audit";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard cap per installation. Configurable via env at the route layer
 * (default 20 per design); the script enforces whatever positive int
 * the caller passes.
 */
export const DEFAULT_TOKEN_LIMIT_PER_INSTALLATION = 20;

/**
 * Clock-skew safety margin (seconds) baked into the envelope's Redis
 * TTL. The middleware does its own envelope `expiresAt` check; the
 * Redis TTL is the eventually-consistent sweep, not the user-visible
 * gate. +300s ensures a Redis-vs-API-server clock drift can't drop
 * the envelope before its `expiresAt` would have fired.
 */
export const ENVELOPE_TTL_SKEW_MARGIN_SECONDS = 300;

export const ENVELOPE_PREFIX = "hive:v1:agent-token:";
const HASH_INDEX_PREFIX = "hive:v1:idx:agent-token:hash:";
const INSTALLATION_INDEX_PREFIX = "hive:v1:idx:agent-token:installation:";
const META_SUFFIX = ":meta";
const LOCK_PREFIX = "hive:v1:lock:agent-token:";

export function envelopeKey(installationId: string, name: string): string {
  return `${ENVELOPE_PREFIX}${installationId}:${name}`;
}

export function hashIndexKey(tokenHash: string): string {
  return `${HASH_INDEX_PREFIX}${tokenHash}`;
}

export function installationIndexKey(installationId: string): string {
  return `${INSTALLATION_INDEX_PREFIX}${installationId}`;
}

export function envelopeMetaKey(installationId: string, name: string): string {
  return `${envelopeKey(installationId, name)}${META_SUFFIX}`;
}

// `auditStreamKey` lives in `agent-token-v1-audit.ts` (owns both
// stream key constructors + their MAXLEN constants). Imported above.
// Closes #505 guard R1 carry-forward #1.

export function lockKey(installationId: string, name: string): string {
  return `${LOCK_PREFIX}${installationId}:${name}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * V1 envelope. Required new fields from V1.5/V1.6:
 *   - `name` — operator-chosen, unique per (installationId, name)
 *   - `agent_role` — server-derived actor identity for multi-actor
 *     APIs (war rooms etc.); never accepted from request body
 *   - `capabilities` — per-key API gates; ≥ 1 entry; wildcards
 *     expanded at request time per `expandCapabilities()`
 */
export interface AgentTokenEnvelopeV1 {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: string;
  tokenHash: string;
  fingerprint: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
  // V1.5/V1.6
  name: string;
  agent_role: string;
  capabilities: string[];
  policy?: AgentTokenPolicy;
}

/**
 * Reverse index for bearer → identity lookup.
 *
 * `expiresAt` removed (was in legacy V1.5 hash record): the middleware
 * reads expiry from the envelope on every auth, keeping a single
 * source of truth. Cost: one extra Redis read per auth, batched into
 * the existing pipeline (per CAPABILITIES_DESIGN.md latency note).
 */
export interface AgentTokenHashRecordV1 {
  installationId: string;
  name: string;
}

/**
 * Per-installation summary entry returned by `listAgentTokens`.
 * Excludes the encrypted ciphertext (we never decrypt for listing).
 */
export interface AgentTokenSummaryV1 {
  name: string;
  agent_role: string;
  capabilities: string[];
  fingerprint: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
  policy?: AgentTokenPolicy;
}

/** Bearer + minimal metadata returned ONCE at issue time (also the
 * shape returned by `rotateAgentToken`). The optional `policy` field
 * round-trips so callers can populate response bodies without an
 * extra GET — closes #506 builder R1 #2: rotate previously surfaced
 * `policy: null` even when the token had policy preserved on the
 * envelope, which falsely advertised the token as legacy-permissive. */
export interface IssuedAgentTokenV1 {
  token: string;
  name: string;
  agent_role: string;
  capabilities: string[];
  fingerprint: string;
  expiresAt: string | null;
  /** Present when the issued/rotated token has a policy on its
   * envelope. Omitted (`undefined`) for legacy / V1.5-pre tokens
   * that have no policy field at all. */
  policy?: AgentTokenPolicy;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class TokenNameTakenError extends Error {
  constructor(installationId: string, name: string) {
    super(`Token name '${name}' already exists for installation ${installationId}`);
    this.name = "TokenNameTakenError";
  }
}

export class TokenLimitReachedError extends Error {
  constructor(installationId: string, limit: number) {
    super(
      `Installation ${installationId} is at the ${limit}-token limit; revoke an unused token before issuing a new one`,
    );
    this.name = "TokenLimitReachedError";
  }
}

export class TokenNotFoundError extends Error {
  constructor(installationId: string, name: string) {
    super(`No agent token named '${name}' for installation ${installationId}`);
    this.name = "TokenNotFoundError";
  }
}

/**
 * Thrown when caller passes an `expiresAt` that is in the past or
 * unparseable. Issuing such a token would create a permanently-401
 * envelope (the auth middleware would reject it from the start),
 * AND consume a slot against the installation's token cap, AND
 * leave a stale sorted-set entry once the past-TTL Redis sweep
 * fires. Reject at write time so the operator gets a clear error
 * (closes builder R1 issue 2).
 */
export class InvalidExpiresAtError extends Error {
  constructor(value: string, reason: string) {
    super(
      `Invalid expiresAt ${JSON.stringify(value)} — ${reason}. Provide a future ISO 8601 timestamp or null for no expiry.`,
    );
    this.name = "InvalidExpiresAtError";
  }
}

/**
 * Thrown when set-capabilities or rotate is called against an
 * envelope whose `expiresAt` has already passed. Closes #506
 * builder R1 #1 (TTL cleanup invariant): `computeEnvelopeTtlSeconds`
 * returns 0 for past expiresAt, which would make the Lua script
 * fall into the unconditional-`SET` branch, CLEARING the existing
 * Redis TTL — turning an expired envelope into a permanent one.
 * The fix is to fail-closed at the storage boundary: an admin
 * holding a still-valid bearer can mutate someone else's token,
 * but cannot resurrect an envelope that the cleanup sweep is
 * about to remove. Operators wanting to extend lifetime must
 * issue a fresh successor.
 */
export class TokenExpiredForMutationError extends Error {
  public readonly installationId: string;
  public readonly tokenName: string;
  public readonly expiredAt: string;
  constructor(installationId: string, tokenName: string, expiredAt: string) {
    super(
      `Refusing to mutate token '${tokenName}' for installation ${installationId}: envelope expired at ${expiredAt} and is awaiting cleanup. Issue a successor token instead of mutating an expired one.`,
    );
    this.name = "TokenExpiredForMutationError";
    this.installationId = installationId;
    this.tokenName = tokenName;
    this.expiredAt = expiredAt;
  }
}

/**
 * Operator-side context for an atomic mutation. Replaces the
 * pre-built `auditEntry` parameter (which let callers race the
 * lock — closes #506 builder R1 #3): the storage layer now builds
 * the entry ITSELF using the locked envelope state, so the `from`
 * lists in `set_capabilities` audits + the `fingerprint_revoked`
 * fields in `revoke` audits + the `created_fingerprint` field in
 * `issue` audits are guaranteed accurate to the moment the
 * mutation lands.
 *
 * The caller (route handler) only knows the operator's identity
 * and any optional extra detail not derivable from envelope state.
 * Storage knows the action, subject, and pre/post envelope state.
 */
export interface AuditMutationContext {
  operator: { fingerprint: string; name: string };
  /** Optional fields merged into the action's standard detail.
   * Use sparingly — the standard detail (from/to / fingerprints)
   * covers the canonical cases. */
  detailExtras?: Record<string, unknown>;
}

/**
 * Throw if the envelope has already expired (`expiresAt` ≤ now) —
 * mutations must not resurrect a token that the cleanup sweep is
 * about to remove. Closes #506 builder R1 #1: the Lua scripts'
 * `tonumber(ARGV[N]) > 0 → SET EX, else SET` branch would CLEAR
 * the existing TTL when called with `ttlSecs = 0`, making the
 * expired envelope permanent. Failing closed at the storage
 * boundary is simpler than per-script TTL preservation logic.
 */
function assertEnvelopeNotExpiredForMutation(
  envelope: AgentTokenEnvelopeV1,
  installationId: string,
  nowMs: number,
): void {
  if (envelope.expiresAt === null) return;
  const expiresAtMs = new Date(envelope.expiresAt).getTime();
  if (Number.isNaN(expiresAtMs)) return; // unparseable — let it through to be cleaned up by other paths
  if (expiresAtMs <= nowMs) {
    throw new TokenExpiredForMutationError(
      installationId,
      envelope.name,
      envelope.expiresAt,
    );
  }
}

// ---------------------------------------------------------------------------
// Lua scripts
// ---------------------------------------------------------------------------

/**
 * ISSUE_TOKEN_SCRIPT — atomic SET NX on the envelope key, plus hash
 * index + sorted-set add. Enforces the 20-token-per-installation
 * limit INSIDE the script (closes guard R2 N1 — was TOCTOU between
 * client SCARD and EVAL).
 *
 * Per the design's R2.3 amendment, the envelope gets an explicit
 * Redis EX when `expirySecsOrZero > 0` (computed by the caller as
 * `expiresAt - now() + 300`). The hash index is intentionally NOT
 * TTL'd — middleware verifies envelope expiry on every auth, and
 * TTLing the hash index too risks dropping it slightly before the
 * envelope under clock skew.
 *
 * Audit emit happens INSIDE the same EVAL when ARGV[7] is non-empty
 * (closes guard R1 G1).
 *
 * Note (closes guard R1 G8): the design doc shows a 7-arg form with
 * `installationId` first; impl drops it because installationId is
 * already encoded in the envelope KEY's prefix and the script never
 * uses it. Functionally equivalent.
 *
 * KEYS: [envelopeKey, hashIndexKey, installationSortedSetKey, auditStreamKey]
 * ARGV: [name, envelopeJson, hashRecordJson, createdAtMs, tokenLimit, expirySecsOrZero, auditEntryJsonOrEmpty]
 *
 * Returns:
 *   {1, name}            success
 *   {0, "name_taken"}    name already exists for this installation
 *   {-1, "limit"}        installation already at tokenLimit names
 */
const ISSUE_TOKEN_SCRIPT = `
local existing = redis.call("get", KEYS[1])
if existing then return {0, "name_taken"} end
local count = redis.call("zcard", KEYS[3])
if count >= tonumber(ARGV[5]) then return {-1, "limit"} end
if tonumber(ARGV[6]) > 0 then
  redis.call("set", KEYS[1], ARGV[2], "EX", tonumber(ARGV[6]))
else
  redis.call("set", KEYS[1], ARGV[2])
end
redis.call("set", KEYS[2], ARGV[3])
redis.call("zadd", KEYS[3], tonumber(ARGV[4]), ARGV[1])
if ARGV[7] ~= "" then
  redis.call("xadd", KEYS[4], "MAXLEN", "~", "10000", "*", "entry", ARGV[7])
end
return {1, ARGV[1]}
`;

/**
 * REVOKE_TOKEN_SCRIPT — atomic 4-key cleanup (envelope + reverse index
 * + installation sorted-set membership + meta) + audit emit.
 *
 * Audit emit happens INSIDE the same EVAL when ARGV[2] is non-empty
 * (closes guard R1 G1). The audit stream itself is NEVER deleted —
 * the audit trail outlives the token.
 *
 * KEYS: [envelopeKey, hashIndexKey, installationSortedSetKey, metaKey, auditStreamKey]
 * ARGV: [name, auditEntryJsonOrEmpty]
 *
 * Returns:
 *   {1, name}    success (envelope existed, all keys cleaned)
 *   {0, name}    nothing to revoke (envelope already gone)
 */
const REVOKE_TOKEN_SCRIPT = `
local existed = redis.call("del", KEYS[1])
redis.call("del", KEYS[2])
redis.call("del", KEYS[4])
redis.call("zrem", KEYS[3], ARGV[1])
-- Audit emit ONLY on actual revoke (existed > 0) — closes guard R1
-- non-blocking #5 on PR #504: an agent_tokens.manage holder calling
-- revoke against a nonexistent name was previously emitting an audit
-- entry per call, which would let them spam real entries past the
-- :audit stream's MAXLEN ~10000 trim and push out genuine forensics.
if ARGV[2] ~= "" and existed > 0 then
  redis.call("xadd", KEYS[5], "MAXLEN", "~", "10000", "*", "entry", ARGV[2])
end
if existed == 0 then return {0, ARGV[1]} end
return {1, ARGV[1]}
`;

/**
 * SET_CAPABILITIES_SCRIPT — atomic mutation of the capabilities field
 * on the envelope. Caller passes the FULL replacement envelope JSON
 * (TypeScript merges the new caps into the existing envelope before
 * calling this). Preserves the envelope's existing TTL via the same
 * `expirySecsOrZero` ARGV pattern as ISSUE.
 *
 * Audit emit happens INSIDE the same EVAL when ARGV[3] is non-empty
 * (closes guard R1 G1 — the design spec'd atomic audit; this PR
 * ships the script with the slot wired so B.1.d only adds the
 * audit-entry construction at the call site, never re-versions the
 * script body).
 *
 * KEYS: [envelopeKey, auditStreamKey]
 * ARGV: [newEnvelopeJson, expirySecsOrZero, auditEntryJsonOrEmpty]
 *
 * Returns:
 *   {1}                  success
 *   {-1, "no_envelope"}  envelope missing (race with revoke)
 */
const SET_CAPABILITIES_SCRIPT = `
local existing = redis.call("get", KEYS[1])
if not existing then return {-1, "no_envelope"} end
if tonumber(ARGV[2]) > 0 then
  redis.call("set", KEYS[1], ARGV[1], "EX", tonumber(ARGV[2]))
else
  redis.call("set", KEYS[1], ARGV[1])
end
if ARGV[3] ~= "" then
  redis.call("xadd", KEYS[2], "MAXLEN", "~", "10000", "*", "entry", ARGV[3])
end
return {1}
`;

/**
 * RESOLVE_BEARER_SCRIPT — single-RTT bearer→envelope resolution.
 *
 * Closes builder R3: the design doc's earlier "pipeline both reads"
 * pseudocode was impossible because the envelope key requires
 * `{installationId, name}` from the hash record returned by the
 * FIRST get. The reads are dependent, so a JS-side
 * `redis.pipeline().get().get().all()` can't construct the second
 * key before the pipeline has run.
 *
 * Resolution: do both reads + the bearer-resurrection invariant
 * check (`envelope.tokenHash === presentedHash`) inside a single
 * Lua EVAL. The script:
 *   1. GET the hash index for the presented bearer.
 *   2. If missing → `{-1, "unknown_bearer"}`.
 *   3. cjson.decode the hash record → `{installationId, name}`.
 *   4. Compute the envelope key in Lua + GET it.
 *   5. If missing → `{-2, "envelope_missing"}` (TTL-swept or
 *      revoke race).
 *   6. cjson.decode the envelope + check `envelope.tokenHash ===
 *      ARGV[2]`. If mismatch → `{-3, "stale_bearer"}` (the
 *      same-name-reissue bearer-resurrection scenario the storage
 *      shape is designed to defend against — see the BEARER-
 *      RESURRECTION INVARIANT block at the top of this file).
 *   7. Otherwise return `{1, envelopeJson}`.
 *
 * Middleware (B.1.c) then:
 *   - Checks `envelope.expiresAt` against current time (Lua can't
 *     reliably compare wall-clock time across instances; the +300s
 *     TTL margin guarantees the envelope outlives its expiresAt
 *     by at least 5 min so this check is the user-visible gate).
 *   - Returns the typed auth result with capabilities + agent_role.
 *
 * KEYS: [hashIndexKey]
 * ARGV: [envelopeKeyPrefix, presentedHash]
 *   envelopeKeyPrefix = "hive:v1:agent-token:" — passed as ARGV
 *                       so the prefix lives in TS code (single
 *                       source of truth) rather than the Lua
 *                       string. Lua does
 *                         envelopeKey = prefix + installationId
 *                                      + ":" + name
 *
 * Returns:
 *   {1, envelopeJson, installationId}  success — caller cjson.parses
 *                                       envelope; installationId is
 *                                       surfaced from the hash record
 *                                       so the middleware can construct
 *                                       the meta-key (lastUsedAt write)
 *                                       and return it on the auth
 *                                       result without an extra round-
 *                                       trip. The V1 envelope schema
 *                                       does NOT carry installationId;
 *                                       it lives only in the storage
 *                                       key + the hash record.
 *   {-1, "unknown_bearer"}             hash index miss
 *   {-2, "envelope_missing"}           hash record points at a TTL'd or revoked envelope
 *   {-3, "stale_bearer"}               bearer-resurrection: hash → envelope but envelope.tokenHash differs
 */
const RESOLVE_BEARER_SCRIPT = `
local hashRecord = redis.call("get", KEYS[1])
if not hashRecord then return {-1, "unknown_bearer"} end
local parsed = cjson.decode(hashRecord)
local envKey = ARGV[1] .. parsed.installationId .. ":" .. parsed.name
local envelope = redis.call("get", envKey)
if not envelope then return {-2, "envelope_missing"} end
local envParsed = cjson.decode(envelope)
if envParsed.tokenHash ~= ARGV[2] then return {-3, "stale_bearer"} end
return {1, envelope, parsed.installationId}
`;

/**
 * ROTATE_TOKEN_SCRIPT — atomic bearer swap. Replaces the envelope +
 * the hash index under the same name with a new bearer's hash record
 * + freshly-encrypted envelope. The previous hash index is DELed in
 * the same EVAL so there is zero "two valid bearers" window at the
 * Redis layer (operationally there is still a stop-and-restart
 * window per the design — see the rotate runbook).
 *
 * Preserves the envelope's `expiresAt` (rotate ≠ extend); caller
 * computes `expirySecsOrZero` as `expiresAt - now() + 300` from the
 * EXISTING envelope's expiry.
 *
 * Audit emit happens INSIDE the same EVAL when ARGV[5] is non-empty
 * (closes guard R1 G1).
 *
 * KEYS: [envelopeKey, oldHashIndexKey, newHashIndexKey, auditStreamKey]
 * ARGV: [name, newEnvelopeJson, newHashRecordJson, expirySecsOrZero, auditEntryJsonOrEmpty]
 *
 * Returns:
 *   {1, name}                success
 *   {-1, "no_envelope"}      name doesn't exist (race with revoke)
 */
const ROTATE_TOKEN_SCRIPT = `
local existing = redis.call("get", KEYS[1])
if not existing then return {-1, "no_envelope"} end
redis.call("del", KEYS[2])
if tonumber(ARGV[4]) > 0 then
  redis.call("set", KEYS[1], ARGV[2], "EX", tonumber(ARGV[4]))
else
  redis.call("set", KEYS[1], ARGV[2])
end
redis.call("set", KEYS[3], ARGV[3])
if ARGV[5] ~= "" then
  redis.call("xadd", KEYS[4], "MAXLEN", "~", "10000", "*", "entry", ARGV[5])
end
return {1, ARGV[1]}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateRawToken(): string {
  return randomBytes(32).toString("hex");
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Derive an audit/list fingerprint from the token's SHA-256 hash.
 * MUST NOT be derived from the raw bearer — that would leak 8 hex
 * chars of the secret anywhere `fingerprint` is exposed (audit log,
 * `tokens list`, dashboard). Hash prefix is the design's canonical
 * form per CAPABILITIES_DESIGN.md §Audit log entry shape.
 */
function fingerprint(tokenHash: string): string {
  return tokenHash.slice(0, 8);
}

/**
 * Compute the Redis TTL (in seconds) to apply to the envelope key.
 * Returns 0 when no expiry is set (V1.5 default — no TTL).
 *
 * The +ENVELOPE_TTL_SKEW_MARGIN_SECONDS ensures the auth middleware's
 * envelope-side `expiresAt` check is the user-visible gate; the Redis
 * TTL is the eventually-consistent cleanup that fires AFTER the
 * envelope is already considered expired.
 *
 * Returns 0 (no TTL) if `expiresAt` is in the past or within the
 * skew margin — the envelope will fail middleware checks immediately
 * anyway, so TTL'ing it just risks racing the auth path.
 */
export function computeEnvelopeTtlSeconds(
  expiresAtIso: string | null,
  nowMs: number = Date.now(),
): number {
  if (expiresAtIso === null) return 0;
  const expiresAtMs = new Date(expiresAtIso).getTime();
  if (Number.isNaN(expiresAtMs)) return 0;
  const remainingSecs = Math.floor((expiresAtMs - nowMs) / 1000);
  if (remainingSecs <= 0) return 0;
  return remainingSecs + ENVELOPE_TTL_SKEW_MARGIN_SECONDS;
}

interface ScriptResult {
  ok: number;
  reason?: string;
}

/**
 * Normalize the Lua script's `[tag, payload]` return into a typed
 * dispatch object.
 *
 *   tag === 1   → ok (positive success)
 *   tag === 0   → benign conflict (named via reason string)
 *   tag === -1  → precondition failed (named via reason string)
 *
 * Other tags ({-2, ...} sequence drift / {-3, ...} unrecoverable)
 * aren't produced by THIS module's scripts, but the helper accepts
 * them uniformly for future-proofing.
 */
function dispatchScriptResult(raw: unknown): ScriptResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `Lua script returned malformed result: ${JSON.stringify(raw)}`,
    );
  }
  const tag = Number(raw[0]);
  const payload = raw.length > 1 ? String(raw[1]) : undefined;
  // Pass payload through for ALL tags. For success (tag === 1) it
  // can carry an envelope/name/etc; for non-success tags it carries
  // the named discriminator (REDIS_KEY_CONVENTION.md `{0, "<reason>"}`).
  return { ok: tag, reason: payload };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Issue a new agent token under `(installationId, name)`. Validates
 * inputs at write time (fail-closed on bad name/role/cap strings) and
 * acquires the per-key lock so concurrent issuances under the same
 * name resolve cleanly via the script's NX path.
 *
 * Returns the bearer ONCE — caller must surface it to the operator
 * (CLI prints to stdout, dashboard shows once-then-clears). The raw
 * bearer is never recoverable: storage holds an encrypted envelope
 * keyed by ciphertext + a SHA-256 hash for reverse lookup.
 *
 * Throws:
 *   - `CapabilityValidationError` on bad name/role/cap inputs
 *   - `TokenNameTakenError` if `(installationId, name)` already exists
 *   - `TokenLimitReachedError` if the installation is at the cap
 */
export async function issueAgentToken(args: {
  installationId: string;
  name: string;
  agent_role: string;
  capabilities: readonly string[];
  createdBy: string;
  expiresAt: string | null;
  policy?: AgentTokenPolicy;
  keyring: Map<string, Buffer>;
  keyVersion: string;
  redis: Redis;
  tokenLimit?: number;
  /**
   * Optional operator-side audit context. When provided, the
   * storage layer builds the `issue` audit entry INSIDE the script's
   * atomic-XADD slot so the mutation + audit land together (closes
   * #506 builder R1 #3). The new token's fingerprint is included
   * automatically — callers don't need to (and can't) compute it.
   * When omitted the script no-ops the XADD (preserves pre-B.1.d
   * behavior so direct-from-tests callers don't have to construct one).
   */
  auditContext?: AuditMutationContext;
}): Promise<IssuedAgentTokenV1> {
  validateName(args.name);
  validateAgentRole(args.agent_role);
  if (args.capabilities.length === 0) {
    throw new Error(
      "Refusing to issue a token with empty capabilities — all envelopes require ≥1 capability",
    );
  }
  for (const c of args.capabilities) validateCapabilityString(c);

  // Reject past or unparseable expiresAt at write time (closes builder R1
  // issue 2 — letting an already-expired envelope land would consume a
  // slot against the cap and produce a permanently-401 token).
  if (args.expiresAt !== null) {
    const expiresAtMs = new Date(args.expiresAt).getTime();
    if (Number.isNaN(expiresAtMs)) {
      throw new InvalidExpiresAtError(args.expiresAt, "not a valid ISO 8601 timestamp");
    }
    if (expiresAtMs <= Date.now()) {
      throw new InvalidExpiresAtError(args.expiresAt, "is in the past");
    }
  }

  const limit = args.tokenLimit ?? DEFAULT_TOKEN_LIMIT_PER_INSTALLATION;
  if (limit <= 0) {
    throw new Error(`tokenLimit must be positive (got ${limit})`);
  }

  // Self-heal orphaned sorted-set entries before the limit check. If
  // explicit-expiry envelopes have been TTL'd by Redis, their hash
  // index + sorted-set membership outlive the envelope; without this
  // pruning the cap would count ghost entries (closes builder R1 #2).
  // Cheap: O(N) Redis reads on a bounded set (cap ≤20).
  await pruneOrphanedIndexEntries({
    installationId: args.installationId,
    redis: args.redis,
  });

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const tokenFingerprint = fingerprint(tokenHash);

  const encrypted: EncryptedEnvelope = encrypt(
    rawToken,
    args.keyVersion,
    args.keyring,
  );

  const createdAtMs = Date.now();
  const createdAtIso = new Date(createdAtMs).toISOString();

  const envelope: AgentTokenEnvelopeV1 = {
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    tag: encrypted.tag,
    keyVersion: encrypted.keyVersion,
    tokenHash,
    fingerprint: tokenFingerprint,
    createdAt: createdAtIso,
    createdBy: args.createdBy,
    expiresAt: args.expiresAt,
    name: args.name,
    agent_role: args.agent_role,
    capabilities: [...args.capabilities],
    ...(args.policy ? { policy: args.policy } : {}),
  };

  const hashRecord: AgentTokenHashRecordV1 = {
    installationId: args.installationId,
    name: args.name,
  };

  const ttlSecs = computeEnvelopeTtlSeconds(args.expiresAt, createdAtMs);

  return await withRedisLock(
    lockKey(args.installationId, args.name),
    args.redis,
    async () => {
      const result = dispatchScriptResult(
        await args.redis.eval(
          ISSUE_TOKEN_SCRIPT,
          [
            envelopeKey(args.installationId, args.name),
            hashIndexKey(tokenHash),
            installationIndexKey(args.installationId),
            auditStreamKey(args.installationId),
          ],
          [
            args.name,
            JSON.stringify(envelope),
            JSON.stringify(hashRecord),
            String(createdAtMs),
            String(limit),
            String(ttlSecs),
            // Empty sentinel = script no-ops the audit XADD. When the
            // endpoint passes an `auditContext`, the entry is built
            // here using the new token's fingerprint (which the caller
            // can't pre-compute), and the script's atomic-audit guard
            // emits the row in the same EVAL as the envelope write.
            args.auditContext
              ? JSON.stringify({
                  ts: createdAtIso,
                  fingerprint: args.auditContext.operator.fingerprint,
                  name: args.name,
                  action: "issue" as const,
                  actor: args.auditContext.operator.name,
                  detail: {
                    agent_role: args.agent_role,
                    capabilities: [...args.capabilities],
                    expiresAt: args.expiresAt,
                    has_policy: args.policy !== undefined,
                    created_fingerprint: tokenFingerprint,
                    ...(args.auditContext.detailExtras ?? {}),
                  },
                } satisfies AuditMutationEntry)
              : "",
          ],
        ),
      );
      if (result.ok === 0 && result.reason === "name_taken") {
        throw new TokenNameTakenError(args.installationId, args.name);
      }
      if (result.ok === -1 && result.reason === "limit") {
        throw new TokenLimitReachedError(args.installationId, limit);
      }
      if (result.ok !== 1) {
        throw new Error(
          `ISSUE_TOKEN_SCRIPT returned unexpected result: ${JSON.stringify(result)}`,
        );
      }
      return {
        token: rawToken,
        name: args.name,
        agent_role: args.agent_role,
        capabilities: [...args.capabilities],
        fingerprint: tokenFingerprint,
        expiresAt: args.expiresAt,
        // Surface policy back to caller so the response shape can
        // round-trip it without an extra GET. Closes #506 builder R1
        // #2 for the issue path (rotate gets the same field below).
        ...(args.policy ? { policy: args.policy } : {}),
      };
    },
  );
}

/**
 * Revoke a token by name. Returns true if the token existed and was
 * cleaned up; false if it was already gone (idempotent revoke).
 *
 * Hard-stop semantics per the design (V1): in-flight calls
 * 401 on next read; current task fails / orphans; queen handles
 * via the existing task watchdog. V1.1 may add a 5-min grace
 * window if hard-stop produces visibly bad task UX.
 */
export async function revokeAgentToken(args: {
  installationId: string;
  name: string;
  redis: Redis;
  /** See `issueAgentToken.auditContext` — same atomic-audit
   * semantics. The revoked envelope's fingerprint is included in
   * detail automatically (taken from the locked envelope read
   * before the script runs). */
  auditContext?: AuditMutationContext;
}): Promise<boolean> {
  validateName(args.name);

  return await withRedisLock(
    lockKey(args.installationId, args.name),
    args.redis,
    async () => {
      // Read the envelope to find the tokenHash (needed to DEL the hash
      // index — the lookup goes envelope → tokenHash → hashIndexKey).
      const envelopeRaw = await args.redis.get<AgentTokenEnvelopeV1>(
        envelopeKey(args.installationId, args.name),
      );
      if (!envelopeRaw) {
        // Sweep both the index entry AND the meta key in case of partial-
        // state from prior failure (closes guard R1 G4 — meta could
        // orphan after a manual Redis intervention).
        await Promise.all([
          args.redis.zrem(installationIndexKey(args.installationId), args.name),
          args.redis.del(envelopeMetaKey(args.installationId, args.name)),
        ]);
        return false;
      }
      const result = dispatchScriptResult(
        await args.redis.eval(
          REVOKE_TOKEN_SCRIPT,
          [
            envelopeKey(args.installationId, args.name),
            hashIndexKey(envelopeRaw.tokenHash),
            installationIndexKey(args.installationId),
            envelopeMetaKey(args.installationId, args.name),
            auditStreamKey(args.installationId),
          ],
          [
            args.name,
            args.auditContext
              ? JSON.stringify({
                  ts: new Date().toISOString(),
                  fingerprint: args.auditContext.operator.fingerprint,
                  name: args.name,
                  action: "revoke" as const,
                  actor: args.auditContext.operator.name,
                  detail: {
                    fingerprint_revoked: envelopeRaw.fingerprint,
                    ...(args.auditContext.detailExtras ?? {}),
                  },
                } satisfies AuditMutationEntry)
              : "",
          ],
        ),
      );
      return result.ok === 1;
    },
  );
}

/**
 * Replace the capabilities on an existing token (in place). Caller
 * provides the FULL new capabilities list; this is a "snap to" not a
 * "merge."
 *
 * Preserves all other envelope fields including `agent_role` and
 * `expiresAt`. The Redis TTL is recomputed from the (preserved)
 * `expiresAt` so the +300s skew margin stays accurate to the
 * envelope's actual lifetime.
 */
export async function setAgentTokenCapabilities(args: {
  installationId: string;
  name: string;
  capabilities: readonly string[];
  redis: Redis;
  nowMs?: number;
  /** See `issueAgentToken.auditContext` — same atomic-audit
   * semantics. The audit `detail.from` list is built from the LOCKED
   * envelope state inside this function, NOT pre-read at the route
   * layer (closes #506 builder R1 #3: pre-read could race a
   * concurrent set-capabilities and produce a `from` that doesn't
   * match the actual previous state).
   */
  auditContext?: AuditMutationContext;
}): Promise<AgentTokenSummaryV1> {
  validateName(args.name);
  if (args.capabilities.length === 0) {
    throw new Error(
      "Refusing to set empty capabilities — all envelopes require ≥1 capability",
    );
  }
  for (const c of args.capabilities) validateCapabilityString(c);

  return await withRedisLock(
    lockKey(args.installationId, args.name),
    args.redis,
    async () => {
      const nowMs = args.nowMs ?? Date.now();
      const envelopeRaw = await args.redis.get<AgentTokenEnvelopeV1>(
        envelopeKey(args.installationId, args.name),
      );
      if (!envelopeRaw) {
        throw new TokenNotFoundError(args.installationId, args.name);
      }
      // Closes #506 builder R1 #1 (TTL cleanup invariant): refuse
      // to mutate an envelope whose expiry has passed. The Lua
      // SET-without-EX branch (when ttlSecs=0) would clear the
      // existing TTL and resurrect the dying envelope. Failing
      // closed at the storage boundary is simpler than per-script
      // TTL preservation logic and gives operators a clear error.
      assertEnvelopeNotExpiredForMutation(envelopeRaw, args.installationId, nowMs);
      const updated: AgentTokenEnvelopeV1 = {
        ...envelopeRaw,
        capabilities: [...args.capabilities],
      };
      const ttlSecs = computeEnvelopeTtlSeconds(updated.expiresAt, nowMs);
      const result = dispatchScriptResult(
        await args.redis.eval(
          SET_CAPABILITIES_SCRIPT,
          [
            envelopeKey(args.installationId, args.name),
            auditStreamKey(args.installationId),
          ],
          [
            JSON.stringify(updated),
            String(ttlSecs),
            args.auditContext
              ? JSON.stringify({
                  ts: new Date().toISOString(),
                  fingerprint: args.auditContext.operator.fingerprint,
                  name: args.name,
                  action: "set_capabilities" as const,
                  actor: args.auditContext.operator.name,
                  detail: {
                    from: [...envelopeRaw.capabilities],
                    to: [...args.capabilities],
                    ...(args.auditContext.detailExtras ?? {}),
                  },
                } satisfies AuditMutationEntry)
              : "",
          ],
        ),
      );
      if (result.ok === -1 && result.reason === "no_envelope") {
        // Race with revoke between the GET above and the EVAL — surface
        // the same NotFound the GET-miss path uses so callers don't
        // need a separate code path.
        throw new TokenNotFoundError(args.installationId, args.name);
      }
      if (result.ok !== 1) {
        throw new Error(
          `SET_CAPABILITIES_SCRIPT returned unexpected result: ${JSON.stringify(result)}`,
        );
      }
      return summarize(updated);
    },
  );
}

/**
 * Replace the bearer for an existing named token. Atomic at the
 * Redis layer (envelope + new hash index swap in one EVAL); the
 * old hash index is DELed in the same call so the previous bearer
 * is invalid the moment this returns.
 *
 * Preserves `expiresAt` (rotate ≠ extend). Operators wanting to
 * extend lifetime should issue a successor under a different name
 * with `--expires-in <duration>`, then revoke the old one.
 */
export async function rotateAgentToken(args: {
  installationId: string;
  name: string;
  keyring: Map<string, Buffer>;
  keyVersion: string;
  redis: Redis;
  nowMs?: number;
  /** See `issueAgentToken.auditContext` — same atomic-audit
   * semantics. The audit detail includes both the old and new
   * fingerprints so investigators can correlate the rotation event
   * with prior `auth.success` entries tied to the old fingerprint. */
  auditContext?: AuditMutationContext;
}): Promise<IssuedAgentTokenV1> {
  validateName(args.name);

  return await withRedisLock(
    lockKey(args.installationId, args.name),
    args.redis,
    async () => {
      const nowMs = args.nowMs ?? Date.now();
      const envelopeRaw = await args.redis.get<AgentTokenEnvelopeV1>(
        envelopeKey(args.installationId, args.name),
      );
      if (!envelopeRaw) {
        throw new TokenNotFoundError(args.installationId, args.name);
      }
      // Closes #506 builder R1 #1 (TTL cleanup invariant): refuse
      // to rotate an expired envelope. Without this guard the new
      // bearer would be issued with the past expiresAt copied
      // forward AND the SET-without-EX branch would clear the
      // existing TTL — a doubly-broken state.
      assertEnvelopeNotExpiredForMutation(envelopeRaw, args.installationId, nowMs);

      const newRawToken = generateRawToken();
      const newTokenHash = hashToken(newRawToken);
      const newFingerprint = fingerprint(newTokenHash);

      const encrypted: EncryptedEnvelope = encrypt(
        newRawToken,
        args.keyVersion,
        args.keyring,
      );

      const updated: AgentTokenEnvelopeV1 = {
        ...envelopeRaw,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        keyVersion: encrypted.keyVersion,
        tokenHash: newTokenHash,
        fingerprint: newFingerprint,
        // expiresAt + capabilities + agent_role + name + createdAt all preserved
      };

      const newHashRecord: AgentTokenHashRecordV1 = {
        installationId: args.installationId,
        name: args.name,
      };

      const ttlSecs = computeEnvelopeTtlSeconds(updated.expiresAt, nowMs);

      const result = dispatchScriptResult(
        await args.redis.eval(
          ROTATE_TOKEN_SCRIPT,
          [
            envelopeKey(args.installationId, args.name),
            hashIndexKey(envelopeRaw.tokenHash),
            hashIndexKey(newTokenHash),
            auditStreamKey(args.installationId),
          ],
          [
            args.name,
            JSON.stringify(updated),
            JSON.stringify(newHashRecord),
            String(ttlSecs),
            args.auditContext
              ? JSON.stringify({
                  ts: new Date().toISOString(),
                  fingerprint: args.auditContext.operator.fingerprint,
                  name: args.name,
                  action: "rotate" as const,
                  actor: args.auditContext.operator.name,
                  detail: {
                    fingerprint_old: envelopeRaw.fingerprint,
                    fingerprint_new: newFingerprint,
                    ...(args.auditContext.detailExtras ?? {}),
                  },
                } satisfies AuditMutationEntry)
              : "",
          ],
        ),
      );
      if (result.ok === -1 && result.reason === "no_envelope") {
        throw new TokenNotFoundError(args.installationId, args.name);
      }
      if (result.ok !== 1) {
        throw new Error(
          `ROTATE_TOKEN_SCRIPT returned unexpected result: ${JSON.stringify(result)}`,
        );
      }

      return {
        token: newRawToken,
        name: args.name,
        agent_role: updated.agent_role,
        capabilities: [...updated.capabilities],
        fingerprint: newFingerprint,
        expiresAt: updated.expiresAt,
        // Closes #506 builder R1 #2: surface the preserved policy
        // back to the caller so the response can round-trip it
        // accurately. Previously the rotate response said
        // `policy: null` regardless, falsely advertising
        // policy-narrowed tokens as legacy-permissive.
        ...(envelopeRaw.policy ? { policy: envelopeRaw.policy } : {}),
      };
    },
  );
}

/**
 * List token summaries for an installation in creation order
 * (by `createdAt` epoch ms via the sorted-set score). Excludes
 * encrypted ciphertext.
 *
 * Self-healing: opportunistically prunes orphaned sorted-set
 * entries whose envelopes have been TTL'd by Redis. Keeps
 * `tokens list` accurate AND ensures the per-installation cap
 * doesn't count ghost entries.
 */
export async function listAgentTokens(args: {
  installationId: string;
  redis: Redis;
}): Promise<AgentTokenSummaryV1[]> {
  const names = await args.redis.zrange<string[]>(
    installationIndexKey(args.installationId),
    0,
    -1,
  );
  if (names.length === 0) return [];
  const envelopes = await Promise.all(
    names.map((name) =>
      args.redis.get<AgentTokenEnvelopeV1>(
        envelopeKey(args.installationId, name),
      ),
    ),
  );
  const out: AgentTokenSummaryV1[] = [];
  const orphans: string[] = [];
  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i];
    if (env !== null) {
      out.push(summarize(env));
    } else {
      orphans.push(names[i]);
    }
  }
  if (orphans.length > 0) {
    // Best-effort cleanup; failures are logged but don't fail the read.
    await Promise.all(
      orphans.map((name) =>
        args.redis
          .zrem(installationIndexKey(args.installationId), name)
          .catch((err: unknown) => {
            console.warn(
              `[agent-token-v1] failed to ZREM orphaned index entry ${args.installationId}:${name}`,
              err,
            );
          }),
      ),
    );
  }
  return out;
}

/**
 * Sweep the per-installation sorted set for entries whose envelope has
 * been TTL'd by Redis. Called by `issueAgentToken` before the cap
 * check so explicit-expiry tokens that have already been swept don't
 * consume slots.
 *
 * Returns the count of pruned entries (mostly for tests / observability).
 * Best-effort: ZREM failures are logged but not propagated.
 */
export async function pruneOrphanedIndexEntries(args: {
  installationId: string;
  redis: Redis;
}): Promise<number> {
  const names = await args.redis.zrange<string[]>(
    installationIndexKey(args.installationId),
    0,
    -1,
  );
  if (names.length === 0) return 0;
  const envelopes = await Promise.all(
    names.map((name) =>
      args.redis.get<AgentTokenEnvelopeV1>(
        envelopeKey(args.installationId, name),
      ),
    ),
  );
  const orphans: string[] = [];
  for (let i = 0; i < envelopes.length; i++) {
    if (envelopes[i] === null) orphans.push(names[i]);
  }
  if (orphans.length === 0) return 0;
  await Promise.all(
    orphans.map((name) =>
      args.redis
        .zrem(installationIndexKey(args.installationId), name)
        .catch((err: unknown) => {
          console.warn(
            `[agent-token-v1] failed to ZREM orphaned index entry ${args.installationId}:${name}`,
            err,
          );
        }),
    ),
  );
  return orphans.length;
}

/**
 * Resolve a presented bearer to the full envelope in ONE Redis
 * round-trip. Used by B.1.c middleware to authenticate incoming
 * requests; the returned envelope carries everything the
 * `requires` capability check needs (capabilities, agent_role,
 * installationId, policy, expiresAt).
 *
 * Returns:
 *   - `{ ok: true, envelope }` when the bearer is valid and
 *     binds to a current envelope (tokenHash matched).
 *   - `{ ok: false, code: "unknown_bearer" }` when the hash index
 *     misses (bearer never existed OR was revoked).
 *   - `{ ok: false, code: "envelope_missing" }` when the hash
 *     record points at an envelope that was Redis-TTL-swept or
 *     concurrently revoked.
 *   - `{ ok: false, code: "stale_bearer" }` when the envelope
 *     exists but its tokenHash differs from the presented bearer's
 *     SHA-256 — the bearer-resurrection scenario (see the
 *     BEARER-RESURRECTION INVARIANT docblock at top of file).
 *
 * Caller (B.1.c middleware in `agent-token-v1-auth.ts`) maps each
 * failure code to its appropriate HTTP response. Mapping reflects
 * what the SHIPPED middleware does (was misdocumented in the
 * pre-#505 JSDoc — closes #505 guard R1 carry-forward #2):
 *   - unknown_bearer → 401 UNKNOWN_BEARER (no record at all — bearer
 *     never existed or was revoked, hash index gone)
 *   - envelope_missing → 401 TOKEN_EXPIRED (hash record points at an
 *     envelope that was TTL-swept or concurrently revoked — from
 *     the bearer's POV the credential is past its lifecycle)
 *   - stale_bearer → 401 TOKEN_EXPIRED (envelope exists but a same-
 *     name reissue replaced its tokenHash — the bearer-resurrection
 *     check; bearer's identity no longer maps to current envelope)
 *   - ok → caller checks `envelope.expiresAt` against the wall
 *     clock + checks the `requires` capability per
 *     `bearerHasCapability(envelope.capabilities, requires)`.
 *
 * The returned envelope INCLUDES the encrypted ciphertext fields
 * (the middleware doesn't decrypt; it only reads metadata). Callers
 * MUST NOT log the envelope object verbatim — it carries the
 * encrypted bearer ciphertext which would defeat the audit-stream
 * "fingerprint, never raw bearer" rule.
 */
export type ResolveBearerResult =
  | {
      ok: true;
      envelope: AgentTokenEnvelopeV1;
      /**
       * Surfaced from the hash record so callers can construct the
       * envelope's `:meta` key (lastUsedAt write) without an extra
       * Redis read. The V1 envelope schema does NOT carry
       * installationId — it lives only in the storage key + the
       * hash record. The resolver script returns it as the third
       * element of its `{1, envelopeJson, installationId}` success
       * tuple.
       */
      installationId: string;
    }
  | {
      ok: false;
      code: "unknown_bearer" | "envelope_missing" | "stale_bearer";
    };

export async function resolveBearerToEnvelope(args: {
  rawBearer: string;
  redis: Redis;
}): Promise<ResolveBearerResult> {
  const presentedHash = hashToken(args.rawBearer);
  const raw = await args.redis.eval(
    RESOLVE_BEARER_SCRIPT,
    [hashIndexKey(presentedHash)],
    [ENVELOPE_PREFIX, presentedHash],
  );
  // Custom dispatch: success returns {1, envelopeJson, installationId}
  // (3 elements) whereas the standard dispatchScriptResult only
  // surfaces position [1] as `reason`. Inline the parsing.
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `RESOLVE_BEARER_SCRIPT returned malformed result: ${JSON.stringify(raw)}`,
    );
  }
  const tag = Number(raw[0]);
  if (tag === 1) {
    if (raw.length !== 3) {
      throw new Error(
        `RESOLVE_BEARER_SCRIPT success expected 3-element tuple, got ${raw.length}`,
      );
    }
    const envelopeJson = String(raw[1]);
    const installationId = String(raw[2]);
    return {
      ok: true,
      envelope: JSON.parse(envelopeJson) as AgentTokenEnvelopeV1,
      installationId,
    };
  }
  const reason = raw.length > 1 ? String(raw[1]) : undefined;
  if (tag === -1 && reason === "unknown_bearer") {
    return { ok: false, code: "unknown_bearer" };
  }
  if (tag === -2 && reason === "envelope_missing") {
    return { ok: false, code: "envelope_missing" };
  }
  if (tag === -3 && reason === "stale_bearer") {
    return { ok: false, code: "stale_bearer" };
  }
  throw new Error(
    `RESOLVE_BEARER_SCRIPT returned unexpected result: ${JSON.stringify(raw)}`,
  );
}

/** Read a single token summary by name. Throws TokenNotFoundError. */
export async function getAgentTokenSummary(args: {
  installationId: string;
  name: string;
  redis: Redis;
}): Promise<AgentTokenSummaryV1> {
  const envelopeRaw = await args.redis.get<AgentTokenEnvelopeV1>(
    envelopeKey(args.installationId, args.name),
  );
  if (!envelopeRaw) {
    throw new TokenNotFoundError(args.installationId, args.name);
  }
  return summarize(envelopeRaw);
}

function summarize(envelope: AgentTokenEnvelopeV1): AgentTokenSummaryV1 {
  return {
    name: envelope.name,
    agent_role: envelope.agent_role,
    capabilities: [...envelope.capabilities],
    fingerprint: envelope.fingerprint,
    createdAt: envelope.createdAt,
    createdBy: envelope.createdBy,
    expiresAt: envelope.expiresAt,
    ...(envelope.policy ? { policy: envelope.policy } : {}),
  };
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { GitHubPermissionLevel };
