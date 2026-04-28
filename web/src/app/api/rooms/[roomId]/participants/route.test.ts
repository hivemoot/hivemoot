/**
 * Tests for GET /api/rooms/:roomId/participants.
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
    getRoomParticipants: vi.fn(),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  getRoomCore,
  getRoomParticipants,
  RoomNotFoundError,
  RoomIdFormatError,
} from "@/server/war-room";
import { GET } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedGetRoomCore = vi.mocked(getRoomCore);
const mockedGetRoomParticipants = vi.mocked(getRoomParticipants);

const VALID_ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";

function makeRequest(): NextRequest {
  return new NextRequest(`https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/participants`, {
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

describe("GET /api/rooms/:roomId/participants", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    mockedGetRoomCore.mockReset();
    mockedGetRoomParticipants.mockReset();
  });

  it("requires rooms.read", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue({} as never);
    mockedGetRoomParticipants.mockResolvedValue({});
    await GET(makeRequest(), { params: Promise.resolve({ roomId: VALID_ROOM_ID }) });
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      { requires: "rooms.read_all" },
    );
  });

  it("returns participants keyed by role", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue({} as never);
    const participants = {
      drone: { role: "drone", agent_id: "drone-1", status: "pending" },
    } as never;
    mockedGetRoomParticipants.mockResolvedValue(participants);
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.participants).toEqual(participants);
    expect(body.roomId).toBe(VALID_ROOM_ID);
  });

  it("verifies room exists in bearer's installation FIRST (cross-install isolation)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockRejectedValue(
      new RoomNotFoundError("12345", VALID_ROOM_ID),
    );
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(404);
    expect(mockedGetRoomParticipants).not.toHaveBeenCalled();
  });

  it("malformed roomId → 404 not 400", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockRejectedValue(new RoomIdFormatError("bad"));
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: "bad" }),
    });
    expect(res.status).toBe(404);
  });

  it("empty participants returns {} not null", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue({} as never);
    mockedGetRoomParticipants.mockResolvedValue({});
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.participants).toEqual({});
  });
});
