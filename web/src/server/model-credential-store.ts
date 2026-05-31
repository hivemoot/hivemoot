/**
 * Model-credential storage layer (MODEL_AUTH_DESIGN.md Stage 1).
 *
 * A per-installation, named-record store for the LLM/provider credentials
 * that dynamically-created agents reference by NAME. It clones the
 * `agent-token-v1.ts` shape (Redis key namespacing, installation sorted-set
 * index, audit stream, `withRedisLock`, inline Lua with a TOCTOU-safe
 * per-installation cap) but DROPS the reverse `hash:{tokenHash}` index:
 * agent-token has that index purely for bearer→identity auth (a presented
 * token resolves to an identity). Model credentials are looked up BY NAME
 * (an agent's engine → a credential name), never by a presented bearer, so
 * cloning the hash index would add a non-load-bearing key.
 *
 * Distinct from BYOK (a single workflow-LLM key per installation, the wrong
 * cardinality here) and distinct from `agent_token` (a GitHub/health
 * capability bearer). This module REUSES the BYOK primitives — `crypto.ts`
 * envelope/keyring and the provider/kind metadata + status + rotate/revoke
 * lifecycle idea — but with the multi-credential named-record cardinality.
 *
 * Storage layout (MODEL_AUTH_DESIGN.md §1.1):
 *
 *   hive:v1:model-cred:{installationId}:{name}            string (envelope JSON)
 *   hive:v1:idx:model-cred:installation:{installationId}  sorted set (names by createdAt)
 *   hive:v1:model-cred:{installationId}:audit             stream (mutations)
 *   hive:v1:lock:model-cred:{installationId}:{name}       string (mutation lock)
 *
 * Atomicity: create is one inline-Lua EVAL with a zcard cap guard (mirrors
 * `agent-token-v1.ts`'s ISSUE_TOKEN_SCRIPT, TOCTOU-safe). Every mutation runs
 * under `withRedisLock`. Audit XADD always goes through an inline-Lua path
 * (the create script, or UPDATE_CREDENTIAL_SCRIPT for rotate/revoke/
 * re-encrypt) so there is exactly one XADD code path — and NO Upstash
 * `cjson`/sandbox-only Lua is used anywhere (see the agent-token cjson
 * regression that 503'd every Bearer request in prod).
 *
 * What this module DOESN'T do (deferred to later stages, by design):
 *   - delivery: NOTHING reads the decrypted value for the hive yet
 *     (Stage 3 endpoint + B/B' sealed-box decision). Stage 1 is
 *     deliberately delivery-agnostic — it only stores + manages, so it is
 *     identical regardless of the later B-vs-B' delivery choice.
 *   - agent association (`model_credential_name` on FleetAgent) — Stage 2.
 *   - apiarist consumption — Stage 4.
 *   - dashboard UI wiring — Stage 5.
 */

import { createHash } from "crypto";
import { type Redis } from "@upstash/redis";
import { encrypt, decrypt, type EncryptedEnvelope } from "@/server/crypto";
import { withRedisLock } from "@hivemoot/war-room/redis-lock";
import {
  validateName,
  CapabilityValidationError,
} from "@/server/agent-token-capabilities";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard cap per installation (MODEL_AUTH_DESIGN.md §6.5 — "suggest 20 like
 * agents/tokens"). Enforced atomically inside the Lua CREATE script (zcard
 * guard), so concurrent creates can never exceed it (TOCTOU-safe, mirroring
 * `agent-token-v1.ts`'s ISSUE_TOKEN_SCRIPT). The route layer may override via
 * the optional `limit` arg, but the script enforces whatever positive int the
 * caller passes.
 */
export const MAX_MODEL_CREDENTIALS_PER_INSTALLATION = 20;

export const ENVELOPE_PREFIX = "hive:v1:model-cred:";
const INSTALLATION_INDEX_PREFIX = "hive:v1:idx:model-cred:installation:";
const AUDIT_SUFFIX = ":audit";
const LOCK_PREFIX = "hive:v1:lock:model-cred:";

/** Trim the audit stream to ~10k entries, matching agent-token-v1. */
const AUDIT_STREAM_MAXLEN = "10000";

export function envelopeKey(installationId: string, name: string): string {
  return `${ENVELOPE_PREFIX}${installationId}:${name}`;
}

export function installationIndexKey(installationId: string): string {
  return `${INSTALLATION_INDEX_PREFIX}${installationId}`;
}

export function auditStreamKey(installationId: string): string {
  return `${ENVELOPE_PREFIX}${installationId}${AUDIT_SUFFIX}`;
}

export function lockKey(installationId: string, name: string): string {
  return `${LOCK_PREFIX}${installationId}:${name}`;
}

/**
 * Names that would collide with a non-envelope Redis key in this namespace.
 * NAME_REGEX permits these, but `auditStreamKey(id)` is `…:{id}:audit` and
 * `envelopeKey(id, "audit")` is byte-identical — so a credential literally named
 * `audit` would alias the installation's audit STREAM with a STRING, a WRONGTYPE
 * collision that corrupts the whole installation's audit trail. Reject the
 * reserved suffix(es) on every path (create AND every by-name read/mutation) so
 * such a name can never be addressed. Keep in sync with the key constructors above.
 */
const RESERVED_CREDENTIAL_NAMES: ReadonlySet<string> = new Set(["audit"]);

/**
 * Validate a credential name at every boundary: NAME_REGEX (shared with
 * agent-tokens) PLUS a reserved-suffix guard. Throws `CapabilityValidationError`
 * so the route layer maps it to `invalid_name` uniformly.
 */
function assertValidCredentialName(name: string): void {
  validateName(name);
  if (RESERVED_CREDENTIAL_NAMES.has(name)) {
    throw new CapabilityValidationError(
      "name",
      name,
      `'${name}' is reserved (it collides with an internal key) — choose another name`,
    );
  }
}

// ---------------------------------------------------------------------------
// Kinds + providers (MODEL_AUTH_DESIGN.md §1.2 / §1.4)
// ---------------------------------------------------------------------------

/**
 * The two credential kinds. `api_key` is a single static key string;
 * `oauth_subscription` covers Claude OAuth (a far-future-expiry string) and
 * Codex device-auth (a mutable blob). Both store the secret inside the GCM
 * plaintext; the difference is purely metadata + (later) delivery policy.
 */
export type ModelCredentialKind = "api_key" | "oauth_subscription";

const MODEL_CREDENTIAL_KINDS: readonly ModelCredentialKind[] = [
  "api_key",
  "oauth_subscription",
] as const;

export function isModelCredentialKind(
  value: unknown,
): value is ModelCredentialKind {
  return (
    typeof value === "string" &&
    (MODEL_CREDENTIAL_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Provider allowlist (MODEL_AUTH_DESIGN.md §1.4). Extensible const — the
 * single source of truth for which provider labels a model credential may
 * carry. Validated server-side at create/rotate time so a Redis tamperer
 * can never introduce an unknown provider, AND so the value is bound inside
 * the GCM-authenticated plaintext.
 */
export const MODEL_CREDENTIAL_PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
  "zai",
  "google",
] as const;

export type ModelCredentialProvider =
  (typeof MODEL_CREDENTIAL_PROVIDERS)[number];

export function isModelCredentialProvider(
  value: unknown,
): value is ModelCredentialProvider {
  return (
    typeof value === "string" &&
    (MODEL_CREDENTIAL_PROVIDERS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The encrypted secret payload (MODEL_AUTH_DESIGN.md §1.3). Serialized to
 * JSON before encryption so `kind` + `provider` are GCM-authenticated
 * alongside the secret `value` — a Redis tamperer cannot swap a credential's
 * provider/kind label without breaking the auth tag (mirrors BYOK's
 * `JSON.stringify({apiKey,provider,model})` pattern).
 *
 *   - api_key            → value = the key string.
 *   - oauth_subscription → value = the OAuth token string (Claude) OR the
 *                          JSON-stringified device-auth blob (Codex).
 */
export interface ModelCredentialSecretPayload {
  kind: ModelCredentialKind;
  provider: ModelCredentialProvider;
  value: string;
}

/**
 * The stored envelope (MODEL_AUTH_DESIGN.md §1.2). Crypto fields hold the
 * encrypted `ModelCredentialSecretPayload`; the clear metadata never carries
 * the secret. `kind`/`provider` are duplicated in the clear for cheap
 * listing/filtering, but the AUTHORITATIVE copies live inside the
 * GCM-authenticated plaintext (a clear-field tamper is detectable on
 * decrypt).
 */
export interface ModelCredentialEnvelopeV1 {
  // --- crypto.ts EncryptedEnvelope, inlined (same shape as ByokEnvelope) ---
  ciphertext: string; // base64 — the secret payload (see §1.3)
  iv: string; // base64
  tag: string; // base64 GCM auth tag
  keyVersion: string; // keyring version that sealed it

  // --- clear metadata (never the secret) ---
  name: string; // operator-chosen, unique per (installationId, name); NAME_REGEX
  kind: ModelCredentialKind;
  provider: ModelCredentialProvider;
  status: "active" | "revoked";
  /**
   * sha256(secret).slice(0,8) — a DISPLAY-only "which key is this?" hint for
   * the dashboard. Not a leak vector (8 hex chars of a SHA-256, never the
   * value). Same trade `agent-token-v1` makes. On revoke the fingerprint is
   * preserved (metadata-for-audit) even though the ciphertext is blanked.
   */
  fingerprint: string;
  createdAt: string; // ISO 8601
  createdBy: string; // GitHub login (operator), like ByokEnvelope.updatedBy
  rotatedAt: string | null;
  expiresAt: string | null; // soft hint (Claude OAuth ~1yr, manual API keys = null)
  /**
   * Fetch-path control (MODEL_AUTH_DESIGN.md §3). true = backend MAY serve
   * the decrypted value to the hive (api_key, Claude OAuth string). false =
   * local-only (Codex device-auth refresh state) — never fetched. Stage 1
   * stores it; NOTHING reads it for delivery yet.
   */
  deliverable: boolean;
}

/**
 * Per-installation summary returned by `listModelCredentials` /
 * `getModelCredentialSummary`. EXCLUDES every crypto field — the ciphertext
 * is never returned for listing/metadata reads (we never decrypt for
 * listing). Mirrors `AgentTokenSummaryV1`.
 */
export interface ModelCredentialSummaryV1 {
  name: string;
  kind: ModelCredentialKind;
  provider: ModelCredentialProvider;
  status: "active" | "revoked";
  fingerprint: string;
  createdAt: string;
  createdBy: string;
  rotatedAt: string | null;
  expiresAt: string | null;
  deliverable: boolean;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class NameTakenError extends Error {
  constructor(installationId: string, name: string) {
    super(
      `Model credential '${name}' already exists for installation ${installationId}`,
    );
    this.name = "NameTakenError";
  }
}

export class LimitReachedError extends Error {
  constructor(installationId: string, limit: number) {
    super(
      `Installation ${installationId} is at the ${limit}-model-credential limit; revoke an unused credential before creating a new one`,
    );
    this.name = "LimitReachedError";
  }
}

export class ModelCredentialNotFoundError extends Error {
  constructor(installationId: string, name: string) {
    super(
      `No model credential named '${name}' for installation ${installationId}`,
    );
    this.name = "ModelCredentialNotFoundError";
  }
}

/**
 * Thrown for an unknown `kind` at write time. Distinct from the route-layer
 * error vocabulary so the storage layer stays HTTP-agnostic (the route maps
 * it to `invalid_kind`).
 */
export class InvalidKindError extends Error {
  public readonly value: unknown;
  constructor(value: unknown) {
    super(
      `Invalid model credential kind ${JSON.stringify(value)} — expected one of: ${MODEL_CREDENTIAL_KINDS.join(", ")}`,
    );
    this.name = "InvalidKindError";
    this.value = value;
  }
}

/**
 * Thrown when a mutation targets a revoked credential. Revoke is terminal:
 * a revoked credential cannot be rotated or otherwise resurrected (design §6
 * "mutating an already-revoked envelope fails closed", matching the agent-token
 * sibling's TokenExpiredForMutation). Route maps it to `revoked` / HTTP 409.
 */
export class RevokedCredentialError extends Error {
  constructor(installationId: string, name: string) {
    super(
      `Model credential '${name}' for installation ${installationId} is revoked and cannot be mutated`,
    );
    this.name = "RevokedCredentialError";
  }
}

/** Thrown for an unknown `provider` at write time (route maps to invalid_provider). */
export class InvalidProviderError extends Error {
  public readonly value: unknown;
  constructor(value: unknown) {
    super(
      `Invalid model credential provider ${JSON.stringify(value)} — expected one of: ${MODEL_CREDENTIAL_PROVIDERS.join(", ")}`,
    );
    this.name = "InvalidProviderError";
    this.value = value;
  }
}

// ---------------------------------------------------------------------------
// Lua scripts (no cjson / cmsgpack / bit / struct — Upstash sandbox safe)
// ---------------------------------------------------------------------------

/**
 * CREATE_CREDENTIAL_SCRIPT — atomic create. Mirrors `agent-token-v1.ts`'s
 * ISSUE_TOKEN_SCRIPT zcard cap guard so the per-installation cap is enforced
 * INSIDE the EVAL (closes the TOCTOU window between a client-side count and
 * the write). Audit emit happens in the same EVAL when ARGV[4] is non-empty.
 *
 * No reverse hash index (dropped per §1.1) and no envelope TTL (model
 * credentials are long-lived; `expiresAt` is a soft display hint only, not
 * a Redis-enforced lifecycle — distinct from agent-token's explicit-expiry
 * envelopes).
 *
 * KEYS: [envelopeKey, installationSortedSetKey, auditStreamKey]
 * ARGV: [name, envelopeJson, createdAtMs, auditEntryJsonOrEmpty, limit]
 *
 * Returns:
 *   {1, name}            success
 *   {0, "name_taken"}    name already exists for this installation
 *   {-1, "limit"}        installation already at `limit` names
 */
const CREATE_CREDENTIAL_SCRIPT = `
local existing = redis.call("get", KEYS[1])
if existing then return {0, "name_taken"} end
local count = redis.call("zcard", KEYS[2])
if count >= tonumber(ARGV[5]) then return {-1, "limit"} end
redis.call("set", KEYS[1], ARGV[2])
redis.call("zadd", KEYS[2], tonumber(ARGV[3]), ARGV[1])
if ARGV[4] ~= "" then
  redis.call("xadd", KEYS[3], "MAXLEN", "~", "${AUDIT_STREAM_MAXLEN}", "*", "entry", ARGV[4])
end
return {1, ARGV[1]}
`;

/**
 * UPDATE_CREDENTIAL_SCRIPT — atomic in-place envelope replace (+ optional
 * audit XADD). Used by rotate / revoke / re-encrypt: the caller has already
 * read the existing envelope under the lock, computed the new envelope JSON,
 * and built the audit entry. This script does the SET + audit XADD in one
 * EVAL so the mutation and its audit row land together. It does NOT recheck
 * existence — the caller's pre-read under the same lock is authoritative (the
 * lock serializes all mutations for this name).
 *
 * KEYS: [envelopeKey, auditStreamKey]
 * ARGV: [newEnvelopeJson, auditEntryJsonOrEmpty]
 *
 * Returns: {1}
 */
const UPDATE_CREDENTIAL_SCRIPT = `
redis.call("set", KEYS[1], ARGV[1])
if ARGV[2] ~= "" then
  redis.call("xadd", KEYS[2], "MAXLEN", "~", "${AUDIT_STREAM_MAXLEN}", "*", "entry", ARGV[2])
end
return {1}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * DISPLAY-only fingerprint: the first 8 hex chars of sha256(secret). Derived
 * from the SECRET VALUE (not a random token) so the dashboard can answer
 * "is this the same key I pasted?" without ever surfacing the value. 8 hex
 * chars of a SHA-256 is not a practical leak vector and can never equal the
 * value itself.
 */
function fingerprintSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

interface ScriptResult {
  ok: number;
  reason?: string;
}

/** Normalize the Lua `[tag, payload]` return (see agent-token-v1). */
function dispatchScriptResult(raw: unknown): ScriptResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `Lua script returned malformed result: ${JSON.stringify(raw)}`,
    );
  }
  const tag = Number(raw[0]);
  const payload = raw.length > 1 ? String(raw[1]) : undefined;
  return { ok: tag, reason: payload };
}

/**
 * Validate kind + provider server-side (MODEL_AUTH_DESIGN.md §1, §6.6).
 * Both are bound inside the GCM plaintext; rejecting unknown values here
 * keeps the stored set closed and fail-closed.
 */
function assertKind(kind: unknown): asserts kind is ModelCredentialKind {
  if (!isModelCredentialKind(kind)) {
    throw new InvalidKindError(kind);
  }
}

function assertProvider(
  provider: unknown,
): asserts provider is ModelCredentialProvider {
  if (!isModelCredentialProvider(provider)) {
    throw new InvalidProviderError(provider);
  }
}

function summarize(
  envelope: ModelCredentialEnvelopeV1,
): ModelCredentialSummaryV1 {
  return {
    name: envelope.name,
    kind: envelope.kind,
    provider: envelope.provider,
    status: envelope.status,
    fingerprint: envelope.fingerprint,
    createdAt: envelope.createdAt,
    createdBy: envelope.createdBy,
    rotatedAt: envelope.rotatedAt,
    expiresAt: envelope.expiresAt,
    deliverable: envelope.deliverable,
  };
}

/** Operator identity for the audit trail. */
export interface ModelCredentialAuditContext {
  operator: string; // GitHub login
}

function buildAuditEntry(args: {
  action: "create" | "rotate" | "revoke" | "re_encrypt";
  name: string;
  operator: string;
  detail?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    action: args.action,
    name: args.name,
    actor: args.operator,
    ...(args.detail ? { detail: args.detail } : {}),
  });
}

/** Run UPDATE_CREDENTIAL_SCRIPT (SET + optional audit XADD) in one EVAL. */
async function writeEnvelope(
  redis: Redis,
  installationId: string,
  name: string,
  envelope: ModelCredentialEnvelopeV1,
  auditEntry: string,
): Promise<void> {
  dispatchScriptResult(
    await redis.eval(
      UPDATE_CREDENTIAL_SCRIPT,
      [envelopeKey(installationId, name), auditStreamKey(installationId)],
      [JSON.stringify(envelope), auditEntry],
    ),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new model credential under `(installationId, name)`. Validates
 * name/kind/provider at write time (fail-closed), encrypts the
 * `{kind, provider, value}` payload, then atomically stores it under the
 * per-key lock with the Lua cap guard.
 *
 * `installationId` is supplied by the caller from the AUTHENTICATED
 * principal — never from request input. Every key embeds it, so a foreign
 * name resolves to a miss in the caller's namespace (no cross-tenant oracle).
 *
 * Throws:
 *   - `CapabilityValidationError` on bad name (reused NAME_REGEX validator)
 *   - `InvalidKindError` / `InvalidProviderError` on bad kind/provider
 *   - `NameTakenError` if `(installationId, name)` already exists
 *   - `LimitReachedError` if the installation is at the cap
 */
export async function createModelCredential(args: {
  installationId: string;
  name: string;
  kind: ModelCredentialKind;
  provider: ModelCredentialProvider;
  /** The raw secret: an api key string, or the OAuth token / device-auth blob. */
  value: string;
  createdBy: string;
  expiresAt?: string | null;
  deliverable: boolean;
  keyring: Map<string, Buffer>;
  keyVersion: string;
  redis: Redis;
  limit?: number;
  auditContext?: ModelCredentialAuditContext;
}): Promise<ModelCredentialSummaryV1> {
  assertValidCredentialName(args.name);
  assertKind(args.kind);
  assertProvider(args.provider);

  const limit = args.limit ?? MAX_MODEL_CREDENTIALS_PER_INSTALLATION;
  if (limit <= 0) {
    throw new Error(`limit must be positive (got ${limit})`);
  }

  const payload: ModelCredentialSecretPayload = {
    kind: args.kind,
    provider: args.provider,
    value: args.value,
  };
  const encrypted: EncryptedEnvelope = encrypt(
    JSON.stringify(payload),
    args.keyVersion,
    args.keyring,
  );

  const createdAtMs = Date.now();
  const createdAtIso = new Date(createdAtMs).toISOString();

  const envelope: ModelCredentialEnvelopeV1 = {
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    tag: encrypted.tag,
    keyVersion: encrypted.keyVersion,
    name: args.name,
    kind: args.kind,
    provider: args.provider,
    status: "active",
    fingerprint: fingerprintSecret(args.value),
    createdAt: createdAtIso,
    createdBy: args.createdBy,
    rotatedAt: null,
    expiresAt: args.expiresAt ?? null,
    deliverable: args.deliverable,
  };

  return await withRedisLock(
    lockKey(args.installationId, args.name),
    args.redis,
    async () => {
      const auditEntry = args.auditContext
        ? buildAuditEntry({
            action: "create",
            name: args.name,
            operator: args.auditContext.operator,
            detail: {
              kind: args.kind,
              provider: args.provider,
              fingerprint: envelope.fingerprint,
              deliverable: args.deliverable,
            },
          })
        : "";

      const result = dispatchScriptResult(
        await args.redis.eval(
          CREATE_CREDENTIAL_SCRIPT,
          [
            envelopeKey(args.installationId, args.name),
            installationIndexKey(args.installationId),
            auditStreamKey(args.installationId),
          ],
          [
            args.name,
            JSON.stringify(envelope),
            String(createdAtMs),
            auditEntry,
            String(limit),
          ],
        ),
      );

      if (result.ok === 0 && result.reason === "name_taken") {
        throw new NameTakenError(args.installationId, args.name);
      }
      if (result.ok === -1 && result.reason === "limit") {
        throw new LimitReachedError(args.installationId, limit);
      }
      if (result.ok !== 1) {
        throw new Error(
          `CREATE_CREDENTIAL_SCRIPT returned unexpected result: ${JSON.stringify(result)}`,
        );
      }
      return summarize(envelope);
    },
  );
}

/**
 * Read the FULL envelope (including crypto fields) by name. INTERNAL — for
 * lifecycle ops (rotate/re-encrypt) and the future Stage-3 delivery path.
 * Never expose its result over an HTTP read; use `getModelCredentialSummary`
 * for anything client-facing.
 *
 * Throws `ModelCredentialNotFoundError` (same 404 for "not yours" and
 * "doesn't exist" — the key embeds installationId, so there is no
 * cross-tenant existence oracle).
 */
export async function getModelCredential(args: {
  installationId: string;
  name: string;
  redis: Redis;
}): Promise<ModelCredentialEnvelopeV1> {
  // Validate the name before it becomes a Redis key segment — defense in depth,
  // matching every mutation path. A malformed name can't forge a key shape; it
  // surfaces as the same NotFound a missing name would (no existence oracle).
  assertValidCredentialName(args.name);
  const raw = await args.redis.get<ModelCredentialEnvelopeV1>(
    envelopeKey(args.installationId, args.name),
  );
  if (!raw) {
    throw new ModelCredentialNotFoundError(args.installationId, args.name);
  }
  return raw;
}

/**
 * Read a single credential SUMMARY by name. Excludes all crypto fields —
 * safe for client-facing GETs. Throws `ModelCredentialNotFoundError`.
 */
export async function getModelCredentialSummary(args: {
  installationId: string;
  name: string;
  redis: Redis;
}): Promise<ModelCredentialSummaryV1> {
  const raw = await getModelCredential(args);
  return summarize(raw);
}

/**
 * List credential summaries for an installation in creation order (by
 * `createdAt` epoch ms via the sorted-set score). Excludes encrypted
 * ciphertext.
 *
 * Self-healing: opportunistically prunes orphaned sorted-set entries whose
 * envelopes are gone (best-effort, mirrors `listAgentTokens`). Keeps the
 * listing accurate AND ensures the cap doesn't count ghosts.
 */
export async function listModelCredentials(args: {
  installationId: string;
  redis: Redis;
}): Promise<ModelCredentialSummaryV1[]> {
  const names = await args.redis.zrange<string[]>(
    installationIndexKey(args.installationId),
    0,
    -1,
  );
  if (names.length === 0) return [];

  const envelopes = await Promise.all(
    names.map((name) =>
      args.redis.get<ModelCredentialEnvelopeV1>(
        envelopeKey(args.installationId, name),
      ),
    ),
  );

  const out: ModelCredentialSummaryV1[] = [];
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
    await Promise.all(
      orphans.map((name) =>
        args.redis
          .zrem(installationIndexKey(args.installationId), name)
          .catch((err: unknown) => {
            console.warn(
              `[model-credential] failed to ZREM orphaned index entry ${args.installationId}:${name}`,
              err,
            );
          }),
      ),
    );
  }
  return out;
}

/**
 * Rotate a credential's secret VALUE in place (MODEL_AUTH_DESIGN.md §5.3 —
 * "new value, re-validate+re-encrypt"). Validation of the new value (live
 * provider probe for api_key) happens at the route layer BEFORE this call;
 * the store re-encrypts the new `{kind, provider, value}` payload, updates
 * the fingerprint + `rotatedAt`, and preserves all other metadata.
 *
 * `provider` and `kind` are NOT rotatable here — a credential's provider/kind
 * is fixed at create (changing it would be a new credential). Rotate only
 * swaps the secret value.
 *
 * Throws `ModelCredentialNotFoundError` if the name doesn't exist for this
 * installation (no cross-tenant oracle).
 */
export async function rotateModelCredential(args: {
  installationId: string;
  name: string;
  /** The new raw secret value (already provider-validated by the route). */
  value: string;
  rotatedBy: string;
  expiresAt?: string | null;
  keyring: Map<string, Buffer>;
  keyVersion: string;
  redis: Redis;
  auditContext?: ModelCredentialAuditContext;
}): Promise<ModelCredentialSummaryV1> {
  assertValidCredentialName(args.name);

  return await withRedisLock(
    lockKey(args.installationId, args.name),
    args.redis,
    async () => {
      const existing = await args.redis.get<ModelCredentialEnvelopeV1>(
        envelopeKey(args.installationId, args.name),
      );
      if (!existing) {
        throw new ModelCredentialNotFoundError(args.installationId, args.name);
      }
      // Revoke is terminal — fail closed on a revoked credential (design §6,
      // matching the agent-token sibling). To put a credential back in service
      // the operator creates a new one; rotate never resurrects a revoked record.
      if (existing.status === "revoked") {
        throw new RevokedCredentialError(args.installationId, args.name);
      }

      const payload: ModelCredentialSecretPayload = {
        kind: existing.kind,
        provider: existing.provider,
        value: args.value,
      };
      const encrypted = encrypt(
        JSON.stringify(payload),
        args.keyVersion,
        args.keyring,
      );

      const updated: ModelCredentialEnvelopeV1 = {
        ...existing,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        keyVersion: encrypted.keyVersion,
        // Status stays "active" (guaranteed above: a revoked record can't reach
        // here). Rotate replaces the secret of a live credential.
        status: "active",
        fingerprint: fingerprintSecret(args.value),
        rotatedAt: new Date().toISOString(),
        // expiresAt: refresh if the caller supplied one (e.g. a new Claude
        // OAuth token's ~1yr horizon); otherwise preserve the existing hint.
        expiresAt:
          args.expiresAt !== undefined ? args.expiresAt : existing.expiresAt,
      };

      const auditEntry = args.auditContext
        ? buildAuditEntry({
            action: "rotate",
            name: args.name,
            operator: args.auditContext.operator,
            detail: {
              fingerprint_old: existing.fingerprint,
              fingerprint_new: updated.fingerprint,
            },
          })
        : "";

      await writeEnvelope(
        args.redis,
        args.installationId,
        args.name,
        updated,
        auditEntry,
      );
      return summarize(updated);
    },
  );
}

/**
 * Revoke a credential (MODEL_AUTH_DESIGN.md §5.3 — "status→revoked + blank
 * ciphertext, keep metadata for audit"). Mirrors `byok/revoke` semantics:
 * the crypto fields are cleared so no key material can be recovered, but the
 * clear metadata (name, kind, provider, fingerprint, timestamps) is preserved
 * for the audit trail and the dashboard's revoked-credential row.
 *
 * Throws `ModelCredentialNotFoundError` if absent (no cross-tenant oracle).
 */
export async function revokeModelCredential(args: {
  installationId: string;
  name: string;
  revokedBy: string;
  redis: Redis;
  auditContext?: ModelCredentialAuditContext;
}): Promise<ModelCredentialSummaryV1> {
  assertValidCredentialName(args.name);

  return await withRedisLock(
    lockKey(args.installationId, args.name),
    args.redis,
    async () => {
      const existing = await args.redis.get<ModelCredentialEnvelopeV1>(
        envelopeKey(args.installationId, args.name),
      );
      if (!existing) {
        throw new ModelCredentialNotFoundError(args.installationId, args.name);
      }

      const revoked: ModelCredentialEnvelopeV1 = {
        ...existing,
        status: "revoked",
        // Blank all crypto fields — the secret is unrecoverable post-revoke.
        ciphertext: "",
        iv: "",
        tag: "",
        // keyVersion/fingerprint/kind/provider/timestamps preserved for audit.
      };

      const auditEntry = args.auditContext
        ? buildAuditEntry({
            action: "revoke",
            name: args.name,
            operator: args.auditContext.operator,
            detail: { fingerprint_revoked: existing.fingerprint },
          })
        : "";

      await writeEnvelope(
        args.redis,
        args.installationId,
        args.name,
        revoked,
        auditEntry,
      );
      return summarize(revoked);
    },
  );
}

/**
 * Re-encrypt a credential's envelope under the current active master key
 * version (MODEL_AUTH_DESIGN.md §5.3 — "master-key rebind"). Mirrors
 * `byok/re-encrypt`: decrypt with the old key, re-encrypt with the active
 * key, preserve everything else. Skips revoked envelopes (no ciphertext to
 * rebind) and already-current envelopes (idempotent).
 *
 * Returns the action taken so the route can report a useful summary.
 * Throws `ModelCredentialNotFoundError` if absent.
 */
export async function reEncryptModelCredential(args: {
  installationId: string;
  name: string;
  activeKeyVersion: string;
  keyring: Map<string, Buffer>;
  redis: Redis;
  auditContext?: ModelCredentialAuditContext;
}): Promise<{ action: "re_encrypted" | "skipped"; reason?: string }> {
  assertValidCredentialName(args.name);

  return await withRedisLock(
    lockKey(args.installationId, args.name),
    args.redis,
    async () => {
      const existing = await args.redis.get<ModelCredentialEnvelopeV1>(
        envelopeKey(args.installationId, args.name),
      );
      if (!existing) {
        throw new ModelCredentialNotFoundError(args.installationId, args.name);
      }

      if (existing.status === "revoked") {
        return { action: "skipped" as const, reason: "revoked" };
      }
      if (existing.keyVersion === args.activeKeyVersion) {
        return { action: "skipped" as const, reason: "already_current" };
      }

      const plaintext = decrypt(
        {
          ciphertext: existing.ciphertext,
          iv: existing.iv,
          tag: existing.tag,
          keyVersion: existing.keyVersion,
        },
        args.keyring,
      );
      const reEncrypted = encrypt(
        plaintext,
        args.activeKeyVersion,
        args.keyring,
      );

      const updated: ModelCredentialEnvelopeV1 = {
        ...existing,
        ciphertext: reEncrypted.ciphertext,
        iv: reEncrypted.iv,
        tag: reEncrypted.tag,
        keyVersion: reEncrypted.keyVersion,
      };

      const auditEntry = args.auditContext
        ? buildAuditEntry({
            action: "re_encrypt",
            name: args.name,
            operator: args.auditContext.operator,
            detail: {
              from_key_version: existing.keyVersion,
              to_key_version: args.activeKeyVersion,
            },
          })
        : "";

      await writeEnvelope(
        args.redis,
        args.installationId,
        args.name,
        updated,
        auditEntry,
      );
      return { action: "re_encrypted" as const };
    },
  );
}

/**
 * Decrypt + parse a credential's secret payload. INTERNAL — reserved for the
 * Stage-3 delivery path (and tests asserting the round-trip). NEVER call this
 * from a client-facing read.
 *
 * The parsed `kind`/`provider` come from the GCM-authenticated plaintext, so
 * they are tamper-evident (a Redis edit of the clear metadata can't change
 * what comes out here without breaking the auth tag).
 */
export function decryptModelCredentialPayload(
  envelope: ModelCredentialEnvelopeV1,
  keyring: Map<string, Buffer>,
): ModelCredentialSecretPayload {
  const plaintext = decrypt(
    {
      ciphertext: envelope.ciphertext,
      iv: envelope.iv,
      tag: envelope.tag,
      keyVersion: envelope.keyVersion,
    },
    keyring,
  );
  return JSON.parse(plaintext) as ModelCredentialSecretPayload;
}
