import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/agent-token-v1-auth", () => ({
  authenticateAgentRequestV1: vi.fn(),
}));

vi.mock("@hivemoot/war-room", async () => {
  const real = await vi.importActual<typeof import("@hivemoot/war-room")>(
    "@hivemoot/war-room",
  );
  return { ...real, getRoomCore: vi.fn() };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { getRoomCore, RoomNotFoundError } from "@hivemoot/war-room";
import { GET } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedCore = vi.mocked(getRoomCore);

// ---------------------------------------------------------------------------
// Mock Redis with smembers — guard pass-1 G1: statusIndexKey is a
// SET in war-room (SADD/SREM in war-room.ts:2269-2526), so the
// route MUST use SMEMBERS (not ZRANGE). Real Redis returns
// WRONGTYPE for ZRANGE against a SET. .zrange is intentionally
// undefined on the mock so a future regression to ZRANGE blows
// up loudly here.
// ---------------------------------------------------------------------------
function makeAuthOk(overrides?: { redisSmembers?: () => Promise<string[]> }) {
  return {
    ok: true as const,
    installationId: "12345",
    name: "queen",
    agent_role: "local_queen",
    capabilities: ["rooms.synthesize"],
    redis: {
      smembers: vi.fn(overrides?.redisSmembers ?? (async () => [])),
    } as never,
    envelope: { fingerprint: "fp", expiresAt: null } as never,
  };
}

function makeRoom(roomId: string, status: string, openedAt = "2026-05-09T00:00:00Z") {
  return {
    manager: "bot-queen",
    subject_type: "pr_review" as const,
    subject_ref: `owner/repo#${roomId.slice(0, 4)}`,
    opened_at: openedAt,
    status: status as "awaiting_contributions",
    timing_config: {
      max_age_secs: 86400,
      drop_threshold_secs: 600,
      quiet_period_secs: 60,
    },
    last_transition_at: openedAt,
    last_post_close_drift_count: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/rooms/synthesis-ready", () => {
  it("delegates 401 on missing bearer", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "agent_auth_v1_missing_bearer" }, { status: 401 }),
    });
    const res = await GET(new NextRequest("https://www.hivemoot.dev/api/rooms/synthesis-ready"));
    expect(res.status).toBe(401);
  });

  it("requires rooms.synthesize capability", async () => {
    const auth = makeAuthOk();
    mockedAuth.mockResolvedValue(auth);
    await GET(new NextRequest("https://www.hivemoot.dev/api/rooms/synthesis-ready"));
    expect(mockedAuth).toHaveBeenCalledWith(expect.any(NextRequest), {
      requires: "rooms.synthesize",
    });
  });

  it("returns rooms in awaiting_contributions only", async () => {
    const auth = makeAuthOk({
      redisSmembers: async () => ["rm-1", "rm-2", "rm-3"],
    });
    mockedAuth.mockResolvedValue(auth);
    mockedCore
      .mockResolvedValueOnce(makeRoom("rm-1", "awaiting_contributions"))
      .mockResolvedValueOnce(makeRoom("rm-2", "deciding")) // raced
      .mockResolvedValueOnce(makeRoom("rm-3", "awaiting_contributions"));
    const res = await GET(new NextRequest("https://www.hivemoot.dev/api/rooms/synthesis-ready"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    // Both rooms have the same opened_at; the tie-breaker is roomId
    // ascending — rm-1 before rm-3.
    expect(body.rooms.map((r: { roomId: string }) => r.roomId)).toEqual(["rm-1", "rm-3"]);
  });

  it("filters out rooms whose hash has been concurrently deleted (RoomNotFoundError swallowed)", async () => {
    // Stale-index race: the room transitioned out of
    // awaiting_contributions and its hash was deleted between the
    // SMEMBERS read and the per-room hydrate. The route swallows
    // RoomNotFoundError specifically (and ONLY that class — see the
    // separate "real failure → 500" test below).
    const auth = makeAuthOk({
      redisSmembers: async () => ["rm-1", "rm-stale"],
    });
    mockedAuth.mockResolvedValue(auth);
    mockedCore
      .mockResolvedValueOnce(makeRoom("rm-1", "awaiting_contributions"))
      .mockRejectedValueOnce(new RoomNotFoundError("12345", "rm-stale"));
    const res = await GET(new NextRequest("https://www.hivemoot.dev/api/rooms/synthesis-ready"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.rooms[0].roomId).toBe("rm-1");
  });

  it("real Redis failure during hydrate → 500 (NOT silently empty list, builder pass-2 fix)", async () => {
    // Pre pass-2, a generic catch swallowed every failure as `null`,
    // turning a Redis read error into `count: 0` — the local queen
    // then read "no work to do" and went idle. The narrowed catch
    // rethrows non-RoomNotFoundError so the outer storage_failure
    // branch fires.
    const auth = makeAuthOk({
      redisSmembers: async () => ["rm-1"],
    });
    mockedAuth.mockResolvedValue(auth);
    mockedCore.mockRejectedValueOnce(new Error("ECONNREFUSED redis://..."));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(new NextRequest("https://www.hivemoot.dev/api/rooms/synthesis-ready"));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "storage_failure" });
    errSpy.mockRestore();
  });

  it("sorts the response newest-first by opened_at (post-hoc, since SETs are unordered)", async () => {
    // SMEMBERS is unordered — the test puts the oldest room first
    // and expects the response to flip to newest-first.
    const auth = makeAuthOk({
      redisSmembers: async () => ["rm-old", "rm-new", "rm-mid"],
    });
    mockedAuth.mockResolvedValue(auth);
    mockedCore.mockImplementation(async ({ roomId }) => {
      if (roomId === "rm-old") return makeRoom(roomId, "awaiting_contributions", "2026-01-01T00:00:00Z");
      if (roomId === "rm-mid") return makeRoom(roomId, "awaiting_contributions", "2026-03-01T00:00:00Z");
      if (roomId === "rm-new") return makeRoom(roomId, "awaiting_contributions", "2026-05-01T00:00:00Z");
      throw new Error(`unexpected ${roomId}`);
    });
    const res = await GET(new NextRequest("https://www.hivemoot.dev/api/rooms/synthesis-ready"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms.map((r: { roomId: string }) => r.roomId)).toEqual([
      "rm-new",
      "rm-mid",
      "rm-old",
    ]);
  });

  it("uses SMEMBERS (not ZRANGE) against the awaiting_contributions status SET (G1 pin)", async () => {
    // The mock's `.zrange` is intentionally undefined — if a future
    // change copies ZRANGE back, this test fails with
    // "redis.zrange is not a function" inside GET(), pinning the
    // SMEMBERS contract loudly. statusIndexKey is a SET (SADD/SREM
    // in war-room.ts:2269-2526), so ZRANGE returns WRONGTYPE in
    // real Redis.
    const smembersSpy = vi.fn(async () => []);
    mockedAuth.mockResolvedValue(makeAuthOk({ redisSmembers: smembersSpy }));
    const res = await GET(
      new NextRequest("https://www.hivemoot.dev/api/rooms/synthesis-ready"),
    );
    expect(res.status).toBe(200);
    expect(smembersSpy).toHaveBeenCalledWith(
      "hive:v1:idx:room:status:12345:awaiting_contributions",
    );
  });

  it("respects the limit query param (slices post-hoc, since SET has no count cap)", async () => {
    const auth = makeAuthOk({
      redisSmembers: async () => ["rm-1", "rm-2", "rm-3"],
    });
    mockedAuth.mockResolvedValue(auth);
    mockedCore.mockImplementation(async ({ roomId }) =>
      makeRoom(roomId, "awaiting_contributions", `2026-05-0${roomId.slice(-1)}T00:00:00Z`),
    );
    const res = await GET(
      new NextRequest("https://www.hivemoot.dev/api/rooms/synthesis-ready?limit=2"),
    );
    const body = await res.json();
    expect(body.count).toBe(2);
    // Newest two only.
    expect(body.rooms.map((r: { roomId: string }) => r.roomId)).toEqual(["rm-3", "rm-2"]);
  });

  it("caps limit at 200", async () => {
    const auth = makeAuthOk({
      redisSmembers: async () => Array.from({ length: 250 }, (_, i) => `rm-${i}`),
    });
    mockedAuth.mockResolvedValue(auth);
    mockedCore.mockImplementation(async ({ roomId }) =>
      makeRoom(roomId, "awaiting_contributions"),
    );
    const res = await GET(
      new NextRequest("https://www.hivemoot.dev/api/rooms/synthesis-ready?limit=99999"),
    );
    const body = await res.json();
    expect(body.count).toBe(200);
  });

  it("returns 500 on storage error", async () => {
    mockedAuth.mockResolvedValue(
      makeAuthOk({
        redisSmembers: async () => {
          throw new Error("redis down");
        },
      }),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(new NextRequest("https://www.hivemoot.dev/api/rooms/synthesis-ready"));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "storage_failure" });
    errSpy.mockRestore();
  });
});
