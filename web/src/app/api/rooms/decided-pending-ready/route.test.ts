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

function makeRoom(status: string) {
  return {
    manager: "bot-queen",
    subject_type: "pr_review" as const,
    subject_ref: "owner/repo#1",
    opened_at: "2026-05-09T00:00:00Z",
    status: status as "decided_pending_action",
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
    // \"today's behavior is empty\" contract.
    mockedAuth.mockResolvedValue(makeAuthOk({ redisZrange: async () => [] }));
    const res = await GET(
      new NextRequest("https://www.hivemoot.dev/api/rooms/decided-pending-ready"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rooms: [], count: 0 });
  });

  it("queries the decided_pending_action status index", async () => {
    const zrangeSpy = vi.fn(async () => []);
    mockedAuth.mockResolvedValue(makeAuthOk({ redisZrange: zrangeSpy }));
    await GET(
      new NextRequest("https://www.hivemoot.dev/api/rooms/decided-pending-ready"),
    );
    expect(zrangeSpy).toHaveBeenCalledWith(
      "hive:v1:idx:room:status:12345:decided_pending_action",
      0,
      49,
      { rev: true },
    );
  });

  it("filters to status=decided_pending_action only (race-safe vs stale index)", async () => {
    mockedAuth.mockResolvedValue(
      makeAuthOk({ redisZrange: async () => ["rm-fresh", "rm-raced"] }),
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

  it("returns 500 on storage error", async () => {
    mockedAuth.mockResolvedValue(
      makeAuthOk({
        redisZrange: async () => {
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
