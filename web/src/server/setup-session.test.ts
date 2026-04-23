import { describe, it, expect, vi } from "vitest";
import { type Redis } from "@upstash/redis";

// ---------------------------------------------------------------------------
// Minimal Redis mock — mirrors @upstash/redis auto-deserialization behavior:
// values are stored and returned as-is (the SDK handles JSON internally).
// ---------------------------------------------------------------------------
function makeMockRedis() {
  const store = new Map<string, unknown>();
  const expiryMs = new Map<string, number>();

  const client = {
    set: vi.fn(async (key: string, value: unknown, opts?: { ex?: number }) => {
      store.set(key, value);
      if (opts?.ex) expiryMs.set(key, Date.now() + opts.ex * 1000);
      return "OK";
    }),
    get: vi.fn(async (key: string) => {
      const exp = expiryMs.get(key);
      if (exp && Date.now() > exp) {
        store.delete(key);
        expiryMs.delete(key);
        return null;
      }
      return store.get(key) ?? null;
    }),
    del: vi.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      expiryMs.delete(key);
      return existed ? 1 : 0;
    }),
    getdel: vi.fn(async (key: string) => {
      const exp = expiryMs.get(key);
      if (exp && Date.now() > exp) {
        store.delete(key);
        expiryMs.delete(key);
        return null;
      }
      const value = store.get(key) ?? null;
      store.delete(key);
      expiryMs.delete(key);
      return value;
    }),
    _store: store,
  };
  return client as unknown as Redis & { _store: Map<string, unknown> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
import {
  createOAuthState,
  validateOAuthState,
  createSetupSession,
  getSetupSession,
  isSessionFresh,
  SESSION_TTL_SECONDS,
  SESSION_FRESHNESS_SECONDS,
} from "./setup-session";

describe("createOAuthState", () => {
  it("returns a 64-char hex state string and state-binding nonce", async () => {
    const redis = makeMockRedis();
    const record = await createOAuthState("123", redis);
    expect(record.state).toMatch(/^[0-9a-f]{64}$/);
    expect(record.stateBinding).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores installationId and binding in Redis under the state key", async () => {
    const redis = makeMockRedis();
    const record = await createOAuthState("456", redis);
    const payload = await redis.get<{ installationId: string; stateBinding: string }>(
      `oauth-state:${record.state}`,
    );
    expect(payload).not.toBeNull();
    expect(payload!.installationId).toBe("456");
    expect(payload!.stateBinding).toBe(record.stateBinding);
  });
});

describe("validateOAuthState", () => {
  it("returns installationId for a valid state", async () => {
    const redis = makeMockRedis();
    const record = await createOAuthState("789", redis);
    const result = await validateOAuthState(record.state, record.stateBinding, redis);
    expect(result).not.toBeNull();
    expect(result!.installationId).toBe("789");
    expect(result!.next).toBeUndefined();
  });

  it("threads next through the state payload", async () => {
    const redis = makeMockRedis();
    const record = await createOAuthState("789", redis, "/dashboard/credentials");
    const result = await validateOAuthState(record.state, record.stateBinding, redis);
    expect(result).not.toBeNull();
    expect(result!.installationId).toBe("789");
    expect(result!.next).toBe("/dashboard/credentials");
  });

  it("returns null for an unknown state (CSRF protection)", async () => {
    const redis = makeMockRedis();
    const result = await validateOAuthState("a".repeat(64), "b".repeat(64), redis);
    expect(result).toBeNull();
  });

  it("deletes the state on first use (one-time nonce)", async () => {
    const redis = makeMockRedis();
    const record = await createOAuthState("101", redis);
    await validateOAuthState(record.state, record.stateBinding, redis);
    // Second call must return null
    const second = await validateOAuthState(record.state, record.stateBinding, redis);
    expect(second).toBeNull();
  });

  it("only one concurrent callback can consume a given state (GETDEL atomicity)", async () => {
    const redis = makeMockRedis();
    const record = await createOAuthState("install-concurrent", redis);

    // Both calls race for the same state nonce
    const [a, b] = await Promise.all([
      validateOAuthState(record.state, record.stateBinding, redis),
      validateOAuthState(record.state, record.stateBinding, redis),
    ]);

    // Exactly one should return the installationId; the other must get null
    const successes = [a, b].filter((v) => v !== null);
    expect(successes).toHaveLength(1);
    expect(successes[0]!.installationId).toBe("install-concurrent");
  });

  it("rejects when state-binding cookie does not match", async () => {
    const redis = makeMockRedis();
    const record = await createOAuthState("install-1", redis);
    const result = await validateOAuthState(record.state, "f".repeat(64), redis);
    expect(result).toBeNull();
  });

  it("rejects when state-binding cookie is missing", async () => {
    const redis = makeMockRedis();
    const record = await createOAuthState("install-2", redis);
    const result = await validateOAuthState(record.state, undefined, redis);
    expect(result).toBeNull();
  });
});

describe("createSetupSession", () => {
  it("returns a 64-char hex token", async () => {
    const redis = makeMockRedis();
    const token = await createSetupSession(
      { installationId: "1", userId: 42, userLogin: "alice" },
      redis,
    );
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores the payload in Redis", async () => {
    const redis = makeMockRedis();
    const token = await createSetupSession(
      { installationId: "2", userId: 99, userLogin: "bob" },
      redis,
    );
    const data = await redis.get<{ installationId: string; userId: number; userLogin: string }>(
      `setup-session:${token}`,
    );
    expect(data).not.toBeNull();
    expect(data!.installationId).toBe("2");
    expect(data!.userId).toBe(99);
    expect(data!.userLogin).toBe("bob");
  });
});

describe("isSessionFresh", () => {
  it("returns true for a newly created session", async () => {
    const redis = makeMockRedis();
    const token = await createSetupSession(
      { installationId: "fresh-1", userId: 1, userLogin: "alice" },
      redis,
    );
    const session = await getSetupSession(token, redis);
    expect(isSessionFresh(session!)).toBe(true);
  });

  it("returns false for a session older than SESSION_FRESHNESS_SECONDS", async () => {
    const redis = makeMockRedis();
    const token = await createSetupSession(
      { installationId: "stale-1", userId: 2, userLogin: "bob" },
      redis,
    );
    // Manually backdate iat to simulate a stale session
    const key = `setup-session:${token}`;
    const data = await redis.get<{ iat: number }>(key);
    await redis.set(key, { ...data, iat: Date.now() - (SESSION_FRESHNESS_SECONDS + 60) * 1000 });

    const session = await getSetupSession(token, redis);
    expect(isSessionFresh(session!)).toBe(false);
  });

  it("returns false for a legacy session without iat", () => {
    const legacySession = {
      installationId: "legacy",
      userId: 3,
      userLogin: "carol",
      expiresAt: Date.now() + 60_000,
      iat: 0,
    };
    expect(isSessionFresh(legacySession)).toBe(false);
  });
});

describe("getSetupSession", () => {
  it("returns the session payload for a valid token", async () => {
    const redis = makeMockRedis();
    const before = Date.now();
    const token = await createSetupSession(
      { installationId: "3", userId: 7, userLogin: "carol" },
      redis,
    );
    const session = await getSetupSession(token, redis);
    expect(session).not.toBeNull();
    expect(session!.installationId).toBe("3");
    expect(session!.userId).toBe(7);
    expect(session!.userLogin).toBe("carol");
    expect(session!.expiresAt).toBeGreaterThanOrEqual(before + SESSION_TTL_SECONDS * 1000);
    expect(session!.iat).toBeGreaterThanOrEqual(before);
  });

  it("returns null for an unknown token", async () => {
    const redis = makeMockRedis();
    const session = await getSetupSession("x".repeat(64), redis);
    expect(session).toBeNull();
  });

  it("returns null for an expired session", async () => {
    const redis = makeMockRedis();
    const token = await createSetupSession(
      { installationId: "4", userId: 8, userLogin: "dave" },
      redis,
    );

    // Manually corrupt the exp to be in the past
    const key = `setup-session:${token}`;
    const data = await redis.get<{ exp: number }>(key);
    await redis.set(key, { ...data, exp: Date.now() - 1000 });

    const session = await getSetupSession(token, redis);
    expect(session).toBeNull();
  });

  it("returns null when exp field is missing (corrupted payload)", async () => {
    const redis = makeMockRedis();
    const key = "setup-session:" + "a".repeat(64);
    await redis.set(key, { installationId: "5", userId: 9, userLogin: "eve" });

    const session = await getSetupSession("a".repeat(64), redis);
    expect(session).toBeNull();
  });

  it("returns null when Redis contains a non-object value (corrupted data)", async () => {
    const redis = makeMockRedis();
    const key = "setup-session:" + "b".repeat(64);
    // Simulate corrupted Redis data by storing a non-object directly
    redis._store.set(key, "corrupted-data");

    const session = await getSetupSession("b".repeat(64), redis);
    expect(session).toBeNull();

    // Corrupted key should be cleaned up
    const remaining = await redis.get(key);
    expect(remaining).toBeNull();
  });
});
