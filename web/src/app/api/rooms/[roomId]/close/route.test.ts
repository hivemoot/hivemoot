/**
 * Tests for POST /api/rooms/:roomId/close — queen happy-path close.
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
    closeRoomWithDecision: vi.fn(),
    getRoomCore: vi.fn(),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  closeRoomWithDecision,
  getRoomCore,
  RoomNotFoundError,
  RoomCloseClaimLostError,
  RoomCloseClaimThroughSeqMismatchError,
  RoomCloseDriftError,
  RoomClaimPayloadCorruptError,
  RoomRunnerFormatError,
} from "@/server/war-room";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedClose = vi.mocked(closeRoomWithDecision);
const mockedGetCore = vi.mocked(getRoomCore);

const VALID_ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";

const VALID_DECISION = {
  synthesized_at: "2026-04-28T08:00:00.000Z",
  synthesis_runner: "queen-A.pid42",
  content: "## Decision\nApprove.",
  sequence_closed: 7,
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    `https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/close`,
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

function makeQueenAuth() {
  return {
    ok: true as const,
    installationId: "12345",
    name: "bot-queen",
    agent_role: "queen",
    capabilities: ["rooms.close"],
    redis: {} as never,
    envelope: { fingerprint: "fp", expiresAt: null } as never,
  };
}

function makeFakeRoom() {
  return {
    subject_type: "pr_review" as const,
    subject_ref: "hivemoot/hivemoot#1",
    status: "deciding" as const,
  } as never;
}

describe("POST /api/rooms/:roomId/close", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    mockedClose.mockReset();
    mockedGetCore.mockReset();
  });

  it("requires rooms.close capability", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 403 }),
    });
    const res = await POST(
      makeRequest({ expectedThroughSequence: 7, decision: VALID_DECISION }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(403);
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      { requires: "rooms.close" },
    );
  });

  it("happy path → returns closedSequence + fetches subject from room hash (no caller-supplied subject)", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedGetCore.mockResolvedValue(makeFakeRoom());
    mockedClose.mockResolvedValue(8);
    const res = await POST(
      makeRequest({ expectedThroughSequence: 7, decision: VALID_DECISION }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.closedSequence).toBe(8);
    // Subject came from getRoomCore — caller can't smuggle a wrong one
    expect(mockedClose).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: { type: "pr_review", ref: "hivemoot/hivemoot#1" },
      }),
    );
  });

  it("rejects missing expectedThroughSequence → 400", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    const res = await POST(
      makeRequest({ decision: VALID_DECISION }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_through_sequence");
  });

  it("rejects malformed decision shape → 400", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    const res = await POST(
      makeRequest({
        expectedThroughSequence: 7,
        decision: { synthesis_runner: "queen-A" }, // missing content/timestamp/sequence_closed
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_decision_shape");
  });

  it("RoomNotFoundError on getRoomCore → 404 (no close attempt)", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedGetCore.mockRejectedValue(
      new RoomNotFoundError("12345", VALID_ROOM_ID),
    );
    const res = await POST(
      makeRequest({ expectedThroughSequence: 7, decision: VALID_DECISION }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(404);
    expect(mockedClose).not.toHaveBeenCalled();
  });

  it("RoomCloseDriftError → 409 sequence_drift with lastSeq", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedGetCore.mockResolvedValue(makeFakeRoom());
    mockedClose.mockRejectedValue(
      new RoomCloseDriftError(VALID_ROOM_ID, 7, 9),
    );
    const res = await POST(
      makeRequest({ expectedThroughSequence: 7, decision: VALID_DECISION }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("sequence_drift");
    expect(body.expectedThroughSequence).toBe(7);
    expect(body.lastSeq).toBe(9);
  });

  it("RoomCloseClaimLostError → 409 claim_lost", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedGetCore.mockResolvedValue(makeFakeRoom());
    mockedClose.mockRejectedValue(new RoomCloseClaimLostError(VALID_ROOM_ID));
    const res = await POST(
      makeRequest({ expectedThroughSequence: 7, decision: VALID_DECISION }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("claim_lost");
  });

  it("RoomCloseClaimThroughSeqMismatchError → 409 with both sequences", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedGetCore.mockResolvedValue(makeFakeRoom());
    mockedClose.mockRejectedValue(
      new RoomCloseClaimThroughSeqMismatchError(VALID_ROOM_ID, 7, 99),
    );
    const res = await POST(
      makeRequest({ expectedThroughSequence: 7, decision: VALID_DECISION }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("claim_through_seq_mismatch");
    expect(body.expectedThroughSequence).toBe(7);
    expect(body.actualThroughSequence).toBe(99);
  });

  it("RoomRunnerFormatError → 400 invalid_synthesis_runner (boundary check)", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedGetCore.mockResolvedValue(makeFakeRoom());
    mockedClose.mockRejectedValue(
      new RoomRunnerFormatError("queen__SEQ__bad", "sentinel collision"),
    );
    const res = await POST(
      makeRequest({
        expectedThroughSequence: 7,
        decision: { ...VALID_DECISION, synthesis_runner: "queen__SEQ__bad" },
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_synthesis_runner");
  });

  it("decision >64 KiB → 400 decision_too_large", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedGetCore.mockResolvedValue(makeFakeRoom());
    mockedClose.mockRejectedValue(
      new Error("RoomDecision.content exceeds 64 KiB (88000 bytes); reduce body before close."),
    );
    const res = await POST(
      makeRequest({ expectedThroughSequence: 7, decision: VALID_DECISION }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("decision_too_large");
  });
});
