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
import { withRedisLock, LockTimeoutError } from "@/server/redis-lock";

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

export interface AgentTokenEnvelope {
  ciphertext: string; // base64
  iv: string; // base64
  tag: string; // base64
  keyVersion: string;
  tokenHash: string; // SHA-256 hex — for revoking the hash index on rotate
  fingerprint: string; // last 8 chars of token for display
  createdAt: string; // ISO 8601
  createdBy: string; // GitHub login
}

export interface AgentTokenMeta {
  fingerprint: string;
  createdAt: string;
  createdBy: string;
  hasToken: true;
}

export interface AgentTokenRecord {
  token: string;
  fingerprint: string;
  createdAt: string;
  createdBy: string;
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
        JSON.stringify({ installationId }),
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
 */
export async function resolveTokenToInstallation(
  rawToken: string,
  redis: Redis,
): Promise<string | null> {
  const hash = hashToken(rawToken);
  const record = await redis.get<{ installationId: string }>(redisHashKey(hash));
  if (!record || typeof record.installationId !== "string") return null;
  return record.installationId;
}
