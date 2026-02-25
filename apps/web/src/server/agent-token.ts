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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = "hive:agent-token:";
const HASH_PREFIX = "agent-token-hash:";

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

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Generates a new agent token for an installation. If one already exists the
 * old hash index is cleaned up first (effectively a rotate).
 *
 * Returns the raw token — this is the only time it's available in plaintext.
 */
export async function generateAgentToken(
  installationId: string,
  createdBy: string,
  activeKeyVersion: string,
  keyring: Map<string, Buffer>,
  redis: Redis,
): Promise<string> {
  // Remove old hash index if a token already exists
  const existing = await redis.get<AgentTokenEnvelope>(redisTokenKey(installationId));
  if (existing && typeof existing.tokenHash === "string") {
    await redis.del(redisHashKey(existing.tokenHash));
  }

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

  // Pipeline: store envelope + create hash reverse index
  await redis.set(redisTokenKey(installationId), envelope);
  await redis.set(redisHashKey(hash), { installationId });

  return rawToken;
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
 * Revokes (deletes) the agent token for an installation.
 * Removes both the encrypted envelope and the hash reverse index.
 */
export async function revokeAgentToken(
  installationId: string,
  redis: Redis,
): Promise<boolean> {
  const envelope = await redis.get<AgentTokenEnvelope>(redisTokenKey(installationId));
  if (!envelope || typeof envelope.tokenHash !== "string") return false;

  await redis.del(redisHashKey(envelope.tokenHash));
  await redis.del(redisTokenKey(installationId));
  return true;
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
