/**
 * Tests for GET /api/rooms/:roomId — fetch a single room's core record.
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
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  getRoomCore,
  RoomNotFoundError,
  RoomIdFormatError,
} from "@/server/war-room";
import { GET } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedGetRoomCore = vi.mocked(getRoomCore);

const VALID_ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";

function makeRequest(): NextRequest {
  return new NextRequest("https://www.hivemoot.dev/api/rooms/x", {
    method: "GET",
    headers: { authorization: "Bearer hmt_test" },
  });
}

function makeAuthOk(installationId = "12345") {
  return {
    ok: true as const,
    installationId,
    name: "worker",
    agent_role: "drone",
    capabilities: ["rooms.read_all"],
    redis: {} as never,
    envelope: { fingerprint: "fp", expiresAt: null } as never,
  };
}

describe("GET /api/rooms/:roomId", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    mockedGetRoomCore.mockReset();
  });

  it("delegates 401 on missing bearer", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "agent_auth_v1_missing_bearer" }, { status: 401 }),
    });
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(401);
  });

  it("requires rooms.read capability", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue({} as never);
    await GET(makeRequest(), { params: Promise.resolve({ roomId: VALID_ROOM_ID }) });
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      { requires: "rooms.read_all" },
    );
  });

  it("returns 200 with the room core on success", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    const fakeRoom = { status: "awaiting_rsvp", manager: "bot-queen" } as never;
    mockedGetRoomCore.mockResolvedValue(fakeRoom);
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(fakeRoom);
  });

  it("scopes read to bearer's installation (cross-installation isolation)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk("BEARER_INSTALL"));
    mockedGetRoomCore.mockResolvedValue({} as never);
    await GET(makeRequest(), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(mockedGetRoomCore).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "BEARER_INSTALL" }),
    );
  });

  it("RoomNotFoundError → 404 with stable code", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockRejectedValue(
      new RoomNotFoundError("12345", VALID_ROOM_ID),
    );
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("room_not_found");
  });

  it("RoomIdFormatError → 404 (no oracle for malformed-vs-missing)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockRejectedValue(new RoomIdFormatError("not-a-uuid"));
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: "not-a-uuid" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    // Same response shape as missing room — closes the unauthorized
    // discovery vector (caller can't distinguish "you guessed an
    // invalid id" from "you guessed a valid id that doesn't exist
    // OR is in another installation").
    expect(body.code).toBe("room_not_found");
  });

  it("propagates unexpected errors (5xx)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockRejectedValue(new Error("Redis down"));
    await expect(
      GET(makeRequest(), {
        params: Promise.resolve({ roomId: VALID_ROOM_ID }),
      }),
    ).rejects.toThrow("Redis down");
  });
});
