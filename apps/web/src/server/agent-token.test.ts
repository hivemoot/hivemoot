import { describe, it, expect, vi, beforeEach } from "vitest";
import { type Redis } from "@upstash/redis";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/server/crypto", () => ({
  encrypt: vi.fn(
    (plaintext: string) =>
      ({
        ciphertext: Buffer.from(plaintext).toString("base64"),
        iv: "mock-iv",
        tag: "mock-tag",
        keyVersion: "v1",
      }),
  ),
  decrypt: vi.fn(
    (envelope: { ciphertext: string }) =>
      Buffer.from(envelope.ciphertext, "base64").toString("utf8"),
  ),
}));

import {
  generateAgentToken,
  getAgentToken,
  getAgentTokenMeta,
  revokeAgentToken,
  reEncryptAgentToken,
  resolveTokenToInstallation,
} from "./agent-token";

// ---------------------------------------------------------------------------
// Minimal Redis mock
// ---------------------------------------------------------------------------

function makeMockRedis() {
  const store = new Map<string, unknown>();

  const client = {
    set: vi.fn(async (
      key: string,
      value: unknown,
      opts?: { nx?: boolean; xx?: boolean },
    ) => {
      if (opts?.nx && store.has(key)) return null;
      if (opts?.xx && !store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),
    eval: vi.fn(async (_script: string, keys: string[], args: string[]) => {
      // RELEASE_LOCK_SCRIPT: 1 key, 1 arg
      if (keys.length === 1 && args.length === 1) {
        const lockKey = keys[0];
        const expectedOwner = args[0];
        if (store.get(lockKey) === expectedOwner) {
          store.delete(lockKey);
          return 1;
        }
        return 0;
      }
      // ROTATE_TOKEN_SCRIPT: 3 keys, 3 args
      if (keys.length === 3 && args.length === 3) {
        if (args[0] === "1") store.delete(keys[0]);
        store.set(keys[1], JSON.parse(args[1]));
        store.set(keys[2], JSON.parse(args[2]));
        return 1;
      }
      // REVOKE_TOKEN_SCRIPT: 2 keys, 0 args
      if (keys.length === 2 && args.length === 0) {
        store.delete(keys[0]);
        store.delete(keys[1]);
        return 1;
      }
      return 0;
    }),
    _store: store,
  };
  return client as unknown as Redis & { _store: Map<string, unknown> };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_KEYRING = new Map([["v1", Buffer.alloc(32)]]);

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateAgentToken", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeMockRedis();
  });

  it("returns a 64-char hex token", async () => {
    const token = await generateAgentToken("inst-1", "alice", "v1", MOCK_KEYRING, redis);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores the encrypted envelope at the correct Redis key", async () => {
    await generateAgentToken("inst-1", "alice", "v1", MOCK_KEYRING, redis);
    expect(redis._store.has("hive:agent-token:inst-1")).toBe(true);
  });

  it("stores a hash reverse index", async () => {
    const token = await generateAgentToken("inst-1", "alice", "v1", MOCK_KEYRING, redis);
    const hash = hashToken(token);
    const record = redis._store.get(`agent-token-hash:${hash}`) as { installationId: string };
    expect(record.installationId).toBe("inst-1");
  });

  it("sets createdBy and fingerprint in the envelope", async () => {
    const token = await generateAgentToken("inst-1", "alice", "v1", MOCK_KEYRING, redis);
    const envelope = redis._store.get("hive:agent-token:inst-1") as Record<string, unknown>;
    expect(envelope.createdBy).toBe("alice");
    expect(envelope.fingerprint).toBe(token.slice(-8));
  });

  it("removes old hash index when generating a new token for the same installation", async () => {
    const token1 = await generateAgentToken("inst-1", "alice", "v1", MOCK_KEYRING, redis);
    const hash1 = hashToken(token1);
    expect(redis._store.has(`agent-token-hash:${hash1}`)).toBe(true);

    const token2 = await generateAgentToken("inst-1", "alice", "v1", MOCK_KEYRING, redis);
    const hash2 = hashToken(token2);

    // Old hash removed, new hash present
    expect(redis._store.has(`agent-token-hash:${hash1}`)).toBe(false);
    expect(redis._store.has(`agent-token-hash:${hash2}`)).toBe(true);
  });

  it("leaves original token intact when rotate script fails (no partial write)", async () => {
    const token1 = await generateAgentToken("inst-1", "alice", "v1", MOCK_KEYRING, redis);
    const hash1 = hashToken(token1);

    (redis.eval as ReturnType<typeof vi.fn>).mockImplementation(
      async (_s: string, keys: string[], args: string[]) => {
        // Keep lock-release working (1 key, 1 arg)
        if (keys.length === 1 && args.length === 1) {
          if (redis._store.get(keys[0]) === args[0]) {
            redis._store.delete(keys[0]);
            return 1;
          }
          return 0;
        }
        throw new Error("simulated Redis write failure");
      },
    );

    await expect(
      generateAgentToken("inst-1", "alice", "v1", MOCK_KEYRING, redis),
    ).rejects.toThrow();

    // Original token and hash index must still be intact
    const hashKeys = [...redis._store.keys()].filter((k) =>
      k.startsWith("agent-token-hash:"),
    );
    expect(hashKeys).toHaveLength(1);
    expect(redis._store.has(`agent-token-hash:${hash1}`)).toBe(true);

    const current = await getAgentToken("inst-1", MOCK_KEYRING, redis);
    expect(current!.token).toBe(token1);
  });

  it("keeps exactly one valid token after concurrent rotations", async () => {
    const tokens = await Promise.all(
      Array.from({ length: 12 }, () =>
        generateAgentToken("inst-1", "alice", "v1", MOCK_KEYRING, redis),
      ),
    );

    const hashKeys = [...redis._store.keys()].filter((k) => k.startsWith("agent-token-hash:"));
    expect(hashKeys).toHaveLength(1);

    const current = await getAgentToken("inst-1", MOCK_KEYRING, redis);
    expect(current).not.toBeNull();

    for (const token of tokens) {
      const resolved = await resolveTokenToInstallation(token, redis);
      if (token === current!.token) {
        expect(resolved).toBe("inst-1");
      } else {
        expect(resolved).toBeNull();
      }
    }
  });
});

describe("getAgentTokenMeta", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeMockRedis();
  });

  it("returns null when no token exists", async () => {
    const meta = await getAgentTokenMeta("unknown", redis);
    expect(meta).toBeNull();
  });

  it("returns non-sensitive metadata for an existing token", async () => {
    const token = await generateAgentToken("inst-1", "alice", "v1", MOCK_KEYRING, redis);
    const meta = await getAgentTokenMeta("inst-1", redis);

    expect(meta).not.toBeNull();
    expect(meta!.fingerprint).toBe(token.slice(-8));
    expect(meta!.createdBy).toBe("alice");
    expect(meta!.hasToken).toBe(true);
    expect(meta!.createdAt).toBeDefined();
  });

  it("does not expose ciphertext or token hash", async () => {
    await generateAgentToken("inst-1", "alice", "v1", MOCK_KEYRING, redis);
    const meta = await getAgentTokenMeta("inst-1", redis);

    const metaStr = JSON.stringify(meta);
    expect(metaStr).not.toContain("ciphertext");
    expect(metaStr).not.toContain("tokenHash");
  });
});

describe("getAgentToken", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeMockRedis();
  });

  it("returns null when no token exists", async () => {
    const record = await getAgentToken("unknown", MOCK_KEYRING, redis);
    expect(record).toBeNull();
  });

  it("decrypts and returns the current token with metadata", async () => {
    const token = await generateAgentToken("inst-1", "alice", "v1", MOCK_KEYRING, redis);
    const record = await getAgentToken("inst-1", MOCK_KEYRING, redis);

    expect(record).not.toBeNull();
    expect(record!.token).toBe(token);
    expect(record!.fingerprint).toBe(token.slice(-8));
    expect(record!.createdBy).toBe("alice");
    expect(record!.createdAt).toBeDefined();
  });
});

describe("revokeAgentToken", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeMockRedis();
  });

  it("returns false when no token exists", async () => {
    const result = await revokeAgentToken("unknown", redis);
    expect(result).toBe(false);
  });

  it("removes both envelope and hash index", async () => {
    const token = await generateAgentToken("inst-1", "alice", "v1", MOCK_KEYRING, redis);
    const hash = hashToken(token);

    const result = await revokeAgentToken("inst-1", redis);
    expect(result).toBe(true);
    expect(redis._store.has("hive:agent-token:inst-1")).toBe(false);
    expect(redis._store.has(`agent-token-hash:${hash}`)).toBe(false);
  });

  it("leaves token intact when revoke script fails (no partial write)", async () => {
    const token = await generateAgentToken("inst-1", "alice", "v1", MOCK_KEYRING, redis);
    const hash = hashToken(token);

    (redis.eval as ReturnType<typeof vi.fn>).mockImplementation(
      async (_s: string, keys: string[], args: string[]) => {
        // Keep lock-release working (1 key, 1 arg)
        if (keys.length === 1 && args.length === 1) {
          if (redis._store.get(keys[0]) === args[0]) {
            redis._store.delete(keys[0]);
            return 1;
          }
          return 0;
        }
        throw new Error("simulated Redis write failure");
      },
    );

    await expect(revokeAgentToken("inst-1", redis)).rejects.toThrow();

    // Both envelope and hash index must still be intact
    expect(redis._store.has("hive:agent-token:inst-1")).toBe(true);
    expect(redis._store.has(`agent-token-hash:${hash}`)).toBe(true);
    const resolved = await resolveTokenToInstallation(token, redis);
    expect(resolved).toBe("inst-1");
  });

  it("token cannot be resolved after revocation", async () => {
    const token = await generateAgentToken("inst-1", "alice", "v1", MOCK_KEYRING, redis);
    await revokeAgentToken("inst-1", redis);

    const resolved = await resolveTokenToInstallation(token, redis);
    expect(resolved).toBeNull();
  });
});

describe("reEncryptAgentToken", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeMockRedis();
  });

  it("returns false when no token exists", async () => {
    const result = await reEncryptAgentToken("unknown", "v2", MOCK_KEYRING, redis);
    expect(result).toBe(false);
  });

  it("re-encrypts without changing the hash index", async () => {
    const token = await generateAgentToken("inst-1", "alice", "v1", MOCK_KEYRING, redis);
    const hash = hashToken(token);

    const keyring = new Map([
      ["v1", Buffer.alloc(32)],
      ["v2", Buffer.alloc(32)],
    ]);
    const result = await reEncryptAgentToken("inst-1", "v2", keyring, redis);
    expect(result).toBe(true);

    // Hash index unchanged
    expect(redis._store.has(`agent-token-hash:${hash}`)).toBe(true);

    // Fingerprint preserved
    const meta = await getAgentTokenMeta("inst-1", redis);
    expect(meta!.fingerprint).toBe(token.slice(-8));
  });
});

describe("resolveTokenToInstallation", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeMockRedis();
  });

  it("returns null for unknown tokens", async () => {
    const result = await resolveTokenToInstallation("deadbeef".repeat(8), redis);
    expect(result).toBeNull();
  });

  it("resolves a valid token to its installationId", async () => {
    const token = await generateAgentToken("inst-42", "bob", "v1", MOCK_KEYRING, redis);
    const resolved = await resolveTokenToInstallation(token, redis);
    expect(resolved).toBe("inst-42");
  });
});
