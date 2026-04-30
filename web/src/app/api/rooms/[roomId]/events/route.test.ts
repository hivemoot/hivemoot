/**
 * Tests for GET /api/rooms/:roomId/events.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/agent-token-v1-auth", () => ({
  authenticateAgentRequestV1: vi.fn(),
}));

vi.mock("@hivemoot/war-room", async () => {
  const real = await vi.importActual<typeof import("@hivemoot/war-room")>(
    "@hivemoot/war-room",
  );
  return {
    ...real,
    getRoomCore: vi.fn(),
    listRoomEvents: vi.fn(),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  getRoomCore,
  listRoomEvents,
  RoomNotFoundError,
  RoomIdFormatError,
} from "@hivemoot/war-room";
import { GET } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedGetRoomCore = vi.mocked(getRoomCore);
const mockedListRoomEvents = vi.mocked(listRoomEvents);

const VALID_ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";

function makeRequest(url: string = `https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/events`): NextRequest {
  return new NextRequest(url, {
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

describe("GET /api/rooms/:roomId/events", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    mockedGetRoomCore.mockReset();
    mockedListRoomEvents.mockReset();
  });

  it("requires rooms.read capability", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue({} as never);
    mockedListRoomEvents.mockResolvedValue([]);
    await GET(makeRequest(), { params: Promise.resolve({ roomId: VALID_ROOM_ID }) });
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      { requires: "rooms.read_all" },
    );
  });

  it("verifies room exists in bearer's installation BEFORE listing events (cross-install isolation)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockRejectedValue(
      new RoomNotFoundError("12345", VALID_ROOM_ID),
    );
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(404);
    // listRoomEvents must NOT have been called when the room
    // doesn't exist in this installation.
    expect(mockedListRoomEvents).not.toHaveBeenCalled();
  });

  it("RoomIdFormatError → 404 (no oracle)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockRejectedValue(new RoomIdFormatError("bad-id"));
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: "bad-id" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("room_not_found");
  });

  it("returns events on success with default since=0 + limit=200", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue({} as never);
    const events = [{ seq: 1, event_type: "room_opened" }] as never[];
    mockedListRoomEvents.mockResolvedValue(events);
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual(events);
    expect(body.roomId).toBe(VALID_ROOM_ID);
    expect(mockedListRoomEvents).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: VALID_ROOM_ID, since: 0, limit: 200 }),
    );
  });

  it("respects valid since cursor", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue({} as never);
    mockedListRoomEvents.mockResolvedValue([]);
    await GET(
      makeRequest(`https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/events?since=42`),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(mockedListRoomEvents).toHaveBeenCalledWith(
      expect.objectContaining({ since: 42 }),
    );
  });

  it("rejects negative since (falls back to default 0)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue({} as never);
    mockedListRoomEvents.mockResolvedValue([]);
    await GET(
      makeRequest(`https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/events?since=-5`),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(mockedListRoomEvents).toHaveBeenCalledWith(
      expect.objectContaining({ since: 0 }),
    );
  });

  it("clamps limit to MAX_LIMIT (500)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue({} as never);
    mockedListRoomEvents.mockResolvedValue([]);
    await GET(
      makeRequest(`https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/events?limit=10000`),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(mockedListRoomEvents).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 500 }),
    );
  });
});
