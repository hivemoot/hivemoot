/**
 * Redis-backed BYOK envelope storage.
 *
 * Each installation gets one encrypted envelope at `hive:byok:{installationId}`.
 * The envelope holds the provider's API key in encrypted form plus non-sensitive
 * metadata (provider name, model, last-4 fingerprint, status).
 */

import type Redis from "ioredis";

const KEY_PREFIX = "hive:byok:";

export interface ByokEnvelope {
  provider: string;
  model: string;
  ciphertext: string; // base64
  iv: string; // base64
  tag: string; // base64 GCM auth tag
  keyVersion: string;
  status: "active" | "revoked";
  updatedAt: string; // ISO 8601
  updatedBy: string; // GitHub login
  fingerprintLast4: string;
}

/**
 * Retrieves the BYOK envelope for an installation, or null if none exists.
 */
export async function getByokEnvelope(
  installationId: string,
  redis: Redis,
): Promise<ByokEnvelope | null> {
  const raw = await redis.get(`${KEY_PREFIX}${installationId}`);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as ByokEnvelope;
  } catch {
    return null;
  }
}

/**
 * Stores (creates or overwrites) the BYOK envelope for an installation.
 */
export async function setByokEnvelope(
  installationId: string,
  envelope: ByokEnvelope,
  redis: Redis,
): Promise<void> {
  await redis.set(`${KEY_PREFIX}${installationId}`, JSON.stringify(envelope));
}

/**
 * Lists all installation IDs that have a BYOK envelope.
 * Uses SCAN to avoid blocking Redis on large datasets.
 */
export async function listByokInstallationIds(redis: Redis): Promise<string[]> {
  const ids: string[] = [];
  let cursor = "0";

  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `${KEY_PREFIX}*`, "COUNT", 100);
    cursor = nextCursor;
    for (const key of keys) {
      ids.push(key.slice(KEY_PREFIX.length));
    }
  } while (cursor !== "0");

  return ids;
}
