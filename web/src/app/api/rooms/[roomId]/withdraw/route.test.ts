/**
 * Tests for POST /api/rooms/:roomId/withdraw.
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
    withdrawParticipant: vi.fn(),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  withdrawParticipant,
  RoomNotFoundError,
  RoomEventIdempotencyReplayError,
  RoomParticipantNotFoundError,
  RoomParticipantStatePreconditionError,
  RoomEventStatusPreconditionError,
} from "@/server/war-room";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedWithdraw = vi.mocked(withdrawParticipant);

const VALID_ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    `https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/withdraw`,
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

function makeWorkerAuth() {
  return {
    ok: true as const,
    installationId: "12345",
    name: "drone-1",
    agent_role: "drone",
    capabilities: ["rooms.contribute"],
    redis: {} as never,
    envelope: { fingerprint: "fp", expiresAt: null } as never,
  };
}

describe("POST /api/rooms/:roomId/withdraw", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    mockedWithdraw.mockReset();
  });

  it("requires rooms.contribute", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 403 }),
    });
    const res = await POST(makeRequest({ sequenceObservedByClient: 1 }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(403);
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      { requires: "rooms.contribute" },
    );
  });

  it("happy path → returns sequence; role/agentId server-derived", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedWithdraw.mockResolvedValue(4);
    const res = await POST(
      makeRequest({ sequenceObservedByClient: 1, reason: "subject too small" }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).sequence).toBe(4);
    expect(mockedWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "drone",
        agentId: "drone-1",
        reason: "subject too small",
      }),
    );
  });

  it("RoomParticipantNotFoundError → 409 participant_not_found", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedWithdraw.mockRejectedValue(
      new RoomParticipantNotFoundError(VALID_ROOM_ID, "drone"),
    );
    const res = await POST(makeRequest({ sequenceObservedByClient: 1 }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("participant_not_found");
  });

  it("RoomParticipantStatePreconditionError → 409 with actualState + allowedStates", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedWithdraw.mockRejectedValue(
      new RoomParticipantStatePreconditionError(
        VALID_ROOM_ID,
        "drone",
        ["pending", "resolved"],
        "withdrew",
      ),
    );
    const res = await POST(makeRequest({ sequenceObservedByClient: 1 }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("participant_state_precondition");
    expect(body.actualState).toBe("withdrew");
    expect(body.allowedStates).toEqual(["pending", "resolved"]);
  });

  it("RoomEventStatusPreconditionError → 409 status_precondition_failed", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedWithdraw.mockRejectedValue(
      new RoomEventStatusPreconditionError(
        VALID_ROOM_ID,
        "awaiting_contributions",
        "deciding",
      ),
    );
    const res = await POST(makeRequest({ sequenceObservedByClient: 1 }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("status_precondition_failed");
  });

  it("idempotency replay → 200 with replay flag", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedWithdraw.mockRejectedValue(
      new RoomEventIdempotencyReplayError(VALID_ROOM_ID, 7),
    );
    const res = await POST(makeRequest({ sequenceObservedByClient: 1 }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).replay).toBe(true);
  });

  it("RoomNotFoundError → 404", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedWithdraw.mockRejectedValue(
      new RoomNotFoundError("12345", VALID_ROOM_ID),
    );
    const res = await POST(makeRequest({ sequenceObservedByClient: 1 }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("body=null → 400", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    const res = await POST(makeRequest(null), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(400);
  });
});
