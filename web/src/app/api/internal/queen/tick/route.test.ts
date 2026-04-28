/**
 * Tests for POST /api/internal/queen/tick — Vercel Cron route.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@upstash/redis", () => {
  const fakeRedis = {
    set: vi.fn(),
    eval: vi.fn(),
    get: vi.fn(),
  };
  return {
    Redis: { fromEnv: vi.fn(() => fakeRedis) },
    __fakeRedis: fakeRedis,
  };
});

vi.mock("@/server/queen-tick", () => ({
  runQueenTick: vi.fn(),
  queenTickLockKey: (id: string) => `hive:v1:lock:queen-tick:${id}`,
  QUEEN_TICK_LOCK_RELEASE_SCRIPT: "MOCK_RELEASE_SCRIPT",
  QUEEN_TICK_LOCK_TTL_SECS: 55,
}));

import * as upstash from "@upstash/redis";
import { runQueenTick } from "@/server/queen-tick";
import { POST, GET } from "./route";

const fakeRedis = (upstash as never as { __fakeRedis: { set: ReturnType<typeof vi.fn>; eval: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } }).__fakeRedis;
const mockedTick = vi.mocked(runQueenTick);

const CRON_SECRET = "test-cron-secret";

function makeRequest(body: unknown, opts?: { authHeader?: string }): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts?.authHeader !== undefined) {
    headers.authorization = opts.authHeader;
  } else {
    headers.authorization = `Bearer ${CRON_SECRET}`;
  }
  return new NextRequest("https://www.hivemoot.dev/api/internal/queen/tick", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/queen/tick", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    fakeRedis.set.mockReset();
    fakeRedis.eval.mockReset();
    fakeRedis.get.mockReset();
    mockedTick.mockReset();
  });

  it("returns 500 when CRON_SECRET is unset (server misconfiguration fail-loud)", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await POST(makeRequest({ installationId: "12345" }));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("server_misconfiguration");
  });

  it("rejects missing Authorization header → 401 with empty body (no oracle per design L967)", async () => {
    const req = new NextRequest("https://www.hivemoot.dev/api/internal/queen/tick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId: "12345" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    // Body must be empty per design — no probing differential
    expect(await res.text()).toBe("");
  });

  it("rejects wrong bearer → 401 empty body", async () => {
    const res = await POST(
      makeRequest({ installationId: "12345" }, { authHeader: "Bearer wrong" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects missing installationId → 400", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_installation_id");
  });

  it("rejects null body → 400 invalid_body_shape", async () => {
    const res = await POST(makeRequest(null));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_body_shape");
  });

  it("happy path: acquires lock, runs tick, releases lock", async () => {
    fakeRedis.set.mockResolvedValue("OK");
    fakeRedis.eval.mockResolvedValue(1);
    mockedTick.mockResolvedValue({
      scannedDeciding: 2,
      recovered: 1,
      scannedOpen: 5,
      expired: 1,
      scannedAwaitingContributions: 3,
      timedOutParticipants: 2,
      errors: 0,
    });

    const res = await POST(makeRequest({ installationId: "12345" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(false);
    expect(body.runnerId).toMatch(/^vercel\./);
    expect(body.result.recovered).toBe(1);
    expect(body.result.expired).toBe(1);
    expect(body.result.timedOutParticipants).toBe(2);

    // Lock acquisition: SET key value NX EX 55
    expect(fakeRedis.set).toHaveBeenCalledWith(
      "hive:v1:lock:queen-tick:12345",
      expect.stringMatching(/^vercel\./),
      { nx: true, ex: 55 },
    );
    // Lock release via eval (compare-and-DEL Lua)
    expect(fakeRedis.eval).toHaveBeenCalledWith(
      "MOCK_RELEASE_SCRIPT",
      ["hive:v1:lock:queen-tick:12345"],
      [expect.stringMatching(/^vercel\./)],
    );
  });

  it("lock contention → 200 skipped (overlapping fires no-op)", async () => {
    fakeRedis.set.mockResolvedValue(null); // SET NX returns null on contention
    const res = await POST(makeRequest({ installationId: "12345" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("lock_contention");
    // Tick body NOT invoked
    expect(mockedTick).not.toHaveBeenCalled();
    // Lock NOT released — we never held it
    expect(fakeRedis.eval).not.toHaveBeenCalled();
  });

  it("tick error → 500, but lock STILL released in finally", async () => {
    fakeRedis.set.mockResolvedValue("OK");
    fakeRedis.eval.mockResolvedValue(1);
    mockedTick.mockRejectedValue(new Error("Redis cluster down"));

    const res = await POST(makeRequest({ installationId: "12345" }));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("tick_failed");
    // CRITICAL — the lock release happens in finally, otherwise
    // the next tick would skip-on-contention until TTL expires.
    expect(fakeRedis.eval).toHaveBeenCalledWith(
      "MOCK_RELEASE_SCRIPT",
      expect.any(Array),
      expect.any(Array),
    );
  });

  it("release error is swallowed (lock will TTL out regardless)", async () => {
    fakeRedis.set.mockResolvedValue("OK");
    fakeRedis.eval.mockRejectedValue(new Error("Redis hiccup"));
    mockedTick.mockResolvedValue({
      scannedDeciding: 0,
      recovered: 0,
      scannedOpen: 0,
      expired: 0,
      scannedAwaitingContributions: 0,
      timedOutParticipants: 0,
      errors: 0,
    });

    const res = await POST(makeRequest({ installationId: "12345" }));
    // Tick result was successful — release error is logged-and-continue
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe(false);
  });

  it("unique runnerId per request (lock value must be unguessable for compare-and-DEL safety)", async () => {
    fakeRedis.set.mockResolvedValue("OK");
    fakeRedis.eval.mockResolvedValue(1);
    mockedTick.mockResolvedValue({
      scannedDeciding: 0,
      recovered: 0,
      scannedOpen: 0,
      expired: 0,
      scannedAwaitingContributions: 0,
      timedOutParticipants: 0,
      errors: 0,
    });

    const res1 = await POST(makeRequest({ installationId: "12345" }));
    const res2 = await POST(makeRequest({ installationId: "12345" }));
    const r1 = await res1.json();
    const r2 = await res2.json();
    expect(r1.runnerId).not.toBe(r2.runnerId);
  });
});

describe("GET /api/internal/queen/tick", () => {
  it("returns 405 method_not_allowed", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });
});
