import { describe, it, expect, vi } from "vitest";
import { type Redis } from "@upstash/redis";
import {
  getByokEnvelope,
  setByokEnvelope,
  listByokInstallationIds,
} from "./byok-store";
import type { ByokEnvelope } from "./byok-store";

// ---------------------------------------------------------------------------
// Minimal Redis mock — mirrors @upstash/redis auto-deserialization behavior:
// values are stored and returned as-is (the SDK handles JSON internally).
// ---------------------------------------------------------------------------

function makeMockRedis() {
  const store = new Map<string, unknown>();

  const client = {
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    scan: vi.fn(async (cursor: string, ..._args: unknown[]) => {
      // Return all matching keys on first call, "0" cursor to signal done
      if (cursor === "0") {
        const keys = [...store.keys()].filter((k) => k.startsWith("hive:byok:"));
        return ["0", keys];
      }
      return ["0", []];
    }),
    _store: store,
  };
  return client as unknown as Redis & { _store: Map<string, unknown> };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnvelope(overrides: Partial<ByokEnvelope> = {}): ByokEnvelope {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    ciphertext: "Y2lwaGVydGV4dA==",
    iv: "aXYtdGVzdA==",
    tag: "dGFnLXRlc3Q=",
    keyVersion: "v1",
    status: "active",
    updatedAt: "2026-02-19T12:00:00Z",
    updatedBy: "alice",
    fingerprint: "ab12",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getByokEnvelope", () => {
  it("returns null when no envelope exists", async () => {
    const redis = makeMockRedis();
    const result = await getByokEnvelope("999", redis);
    expect(result).toBeNull();
  });

  it("returns the stored envelope", async () => {
    const redis = makeMockRedis();
    const envelope = makeEnvelope();
    await setByokEnvelope("123", envelope, redis);

    const result = await getByokEnvelope("123", redis);
    expect(result).toEqual(envelope);
  });

  it("returns null for corrupted (non-object) data in Redis", async () => {
    const redis = makeMockRedis();
    // Simulate corrupted Redis data by storing a non-object directly
    redis._store.set("hive:byok:456", "not-valid-data");

    const result = await getByokEnvelope("456", redis);
    expect(result).toBeNull();
  });

  it("reads legacy envelopes that still use fingerprintLast4", async () => {
    const redis = makeMockRedis();
    redis._store.set("hive:byok:789", {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      ciphertext: "Y2lwaGVydGV4dA==",
      iv: "aXYtdGVzdA==",
      tag: "dGFnLXRlc3Q=",
      keyVersion: "v1",
      status: "active",
      updatedAt: "2026-02-19T12:00:00Z",
      updatedBy: "alice",
      fingerprintLast4: "c0de",
    });

    const result = await getByokEnvelope("789", redis);
    expect(result).toEqual(
      expect.objectContaining({
        fingerprint: "c0de",
      }),
    );
  });
});

describe("setByokEnvelope", () => {
  it("stores the envelope", async () => {
    const redis = makeMockRedis();
    const envelope = makeEnvelope();
    await setByokEnvelope("123", envelope, redis);

    const stored = redis._store.get("hive:byok:123");
    expect(stored).toBeDefined();
    expect(stored).toEqual(envelope);
  });

  it("overwrites an existing envelope", async () => {
    const redis = makeMockRedis();
    await setByokEnvelope("123", makeEnvelope({ provider: "anthropic" }), redis);
    await setByokEnvelope("123", makeEnvelope({ provider: "openai" }), redis);

    const result = await getByokEnvelope("123", redis);
    expect(result!.provider).toBe("openai");
  });
});

describe("setByokEnvelope + getByokEnvelope lifecycle", () => {
  it("handles a full create → read → revoke → read cycle", async () => {
    const redis = makeMockRedis();

    // Create
    const envelope = makeEnvelope();
    await setByokEnvelope("100", envelope, redis);
    expect((await getByokEnvelope("100", redis))!.status).toBe("active");

    // Revoke — clear crypto fields, set status
    const revoked: ByokEnvelope = {
      ...envelope,
      status: "revoked",
      ciphertext: "",
      iv: "",
      tag: "",
      updatedAt: "2026-02-19T13:00:00Z",
    };
    await setByokEnvelope("100", revoked, redis);

    const result = await getByokEnvelope("100", redis);
    expect(result!.status).toBe("revoked");
    expect(result!.ciphertext).toBe("");
  });
});

describe("listByokInstallationIds", () => {
  it("returns empty array when no envelopes exist", async () => {
    const redis = makeMockRedis();
    const ids = await listByokInstallationIds(redis);
    expect(ids).toEqual([]);
  });

  it("returns installation IDs for all stored envelopes", async () => {
    const redis = makeMockRedis();
    await setByokEnvelope("100", makeEnvelope(), redis);
    await setByokEnvelope("200", makeEnvelope(), redis);
    await setByokEnvelope("300", makeEnvelope(), redis);

    const ids = await listByokInstallationIds(redis);
    expect(ids.sort()).toEqual(["100", "200", "300"]);
  });

  it("does not include non-BYOK keys", async () => {
    const redis = makeMockRedis();
    redis._store.set("setup-session:abc", {});
    redis._store.set("oauth-state:xyz", {});
    await setByokEnvelope("100", makeEnvelope(), redis);

    const ids = await listByokInstallationIds(redis);
    expect(ids).toEqual(["100"]);
  });
});
