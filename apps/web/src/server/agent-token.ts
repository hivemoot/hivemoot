/**
 * Agent-token storage and lifecycle management.
 *
 * Each installation gets one agent-token: a 64-char hex random credential
 * that agents use to authenticate with the hivemoot server (health API and
 * future endpoints). The token is stored as an AES-256-GCM encrypted envelope
 * in Redis, mirroring the BYOK envelope pattern.
 *
 * Two Redis keys per token:
 *   hive:agent-token:{installationId}  — encrypted envelope + metadata
 *   agent-token-hash:{sha256hex}       — reverse index: hash → installationId
 *
 * The hash index enables O(1) Bearer token auth lookup without storing the
 * raw token in Redis.
 */

import { randomBytes, createHash } from "crypto";
import { type Redis } from "@upstash/redis";
import { encrypt, decrypt, type EncryptedEnvelope } from "@/server/crypto";

const ENVELOPE_KEY_PREFIX = "hive:agent-token:";
const HASH_INDEX_KEY_PREFIX = "agent-token-hash:";

const TOKEN_BYTES = 32; // 64-char hex output

export interface AgentTokenEnvelope {
  ciphertext: string; // base64 — encrypted raw token
  iv: string; // base64
  tag: string; // base64 GCM auth tag
  keyVersion: string;
  status: "active" | "revoked";
  updatedAt: string; // ISO 8601
  updatedBy: string; // GitHub login of the admin who generated/rotated
  fingerprint: string; // last 4 chars of raw token, for identification
}

function isAgentTokenStatus(value: unknown): value is AgentTokenEnvelope["status"] {
  return value === "active" || value === "revoked";
}

function normalizeEnvelope(
  installationId: string,
  raw: Partial<AgentTokenEnvelope>,
): AgentTokenEnvelope | null {
  if (
    typeof raw.ciphertext !== "string" ||
    typeof raw.iv !== "string" ||
    typeof raw.tag !== "string" ||
    typeof raw.keyVersion !== "string" ||
    !isAgentTokenStatus(raw.status) ||
    typeof raw.updatedAt !== "string" ||
    typeof raw.updatedBy !== "string" ||
    typeof raw.fingerprint !== "string"
  ) {
    console.warn("Invalid agent-token envelope shape in Redis", { installationId });
    return null;
  }

  return {
    ciphertext: raw.ciphertext,
    iv: raw.iv,
    tag: raw.tag,
    keyVersion: raw.keyVersion,
    status: raw.status,
    updatedAt: raw.updatedAt,
    updatedBy: raw.updatedBy,
    fingerprint: raw.fingerprint,
  };
}

function tokenHash(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * Generates a new agent-token, encrypts it, and stores the envelope +
 * hash index. If a token already exists, the old hash index is deleted
 * before the new one is created (rotation).
 *
 * Returns the raw (plaintext) token — caller should present it to the user
 * exactly once; it is not stored in plaintext anywhere.
 */
export async function generateAgentToken(
  installationId: string,
  userLogin: string,
  keyVersion: string,
  keyring: Map<string, Buffer>,
  redis: Redis,
): Promise<{ token: string; fingerprint: string; createdAt: string }> {
  // Rotate: delete old hash index before replacing
  const existingEnvelope = await getAgentTokenEnvelope(installationId, redis);
  if (existingEnvelope) {
    const oldToken = decrypt(existingEnvelope, keyring);
    const oldHash = tokenHash(oldToken);
    await redis.del(`${HASH_INDEX_KEY_PREFIX}${oldHash}`);
  }

  const rawToken = randomBytes(TOKEN_BYTES).toString("hex");
  const fingerprint = rawToken.slice(-4);
  const createdAt = new Date().toISOString();

  const encrypted: EncryptedEnvelope = encrypt(rawToken, keyVersion, keyring);

  const envelope: AgentTokenEnvelope = {
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    tag: encrypted.tag,
    keyVersion: encrypted.keyVersion,
    status: "active",
    updatedAt: createdAt,
    updatedBy: userLogin,
    fingerprint,
  };

  const hash = tokenHash(rawToken);

  // Pipeline: set envelope + hash index atomically-ish
  // (Upstash REST does not expose MULTI/EXEC; sequential writes are acceptable
  // here — worst case a crash between the two leaves a stale envelope with no
  // hash index, which means the token is silently unusable until next rotation)
  await redis.set(`${ENVELOPE_KEY_PREFIX}${installationId}`, envelope);
  await redis.set(`${HASH_INDEX_KEY_PREFIX}${hash}`, { installationId });

  return { token: rawToken, fingerprint, createdAt };
}

/**
 * Returns the decrypted raw token for an installation, or null if none exists.
 */
export async function getAgentToken(
  installationId: string,
  keyring: Map<string, Buffer>,
  redis: Redis,
): Promise<{ token: string; fingerprint: string; createdAt: string } | null> {
  const envelope = await getAgentTokenEnvelope(installationId, redis);
  if (!envelope) return null;

  const token = decrypt(envelope, keyring);
  return { token, fingerprint: envelope.fingerprint, createdAt: envelope.updatedAt };
}

/**
 * Revokes the agent-token for an installation by deleting both the envelope
 * and the hash index. Returns true if a token existed and was deleted,
 * false if none existed.
 */
export async function revokeAgentToken(
  installationId: string,
  keyring: Map<string, Buffer>,
  redis: Redis,
): Promise<boolean> {
  const envelope = await getAgentTokenEnvelope(installationId, redis);
  if (!envelope) return false;

  const token = decrypt(envelope, keyring);
  const hash = tokenHash(token);

  await redis.del(`${HASH_INDEX_KEY_PREFIX}${hash}`);
  await redis.del(`${ENVELOPE_KEY_PREFIX}${installationId}`);

  return true;
}

/**
 * Looks up an installationId by Bearer token hash.
 * Used by the health POST endpoint to authenticate incoming agent requests.
 * Returns null if the token is unknown or revoked.
 */
export async function lookupInstallationByToken(
  rawToken: string,
  redis: Redis,
): Promise<string | null> {
  const hash = tokenHash(rawToken);
  const record = await redis.get<{ installationId: string }>(`${HASH_INDEX_KEY_PREFIX}${hash}`);
  if (!record || typeof record.installationId !== "string") return null;
  return record.installationId;
}

// Internal helper — reads and normalizes the envelope from Redis
async function getAgentTokenEnvelope(
  installationId: string,
  redis: Redis,
): Promise<AgentTokenEnvelope | null> {
  const raw = await redis.get<Partial<AgentTokenEnvelope>>(
    `${ENVELOPE_KEY_PREFIX}${installationId}`,
  );
  if (!raw) return null;
  return normalizeEnvelope(installationId, raw);
}
