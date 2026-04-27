/**
 * Agent token lifecycle management.
 *
 * Tokens are 64-char hex strings (32 random bytes). On creation the raw token
 * is encrypted with the BYOK keyring and stored at `hive:agent-token:{installationId}`.
 * A SHA-256 hash of the raw token is stored as a reverse index at
 * `agent-token-hash:{hash}` so incoming Bearer tokens can be resolved to an
 * installationId in O(1) without decrypting anything.
 *
 * Only one active token per installation. Creating a new token revokes the old one.
 */

import { randomBytes, createHash } from "crypto";
import { type Redis } from "@upstash/redis";
import { encrypt, decrypt, type EncryptedEnvelope } from "@/server/crypto";
import { withRedisLock } from "@/server/redis-lock";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = "hive:agent-token:";
const HASH_PREFIX = "agent-token-hash:";
const LOCK_PREFIX = "hive:agent-token-lock:";

// Atomic rotate: DEL old hash (if any), SET envelope, SET new hash index.
// KEYS: [oldHashKey, envelopeKey, newHashKey]
// ARGV: [deleteOld ("1"|"0"), envelopeJSON, hashRecordJSON]
const ROTATE_TOKEN_SCRIPT = `
if ARGV[1] == "1" then redis.call("del", KEYS[1]) end
redis.call("set", KEYS[2], ARGV[2])
redis.call("set", KEYS[3], ARGV[3])
return 1
`;

// Atomic revoke: DEL hash index and envelope together.
// KEYS: [hashKey, envelopeKey]
const REVOKE_TOKEN_SCRIPT = `
redis.call("del", KEYS[1])
redis.call("del", KEYS[2])
return 1
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-token authorization policy. Constrains what the token holder can
 * request from token-minting endpoints (currently:
 * `POST /api/github/installation-tokens`).
 *
 * V1.5 enforcement model (apiarist DESIGN.md §10 "V1 token-policy gap"):
 *
 *   (request scope) ⊆ (token policy) ⊆ (installation grant)
 *
 * The middle containment ⊆ is what `policy` provides. Without it (legacy
 * tokens, `policy: null`), the middle ⊆ collapses to identity and a leaked
 * agent token can mint for any repo covered by the installation grant.
 *
 * `allowed_repos` is the set of `owner/name` strings the token may request
 * tokens for. Empty array `[]` rejects all (intentional — distinct from
 * `null`/undefined which means legacy permissive). If the field is absent
 * on the envelope (legacy tokens created before V1.5), the mint endpoint
 * logs a warning and defers to the installation grant — this preserves
 * compatibility with existing tokens during the V1.5 migration window.
 *
 * `allowed_permissions` (V1.6, this revision) is per-token permission
 * narrowing on top of the V1.5 repo narrowing. When set, the mint
 * endpoint intersects these permissions with `V1_PERMISSIONS` (the
 * default scope hard-coded in `github-installation-token.ts`) before
 * passing to GitHub: the token can NARROW the default but never
 * EXCEED it. Permissions GitHub doesn't grant on the installation are
 * always rejected by GitHub regardless. Absence (`undefined`) = use
 * `V1_PERMISSIONS` unchanged (V1.5 behavior, no narrowing).
 */
export type GitHubPermissionLevel = "read" | "write" | "admin";

export interface AgentTokenPolicy {
  /** `owner/name` strings the token may request mints for. Empty array
   * = reject everything (intentional). Field absence on the envelope =
   * legacy permissive (defer to installation grant). */
  allowed_repos: string[];
  /** V1.6+: per-token permission narrowing. Map of GitHub App permission
   * name (e.g. "contents", "pull_requests", "issues", "metadata") to
   * the maximum level the token may request. Mint intersects with
   * `V1_PERMISSIONS` (lower level wins per `read < write < admin`).
   * Permissions named here that aren't in `V1_PERMISSIONS` are silently
   * dropped (a token cannot grant scope the default doesn't have).
   * Absence (`undefined`) = use `V1_PERMISSIONS` as-is. */
  allowed_permissions?: Record<string, GitHubPermissionLevel>;
}

export interface AgentTokenEnvelope {
  ciphertext: string; // base64
  iv: string; // base64
  tag: string; // base64
  keyVersion: string;
  tokenHash: string; // SHA-256 hex — for revoking the hash index on rotate
  fingerprint: string; // last 8 chars of token for display
  createdAt: string; // ISO 8601
  createdBy: string; // GitHub login
  expiresAt: string | null; // ISO 8601, null for legacy/no-expiry tokens
  /** V1.5+: per-token authorization policy. Absent on legacy tokens
   * (created pre-V1.5); set via `setAgentTokenPolicy`. Mint endpoint
   * treats absence as legacy-permissive (logged warning) and presence
   * as authoritative. */
  policy?: AgentTokenPolicy;
}

export interface AgentTokenHashRecord {
  installationId: string;
  expiresAt?: string | null;
}

export interface AgentTokenMeta {
  fingerprint: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
  hasToken: true;
}

export interface AgentTokenRecord {
  token: string;
  fingerprint: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
}

export class AgentTokenExpiredError extends Error {
  constructor() {
    super("Agent token expired");
    this.name = "AgentTokenExpiredError";
  }
}

// Re-exported so API route consumers can import from a single location.
export { LockTimeoutError } from "@/server/redis-lock";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function redisTokenKey(installationId: string): string {
  return `${TOKEN_PREFIX}${installationId}`;
}

function redisHashKey(hash: string): string {
  return `${HASH_PREFIX}${hash}`;
}

function redisLockKey(installationId: string): string {
  return `${LOCK_PREFIX}${installationId}`;
}

function assertTokenNotExpired(expiresAt: unknown): void {
  if (expiresAt == null) return;
  if (typeof expiresAt !== "string") throw new AgentTokenExpiredError();

  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new AgentTokenExpiredError();
  }
}

function withInstallationLock<T>(
  installationId: string,
  redis: Redis,
  fn: () => Promise<T>,
): Promise<T> {
  return withRedisLock(redisLockKey(installationId), redis, fn, {
    onReleaseError: (error) =>
      console.error("[agent-token] Failed to release installation lock", {
        installationId,
        error,
      }),
  });
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Generates a new agent token for an installation. If one already exists the
 * old hash index is cleaned up first (effectively a rotate).
 *
 * Returns the raw token. Admins can also recover the plaintext later
 * via getAgentToken(), which decrypts the stored envelope on demand.
 */
export async function generateAgentToken(
  installationId: string,
  createdBy: string,
  activeKeyVersion: string,
  keyring: Map<string, Buffer>,
  redis: Redis,
  expiresAt: string | null = null,
): Promise<string> {
  return withInstallationLock(installationId, redis, async () => {
    const existing = await redis.get<AgentTokenEnvelope>(redisTokenKey(installationId));
    const hasExisting = existing != null && typeof existing.tokenHash === "string";

    const rawToken = randomBytes(32).toString("hex");
    const hash = hashToken(rawToken);
    const encrypted = encrypt(rawToken, activeKeyVersion, keyring);

    const envelope: AgentTokenEnvelope = {
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      keyVersion: encrypted.keyVersion,
      tokenHash: hash,
      fingerprint: rawToken.slice(-8),
      createdAt: new Date().toISOString(),
      createdBy,
      expiresAt,
    };

    await redis.eval(
      ROTATE_TOKEN_SCRIPT,
      [
        // When no existing token, use envelope key as a no-op placeholder
        // (the DEL is guarded by ARGV[1]=="1" so this key is never deleted).
        hasExisting ? redisHashKey(existing!.tokenHash) : redisTokenKey(installationId),
        redisTokenKey(installationId),
        redisHashKey(hash),
      ],
      [
        hasExisting ? "1" : "0",
        JSON.stringify(envelope),
        JSON.stringify({ installationId, expiresAt }),
      ],
    );

    return rawToken;
  });
}

/**
 * Returns non-sensitive metadata about the stored token, or null.
 */
export async function getAgentTokenMeta(
  installationId: string,
  redis: Redis,
): Promise<AgentTokenMeta | null> {
  const envelope = await redis.get<AgentTokenEnvelope>(redisTokenKey(installationId));
  if (!envelope || typeof envelope.fingerprint !== "string") return null;

  return {
    fingerprint: envelope.fingerprint,
    createdAt: envelope.createdAt,
    createdBy: envelope.createdBy,
    expiresAt: envelope.expiresAt ?? null,
    hasToken: true,
  };
}

/**
 * Returns the current raw token and metadata for an installation, or null.
 * Used by admins to copy/recover the current token from encrypted storage.
 */
export async function getAgentToken(
  installationId: string,
  keyring: Map<string, Buffer>,
  redis: Redis,
): Promise<AgentTokenRecord | null> {
  const envelope = await redis.get<AgentTokenEnvelope>(redisTokenKey(installationId));
  if (
    !envelope ||
    typeof envelope.ciphertext !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.keyVersion !== "string" ||
    typeof envelope.fingerprint !== "string" ||
    typeof envelope.createdAt !== "string" ||
    typeof envelope.createdBy !== "string"
  ) {
    return null;
  }

  const encryptedEnvelope: EncryptedEnvelope = {
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
    tag: envelope.tag,
    keyVersion: envelope.keyVersion,
  };

  const token = decrypt(encryptedEnvelope, keyring);

  return {
    token,
    fingerprint: envelope.fingerprint,
    createdAt: envelope.createdAt,
    createdBy: envelope.createdBy,
    expiresAt: envelope.expiresAt ?? null,
  };
}

/**
 * Revokes (deletes) the agent token for an installation.
 * Removes both the encrypted envelope and the hash reverse index.
 */
export async function revokeAgentToken(
  installationId: string,
  redis: Redis,
): Promise<boolean> {
  return withInstallationLock(installationId, redis, async () => {
    const envelope = await redis.get<AgentTokenEnvelope>(redisTokenKey(installationId));
    if (!envelope || typeof envelope.tokenHash !== "string") return false;

    await redis.eval(
      REVOKE_TOKEN_SCRIPT,
      [redisHashKey(envelope.tokenHash), redisTokenKey(installationId)],
      [],
    );
    return true;
  });
}

/**
 * Re-encrypts the stored token with a new key version without changing
 * the raw token value. Used during master key rotation.
 */
export async function reEncryptAgentToken(
  installationId: string,
  newKeyVersion: string,
  keyring: Map<string, Buffer>,
  redis: Redis,
): Promise<boolean> {
  return withInstallationLock(installationId, redis, async () => {
    const envelope = await redis.get<AgentTokenEnvelope>(redisTokenKey(installationId));
    if (!envelope) return false;

    const encryptedEnvelope: EncryptedEnvelope = {
      ciphertext: envelope.ciphertext,
      iv: envelope.iv,
      tag: envelope.tag,
      keyVersion: envelope.keyVersion,
    };

    const rawToken = decrypt(encryptedEnvelope, keyring);
    const reEncrypted = encrypt(rawToken, newKeyVersion, keyring);

    const updated: AgentTokenEnvelope = {
      ...envelope,
      ciphertext: reEncrypted.ciphertext,
      iv: reEncrypted.iv,
      tag: reEncrypted.tag,
      keyVersion: reEncrypted.keyVersion,
    };

    await redis.set(redisTokenKey(installationId), updated);
    return true;
  });
}

/**
 * Resolves a raw Bearer token to an installationId via the hash index.
 * Returns null if the token is unknown.
 *
 * Note: returns ONLY the installationId — does NOT load the envelope or
 * policy. Existing callers (`/api/agent-health`, `/api/tasks/*`) only
 * need the installation id. Token-minting endpoints that need the policy
 * use `resolveTokenToInstallationAndPolicy` instead.
 */
export async function resolveTokenToInstallation(
  rawToken: string,
  redis: Redis,
): Promise<string | null> {
  const hash = hashToken(rawToken);
  const record = await redis.get<AgentTokenHashRecord>(redisHashKey(hash));
  if (!record || typeof record.installationId !== "string") return null;
  assertTokenNotExpired(record.expiresAt);
  return record.installationId;
}

/**
 * Resolves a Bearer token to its installationId AND the per-token policy
 * (if set). Used by token-minting endpoints that need to enforce the
 * `(request) ⊆ (token policy)` containment per `AgentTokenPolicy`.
 *
 * Two Redis reads (hash index → envelope) instead of one — slightly more
 * expensive than `resolveTokenToInstallation`. Use that helper when the
 * caller doesn't need the policy.
 *
 * Returns null if the token is unknown. Returns `policy: undefined` for
 * legacy tokens (created pre-V1.5, no policy field on the envelope) —
 * callers must distinguish legacy-permissive (`undefined`) from
 * empty-allow-list (`{ allowed_repos: [] }`, intentional reject-all).
 */
export async function resolveTokenToInstallationAndPolicy(
  rawToken: string,
  redis: Redis,
): Promise<{ installationId: string; policy: AgentTokenPolicy | undefined } | null> {
  const installationId = await resolveTokenToInstallation(rawToken, redis);
  if (installationId === null) return null;

  const envelope = await redis.get<AgentTokenEnvelope>(redisTokenKey(installationId));
  // Defensive: hash index exists but envelope doesn't. Should not happen
  // (atomic rotate keeps both in sync), but if it does treat as unknown
  // rather than fail-open with no policy.
  if (!envelope) return null;
  assertTokenNotExpired(envelope.expiresAt);

  return { installationId, policy: envelope.policy };
}

/**
 * Sets (or clears) the per-token policy on an existing agent token.
 * Operator-only; called from CLI script `web/scripts/set-agent-policy.ts`
 * or future dashboard UI. Holds the per-installation lock to serialize
 * with rotate/revoke.
 *
 * Pass `null` to clear the policy (revert to legacy-permissive).
 *
 * Returns true on success, false if no token exists for that installation.
 */
export async function setAgentTokenPolicy(
  installationId: string,
  policy: AgentTokenPolicy | null,
  redis: Redis,
): Promise<boolean> {
  return withInstallationLock(installationId, redis, async () => {
    const envelope = await redis.get<AgentTokenEnvelope>(redisTokenKey(installationId));
    if (!envelope) return false;

    const updated: AgentTokenEnvelope = { ...envelope };
    if (policy === null) {
      // Explicit clear: drop the field entirely so the envelope shape
      // matches a legacy token (vs storing `policy: null` which would be
      // ambiguous with "explicit reject all").
      delete updated.policy;
    } else {
      updated.policy = policy;
    }

    await redis.set(redisTokenKey(installationId), updated);
    return true;
  });
}
