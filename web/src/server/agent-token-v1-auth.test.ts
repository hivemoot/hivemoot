/**
 * Unit tests for the V1 agent-token auth middleware.
 *
 * Reuses the storage-layer mock from agent-token-v1.test.ts logic
 * (inlined here since we need a slightly different surface — env
 * mocking, request factory). The Lua simulator handles the same
 * 5 scripts (issue/revoke/setCaps/rotate/resolve) per the storage
 * layer, plus the lock-release script.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { type Redis } from "@upstash/redis";
import { NextRequest } from "next/server";

import {
  authenticateAgentRequestV1,
  AGENT_AUTH_V1_ERROR,
  LAST_USED_AT_DEBOUNCE_SECONDS,
} from "./agent-token-v1-auth";
import {
  issueAgentToken,
  envelopeMetaKey,
} from "./agent-token-v1";

// ---------------------------------------------------------------------------
// Env + redis-client mocks
// ---------------------------------------------------------------------------

vi.mock("@/server/env", () => ({
  validateEnv: vi.fn(() => ({
    ok: true,
    config: {
      redisRestUrl: "https://fake.upstash.io",
      redisRestToken: "fake-token",
    },
  })),
}));

vi.mock("@/server/redis", () => ({
  getRedisClient: vi.fn(),
}));

import { getRedisClient } from "@/server/redis";
const mockedGetRedis = vi.mocked(getRedisClient);

// ---------------------------------------------------------------------------
// Mock Redis (shared semantics with agent-token-v1.test.ts)
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

  const luaSim = vi.fn(
    async (script: string, keys: string[], argv: string[]) => {
      // RELEASE_LOCK_SCRIPT (1 key, 1 arg)
      if (
        keys.length === 1 &&
        argv.length === 1 &&
        script.includes("ARGV[1]") &&
        !script.includes("name_taken")
      ) {
        if (store.get(keys[0]) === argv[0]) {
          store.delete(keys[0]);
          return 1;
        }
        return 0;
      }
      // ISSUE_TOKEN_SCRIPT (4 keys, 7 args)
      if (
        keys.length === 4 &&
        argv.length === 7 &&
        script.includes("name_taken")
      ) {
        const [envelopeK, hashIdxK, instIdxK] = keys;
        const [name, envelopeJson, hashRecordJson, createdAtMs, tokenLimit] =
          argv;
        if (store.has(envelopeK)) return [0, "name_taken"];
        const set = getSortedSet(instIdxK);
        if (set.length >= Number(tokenLimit)) return [-1, "limit"];
        store.set(envelopeK, JSON.parse(envelopeJson));
        store.set(hashIdxK, JSON.parse(hashRecordJson));
        set.push({ member: name, score: Number(createdAtMs) });
        set.sort((a, b) => a.score - b.score);
        return [1, name];
      }
      // RESOLVE_BEARER_SCRIPT (1 key, 2 args)
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
    zrange: vi.fn(async (key: string, _start: number, _stop: number) => {
      const set = getSortedSet(key);
      return set.map((e) => e.member);
    }),
    zrem: vi.fn(async (key: string, member: string) => {
      const set = getSortedSet(key);
      const idx = set.findIndex((e) => e.member === member);
      if (idx === -1) return 0;
      set.splice(idx, 1);
      return 1;
    }),
    hget: vi.fn(async (key: string, field: string) => {
      const hash = store.get(key);
      if (!hash || typeof hash !== "object") return null;
      const val = (hash as Record<string, unknown>)[field];
      return val ?? null;
    }),
    hset: vi.fn(async (key: string, value: Record<string, unknown>) => {
      const existing = store.get(key);
      if (existing && typeof existing === "object") {
        Object.assign(existing as Record<string, unknown>, value);
      } else {
        store.set(key, { ...value });
      }
      return Object.keys(value).length;
    }),
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

function makeRequest(token: string | null): NextRequest {
  const headers = new Headers();
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return new NextRequest("https://www.hivemoot.dev/api/test", {
    method: "POST",
    headers,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("authenticateAgentRequestV1 — unauthenticated paths", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
    mockedGetRedis.mockReturnValue(redis as unknown as Redis);
  });

  it("missing Authorization header → 401 MISSING_BEARER", async () => {
    const result = await authenticateAgentRequestV1(makeRequest(null), {
      requires: "tasks.claim",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.code).toBe(AGENT_AUTH_V1_ERROR.MISSING_BEARER);
    }
  });

  it("malformed Authorization header (not Bearer) → 401 MISSING_BEARER", async () => {
    const headers = new Headers();
    headers.set("authorization", "Basic abc:def");
    const req = new NextRequest("https://www.hivemoot.dev/api/test", {
      method: "POST",
      headers,
    });
    const result = await authenticateAgentRequestV1(req, {
      requires: "tasks.claim",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("unknown bearer (hash index miss) → 401 UNKNOWN_BEARER", async () => {
    const result = await authenticateAgentRequestV1(
      makeRequest("a".repeat(64)),
      { requires: "tasks.claim" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.code).toBe(AGENT_AUTH_V1_ERROR.UNKNOWN_BEARER);
    }
  });
});

describe("authenticateAgentRequestV1 — happy path", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
    mockedGetRedis.mockReturnValue(redis as unknown as Redis);
  });

  it("valid bearer with required cap → ok=true with full identity", async () => {
    const issued = await issueAgentToken({
      installationId: "12345",
      name: "worker",
      agent_role: "drone",
      capabilities: ["agent_health.report", "tasks.claim"],
      createdBy: "operator",
      expiresAt: null,
      keyring: KEYRING,
      keyVersion: "v1",
      redis,
    });

    const result = await authenticateAgentRequestV1(
      makeRequest(issued.token),
      { requires: "tasks.claim" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installationId).toBe("12345");
      expect(result.name).toBe("worker");
      expect(result.agent_role).toBe("drone");
      expect(result.capabilities).toEqual([
        "agent_health.report",
        "tasks.claim",
      ]);
      expect(result.envelope.tokenHash).toBeDefined();
    }
  });

  it("requires=null (no cap check) → success on any valid bearer", async () => {
    const issued = await issueAgentToken({
      installationId: "12345",
      name: "monitor",
      agent_role: "monitoring",
      capabilities: ["agent_health.read"],
      createdBy: "operator",
      expiresAt: null,
      keyring: KEYRING,
      keyVersion: "v1",
      redis,
    });

    const result = await authenticateAgentRequestV1(
      makeRequest(issued.token),
      { requires: null },
    );
    expect(result.ok).toBe(true);
  });

  it("wildcard capability bearer satisfies any required cap", async () => {
    const issued = await issueAgentToken({
      installationId: "12345",
      name: "admin",
      agent_role: "admin",
      capabilities: ["*"],
      createdBy: "operator",
      expiresAt: null,
      keyring: KEYRING,
      keyVersion: "v1",
      redis,
    });

    const result = await authenticateAgentRequestV1(
      makeRequest(issued.token),
      { requires: "tasks.claim" },
    );
    expect(result.ok).toBe(true);
  });
});

describe("authenticateAgentRequestV1 — capability check", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
    mockedGetRedis.mockReturnValue(redis as unknown as Redis);
  });

  it("bearer lacks required cap → 403 MISSING_CAPABILITY with structured body", async () => {
    const issued = await issueAgentToken({
      installationId: "12345",
      name: "worker",
      agent_role: "drone",
      capabilities: ["agent_health.report"], // missing tasks.claim
      createdBy: "operator",
      expiresAt: null,
      keyring: KEYRING,
      keyVersion: "v1",
      redis,
    });

    const result = await authenticateAgentRequestV1(
      makeRequest(issued.token),
      { requires: "tasks.claim" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.code).toBe(AGENT_AUTH_V1_ERROR.MISSING_CAPABILITY);
      expect(body.required).toBe("tasks.claim");
      expect(body.granted).toEqual(["agent_health.report"]);
    }
  });

  it("admin bearer with bare * does NOT satisfy agent_tokens.manage (admin-class carve-out)", async () => {
    // Bare `*` excludes ADMIN_CLASS_CAPABILITIES per the design's
    // R2 N3 fix. Verify that the wildcard expansion in the
    // middleware honors the carve-out.
    const issued = await issueAgentToken({
      installationId: "12345",
      name: "almost-admin",
      agent_role: "admin",
      capabilities: ["*"],
      createdBy: "operator",
      expiresAt: null,
      keyring: KEYRING,
      keyVersion: "v1",
      redis,
    });

    const result = await authenticateAgentRequestV1(
      makeRequest(issued.token),
      { requires: "agent_tokens.manage" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
  });

  it("explicit agent_tokens.manage in caps works", async () => {
    const issued = await issueAgentToken({
      installationId: "12345",
      name: "real-admin",
      agent_role: "admin",
      capabilities: ["*", "agent_tokens.manage"],
      createdBy: "operator",
      expiresAt: null,
      keyring: KEYRING,
      keyVersion: "v1",
      redis,
    });

    const result = await authenticateAgentRequestV1(
      makeRequest(issued.token),
      { requires: "agent_tokens.manage" },
    );
    expect(result.ok).toBe(true);
  });
});

describe("authenticateAgentRequestV1 — bearer-resurrection (B.1.b invariant end-to-end)", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
    mockedGetRedis.mockReturnValue(redis as unknown as Redis);
  });

  it("old bearer presented after same-name reissue → 401 TOKEN_EXPIRED (NOT auth success under new envelope's identity)", async () => {
    // 1. Issue token A under "worker"
    const tokenA = await issueAgentToken({
      installationId: "12345",
      name: "worker",
      agent_role: "drone",
      capabilities: ["tasks.claim"],
      createdBy: "operator",
      expiresAt: null,
      keyring: KEYRING,
      keyVersion: "v1",
      redis,
    });

    // 2. Simulate Redis TTL sweep on A's envelope (the exact
    //    scenario CAPABILITIES_DESIGN.md "Latency + bearer-
    //    resurrection" defends against).
    const aEnvKey = `hive:v1:agent-token:12345:worker`;
    redis._store.delete(aEnvKey);

    // 3. Reissue under SAME name → token B with different caps
    await issueAgentToken({
      installationId: "12345",
      name: "worker",
      agent_role: "drone",
      capabilities: ["rooms.read"],
      createdBy: "operator",
      expiresAt: null,
      keyring: KEYRING,
      keyVersion: "v1",
      redis,
    });

    // 4. Present bearer A. The middleware MUST reject as
    //    TOKEN_EXPIRED (the resolver returns stale_bearer; the
    //    middleware translates to a TOKEN_EXPIRED response).
    //    This is the B.1.c acceptance criterion from the design
    //    doc.
    const result = await authenticateAgentRequestV1(
      makeRequest(tokenA.token),
      { requires: "tasks.claim" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.code).toBe(AGENT_AUTH_V1_ERROR.TOKEN_EXPIRED);
    }
  });
});

describe("authenticateAgentRequestV1 — expiresAt wall-clock check", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
    mockedGetRedis.mockReturnValue(redis as unknown as Redis);
  });

  it("envelope with expiresAt in past → 401 TOKEN_EXPIRED", async () => {
    const issued = await issueAgentToken({
      installationId: "12345",
      name: "worker",
      agent_role: "drone",
      capabilities: ["tasks.claim"],
      createdBy: "operator",
      expiresAt: null,
      keyring: KEYRING,
      keyVersion: "v1",
      redis,
    });
    // Mutate the stored envelope so its expiresAt is in the past.
    // Bypass the storage layer's issue-time validation (which would
    // have rejected past expiresAt).
    const envKey = `hive:v1:agent-token:12345:worker`;
    const envelope = redis._store.get(envKey) as Record<string, unknown>;
    envelope.expiresAt = new Date(Date.now() - 60_000).toISOString();
    redis._store.set(envKey, envelope);

    const result = await authenticateAgentRequestV1(
      makeRequest(issued.token),
      { requires: "tasks.claim" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const body = await result.response.json();
      expect(body.code).toBe(AGENT_AUTH_V1_ERROR.TOKEN_EXPIRED);
    }
  });
});

describe("authenticateAgentRequestV1 — lastUsedAt write strategy", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
    mockedGetRedis.mockReturnValue(redis as unknown as Redis);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("first auth writes lastUsedAt to the :meta key", async () => {
    const issued = await issueAgentToken({
      installationId: "12345",
      name: "worker",
      agent_role: "drone",
      capabilities: ["tasks.claim"],
      createdBy: "operator",
      expiresAt: null,
      keyring: KEYRING,
      keyVersion: "v1",
      redis,
    });

    const result = await authenticateAgentRequestV1(
      makeRequest(issued.token),
      { requires: "tasks.claim" },
    );
    expect(result.ok).toBe(true);

    // Allow the fire-and-forget to complete
    await new Promise((resolve) => setImmediate(resolve));

    const metaKey = envelopeMetaKey("12345", "worker");
    const meta = redis._store.get(metaKey) as
      | { lastUsedAt?: string }
      | undefined;
    expect(meta?.lastUsedAt).toBeDefined();
  });

  it("repeated auth within debounce window does NOT touch the meta key again", async () => {
    const issued = await issueAgentToken({
      installationId: "12345",
      name: "worker",
      agent_role: "drone",
      capabilities: ["tasks.claim"],
      createdBy: "operator",
      expiresAt: null,
      keyring: KEYRING,
      keyVersion: "v1",
      redis,
    });

    // First auth: should hset
    await authenticateAgentRequestV1(makeRequest(issued.token), {
      requires: "tasks.claim",
    });
    await new Promise((resolve) => setImmediate(resolve));

    const hsetCallsAfterFirst = (redis.hset as ReturnType<typeof vi.fn>).mock
      .calls.length;

    // Second auth, immediately after: hset should NOT be called again
    await authenticateAgentRequestV1(makeRequest(issued.token), {
      requires: "tasks.claim",
    });
    await new Promise((resolve) => setImmediate(resolve));

    const hsetCallsAfterSecond = (redis.hset as ReturnType<typeof vi.fn>).mock
      .calls.length;
    expect(hsetCallsAfterSecond).toBe(hsetCallsAfterFirst);
  });

  it("skipLastUsedAtWrite=true skips the write entirely (for /whoami snapshot endpoint)", async () => {
    const issued = await issueAgentToken({
      installationId: "12345",
      name: "worker",
      agent_role: "drone",
      capabilities: ["tasks.claim"],
      createdBy: "operator",
      expiresAt: null,
      keyring: KEYRING,
      keyVersion: "v1",
      redis,
    });

    await authenticateAgentRequestV1(makeRequest(issued.token), {
      requires: null,
      skipLastUsedAtWrite: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    // hget AND hset should both be untouched
    expect(
      (redis.hget as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
    expect(
      (redis.hset as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
  });

  it("debounce constant is exported and matches the design (60s)", () => {
    expect(LAST_USED_AT_DEBOUNCE_SECONDS).toBe(60);
  });
});

describe("authenticateAgentRequestV1 — server misconfiguration", () => {
  it("env validation failure → 503 SERVER_MISCONFIGURATION", async () => {
    const validateEnvMock = (
      await import("@/server/env")
    ).validateEnv as ReturnType<typeof vi.fn>;
    validateEnvMock.mockReturnValueOnce({ ok: false });
    const result = await authenticateAgentRequestV1(makeRequest("abc"), {
      requires: "tasks.claim",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      const body = await result.response.json();
      expect(body.code).toBe(AGENT_AUTH_V1_ERROR.SERVER_MISCONFIGURATION);
    }
  });
});
