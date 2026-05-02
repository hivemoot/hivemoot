import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));

vi.mock("@hivemoot/war-room", () => ({
  listRooms: vi.fn(),
}));

import { authenticateByokRequest } from "@/server/byok-auth";
import { listRooms } from "@hivemoot/war-room";
import { GET } from "./route";

const mockedAuth = vi.mocked(authenticateByokRequest);
const mockedList = vi.mocked(listRooms);

function makeRequest(url = "https://www.hivemoot.dev/api/dashboard/rooms"): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

function makeAuth(installationId: string | null) {
  return {
    ok: true as const,
    session: {
      installationId,
      userId: 101,
      userLogin: "queen",
    },
    redis: {} as never,
    keyring: new Map(),
    activeKeyVersion: "v1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/dashboard/rooms", () => {
  it("returns 401 when session auth fails", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 401 }),
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("returns empty list when session has no installationId", async () => {
    mockedAuth.mockResolvedValue(makeAuth(null));
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rooms: [] });
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("returns rooms scoped to session installationId", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedList.mockResolvedValue([
      {
        roomId: "01234567-89ab-4cde-9012-3456789abcde",
        manager: "bot-queen",
        subject_type: "pr_review",
        subject_ref: "owner/repo#42",
        status: "awaiting_contributions",
        opened_at: "2026-04-28T20:00:00Z",
        timing_config: {
          max_age_secs: 3600,
          drop_threshold_secs: 600,
          quiet_period_secs: 600,
        },
      },
    ]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].roomId).toBe("01234567-89ab-4cde-9012-3456789abcde");
    expect(mockedList).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "12345",
        limit: 50, // default
      }),
    );
  });

  it("respects ?limit query param within bounds", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedList.mockResolvedValue([]);
    await GET(
      makeRequest("https://www.hivemoot.dev/api/dashboard/rooms?limit=25"),
    );
    expect(mockedList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25 }),
    );
  });

  it("clamps ?limit above MAX_LIMIT to 200", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedList.mockResolvedValue([]);
    await GET(
      makeRequest("https://www.hivemoot.dev/api/dashboard/rooms?limit=9999"),
    );
    expect(mockedList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 }),
    );
  });

  it("clamps ?limit below 1 to 1", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedList.mockResolvedValue([]);
    await GET(
      makeRequest("https://www.hivemoot.dev/api/dashboard/rooms?limit=0"),
    );
    expect(mockedList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 }),
    );
  });

  it("ignores non-numeric ?limit and uses default", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedList.mockResolvedValue([]);
    await GET(
      makeRequest("https://www.hivemoot.dev/api/dashboard/rooms?limit=abc"),
    );
    expect(mockedList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("returns 500 when storage throws", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedList.mockRejectedValue(new Error("Redis down"));
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("list_rooms_failed");
  });
});
