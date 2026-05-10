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
// SET (SADD/SREM in war-room.ts:2269-2526). Real Redis returns
// WRONGTYPE for ZRANGE against a SET; .zrange is left undefined on
// the stub so a regression to ZRANGE blows up loudly here.
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

function makeRoom(status: string, openedAt = "2026-05-09T00:00:00Z") {
  return {
    manager: "bot-queen",
    subject_type: "pr_review" as const,
    subject_ref: "owner/repo#1",
    opened_at: openedAt,
    status: status as "decided_pending_action",
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

describe("GET /api/rooms/decided-pending-ready", () => {
  it("delegates 401 on missing bearer", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "agent_auth_v1_missing_bearer" }, { status: 401 }),
    });
    const res = await GET(
      new NextRequest("https://www.hivemoot.dev/api/rooms/decided-pending-ready"),
    );
    expect(res.status).toBe(401);
  });

  it("requires rooms.synthesize capability (same as synthesis-ready)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    await GET(
      new NextRequest("https://www.hivemoot.dev/api/rooms/decided-pending-ready"),
    );
    expect(mockedAuth).toHaveBeenCalledWith(expect.any(NextRequest), {
      requires: "rooms.synthesize",
    });
  });

  it("returns empty when no rooms in decided_pending_action (today's expected default)", async () => {
    // No code path SADDs to the decided_pending_action index until
    // PR 3c's seal-decision endpoint ships, so this test pins the
    // "today's behavior is empty" contract.
    mockedAuth.mockResolvedValue(makeAuthOk({ redisSmembers: async () => [] }));
    const res = await GET(
      new NextRequest("https://www.hivemoot.dev/api/rooms/decided-pending-ready"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rooms: [], count: 0 });
  });

  it("uses SMEMBERS (not ZRANGE) against the decided_pending_action status SET (G1 pin)", async () => {
    // .zrange is intentionally undefined on the mock — if the route
    // ever regresses to ZRANGE, GET() throws and this test fails
    // loudly. statusIndexKey is a SET; ZRANGE returns WRONGTYPE
    // against a SET in real Redis.
    const smembersSpy = vi.fn(async () => []);
    mockedAuth.mockResolvedValue(makeAuthOk({ redisSmembers: smembersSpy }));
    const res = await GET(
      new NextRequest("https://www.hivemoot.dev/api/rooms/decided-pending-ready"),
    );
    expect(res.status).toBe(200);
    expect(smembersSpy).toHaveBeenCalledWith(
      "hive:v1:idx:room:status:12345:decided_pending_action",
    );
  });

  it("filters to status=decided_pending_action only (race-safe vs stale index)", async () => {
    mockedAuth.mockResolvedValue(
      makeAuthOk({ redisSmembers: async () => ["rm-fresh", "rm-raced"] }),
    );
    mockedCore
      .mockResolvedValueOnce(makeRoom("decided_pending_action"))
      .mockResolvedValueOnce(makeRoom("closed")); // moved out
    const res = await GET(
      new NextRequest("https://www.hivemoot.dev/api/rooms/decided-pending-ready"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.rooms[0].roomId).toBe("rm-fresh");
  });

  it("RoomNotFoundError during hydrate is swallowed (stale-index race)", async () => {
    mockedAuth.mockResolvedValue(
      makeAuthOk({ redisSmembers: async () => ["rm-fresh", "rm-stale"] }),
    );
    mockedCore
      .mockResolvedValueOnce(makeRoom("decided_pending_action"))
      .mockRejectedValueOnce(new RoomNotFoundError("12345", "rm-stale"));
    const res = await GET(
      new NextRequest("https://www.hivemoot.dev/api/rooms/decided-pending-ready"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.rooms[0].roomId).toBe("rm-fresh");
  });

  it("real Redis failure during hydrate → 500 (NOT silently empty list, builder pass-2 fix)", async () => {
    // Pre pass-2, the catch swallowed every failure as `null`,
    // turning a Redis read error into `count: 0`. The local queen
    // would then read "no work to do" and skip what it should have
    // retried. Narrowed catch rethrows non-RoomNotFoundError so the
    // outer storage_failure 500 fires.
    mockedAuth.mockResolvedValue(
      makeAuthOk({ redisSmembers: async () => ["rm-1"] }),
    );
    mockedCore.mockRejectedValueOnce(new Error("ECONNREFUSED redis://..."));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(
      new NextRequest("https://www.hivemoot.dev/api/rooms/decided-pending-ready"),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "storage_failure" });
    errSpy.mockRestore();
  });

  it("sorts the response newest-first by opened_at (post-hoc, since SETs are unordered)", async () => {
    mockedAuth.mockResolvedValue(
      makeAuthOk({ redisSmembers: async () => ["rm-old", "rm-new"] }),
    );
    mockedCore.mockImplementation(async ({ roomId }) => {
      if (roomId === "rm-old") return makeRoom("decided_pending_action", "2026-01-01T00:00:00Z");
      if (roomId === "rm-new") return makeRoom("decided_pending_action", "2026-05-01T00:00:00Z");
      throw new Error(`unexpected ${roomId}`);
    });
    const res = await GET(
      new NextRequest("https://www.hivemoot.dev/api/rooms/decided-pending-ready"),
    );
    const body = await res.json();
    expect(body.rooms.map((r: { roomId: string }) => r.roomId)).toEqual(["rm-new", "rm-old"]);
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
    const res = await GET(
      new NextRequest("https://www.hivemoot.dev/api/rooms/decided-pending-ready"),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "storage_failure" });
    errSpy.mockRestore();
  });
});
