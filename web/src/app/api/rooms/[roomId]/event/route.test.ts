/**
 * Tests for POST /api/rooms/:roomId/event — bot/queen meta-events.
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
    appendRoomEvent: vi.fn(),
    deriveIdempotencyKey: real.deriveIdempotencyKey,
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  appendRoomEvent,
  RoomNotFoundError,
  RoomEventIdempotencyReplayError,
  RoomEventStatusPreconditionError,
  RoomEventBodyTooLargeError,
} from "@/server/war-room";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedAppend = vi.mocked(appendRoomEvent);

const VALID_ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    `https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/event`,
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
    capabilities: ["rooms.update"],
    redis: {} as never,
    envelope: { fingerprint: "fp", expiresAt: null } as never,
  };
}

describe("POST /api/rooms/:roomId/event", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    mockedAppend.mockReset();
  });

  it("requires rooms.update capability", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 403 }),
    });
    const res = await POST(
      makeRequest({
        event_type: "subject_updated",
        body: {},
        sequenceObservedByClient: 1,
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(403);
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      { requires: "rooms.update" },
    );
  });

  it("happy path: subject_updated event → returns sequence", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedAppend.mockResolvedValue(5);
    const res = await POST(
      makeRequest({
        event_type: "subject_updated",
        body: { reason: "PR rebased", sha: "abc123" },
        sequenceObservedByClient: 4,
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).sequence).toBe(5);
    // Server fills timestamp + actor_role/actor_id from envelope
    expect(mockedAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: VALID_ROOM_ID,
        installationId: "12345",
        event: expect.objectContaining({
          event_type: "subject_updated",
          actor_role: "queen",
          actor_id: "bot-queen",
          body: { reason: "PR rebased", sha: "abc123" },
        }),
      }),
    );
  });

  it("rejects unknown event_type → 400 invalid_event_type", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    const res = await POST(
      makeRequest({
        event_type: "room_decided", // lifecycle event NOT allowed via /event
        body: {},
        sequenceObservedByClient: 1,
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_event_type");
    expect(mockedAppend).not.toHaveBeenCalled();
  });

  it("queen_question event is allowed (V1.1 readiness)", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedAppend.mockResolvedValue(3);
    const res = await POST(
      makeRequest({
        event_type: "queen_question",
        body: { target_role: "drone", question: "elaborate on..." },
        sequenceObservedByClient: 2,
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(200);
  });

  it("rejects missing idempotency input → 400 missing_idempotency", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    const res = await POST(
      makeRequest({
        event_type: "subject_updated",
        body: { reason: "rebased" },
        // No idempotencyKey + no sequenceObservedByClient
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("missing_idempotency");
  });

  it("accepts caller-supplied idempotencyKey directly", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedAppend.mockResolvedValue(5);
    const res = await POST(
      makeRequest({
        event_type: "subject_updated",
        body: { reason: "rebased" },
        idempotencyKey: "caller-derived-key-abc123",
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(200);
    expect(mockedAppend).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "caller-derived-key-abc123" }),
    );
  });

  it("RoomEventIdempotencyReplayError → 200 with replay flag (treats as success)", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedAppend.mockRejectedValue(
      new RoomEventIdempotencyReplayError(VALID_ROOM_ID, 3),
    );
    const res = await POST(
      makeRequest({
        event_type: "subject_updated",
        body: { reason: "rebased" },
        sequenceObservedByClient: 2,
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sequence).toBe(3);
    expect(body.replay).toBe(true);
  });

  it("RoomNotFoundError → 404", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedAppend.mockRejectedValue(
      new RoomNotFoundError("12345", VALID_ROOM_ID),
    );
    const res = await POST(
      makeRequest({
        event_type: "subject_updated",
        body: { reason: "rebased" },
        sequenceObservedByClient: 1,
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(404);
  });

  it("RoomEventBodyTooLargeError → 400 event_body_too_large", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedAppend.mockRejectedValue(
      new RoomEventBodyTooLargeError(9 * 1024),
    );
    const res = await POST(
      makeRequest({
        event_type: "subject_updated",
        body: { huge: "payload" },
        sequenceObservedByClient: 1,
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("event_body_too_large");
  });

  it("RoomEventStatusPreconditionError → 409 status_precondition_failed", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedAppend.mockRejectedValue(
      new RoomEventStatusPreconditionError(
        VALID_ROOM_ID,
        "awaiting_contributions",
        "closed",
      ),
    );
    const res = await POST(
      makeRequest({
        event_type: "subject_updated",
        body: { reason: "rebased" },
        sequenceObservedByClient: 1,
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("status_precondition_failed");
    expect(body.actualStatus).toBe("closed");
  });
});
