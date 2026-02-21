import { describe, it, expect, vi } from "vitest";
import type Redis from "ioredis";

// ---------------------------------------------------------------------------
// Minimal Redis mock — mirrors ioredis behavior: values are stored and
// returned as strings (the caller handles JSON serialization).
// ---------------------------------------------------------------------------
function makeMockRedis() {
  const store = new Map<string, string>();
  const expiryMs = new Map<string, number>();

  const client = {
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      store.set(key, value);
      // Parse positional EX arg: "EX", <seconds>
      const exIdx = args.indexOf("EX");
      if (exIdx !== -1 && typeof args[exIdx + 1] === "number") {
        expiryMs.set(key, Date.now() + (args[exIdx + 1] as number) * 1000);
      }
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
  return client as unknown as Redis & { _store: Map<string, string> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
import {
  createOAuthState,
  validateOAuthState,
  createSetupSession,
  getSetupSession,
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
    const raw = await redis.get(`oauth-state:${record.state}`);
    expect(raw).not.toBeNull();
    const payload = JSON.parse(raw!);
    expect(payload.installationId).toBe("456");
    expect(payload.stateBinding).toBe(record.stateBinding);
  });
});

describe("validateOAuthState", () => {
  it("returns installationId for a valid state", async () => {
    const redis = makeMockRedis();
    const record = await createOAuthState("789", redis);
    const result = await validateOAuthState(record.state, record.stateBinding, redis);
    expect(result).toBe("789");
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
    expect(successes[0]).toBe("install-concurrent");
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
    const raw = await redis.get(`setup-session:${token}`);
    expect(raw).not.toBeNull();
    const data = JSON.parse(raw!);
    expect(data.installationId).toBe("2");
    expect(data.userId).toBe(99);
    expect(data.userLogin).toBe("bob");
  });
});

describe("getSetupSession", () => {
  it("returns the session payload for a valid token", async () => {
    const redis = makeMockRedis();
    const token = await createSetupSession(
      { installationId: "3", userId: 7, userLogin: "carol" },
      redis,
    );
    const session = await getSetupSession(token, redis);
    expect(session).toEqual({ installationId: "3", userId: 7, userLogin: "carol" });
  });

  it("returns null for an unknown token", async () => {
    const redis = makeMockRedis();
    const session = await getSetupSession("x".repeat(64), redis);
    expect(session).toBeNull();
  });

  it("returns null for an expired session", async () => {
    const redis = makeMockRedis();
    const key = "setup-session:" + "c".repeat(64);
    // Store a session with an exp in the past
    await redis.set(
      key,
      JSON.stringify({ installationId: "4", userId: 8, userLogin: "dave", exp: Date.now() - 1000 }),
      "EX",
      1800,
    );

    const session = await getSetupSession("c".repeat(64), redis);
    expect(session).toBeNull();
  });

  it("returns null when exp field is missing (corrupted payload)", async () => {
    const redis = makeMockRedis();
    const key = "setup-session:" + "a".repeat(64);
    await redis.set(key, JSON.stringify({ installationId: "5", userId: 9, userLogin: "eve" }));

    const session = await getSetupSession("a".repeat(64), redis);
    expect(session).toBeNull();
  });

  it("returns null when Redis contains a non-JSON value (corrupted data)", async () => {
    const redis = makeMockRedis();
    const key = "setup-session:" + "b".repeat(64);
    // Simulate corrupted Redis data by storing a non-JSON string directly
    redis._store.set(key, "corrupted-data");

    const session = await getSetupSession("b".repeat(64), redis);
    expect(session).toBeNull();

    // Corrupted key should be cleaned up
    const remaining = await redis.get(key);
    expect(remaining).toBeNull();
  });
});
