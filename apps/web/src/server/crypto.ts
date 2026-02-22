/**
 * AES-256-GCM envelope encryption with versioned keyring.
 *
 * Each encrypted envelope tags which master key version was used. This lets
 * old ciphertext survive master key rotation — the old key stays in the keyring
 * for decryption while new encryptions use the active version.
 */

import { randomBytes, createCipheriv, createDecipheriv } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // NIST-recommended for GCM
const TAG_BYTES = 16;
const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/i;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type ByokCryptoErrorCode = "byok_key_version_unavailable" | "byok_decrypt_failed";

export class ByokCryptoError extends Error {
  readonly code: ByokCryptoErrorCode;

  constructor(code: ByokCryptoErrorCode, message: string) {
    super(message);
    this.name = "ByokCryptoError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Keyring
// ---------------------------------------------------------------------------

/**
 * Parses and validates the JSON keyring string into a Map of version → Buffer.
 * Throws on invalid JSON, non-object shape, or malformed hex keys.
 */
export function parseKeyring(json: string): Map<string, Buffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Keyring JSON is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Keyring JSON must be a plain object");
  }

  const record = parsed as Record<string, unknown>;
  const keyring = new Map<string, Buffer>();

  for (const [version, value] of Object.entries(record)) {
    if (typeof value !== "string" || !HEX_KEY_PATTERN.test(value)) {
      throw new Error(`Keyring key "${version}" is not a valid 64-char hex string`);
    }
    keyring.set(version, Buffer.from(value, "hex"));
  }

  return keyring;
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt
// ---------------------------------------------------------------------------

export interface EncryptedEnvelope {
  ciphertext: string; // base64
  iv: string; // base64
  tag: string; // base64
  keyVersion: string;
}

/**
 * Encrypts plaintext using AES-256-GCM with the specified key version.
 * Returns all fields as base64 strings for safe JSON storage.
 */
export function encrypt(
  plaintext: string,
  keyVersion: string,
  keyring: Map<string, Buffer>,
): EncryptedEnvelope {
  const key = keyring.get(keyVersion);
  if (!key) {
    throw new ByokCryptoError(
      "byok_key_version_unavailable",
      `Key version "${keyVersion}" not found in keyring`,
    );
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    keyVersion,
  };
}

/**
 * Decrypts an AES-256-GCM envelope using the key version tagged in the envelope.
 * Throws ByokCryptoError on missing key version or tampered data.
 */
export function decrypt(
  envelope: EncryptedEnvelope,
  keyring: Map<string, Buffer>,
): string {
  const key = keyring.get(envelope.keyVersion);
  if (!key) {
    throw new ByokCryptoError(
      "byok_key_version_unavailable",
      `Key version "${envelope.keyVersion}" not found in keyring`,
    );
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(envelope.iv, "base64"),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);

    return decrypted.toString("utf8");
  } catch (err) {
    // Re-throw our own errors; wrap everything else as tamper detection
    if (err instanceof ByokCryptoError) throw err;
    throw new ByokCryptoError("byok_decrypt_failed", "Decryption failed — data may be tampered");
  }
}
