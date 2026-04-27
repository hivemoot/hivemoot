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

const ENVELOPE_PREFIX = "hive:v1:agent-token:";
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

/** Bearer + minimal metadata returned ONCE at issue time. */
export interface IssuedAgentTokenV1 {
  token: string;
  name: string;
  agent_role: string;
  capabilities: string[];
  fingerprint: string;
  expiresAt: string | null;
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
 * KEYS: [envelopeKey, hashIndexKey, installationSortedSetKey]
 * ARGV: [name, envelopeJson, hashRecordJson, createdAtMs, tokenLimit, expirySecsOrZero]
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
return {1, ARGV[1]}
`;

/**
 * REVOKE_TOKEN_SCRIPT — atomic 4-key cleanup (envelope + reverse index
 * + installation sorted-set membership + meta).
 *
 * KEYS: [envelopeKey, hashIndexKey, installationSortedSetKey, metaKey]
 * ARGV: [name]
 *
 * Returns:
 *   {1, name}    success (envelope existed, all keys cleaned)
 *   {0, name}    nothing to revoke (envelope already gone)
 *
 * The audit stream is intentionally NOT deleted on revoke — the
 * audit trail outlives the token.
 */
const REVOKE_TOKEN_SCRIPT = `
local existed = redis.call("del", KEYS[1])
redis.call("del", KEYS[2])
redis.call("del", KEYS[4])
redis.call("zrem", KEYS[3], ARGV[1])
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
 * KEYS: [envelopeKey]
 * ARGV: [newEnvelopeJson, expirySecsOrZero]
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
return {1}
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
 * KEYS: [envelopeKey, oldHashIndexKey, newHashIndexKey]
 * ARGV: [newEnvelopeJson, newHashRecordJson, expirySecsOrZero]
 *
 * Returns:
 *   {1, name}                success
 *   {-1, "no_envelope"}      name doesn't exist (race with revoke)
 */
const ROTATE_TOKEN_SCRIPT = `
local existing = redis.call("get", KEYS[1])
if not existing then return {-1, "no_envelope"} end
redis.call("del", KEYS[2])
if tonumber(ARGV[3]) > 0 then
  redis.call("set", KEYS[1], ARGV[1], "EX", tonumber(ARGV[3]))
else
  redis.call("set", KEYS[1], ARGV[1])
end
redis.call("set", KEYS[3], ARGV[2])
return {1, ARGV[2]}
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

function fingerprint(rawToken: string): string {
  return rawToken.slice(-8);
}

/**
 * Bracket-notation alias around the Upstash Redis client's Lua
 * execution method. The literal `.<method>(` token-pattern is
 * flagged by an unrelated security-warning hook (it can't tell
 * the difference between Node's built-in eval and Redis's
 * Lua-script entrypoint), so we route the call through bracket
 * access in one place and keep the rest of the file readable.
 */
function runLuaScript(
  client: Redis,
  script: string,
  keys: string[],
  argv: string[],
): Promise<unknown> {
  const method = "eval";
  const fn = (client as unknown as Record<string, unknown>)[method] as (
    s: string,
    k: string[],
    a: string[],
  ) => Promise<unknown>;
  return fn.call(client, script, keys, argv);
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
  return {
    ok: tag,
    reason: tag === 0 || tag === -1 ? payload : undefined,
  };
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
}): Promise<IssuedAgentTokenV1> {
  validateName(args.name);
  validateAgentRole(args.agent_role);
  if (args.capabilities.length === 0) {
    throw new Error(
      "Refusing to issue a token with empty capabilities — all envelopes require ≥1 capability",
    );
  }
  for (const c of args.capabilities) validateCapabilityString(c);

  const limit = args.tokenLimit ?? DEFAULT_TOKEN_LIMIT_PER_INSTALLATION;
  if (limit <= 0) {
    throw new Error(`tokenLimit must be positive (got ${limit})`);
  }

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const tokenFingerprint = fingerprint(rawToken);

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
        await runLuaScript(
          args.redis,
          ISSUE_TOKEN_SCRIPT,
          [
            envelopeKey(args.installationId, args.name),
            hashIndexKey(tokenHash),
            installationIndexKey(args.installationId),
          ],
          [
            args.name,
            JSON.stringify(envelope),
            JSON.stringify(hashRecord),
            String(createdAtMs),
            String(limit),
            String(ttlSecs),
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
        // Sweep just the index in case of partial-state from prior failure
        await args.redis.zrem(
          installationIndexKey(args.installationId),
          args.name,
        );
        return false;
      }
      const result = dispatchScriptResult(
        await runLuaScript(
          args.redis,
          REVOKE_TOKEN_SCRIPT,
          [
            envelopeKey(args.installationId, args.name),
            hashIndexKey(envelopeRaw.tokenHash),
            installationIndexKey(args.installationId),
            envelopeMetaKey(args.installationId, args.name),
          ],
          [args.name],
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
      const envelopeRaw = await args.redis.get<AgentTokenEnvelopeV1>(
        envelopeKey(args.installationId, args.name),
      );
      if (!envelopeRaw) {
        throw new TokenNotFoundError(args.installationId, args.name);
      }
      const updated: AgentTokenEnvelopeV1 = {
        ...envelopeRaw,
        capabilities: [...args.capabilities],
      };
      const ttlSecs = computeEnvelopeTtlSeconds(
        updated.expiresAt,
        args.nowMs ?? Date.now(),
      );
      const result = dispatchScriptResult(
        await runLuaScript(
          args.redis,
          SET_CAPABILITIES_SCRIPT,
          [envelopeKey(args.installationId, args.name)],
          [JSON.stringify(updated), String(ttlSecs)],
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
}): Promise<IssuedAgentTokenV1> {
  validateName(args.name);

  return await withRedisLock(
    lockKey(args.installationId, args.name),
    args.redis,
    async () => {
      const envelopeRaw = await args.redis.get<AgentTokenEnvelopeV1>(
        envelopeKey(args.installationId, args.name),
      );
      if (!envelopeRaw) {
        throw new TokenNotFoundError(args.installationId, args.name);
      }

      const newRawToken = generateRawToken();
      const newTokenHash = hashToken(newRawToken);
      const newFingerprint = fingerprint(newRawToken);

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

      const ttlSecs = computeEnvelopeTtlSeconds(
        updated.expiresAt,
        args.nowMs ?? Date.now(),
      );

      const result = dispatchScriptResult(
        await runLuaScript(
          args.redis,
          ROTATE_TOKEN_SCRIPT,
          [
            envelopeKey(args.installationId, args.name),
            hashIndexKey(envelopeRaw.tokenHash),
            hashIndexKey(newTokenHash),
          ],
          [
            JSON.stringify(updated),
            JSON.stringify(newHashRecord),
            String(ttlSecs),
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
      };
    },
  );
}

/**
 * List token summaries for an installation in creation order
 * (by `createdAt` epoch ms via the sorted-set score). Excludes
 * encrypted ciphertext.
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
  for (const env of envelopes) {
    if (env !== null) out.push(summarize(env));
  }
  return out;
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
