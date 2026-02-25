import { describe, it, expect, vi, beforeEach } from "vitest";
import { type Redis } from "@upstash/redis";
import {
  generateAgentToken,
  getAgentToken,
  revokeAgentToken,
  lookupInstallationByToken,
} from "./agent-token";
import { parseKeyring } from "./crypto";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_KEYRING_JSON = JSON.stringify({
  v1: "a".repeat(64),
});

const keyring = parseKeyring(TEST_KEYRING_JSON);
const KEY_VERSION = "v1";

// ---------------------------------------------------------------------------
// Minimal Redis mock — same pattern as byok-store.test.ts
// ---------------------------------------------------------------------------

function makeMockRedis() {
  const store = new Map<string, unknown>();

  const client = {
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (...keys: string[]) => {
      let deleted = 0;
      for (const k of keys) {
        if (store.has(k)) {
          store.delete(k);
          deleted++;
        }
      }
      return deleted;
    }),
    _store: store,
  };
  return client as unknown as Redis & { _store: Map<string, unknown> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateAgentToken", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("returns a 64-char hex token", async () => {
    const result = await generateAgentToken("inst-1", "admin", KEY_VERSION, keyring, redis);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fingerprint is the last 4 chars of the token", async () => {
    const result = await generateAgentToken("inst-1", "admin", KEY_VERSION, keyring, redis);
    expect(result.fingerprint).toBe(result.token.slice(-4));
    expect(result.fingerprint).toHaveLength(4);
  });

  it("stores an envelope at hive:agent-token:{installationId}", async () => {
    await generateAgentToken("inst-1", "admin", KEY_VERSION, keyring, redis);
    const stored = redis._store.get("hive:agent-token:inst-1") as Record<string, unknown>;
    expect(stored).toBeDefined();
    expect(typeof stored.ciphertext).toBe("string");
    expect(typeof stored.iv).toBe("string");
    expect(typeof stored.tag).toBe("string");
    expect(stored.keyVersion).toBe(KEY_VERSION);
    expect(stored.status).toBe("active");
    expect(typeof stored.updatedAt).toBe("string");
    expect(stored.updatedBy).toBe("admin");
    expect(typeof stored.fingerprint).toBe("string");
  });

  it("stores a hash index at agent-token-hash:{sha256}", async () => {
    const { token } = await generateAgentToken("inst-1", "admin", KEY_VERSION, keyring, redis);
    // Find the hash key in the store
    const hashKeys = [...redis._store.keys()].filter((k) =>
      k.startsWith("agent-token-hash:"),
    );
    expect(hashKeys).toHaveLength(1);
    const record = redis._store.get(hashKeys[0]) as { installationId: string };
    expect(record.installationId).toBe("inst-1");
    // Verify the hash matches
    const { createHash } = await import("crypto");
    const expectedHash = createHash("sha256").update(token, "utf8").digest("hex");
    expect(hashKeys[0]).toBe(`agent-token-hash:${expectedHash}`);
  });

  it("rotation: replaces old envelope, deletes old hash index", async () => {
    const { token: firstToken } = await generateAgentToken(
      "inst-1",
      "admin",
      KEY_VERSION,
      keyring,
      redis,
    );
    const { token: secondToken } = await generateAgentToken(
      "inst-1",
      "admin",
      KEY_VERSION,
      keyring,
      redis,
    );

    expect(firstToken).not.toBe(secondToken);

    // Only one hash index should exist (the new one)
    const hashKeys = [...redis._store.keys()].filter((k) =>
      k.startsWith("agent-token-hash:"),
    );
    expect(hashKeys).toHaveLength(1);

    // The new token should be resolvable
    const installationId = await lookupInstallationByToken(secondToken, redis);
    expect(installationId).toBe("inst-1");

    // The old token should no longer be resolvable
    const oldResult = await lookupInstallationByToken(firstToken, redis);
    expect(oldResult).toBeNull();
  });

  it("createdAt is an ISO 8601 string", async () => {
    const result = await generateAgentToken("inst-1", "admin", KEY_VERSION, keyring, redis);
    expect(() => new Date(result.createdAt)).not.toThrow();
    expect(new Date(result.createdAt).toISOString()).toBe(result.createdAt);
  });
});

describe("getAgentToken", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("returns null when no token exists", async () => {
    const result = await getAgentToken("inst-1", keyring, redis);
    expect(result).toBeNull();
  });

  it("decrypts and returns the original token", async () => {
    const { token: generated } = await generateAgentToken(
      "inst-1",
      "admin",
      KEY_VERSION,
      keyring,
      redis,
    );
    const result = await getAgentToken("inst-1", keyring, redis);
    expect(result).not.toBeNull();
    expect(result!.token).toBe(generated);
    expect(result!.fingerprint).toBe(generated.slice(-4));
  });

  it("returns null when envelope has invalid shape", async () => {
    redis._store.set("hive:agent-token:inst-bad", { broken: true });
    const result = await getAgentToken("inst-bad", keyring, redis);
    expect(result).toBeNull();
  });
});

describe("revokeAgentToken", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("returns false when no token exists", async () => {
    const result = await revokeAgentToken("inst-1", keyring, redis);
    expect(result).toBe(false);
  });

  it("deletes both envelope and hash index, returns true", async () => {
    const { token } = await generateAgentToken("inst-1", "admin", KEY_VERSION, keyring, redis);
    expect(redis._store.has("hive:agent-token:inst-1")).toBe(true);

    const result = await revokeAgentToken("inst-1", keyring, redis);
    expect(result).toBe(true);

    expect(redis._store.has("hive:agent-token:inst-1")).toBe(false);
    const hashKeys = [...redis._store.keys()].filter((k) =>
      k.startsWith("agent-token-hash:"),
    );
    expect(hashKeys).toHaveLength(0);

    // Token no longer resolvable
    const installationId = await lookupInstallationByToken(token, redis);
    expect(installationId).toBeNull();
  });
});

describe("lookupInstallationByToken", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("returns null for unknown token", async () => {
    const result = await lookupInstallationByToken("unknown-token", redis);
    expect(result).toBeNull();
  });

  it("resolves installationId for valid token", async () => {
    const { token } = await generateAgentToken("inst-42", "admin", KEY_VERSION, keyring, redis);
    const result = await lookupInstallationByToken(token, redis);
    expect(result).toBe("inst-42");
  });

  it("returns null after token is revoked", async () => {
    const { token } = await generateAgentToken("inst-42", "admin", KEY_VERSION, keyring, redis);
    await revokeAgentToken("inst-42", keyring, redis);
    const result = await lookupInstallationByToken(token, redis);
    expect(result).toBeNull();
  });
});
