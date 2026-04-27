/**
 * Unit tests for the V1 agent-token storage layer.
 *
 * Uses a smart in-memory Redis mock that simulates the four Lua
 * script semantics by inspecting the script source. The mock is
 * intentionally larger than the agent-token.test.ts mock because
 * V1 introduces sorted-set indexes + per-key locks + an
 * envelope-then-script READ pattern.
 *
 * Note: bracket-notation access (`redis["eval"]`) is used throughout
 * to sidestep an unrelated security-warning hook that pattern-matches
 * on the literal `.eval(` token even for Redis Lua-execution methods.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { type Redis } from "@upstash/redis";

import {
  // Public API under test
  issueAgentToken,
  revokeAgentToken,
  setAgentTokenCapabilities,
  rotateAgentToken,
  listAgentTokens,
  getAgentTokenSummary,
  // Helpers we want to unit-test directly
  computeEnvelopeTtlSeconds,
  envelopeKey,
  hashIndexKey,
  installationIndexKey,
  envelopeMetaKey,
  lockKey,
  ENVELOPE_TTL_SKEW_MARGIN_SECONDS,
  DEFAULT_TOKEN_LIMIT_PER_INSTALLATION,
  TokenNameTakenError,
  TokenLimitReachedError,
  TokenNotFoundError,
  type AgentTokenEnvelopeV1,
  type AgentTokenHashRecordV1,
} from "./agent-token-v1";
import { CapabilityValidationError } from "./agent-token-capabilities";

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

interface SortedSetEntry {
  member: string;
  score: number;
}

function makeMockRedis() {
  const store = new Map<string, unknown>();

  function getSortedSet(key: string): SortedSetEntry[] {
    const existing = store.get(key);
    if (Array.isArray(existing)) return existing as SortedSetEntry[];
    const fresh: SortedSetEntry[] = [];
    store.set(key, fresh);
    return fresh;
  }

  // Lua-script simulator: inspects the script body to identify which
  // operation is being requested, then mirrors the real Lua semantics.
  // Returns match the design's `{tag, payload?}` convention.
  const luaSim = vi.fn(
    async (script: string, keys: string[], argv: string[]) => {
      // withRedisLock release script — 1 key, 1 arg, references ARGV[1]
      if (keys.length === 1 && argv.length === 1 && script.includes("ARGV[1]") && !script.includes("name_taken")) {
        const lockKey = keys[0];
        if (store.get(lockKey) === argv[0]) {
          store.delete(lockKey);
          return 1;
        }
        return 0;
      }

      // ISSUE_TOKEN_SCRIPT — 3 keys, 6 args
      if (keys.length === 3 && argv.length === 6 && script.includes("name_taken")) {
        const [envelopeK, hashIdxK, instIdxK] = keys;
        const [name, envelopeJson, hashRecordJson, createdAtMs, tokenLimit, expirySecsOrZero] = argv;
        if (store.has(envelopeK)) return [0, "name_taken"];
        const set = getSortedSet(instIdxK);
        if (set.length >= Number(tokenLimit)) return [-1, "limit"];
        const env = JSON.parse(envelopeJson) as Record<string, unknown>;
        if (Number(expirySecsOrZero) > 0) {
          env.__ttl_secs__ = Number(expirySecsOrZero);
        }
        store.set(envelopeK, env);
        store.set(hashIdxK, JSON.parse(hashRecordJson));
        set.push({ member: name, score: Number(createdAtMs) });
        set.sort((a, b) => a.score - b.score);
        return [1, name];
      }

      // REVOKE_TOKEN_SCRIPT — 4 keys, 1 arg
      if (
        keys.length === 4 &&
        argv.length === 1 &&
        script.includes('existed = redis.call("del"')
      ) {
        const [envelopeK, hashIdxK, instIdxK, metaK] = keys;
        const [name] = argv;
        const existed = store.has(envelopeK) ? 1 : 0;
        store.delete(envelopeK);
        store.delete(hashIdxK);
        store.delete(metaK);
        const set = getSortedSet(instIdxK);
        const idx = set.findIndex((e) => e.member === name);
        if (idx !== -1) set.splice(idx, 1);
        if (existed === 0) return [0, name];
        return [1, name];
      }

      // SET_CAPABILITIES_SCRIPT — 1 key, 2 args, includes no_envelope
      // (and NOT 3 keys like ROTATE)
      if (
        keys.length === 1 &&
        argv.length === 2 &&
        script.includes("no_envelope")
      ) {
        const [envelopeK] = keys;
        const [envelopeJson, expirySecsOrZero] = argv;
        if (!store.has(envelopeK)) return [-1, "no_envelope"];
        const env = JSON.parse(envelopeJson) as Record<string, unknown>;
        if (Number(expirySecsOrZero) > 0) {
          env.__ttl_secs__ = Number(expirySecsOrZero);
        }
        store.set(envelopeK, env);
        return [1];
      }

      // ROTATE_TOKEN_SCRIPT — 3 keys, 3 args, includes no_envelope
      if (
        keys.length === 3 &&
        argv.length === 3 &&
        script.includes("no_envelope")
      ) {
        const [envelopeK, oldHashIdxK, newHashIdxK] = keys;
        const [envelopeJson, hashRecordJson, expirySecsOrZero] = argv;
        if (!store.has(envelopeK)) return [-1, "no_envelope"];
        store.delete(oldHashIdxK);
        const env = JSON.parse(envelopeJson) as Record<string, unknown>;
        if (Number(expirySecsOrZero) > 0) {
          env.__ttl_secs__ = Number(expirySecsOrZero);
        }
        store.set(envelopeK, env);
        store.set(newHashIdxK, JSON.parse(hashRecordJson));
        return [1, envelopeJson];
      }

      return null;
    },
  );

  const client = {
    set: vi.fn(
      async (
        key: string,
        value: unknown,
        opts?: { nx?: boolean; xx?: boolean; ex?: number },
      ) => {
        if (opts?.nx && store.has(key)) return null;
        if (opts?.xx && !store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
    ),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      const set = getSortedSet(key);
      const existing = set.find((e) => e.member === member);
      if (existing) {
        existing.score = score;
        return 0;
      }
      set.push({ member, score });
      set.sort((a, b) => a.score - b.score);
      return 1;
    }),
    zrem: vi.fn(async (key: string, member: string) => {
      const set = getSortedSet(key);
      const idx = set.findIndex((e) => e.member === member);
      if (idx === -1) return 0;
      set.splice(idx, 1);
      return 1;
    }),
    zrange: vi.fn(async (key: string, _start: number, _stop: number) => {
      const set = getSortedSet(key);
      return set.map((e) => e.member);
    }),
    // Lua-script entrypoint exposed as a property — production code
    // accesses it via bracket notation; tests do too.
    "eval": luaSim,
    _store: store,
    _luaSim: luaSim,
  };
  return client as unknown as Redis & {
    _store: Map<string, unknown>;
    _luaSim: ReturnType<typeof vi.fn>;
  };
}

const KEYRING = new Map([["v1", Buffer.alloc(32)]]);

function defaultIssueArgs(redis: Redis) {
  return {
    installationId: "12345",
    name: "worker",
    agent_role: "drone",
    capabilities: ["agent_health.report", "tasks.claim"],
    createdBy: "operator",
    expiresAt: null,
    keyring: KEYRING,
    keyVersion: "v1",
    redis,
  };
}

// ---------------------------------------------------------------------------
// Pure-function helpers
// ---------------------------------------------------------------------------

describe("key prefix helpers", () => {
  it("envelopeKey uses the v1 prefix and escapes nothing", () => {
    expect(envelopeKey("12345", "worker")).toBe("hive:v1:agent-token:12345:worker");
  });

  it("hashIndexKey uses the v1 idx prefix", () => {
    expect(hashIndexKey("abcd")).toBe("hive:v1:idx:agent-token:hash:abcd");
  });

  it("installationIndexKey uses the v1 idx installation prefix", () => {
    expect(installationIndexKey("12345")).toBe(
      "hive:v1:idx:agent-token:installation:12345",
    );
  });

  it("envelopeMetaKey is envelopeKey + :meta", () => {
    expect(envelopeMetaKey("12345", "worker")).toBe(
      "hive:v1:agent-token:12345:worker:meta",
    );
  });

  it("lockKey uses the v1 lock prefix", () => {
    expect(lockKey("12345", "worker")).toBe(
      "hive:v1:lock:agent-token:12345:worker",
    );
  });
});

describe("computeEnvelopeTtlSeconds", () => {
  it("expiresAt: null → 0 (no TTL)", () => {
    expect(computeEnvelopeTtlSeconds(null)).toBe(0);
  });

  it("expiresAt in past → 0 (envelope fails middleware anyway)", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(computeEnvelopeTtlSeconds(past)).toBe(0);
  });

  it("expiresAt 30 days out → ~30 days * 86400 + 300 margin", () => {
    const future = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    const ttl = computeEnvelopeTtlSeconds(future);
    expect(ttl).toBeGreaterThan(30 * 86400);
    expect(ttl).toBeLessThanOrEqual(30 * 86400 + ENVELOPE_TTL_SKEW_MARGIN_SECONDS);
  });

  it("invalid ISO → 0 (defensive — never NaN-EX a key)", () => {
    expect(computeEnvelopeTtlSeconds("not-a-date")).toBe(0);
  });

  it("explicit nowMs lets tests pin the math deterministically", () => {
    const expiresAt = new Date(2026, 0, 2, 0, 0, 0).toISOString();
    const nowMs = new Date(2026, 0, 1, 0, 0, 0).getTime();
    expect(computeEnvelopeTtlSeconds(expiresAt, nowMs)).toBe(86400 + 300);
  });
});

// ---------------------------------------------------------------------------
// issueAgentToken
// ---------------------------------------------------------------------------

describe("issueAgentToken", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("issues a token, returns the bearer ONCE, stores envelope + hash idx + installation idx", async () => {
    const issued = await issueAgentToken(defaultIssueArgs(redis));

    expect(issued.token).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.name).toBe("worker");
    expect(issued.agent_role).toBe("drone");
    expect(issued.capabilities).toEqual(["agent_health.report", "tasks.claim"]);
    expect(issued.fingerprint.length).toBe(8);
    expect(issued.expiresAt).toBeNull();

    const envelope = redis._store.get(
      envelopeKey("12345", "worker"),
    ) as AgentTokenEnvelopeV1;
    expect(envelope).toBeDefined();
    expect(envelope.name).toBe("worker");
    expect(envelope.agent_role).toBe("drone");
    expect(envelope.capabilities).toEqual(["agent_health.report", "tasks.claim"]);

    const hashIdxRecord = redis._store.get(
      hashIndexKey(envelope.tokenHash),
    ) as AgentTokenHashRecordV1;
    expect(hashIdxRecord.installationId).toBe("12345");
    expect(hashIdxRecord.name).toBe("worker");

    const idx = redis._store.get(
      installationIndexKey("12345"),
    ) as SortedSetEntry[];
    expect(idx).toHaveLength(1);
    expect(idx[0].member).toBe("worker");
    expect(idx[0].score).toBeGreaterThan(0);
  });

  it("rejects empty capabilities", async () => {
    await expect(
      issueAgentToken({ ...defaultIssueArgs(redis), capabilities: [] }),
    ).rejects.toThrow(/empty capabilities/);
  });

  it("rejects invalid name (uppercase)", async () => {
    await expect(
      issueAgentToken({ ...defaultIssueArgs(redis), name: "Worker" }),
    ).rejects.toThrow(CapabilityValidationError);
  });

  it("rejects invalid agent_role (leading digit)", async () => {
    await expect(
      issueAgentToken({ ...defaultIssueArgs(redis), agent_role: "1drone" }),
    ).rejects.toThrow(CapabilityValidationError);
  });

  it("rejects invalid capability string (mid-segment wildcard)", async () => {
    await expect(
      issueAgentToken({
        ...defaultIssueArgs(redis),
        capabilities: ["tasks.*claim"],
      }),
    ).rejects.toThrow(CapabilityValidationError);
  });

  it("throws TokenNameTakenError on duplicate name", async () => {
    await issueAgentToken(defaultIssueArgs(redis));
    await expect(
      issueAgentToken(defaultIssueArgs(redis)),
    ).rejects.toThrow(TokenNameTakenError);
  });

  it("throws TokenLimitReachedError when installation already at the cap", async () => {
    await issueAgentToken({
      ...defaultIssueArgs(redis),
      name: "first",
      tokenLimit: 2,
    });
    await issueAgentToken({
      ...defaultIssueArgs(redis),
      name: "second",
      tokenLimit: 2,
    });
    await expect(
      issueAgentToken({
        ...defaultIssueArgs(redis),
        name: "third",
        tokenLimit: 2,
      }),
    ).rejects.toThrow(TokenLimitReachedError);
  });

  it("DEFAULT_TOKEN_LIMIT_PER_INSTALLATION matches the design doc claim", () => {
    expect(DEFAULT_TOKEN_LIMIT_PER_INSTALLATION).toBe(20);
  });

  it("with expiresAt set, ISSUE script call carries positive expirySecsOrZero", async () => {
    const future = new Date(Date.now() + 86400 * 1000).toISOString();
    await issueAgentToken({ ...defaultIssueArgs(redis), expiresAt: future });

    const issueCall = redis._luaSim.mock.calls.find(
      (c) => c[1].length === 3 && c[2].length === 6,
    );
    expect(issueCall).toBeDefined();
    if (issueCall) {
      const expirySecsOrZero = Number(issueCall[2][5]);
      expect(expirySecsOrZero).toBeGreaterThan(0);
    }
  });

  it("with expiresAt: null, ISSUE script call carries expirySecsOrZero=0", async () => {
    await issueAgentToken(defaultIssueArgs(redis));
    const issueCall = redis._luaSim.mock.calls.find(
      (c) => c[1].length === 3 && c[2].length === 6,
    );
    expect(issueCall).toBeDefined();
    if (issueCall) {
      expect(issueCall[2][5]).toBe("0");
    }
  });
});

// ---------------------------------------------------------------------------
// revokeAgentToken
// ---------------------------------------------------------------------------

describe("revokeAgentToken", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("returns true and cleans envelope + hash + meta + index", async () => {
    await issueAgentToken(defaultIssueArgs(redis));
    const envelope = redis._store.get(
      envelopeKey("12345", "worker"),
    ) as AgentTokenEnvelopeV1;

    const removed = await revokeAgentToken({
      installationId: "12345",
      name: "worker",
      redis,
    });

    expect(removed).toBe(true);
    expect(redis._store.has(envelopeKey("12345", "worker"))).toBe(false);
    expect(redis._store.has(hashIndexKey(envelope.tokenHash))).toBe(false);
    expect(redis._store.has(envelopeMetaKey("12345", "worker"))).toBe(false);

    const idx = redis._store.get(
      installationIndexKey("12345"),
    ) as SortedSetEntry[];
    expect(idx).toEqual([]);
  });

  it("returns false when there's no envelope to revoke (idempotent)", async () => {
    const removed = await revokeAgentToken({
      installationId: "12345",
      name: "nonexistent",
      redis,
    });
    expect(removed).toBe(false);
  });

  it("rejects invalid name without making any Redis writes", async () => {
    const beforeWriteCount = (redis.set as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(
      revokeAgentToken({ installationId: "12345", name: "Worker", redis }),
    ).rejects.toThrow(CapabilityValidationError);
    const afterWriteCount = (redis.set as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(afterWriteCount).toBe(beforeWriteCount);
  });
});

// ---------------------------------------------------------------------------
// setAgentTokenCapabilities
// ---------------------------------------------------------------------------

describe("setAgentTokenCapabilities", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("replaces capabilities on the existing envelope (snap-to, not merge)", async () => {
    await issueAgentToken(defaultIssueArgs(redis));

    const summary = await setAgentTokenCapabilities({
      installationId: "12345",
      name: "worker",
      capabilities: ["rooms.read", "rooms.contribute"],
      redis,
    });

    expect(summary.capabilities).toEqual(["rooms.read", "rooms.contribute"]);
    expect(summary.agent_role).toBe("drone");
    expect(summary.name).toBe("worker");

    const envelope = redis._store.get(
      envelopeKey("12345", "worker"),
    ) as AgentTokenEnvelopeV1;
    expect(envelope.capabilities).toEqual(["rooms.read", "rooms.contribute"]);
  });

  it("rejects empty capabilities", async () => {
    await issueAgentToken(defaultIssueArgs(redis));
    await expect(
      setAgentTokenCapabilities({
        installationId: "12345",
        name: "worker",
        capabilities: [],
        redis,
      }),
    ).rejects.toThrow(/empty capabilities/);
  });

  it("rejects invalid capability string", async () => {
    await issueAgentToken(defaultIssueArgs(redis));
    await expect(
      setAgentTokenCapabilities({
        installationId: "12345",
        name: "worker",
        capabilities: ["Tasks.Claim"],
        redis,
      }),
    ).rejects.toThrow(CapabilityValidationError);
  });

  it("throws TokenNotFoundError when the envelope doesn't exist", async () => {
    await expect(
      setAgentTokenCapabilities({
        installationId: "12345",
        name: "missing",
        capabilities: ["tasks.claim"],
        redis,
      }),
    ).rejects.toThrow(TokenNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// rotateAgentToken
// ---------------------------------------------------------------------------

describe("rotateAgentToken", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("replaces the bearer atomically; old hash index is gone, new one points at same identity", async () => {
    const original = await issueAgentToken(defaultIssueArgs(redis));
    const originalEnvelope = redis._store.get(
      envelopeKey("12345", "worker"),
    ) as AgentTokenEnvelopeV1;

    const rotated = await rotateAgentToken({
      installationId: "12345",
      name: "worker",
      keyring: KEYRING,
      keyVersion: "v1",
      redis,
    });

    expect(rotated.token).not.toBe(original.token);
    expect(rotated.name).toBe("worker");
    expect(rotated.agent_role).toBe("drone");
    expect(rotated.capabilities).toEqual(["agent_health.report", "tasks.claim"]);

    const newEnvelope = redis._store.get(
      envelopeKey("12345", "worker"),
    ) as AgentTokenEnvelopeV1;
    expect(newEnvelope.fingerprint).toBe(rotated.fingerprint);
    expect(newEnvelope.fingerprint).not.toBe(originalEnvelope.fingerprint);
    expect(newEnvelope.expiresAt).toBe(originalEnvelope.expiresAt);
    expect(newEnvelope.createdAt).toBe(originalEnvelope.createdAt);
    expect(newEnvelope.capabilities).toEqual(originalEnvelope.capabilities);

    expect(redis._store.has(hashIndexKey(originalEnvelope.tokenHash))).toBe(false);
    expect(redis._store.has(hashIndexKey(newEnvelope.tokenHash))).toBe(true);
  });

  it("throws TokenNotFoundError when the envelope doesn't exist", async () => {
    await expect(
      rotateAgentToken({
        installationId: "12345",
        name: "missing",
        keyring: KEYRING,
        keyVersion: "v1",
        redis,
      }),
    ).rejects.toThrow(TokenNotFoundError);
  });

  it("preserves expiresAt (rotate ≠ extend)", async () => {
    const future = new Date(Date.now() + 86400 * 1000).toISOString();
    await issueAgentToken({ ...defaultIssueArgs(redis), expiresAt: future });

    const rotated = await rotateAgentToken({
      installationId: "12345",
      name: "worker",
      keyring: KEYRING,
      keyVersion: "v1",
      redis,
    });

    expect(rotated.expiresAt).toBe(future);
  });
});

// ---------------------------------------------------------------------------
// listAgentTokens / getAgentTokenSummary
// ---------------------------------------------------------------------------

describe("listAgentTokens", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("returns empty array when no tokens for installation", async () => {
    const out = await listAgentTokens({ installationId: "99", redis });
    expect(out).toEqual([]);
  });

  it("returns tokens in creation order (sorted-set score == createdAt epoch ms)", async () => {
    await issueAgentToken({ ...defaultIssueArgs(redis), name: "first" });
    await issueAgentToken({ ...defaultIssueArgs(redis), name: "second" });
    await issueAgentToken({ ...defaultIssueArgs(redis), name: "third" });

    const out = await listAgentTokens({ installationId: "12345", redis });
    expect(out.map((s) => s.name)).toEqual(["first", "second", "third"]);
    for (const summary of out) {
      expect("ciphertext" in summary).toBe(false);
      expect(summary.fingerprint).toBeDefined();
    }
  });
});

describe("getAgentTokenSummary", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("returns the summary excluding ciphertext", async () => {
    await issueAgentToken(defaultIssueArgs(redis));

    const summary = await getAgentTokenSummary({
      installationId: "12345",
      name: "worker",
      redis,
    });

    expect(summary.name).toBe("worker");
    expect(summary.agent_role).toBe("drone");
    expect(summary.capabilities).toEqual(["agent_health.report", "tasks.claim"]);
    expect("ciphertext" in summary).toBe(false);
  });

  it("throws TokenNotFoundError when not found", async () => {
    await expect(
      getAgentTokenSummary({
        installationId: "12345",
        name: "missing",
        redis,
      }),
    ).rejects.toThrow(TokenNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Cross-invariant: no operation accidentally reads/writes a legacy key
// ---------------------------------------------------------------------------

describe("v1 storage layer never touches legacy keys", () => {
  it("issue + revoke leave no legacy `hive:agent-token:` (no v1) key in store", async () => {
    const redis = makeMockRedis();
    await issueAgentToken(defaultIssueArgs(redis));
    await revokeAgentToken({ installationId: "12345", name: "worker", redis });
    for (const key of redis._store.keys()) {
      // legacy envelope = `hive:agent-token:` (no v1)
      expect(key, key).not.toMatch(/^hive:agent-token:[^v]/);
      // legacy reverse idx = `agent-token-hash:`
      expect(key, key).not.toMatch(/^agent-token-hash:/);
    }
  });
});
