/**
 * Tests for GET /api/rooms/:roomId/contributions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/agent-token-v1-auth", () => ({
  authenticateAgentRequestV1: vi.fn(),
}));

vi.mock("@/server/war-room", async () => {
  const real = await vi.importActual<typeof import("@/server/war-room")>(
    "@/server/war-room",
  );
  return {
    ...real,
    getRoomCore: vi.fn(),
    getRoomContributions: vi.fn(),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  getRoomCore,
  getRoomContributions,
  RoomNotFoundError,
  RoomIdFormatError,
} from "@/server/war-room";
import { GET } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedGetRoomCore = vi.mocked(getRoomCore);
const mockedGetRoomContributions = vi.mocked(getRoomContributions);

const VALID_ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";

function makeRequest(): NextRequest {
  return new NextRequest(`https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/contributions`, {
    method: "GET",
    headers: { authorization: "Bearer hmt_test" },
  });
}

function makeAuthOk() {
  return {
    ok: true as const,
    installationId: "12345",
    name: "worker",
    agent_role: "drone",
    capabilities: ["rooms.read_all"],
    redis: {} as never,
    envelope: { fingerprint: "fp", expiresAt: null } as never,
  };
}

describe("GET /api/rooms/:roomId/contributions", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    mockedGetRoomCore.mockReset();
    mockedGetRoomContributions.mockReset();
  });

  it("requires rooms.read", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue({} as never);
    mockedGetRoomContributions.mockResolvedValue({});
    await GET(makeRequest(), { params: Promise.resolve({ roomId: VALID_ROOM_ID }) });
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      { requires: "rooms.read_all" },
    );
  });

  it("returns contributions keyed by role", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue({} as never);
    const contributions = {
      drone: {
        role: "drone",
        body: { verdict: "APPROVE", summary: "ok" },
        contributed_at: "2026-04-28T07:00:00.000Z",
      },
    } as never;
    mockedGetRoomContributions.mockResolvedValue(contributions);
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contributions).toEqual(contributions);
    expect(body.roomId).toBe(VALID_ROOM_ID);
  });

  it("withdrawn tombstones are surfaced as-is (caller distinguishes via withdrawn:true)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue({} as never);
    const contributions = {
      drone: { withdrawn: true, contributed_at: "2026-04-28T07:00:00.000Z" },
    } as never;
    mockedGetRoomContributions.mockResolvedValue(contributions);
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contributions.drone.withdrawn).toBe(true);
  });

  it("verifies room exists FIRST (cross-install isolation)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockRejectedValue(
      new RoomNotFoundError("12345", VALID_ROOM_ID),
    );
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(404);
    expect(mockedGetRoomContributions).not.toHaveBeenCalled();
  });

  it("malformed roomId → 404", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockRejectedValue(new RoomIdFormatError("bad"));
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: "bad" }),
    });
    expect(res.status).toBe(404);
  });
});
