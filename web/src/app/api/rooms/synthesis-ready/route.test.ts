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
import { getRoomCore } from "@hivemoot/war-room";
import { GET } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedCore = vi.mocked(getRoomCore);

function makeAuthOk(overrides?: { redisZrange?: (...args: unknown[]) => Promise<string[]> }) {
  return {
    ok: true as const,
    installationId: "12345",
    name: "queen",
    agent_role: "local_queen",
    capabilities: ["rooms.synthesize"],
    redis: {
      zrange: vi.fn(overrides?.redisZrange ?? (async () => [])),
    } as never,
    envelope: { fingerprint: "fp", expiresAt: null } as never,
  };
}

function makeRoom(roomId: string, status: string) {
  return {
    manager: "bot-queen",
    subject_type: "pr_review" as const,
    subject_ref: `owner/repo#${roomId.slice(0, 4)}`,
    opened_at: "2026-05-09T00:00:00Z",
    status: status as "awaiting_contributions",
    timing_config: {
      max_age_secs: 86400,
      drop_threshold_secs: 600,
      quiet_period_secs: 60,
    },
    last_transition_at: "2026-05-09T00:00:00Z",
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
      redisZrange: async () => ["rm-1", "rm-2", "rm-3"],
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
    expect(body.rooms.map((r: { roomId: string }) => r.roomId)).toEqual(["rm-1", "rm-3"]);
  });

  it("filters out rooms whose hash has been concurrently deleted", async () => {
    const auth = makeAuthOk({
      redisZrange: async () => ["rm-1", "rm-stale"],
    });
    mockedAuth.mockResolvedValue(auth);
    mockedCore
      .mockResolvedValueOnce(makeRoom("rm-1", "awaiting_contributions"))
      .mockRejectedValueOnce(new Error("RoomNotFoundError")); // raced
    const res = await GET(new NextRequest("https://www.hivemoot.dev/api/rooms/synthesis-ready"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.rooms[0].roomId).toBe("rm-1");
  });

  it("queries the awaiting_contributions status index, not the global one", async () => {
    const zrangeSpy = vi.fn(async () => []);
    mockedAuth.mockResolvedValue(makeAuthOk({ redisZrange: zrangeSpy }));
    await GET(new NextRequest("https://www.hivemoot.dev/api/rooms/synthesis-ready"));
    expect(zrangeSpy).toHaveBeenCalledWith(
      "hive:v1:idx:room:status:12345:awaiting_contributions",
      0,
      49,
      { rev: true },
    );
  });

  it("respects the limit query param", async () => {
    const zrangeSpy = vi.fn(async () => []);
    mockedAuth.mockResolvedValue(makeAuthOk({ redisZrange: zrangeSpy }));
    await GET(
      new NextRequest("https://www.hivemoot.dev/api/rooms/synthesis-ready?limit=10"),
    );
    expect(zrangeSpy).toHaveBeenCalledWith(
      expect.any(String),
      0,
      9,
      { rev: true },
    );
  });

  it("caps limit at 200", async () => {
    const zrangeSpy = vi.fn(async () => []);
    mockedAuth.mockResolvedValue(makeAuthOk({ redisZrange: zrangeSpy }));
    await GET(
      new NextRequest("https://www.hivemoot.dev/api/rooms/synthesis-ready?limit=99999"),
    );
    expect(zrangeSpy).toHaveBeenCalledWith(
      expect.any(String),
      0,
      199,
      { rev: true },
    );
  });

  it("returns 500 on storage error", async () => {
    mockedAuth.mockResolvedValue(
      makeAuthOk({
        redisZrange: async () => {
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
