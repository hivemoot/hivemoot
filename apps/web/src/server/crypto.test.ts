import { describe, it, expect } from "vitest";
import { parseKeyring, encrypt, decrypt, ByokCryptoError } from "./crypto";
import type { EncryptedEnvelope } from "./crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEY_V1 = "a".repeat(64);
const KEY_V2 = "b".repeat(64);

function makeKeyring(keys: Record<string, string> = { v1: KEY_V1 }) {
  return parseKeyring(JSON.stringify(keys));
}

// ---------------------------------------------------------------------------
// parseKeyring
// ---------------------------------------------------------------------------

describe("parseKeyring", () => {
  it("parses a valid single-key keyring", () => {
    const keyring = makeKeyring();
    expect(keyring.size).toBe(1);
    expect(keyring.get("v1")).toBeInstanceOf(Buffer);
    expect(keyring.get("v1")!.length).toBe(32); // 64 hex chars = 32 bytes
  });

  it("parses a multi-key keyring", () => {
    const keyring = makeKeyring({ v1: KEY_V1, v2: KEY_V2 });
    expect(keyring.size).toBe(2);
    expect(keyring.has("v1")).toBe(true);
    expect(keyring.has("v2")).toBe(true);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseKeyring("not-json")).toThrow("not valid JSON");
  });

  it("throws on non-object JSON", () => {
    expect(() => parseKeyring("[]")).toThrow("plain object");
    expect(() => parseKeyring('"string"')).toThrow("plain object");
  });

  it("throws on non-hex key values", () => {
    expect(() => parseKeyring(JSON.stringify({ v1: "short" }))).toThrow("64-char hex");
  });

  it("throws on wrong-length hex keys", () => {
    expect(() => parseKeyring(JSON.stringify({ v1: "ab".repeat(16) }))).toThrow("64-char hex");
  });
});

// ---------------------------------------------------------------------------
// encrypt / decrypt round-trip
// ---------------------------------------------------------------------------

describe("encrypt + decrypt", () => {
  it("round-trips a normal string", () => {
    const keyring = makeKeyring();
    const envelope = encrypt("sk-ant-test-key-123", "v1", keyring);
    const result = decrypt(envelope, keyring);
    expect(result).toBe("sk-ant-test-key-123");
  });

  it("round-trips an empty string", () => {
    const keyring = makeKeyring();
    const envelope = encrypt("", "v1", keyring);
    const result = decrypt(envelope, keyring);
    expect(result).toBe("");
  });

  it("round-trips a long string", () => {
    const keyring = makeKeyring();
    const longKey = "x".repeat(10_000);
    const envelope = encrypt(longKey, "v1", keyring);
    const result = decrypt(envelope, keyring);
    expect(result).toBe(longKey);
  });

  it("round-trips unicode content", () => {
    const keyring = makeKeyring();
    const envelope = encrypt("hivemoot resume", "v1", keyring);
    expect(decrypt(envelope, keyring)).toBe("hivemoot resume");
  });

  it("produces base64 output fields", () => {
    const keyring = makeKeyring();
    const envelope = encrypt("test", "v1", keyring);
    const base64Pattern = /^[A-Za-z0-9+/]+=*$/;
    expect(envelope.ciphertext).toMatch(base64Pattern);
    expect(envelope.iv).toMatch(base64Pattern);
    expect(envelope.tag).toMatch(base64Pattern);
    expect(envelope.keyVersion).toBe("v1");
  });

  it("generates unique IVs per encryption (non-deterministic)", () => {
    const keyring = makeKeyring();
    const a = encrypt("same-plaintext", "v1", keyring);
    const b = encrypt("same-plaintext", "v1", keyring);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("decrypts with the correct key version from a multi-key keyring", () => {
    const keyring = makeKeyring({ v1: KEY_V1, v2: KEY_V2 });
    const envelope = encrypt("secret", "v2", keyring);
    expect(envelope.keyVersion).toBe("v2");
    expect(decrypt(envelope, keyring)).toBe("secret");
  });
});

// ---------------------------------------------------------------------------
// Tamper detection
// ---------------------------------------------------------------------------

describe("tamper detection", () => {
  function flipByte(base64: string): string {
    const buf = Buffer.from(base64, "base64");
    buf[0] ^= 0xff;
    return buf.toString("base64");
  }

  it("rejects tampered ciphertext", () => {
    const keyring = makeKeyring();
    const envelope = encrypt("secret", "v1", keyring);
    const tampered: EncryptedEnvelope = { ...envelope, ciphertext: flipByte(envelope.ciphertext) };

    expect(() => decrypt(tampered, keyring)).toThrow(ByokCryptoError);
    try {
      decrypt(tampered, keyring);
    } catch (err) {
      expect((err as ByokCryptoError).code).toBe("byok_decrypt_failed");
    }
  });

  it("rejects tampered IV", () => {
    const keyring = makeKeyring();
    const envelope = encrypt("secret", "v1", keyring);
    const tampered: EncryptedEnvelope = { ...envelope, iv: flipByte(envelope.iv) };

    expect(() => decrypt(tampered, keyring)).toThrow(ByokCryptoError);
    try {
      decrypt(tampered, keyring);
    } catch (err) {
      expect((err as ByokCryptoError).code).toBe("byok_decrypt_failed");
    }
  });

  it("rejects tampered auth tag", () => {
    const keyring = makeKeyring();
    const envelope = encrypt("secret", "v1", keyring);
    const tampered: EncryptedEnvelope = { ...envelope, tag: flipByte(envelope.tag) };

    expect(() => decrypt(tampered, keyring)).toThrow(ByokCryptoError);
    try {
      decrypt(tampered, keyring);
    } catch (err) {
      expect((err as ByokCryptoError).code).toBe("byok_decrypt_failed");
    }
  });
});

// ---------------------------------------------------------------------------
// Key version errors
// ---------------------------------------------------------------------------

describe("key version errors", () => {
  it("throws byok_key_version_unavailable on encrypt with unknown version", () => {
    const keyring = makeKeyring();
    expect(() => encrypt("test", "v99", keyring)).toThrow(ByokCryptoError);
    try {
      encrypt("test", "v99", keyring);
    } catch (err) {
      expect((err as ByokCryptoError).code).toBe("byok_key_version_unavailable");
    }
  });

  it("throws byok_key_version_unavailable on decrypt with unknown version", () => {
    const keyring = makeKeyring();
    const envelope = encrypt("test", "v1", keyring);

    // Remove v1 from a new keyring to simulate rotation where old key is dropped
    const smallKeyring = makeKeyring({ v2: KEY_V2 });

    expect(() => decrypt(envelope, smallKeyring)).toThrow(ByokCryptoError);
    try {
      decrypt(envelope, smallKeyring);
    } catch (err) {
      expect((err as ByokCryptoError).code).toBe("byok_key_version_unavailable");
    }
  });
});
