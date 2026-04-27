import { describe, it, expect, vi, beforeEach } from "vitest";
import { type Redis } from "@upstash/redis";

import {
  auditAppend,
  buildAuditEntryJson,
  auditStreamKey,
  authStreamKey,
  AUDIT_STREAM_MAXLEN,
  AUTH_STREAM_MAXLEN,
  type AuditMutationEntry,
  type AuditAuthEntry,
} from "./agent-token-v1-audit";

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------
//
// Captures Lua-script invocations and decodes the XADD shape.

function makeMockRedis() {
  const xaddCalls: Array<{ key: string; maxlen: number; entryJson: string }> = [];

  const luaSim = vi.fn(
    async (script: string, keys: string[], argv: string[]) => {
      // XADD_AUDIT_SCRIPT: 1 key, 2 args
      if (
        keys.length === 1 &&
        argv.length === 2 &&
        script.includes('redis.call("xadd"')
      ) {
        xaddCalls.push({
          key: keys[0],
          maxlen: Number(argv[0]),
          entryJson: argv[1],
        });
        return "1234567890-0";
      }
      return null;
    },
  );

  return {
    "eval": luaSim,
    _xaddCalls: xaddCalls,
    _luaSim: luaSim,
  } as unknown as Redis & {
    _xaddCalls: typeof xaddCalls;
    _luaSim: ReturnType<typeof vi.fn>;
  };
}

// ---------------------------------------------------------------------------
// Stream key helpers
// ---------------------------------------------------------------------------

describe("auditStreamKey + authStreamKey", () => {
  it("auditStreamKey uses the :audit suffix on the v1 envelope prefix", () => {
    expect(auditStreamKey("12345")).toBe(
      "hive:v1:agent-token:12345:audit",
    );
  });

  it("authStreamKey uses the :auth suffix on the v1 envelope prefix", () => {
    expect(authStreamKey("12345")).toBe(
      "hive:v1:agent-token:12345:auth",
    );
  });

  it("the two streams are distinct (closes guard R2 N2 — separate trim budgets)", () => {
    expect(auditStreamKey("12345")).not.toBe(authStreamKey("12345"));
  });
});

describe("MAXLEN constants match the design doc retention math", () => {
  it("AUDIT_STREAM_MAXLEN = 10000 (mutations effectively unbounded at <10/day)", () => {
    expect(AUDIT_STREAM_MAXLEN).toBe(10000);
  });

  it("AUTH_STREAM_MAXLEN = 100000 (hours-to-days at single-Hive load)", () => {
    expect(AUTH_STREAM_MAXLEN).toBe(100000);
  });
});

// ---------------------------------------------------------------------------
// auditAppend — routing + content
// ---------------------------------------------------------------------------

describe("auditAppend — mutation events route to :audit stream", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
  });

  it.each([
    ["issue"],
    ["revoke"],
    ["set_capabilities"],
    ["rotate"],
    ["bootstrap"],
  ] as const)(
    "%s → :audit stream with AUDIT_STREAM_MAXLEN",
    async (action) => {
      const entry: AuditMutationEntry = {
        ts: new Date().toISOString(),
        fingerprint: "abcd1234",
        name: "worker",
        action,
        actor: "operator",
      };
      await auditAppend({
        redis,
        installationId: "12345",
        entry,
      });
      expect(redis._xaddCalls).toHaveLength(1);
      expect(redis._xaddCalls[0].key).toBe(auditStreamKey("12345"));
      expect(redis._xaddCalls[0].maxlen).toBe(AUDIT_STREAM_MAXLEN);
      const parsed = JSON.parse(redis._xaddCalls[0].entryJson);
      expect(parsed.action).toBe(action);
    },
  );
});

describe("auditAppend — auth events route to :auth stream", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
  });

  it.each([["auth.success"], ["auth.failure"]] as const)(
    "%s → :auth stream with AUTH_STREAM_MAXLEN",
    async (action) => {
      const entry: AuditAuthEntry = {
        ts: new Date().toISOString(),
        fingerprint: "abcd1234",
        name: "worker",
        action,
        endpoint: "GET /api/whoami",
        required_capability: null,
        outcome: "ok",
      };
      await auditAppend({
        redis,
        installationId: "12345",
        entry,
      });
      expect(redis._xaddCalls).toHaveLength(1);
      expect(redis._xaddCalls[0].key).toBe(authStreamKey("12345"));
      expect(redis._xaddCalls[0].maxlen).toBe(AUTH_STREAM_MAXLEN);
    },
  );
});

describe("auditAppend — security: never logs raw bearer", () => {
  it("AuditEntry shape has no `token` field — only fingerprint", () => {
    const entry: AuditMutationEntry = {
      ts: new Date().toISOString(),
      fingerprint: "abcd1234",
      name: "worker",
      action: "issue",
      actor: "operator",
    };
    const json = buildAuditEntryJson(entry);
    expect(json).not.toMatch(/"token"\s*:/);
    expect(json).toContain('"fingerprint":"abcd1234"');
  });
});

describe("auditAppend — failure mode (best-effort, never throws)", () => {
  it("Redis errors are caught, logged, and don't propagate", async () => {
    const consoleWarn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    const failingRedis = {
      "eval": vi.fn(async () => {
        throw new Error("simulated Redis outage");
      }),
    } as unknown as Redis;

    const entry: AuditMutationEntry = {
      ts: new Date().toISOString(),
      fingerprint: "abcd1234",
      name: "worker",
      action: "issue",
      actor: "operator",
    };

    await expect(
      auditAppend({
        redis: failingRedis,
        installationId: "12345",
        entry,
      }),
    ).resolves.toBeUndefined();

    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("auditAppend failed"),
      expect.any(Error),
    );
    consoleWarn.mockRestore();
  });
});

describe("buildAuditEntryJson — symmetric with auditAppend payload", () => {
  it("produces the same JSON string the script would receive", () => {
    const entry: AuditMutationEntry = {
      ts: "2026-04-27T13:00:00.000Z",
      fingerprint: "abcd1234",
      name: "worker",
      action: "set_capabilities",
      actor: "admin-token",
      detail: { from: ["tasks.claim"], to: ["tasks.claim", "rooms.read"] },
    };
    const json = buildAuditEntryJson(entry);
    const parsed = JSON.parse(json);
    expect(parsed.action).toBe("set_capabilities");
    expect(parsed.detail.from).toEqual(["tasks.claim"]);
    expect(parsed.detail.to).toEqual(["tasks.claim", "rooms.read"]);
  });
});
