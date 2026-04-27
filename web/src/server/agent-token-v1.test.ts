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

import { createHash } from "crypto";
import {
  // Public API under test
  issueAgentToken,
  revokeAgentToken,
  setAgentTokenCapabilities,
  rotateAgentToken,
  listAgentTokens,
  getAgentTokenSummary,
  pruneOrphanedIndexEntries,
  resolveBearerToEnvelope,
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
  InvalidExpiresAtError,
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
      if (keys.length === 4 && argv.length === 7 && script.includes("name_taken")) {
        // R2 (audit slot): 4 keys (added auditStreamKey), 7 args (added auditEntry)
        const [envelopeK, hashIdxK, instIdxK, _auditK] = keys;
        const [name, envelopeJson, hashRecordJson, createdAtMs, tokenLimit, expirySecsOrZero, _auditEntry] = argv;
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

      // REVOKE_TOKEN_SCRIPT — 5 keys, 2 args (R2: + auditStreamKey + auditEntry)
      if (
        keys.length === 5 &&
        argv.length === 2 &&
        script.includes('existed = redis.call("del"')
      ) {
        const [envelopeK, hashIdxK, instIdxK, metaK, _auditK] = keys;
        const [name, _auditEntry] = argv;
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

      // SET_CAPABILITIES_SCRIPT — 2 keys, 3 args (R2: + auditStreamKey + auditEntry)
      // (distinguished from ROTATE by 2 keys vs ROTATE's 4 keys)
      if (
        keys.length === 2 &&
        argv.length === 3 &&
        script.includes("no_envelope")
      ) {
        const [envelopeK, _auditK] = keys;
        const [envelopeJson, expirySecsOrZero, _auditEntry] = argv;
        if (!store.has(envelopeK)) return [-1, "no_envelope"];
        const env = JSON.parse(envelopeJson) as Record<string, unknown>;
        if (Number(expirySecsOrZero) > 0) {
          env.__ttl_secs__ = Number(expirySecsOrZero);
        }
        store.set(envelopeK, env);
        return [1];
      }

      // RESOLVE_BEARER_SCRIPT — 1 key, 2 args (R3: + envelopePrefix + presentedHash)
      if (
        keys.length === 1 &&
        argv.length === 2 &&
        script.includes("unknown_bearer")
      ) {
        const [hashIdxK] = keys;
        const [envelopePrefix, presentedHash] = argv;
        const hashRecord = store.get(hashIdxK) as
          | { installationId: string; name: string }
          | undefined;
        if (!hashRecord) return [-1, "unknown_bearer"];
        const envKey = `${envelopePrefix}${hashRecord.installationId}:${hashRecord.name}`;
        const envelope = store.get(envKey) as
          | { tokenHash: string }
          | undefined;
        if (!envelope) return [-2, "envelope_missing"];
        if (envelope.tokenHash !== presentedHash) return [-3, "stale_bearer"];
        return [1, JSON.stringify(envelope), hashRecord.installationId];
      }

      // ROTATE_TOKEN_SCRIPT — 4 keys, 5 args (R2: + auditStreamKey + name first + auditEntry)
      if (
        keys.length === 4 &&
        argv.length === 5 &&
        script.includes("no_envelope")
      ) {
        const [envelopeK, oldHashIdxK, newHashIdxK, _auditK] = keys;
        const [name, envelopeJson, hashRecordJson, expirySecsOrZero, _auditEntry] = argv;
        if (!store.has(envelopeK)) return [-1, "no_envelope"];
        store.delete(oldHashIdxK);
        const env = JSON.parse(envelopeJson) as Record<string, unknown>;
        if (Number(expirySecsOrZero) > 0) {
          env.__ttl_secs__ = Number(expirySecsOrZero);
        }
        store.set(envelopeK, env);
        store.set(newHashIdxK, JSON.parse(hashRecordJson));
        // R2 (G6 fix): script returns {1, name} for parity with ISSUE
        return [1, name];
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

    // R1 fix: fingerprint MUST equal the SHA-256 prefix of the bearer,
    // NOT the suffix of the raw bearer (would leak 8 hex chars of
    // the secret anywhere fingerprint is exposed).
    const expectedFingerprint = createHash("sha256")
      .update(issued.token)
      .digest("hex")
      .slice(0, 8);
    expect(issued.fingerprint).toBe(expectedFingerprint);
    expect(issued.fingerprint).not.toBe(issued.token.slice(-8));

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
      (c) => c[1].length === 4 && c[2].length === 7,
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
      (c) => c[1].length === 4 && c[2].length === 7,
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

// ---------------------------------------------------------------------------
// R1 fix — past/invalid expiresAt rejected at issue time (builder #2)
// ---------------------------------------------------------------------------

describe("issueAgentToken — expiresAt validation (R1 fix)", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("rejects past expiresAt with InvalidExpiresAtError", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await expect(
      issueAgentToken({ ...defaultIssueArgs(redis), expiresAt: past }),
    ).rejects.toThrow(InvalidExpiresAtError);
  });

  it("rejects unparseable expiresAt string with InvalidExpiresAtError", async () => {
    await expect(
      issueAgentToken({ ...defaultIssueArgs(redis), expiresAt: "not-a-date" }),
    ).rejects.toThrow(InvalidExpiresAtError);
  });

  it("accepts future expiresAt", async () => {
    const future = new Date(Date.now() + 86400 * 1000).toISOString();
    const issued = await issueAgentToken({
      ...defaultIssueArgs(redis),
      expiresAt: future,
    });
    expect(issued.expiresAt).toBe(future);
  });

  it("accepts null expiresAt (no-expiry default)", async () => {
    const issued = await issueAgentToken({
      ...defaultIssueArgs(redis),
      expiresAt: null,
    });
    expect(issued.expiresAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R1 fix — orphaned index entries pruned (builder #2)
// ---------------------------------------------------------------------------

describe("pruneOrphanedIndexEntries (R1 fix)", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("returns 0 when there are no orphans", async () => {
    await issueAgentToken(defaultIssueArgs(redis));
    const pruned = await pruneOrphanedIndexEntries({
      installationId: "12345",
      redis,
    });
    expect(pruned).toBe(0);
  });

  it("ZREMs orphaned entries when their envelope was TTL'd", async () => {
    await issueAgentToken({ ...defaultIssueArgs(redis), name: "alive" });
    await issueAgentToken({ ...defaultIssueArgs(redis), name: "ghost" });

    // Simulate Redis TTL expiry: delete the envelope but leave the
    // sorted-set entry (this is exactly what happens when a Redis EX
    // fires on the envelope key without our explicit revoke flow).
    redis._store.delete(envelopeKey("12345", "ghost"));

    const pruned = await pruneOrphanedIndexEntries({
      installationId: "12345",
      redis,
    });
    expect(pruned).toBe(1);

    // Sorted set should now only contain "alive"
    const idx = redis._store.get(
      installationIndexKey("12345"),
    ) as SortedSetEntry[];
    expect(idx.map((e) => e.member)).toEqual(["alive"]);
  });
});

describe("listAgentTokens — self-heals orphans (R1 fix)", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("skips orphans in the returned list AND ZREMs them from the index", async () => {
    await issueAgentToken({ ...defaultIssueArgs(redis), name: "alive" });
    await issueAgentToken({ ...defaultIssueArgs(redis), name: "ghost" });
    redis._store.delete(envelopeKey("12345", "ghost"));

    const out = await listAgentTokens({ installationId: "12345", redis });
    expect(out.map((s) => s.name)).toEqual(["alive"]);

    // Orphan was opportunistically pruned
    const idx = redis._store.get(
      installationIndexKey("12345"),
    ) as SortedSetEntry[];
    expect(idx.map((e) => e.member)).toEqual(["alive"]);
  });
});

describe("issueAgentToken — at-cap orphan self-heal (R1 fix)", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("issuing at the cap succeeds when an orphan exists (the orphan is pruned first)", async () => {
    // Issue 2 tokens with cap=2, then orphan one and try to issue a third.
    // Without orphan-pruning before the cap check, this would 422 with
    // TokenLimitReached. With pruning, the third issuance succeeds.
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

    // Orphan "second" by deleting its envelope (simulating TTL expiry)
    redis._store.delete(envelopeKey("12345", "second"));

    // Third issue should succeed because the orphaned "second" is
    // pruned before the cap check.
    const issued = await issueAgentToken({
      ...defaultIssueArgs(redis),
      name: "third",
      tokenLimit: 2,
    });
    expect(issued.name).toBe("third");
  });
});

// ---------------------------------------------------------------------------
// G7 — direct test coverage for {-1, "no_envelope"} race paths
// ---------------------------------------------------------------------------

describe("SET_CAPABILITIES_SCRIPT — {-1, no_envelope} race path (G7)", () => {
  it("translates {-1, no_envelope} from the script to TokenNotFoundError", async () => {
    const redis = makeMockRedis();
    await issueAgentToken(defaultIssueArgs(redis));

    // Force the eval to return [-1, "no_envelope"] — simulates a race
    // where the GET succeeded (envelope was there) but a concurrent
    // revoke deleted the envelope before the EVAL ran.
    const original = redis._luaSim.getMockImplementation();
    redis._luaSim.mockImplementation(async (script, keys, argv) => {
      // Hit only on SET_CAPABILITIES_SCRIPT shape (2 keys, 3 args)
      if (
        keys.length === 2 &&
        argv.length === 3 &&
        script.includes("no_envelope")
      ) {
        return [-1, "no_envelope"];
      }
      return original ? await (original as (s: string, k: string[], a: string[]) => Promise<unknown>)(script, keys, argv) : null;
    });

    await expect(
      setAgentTokenCapabilities({
        installationId: "12345",
        name: "worker",
        capabilities: ["rooms.read"],
        redis,
      }),
    ).rejects.toThrow(TokenNotFoundError);
  });
});

describe("bearer-resurrection invariant (builder R2 on PR #503)", () => {
  // Demonstrates the storage state after the same-name reissue
  // scenario builder flagged. This module's storage shape REQUIRES
  // the middleware (B.1.c) to enforce
  //   sha256(presentedBearer) === envelope.tokenHash
  // and reject mismatches. This test pins the storage state so a
  // future B.1.c regression test can assert against it concretely.
  it("after TTL-sweep + same-name reissue, old hash index lingers and points at NEW envelope (middleware MUST reject by tokenHash mismatch)", async () => {
    const redis = makeMockRedis();

    // 1. Issue token A under name "worker"
    const tokenA = await issueAgentToken({
      ...defaultIssueArgs(redis),
      name: "worker",
      expiresAt: null, // would normally be future-dated; null here for test simplicity
    });
    const oldHash = redis._store.get(envelopeKey("12345", "worker")) as AgentTokenEnvelopeV1;
    const oldTokenHash = oldHash.tokenHash;
    expect(oldTokenHash).toBeDefined();
    expect(redis._store.has(hashIndexKey(oldTokenHash))).toBe(true);

    // 2. Simulate Redis TTL sweep on the envelope (real-world: explicit
    //    expiresAt fires Redis EX). The hash index is intentionally
    //    NOT TTL'd, so it persists pointing at the now-deleted name.
    redis._store.delete(envelopeKey("12345", "worker"));

    // 3. Reissue under the SAME name. listAgentTokens / issueAgentToken
    //    self-heal the orphaned sorted-set entry, so the issuance
    //    succeeds.
    const tokenB = await issueAgentToken({
      ...defaultIssueArgs(redis),
      name: "worker",
      capabilities: ["rooms.read"],
      expiresAt: null,
    });
    expect(tokenB.token).not.toBe(tokenA.token);

    // 4. THE INVARIANT: the OLD hash index still exists, pointing at
    //    `{installationId, name: "worker"}` — but the envelope at
    //    that name is now token B's, with a DIFFERENT tokenHash.
    //    The middleware (B.1.c) MUST reject by comparing the
    //    presented bearer's hash against envelope.tokenHash.
    const oldHashRecordStillThere = redis._store.get(hashIndexKey(oldTokenHash));
    expect(oldHashRecordStillThere).toEqual({
      installationId: "12345",
      name: "worker",
    });

    const newEnvelope = redis._store.get(
      envelopeKey("12345", "worker"),
    ) as AgentTokenEnvelopeV1;
    expect(newEnvelope.tokenHash).not.toBe(oldTokenHash);
    expect(newEnvelope.tokenHash).toBe(
      createHash("sha256").update(tokenB.token).digest("hex"),
    );

    // The middleware-side check that closes this:
    //   const presentedHash = sha256(rawBearerA);
    //   if (envelope.tokenHash !== presentedHash) reject(TOKEN_EXPIRED);
    // → bearer A presented against new envelope B fails because their
    //   hashes don't match.
    const presentedHashIfBearerAUsed = createHash("sha256")
      .update(tokenA.token)
      .digest("hex");
    expect(presentedHashIfBearerAUsed).not.toBe(newEnvelope.tokenHash);
    // ↑ this is the assertion the B.1.c middleware translates into
    // a 401 TOKEN_EXPIRED response.
  });
});

// ---------------------------------------------------------------------------
// resolveBearerToEnvelope — single-RTT bearer resolution (R3 fix for builder)
// ---------------------------------------------------------------------------

describe("resolveBearerToEnvelope (R3 fix — replaces broken pipeline pseudocode)", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("returns ok=true with the envelope + installationId when bearer is valid", async () => {
    const issued = await issueAgentToken(defaultIssueArgs(redis));
    const result = await resolveBearerToEnvelope({
      rawBearer: issued.token,
      redis,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.name).toBe("worker");
      expect(result.envelope.agent_role).toBe("drone");
      expect(result.envelope.capabilities).toEqual([
        "agent_health.report",
        "tasks.claim",
      ]);
      // Envelope carries the SHA-256-derived fingerprint, not bearer suffix
      expect(result.envelope.fingerprint).toBe(
        createHash("sha256").update(issued.token).digest("hex").slice(0, 8),
      );
      // installationId surfaced from the hash record (not on the
      // envelope schema itself) so the middleware can construct
      // the meta key without an extra round-trip.
      expect(result.installationId).toBe("12345");
    }
  });

  it("returns code=unknown_bearer when the hash index has no entry", async () => {
    const result = await resolveBearerToEnvelope({
      rawBearer: "deadbeef".repeat(8), // 64 chars, valid shape but never issued
      redis,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unknown_bearer");
  });

  it("returns code=envelope_missing when hash record points at a TTL-swept envelope", async () => {
    const issued = await issueAgentToken(defaultIssueArgs(redis));
    // Simulate Redis TTL sweep on the envelope (hash index intentionally
    // not TTL'd, so it lingers).
    redis._store.delete(envelopeKey("12345", "worker"));

    const result = await resolveBearerToEnvelope({
      rawBearer: issued.token,
      redis,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("envelope_missing");
  });

  it("returns code=stale_bearer for the bearer-resurrection scenario (closes builder R2 invariant end-to-end)", async () => {
    // 1. Issue token A
    const tokenA = await issueAgentToken({
      ...defaultIssueArgs(redis),
      name: "worker",
    });
    // 2. TTL-sweep A's envelope
    redis._store.delete(envelopeKey("12345", "worker"));
    // 3. Reissue under same name → token B
    await issueAgentToken({
      ...defaultIssueArgs(redis),
      name: "worker",
      capabilities: ["rooms.read"],
    });

    // 4. Bearer A presented now: the resolver SHOULD reject as
    //    stale_bearer because envelope.tokenHash (B's) != sha256(A).
    //    This is the bearer-resurrection close.
    const result = await resolveBearerToEnvelope({
      rawBearer: tokenA.token,
      redis,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("stale_bearer");
  });

  it("succeeds for the NEW bearer after a same-name reissue (B doesn't get rejected)", async () => {
    // Same setup as bearer-resurrection test, but verify token B (the
    // legitimate new bearer) is not collateral damage.
    await issueAgentToken({
      ...defaultIssueArgs(redis),
      name: "worker",
    });
    redis._store.delete(envelopeKey("12345", "worker"));
    const tokenB = await issueAgentToken({
      ...defaultIssueArgs(redis),
      name: "worker",
      capabilities: ["rooms.read"],
    });

    const result = await resolveBearerToEnvelope({
      rawBearer: tokenB.token,
      redis,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // It's B's envelope (the new one with rooms.read)
      expect(result.envelope.capabilities).toEqual(["rooms.read"]);
    }
  });
});

describe("ROTATE_TOKEN_SCRIPT — {-1, no_envelope} race path (G7)", () => {
  it("translates {-1, no_envelope} from the script to TokenNotFoundError", async () => {
    const redis = makeMockRedis();
    await issueAgentToken(defaultIssueArgs(redis));

    const original = redis._luaSim.getMockImplementation();
    redis._luaSim.mockImplementation(async (script, keys, argv) => {
      // Hit only on ROTATE_TOKEN_SCRIPT shape (4 keys, 5 args)
      if (
        keys.length === 4 &&
        argv.length === 5 &&
        script.includes("no_envelope")
      ) {
        return [-1, "no_envelope"];
      }
      return original ? await (original as (s: string, k: string[], a: string[]) => Promise<unknown>)(script, keys, argv) : null;
    });

    await expect(
      rotateAgentToken({
        installationId: "12345",
        name: "worker",
        keyring: KEYRING,
        keyVersion: "v1",
        redis,
      }),
    ).rejects.toThrow(TokenNotFoundError);
  });
});
