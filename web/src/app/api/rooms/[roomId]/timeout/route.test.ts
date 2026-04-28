/**
 * Tests for POST /api/rooms/:roomId/timeout — watchdog timeout.
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
    timeoutParticipant: vi.fn(),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  timeoutParticipant,
  RoomNotFoundError,
  RoomEventIdempotencyReplayError,
  RoomParticipantNotFoundError,
  RoomParticipantStatePreconditionError,
  RoomEventStatusPreconditionError,
} from "@/server/war-room";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedTimeout = vi.mocked(timeoutParticipant);

const VALID_ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    `https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/timeout`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer hmt_test",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

function makeBotAuth() {
  return {
    ok: true as const,
    installationId: "12345",
    name: "bot-queen",
    agent_role: "queen",
    capabilities: ["rooms.update"],
    redis: {} as never,
    envelope: { fingerprint: "fp", expiresAt: null } as never,
  };
}

describe("POST /api/rooms/:roomId/timeout", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    mockedTimeout.mockReset();
  });

  it("requires rooms.update", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 403 }),
    });
    const res = await POST(
      makeRequest({ subjectRole: "drone", sequenceObservedByClient: 1 }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(403);
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      { requires: "rooms.update" },
    );
  });

  it("happy path → returns sequence; watchdog identity from envelope, subject from body", async () => {
    mockedAuth.mockResolvedValue(makeBotAuth());
    mockedTimeout.mockResolvedValue(8);
    const res = await POST(
      makeRequest({ subjectRole: "drone", sequenceObservedByClient: 5 }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).sequence).toBe(8);
    expect(mockedTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectRole: "drone",      // from body
        watchdogRole: "queen",      // from envelope (NOT body)
        watchdogAgentId: "bot-queen",
        sequenceObservedByClient: 5,
      }),
    );
  });

  it("rejects missing subjectRole → 400", async () => {
    mockedAuth.mockResolvedValue(makeBotAuth());
    const res = await POST(makeRequest({ sequenceObservedByClient: 1 }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_subject_role");
  });

  it("RoomParticipantStatePreconditionError → 409 (covers stale-watchdog-loses-to-resolve race)", async () => {
    mockedAuth.mockResolvedValue(makeBotAuth());
    mockedTimeout.mockRejectedValue(
      new RoomParticipantStatePreconditionError(
        VALID_ROOM_ID,
        "drone",
        ["pending"],
        "resolved", // worker resolved between scan and EVAL
      ),
    );
    const res = await POST(
      makeRequest({ subjectRole: "drone", sequenceObservedByClient: 1 }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("participant_state_precondition");
    expect(body.actualState).toBe("resolved");
  });

  it("RoomEventStatusPreconditionError → 409 (room moved to deciding before timeout)", async () => {
    mockedAuth.mockResolvedValue(makeBotAuth());
    mockedTimeout.mockRejectedValue(
      new RoomEventStatusPreconditionError(
        VALID_ROOM_ID,
        "awaiting_contributions",
        "deciding",
      ),
    );
    const res = await POST(
      makeRequest({ subjectRole: "drone", sequenceObservedByClient: 1 }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("status_precondition_failed");
  });

  it("idempotency replay → 200", async () => {
    mockedAuth.mockResolvedValue(makeBotAuth());
    mockedTimeout.mockRejectedValue(
      new RoomEventIdempotencyReplayError(VALID_ROOM_ID, 5),
    );
    const res = await POST(
      makeRequest({ subjectRole: "drone", sequenceObservedByClient: 1 }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).replay).toBe(true);
  });

  it("RoomParticipantNotFoundError → 409", async () => {
    mockedAuth.mockResolvedValue(makeBotAuth());
    mockedTimeout.mockRejectedValue(
      new RoomParticipantNotFoundError(VALID_ROOM_ID, "drone"),
    );
    const res = await POST(
      makeRequest({ subjectRole: "drone", sequenceObservedByClient: 1 }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(409);
  });

  it("RoomNotFoundError → 404", async () => {
    mockedAuth.mockResolvedValue(makeBotAuth());
    mockedTimeout.mockRejectedValue(
      new RoomNotFoundError("12345", VALID_ROOM_ID),
    );
    const res = await POST(
      makeRequest({ subjectRole: "drone", sequenceObservedByClient: 1 }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(404);
  });
});
