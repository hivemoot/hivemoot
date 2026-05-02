/**
 * Tests for POST /api/rooms/:roomId/present.
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
    presentParticipant: vi.fn(),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  presentParticipant,
  RoomNotFoundError,
  RoomEventIdempotencyReplayError,
  RoomEventStatusPreconditionError,
  RoomEventBodyTooLargeError,
  RoomParticipantOwnerConflictError,
} from "@hivemoot/war-room";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedPresent = vi.mocked(presentParticipant);

const VALID_ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    `https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/present`,
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
    capabilities: ["rooms.contribute", "rooms.watch"],
    redis: {} as never,
    envelope: { fingerprint: "fp", expiresAt: null } as never,
  };
}

describe("POST /api/rooms/:roomId/present", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    mockedPresent.mockReset();
  });

  it("requires rooms.contribute capability", async () => {
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

  it("happy path → returns sequence; role server-derived; agentId defaults to auth.name", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedPresent.mockResolvedValue(3);
    const res = await POST(
      makeRequest({ sequenceObservedByClient: 1, intentHint: "review" }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).sequence).toBe(3);
    expect(mockedPresent).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "12345",
        roomId: VALID_ROOM_ID,
        role: "drone", // server-derived from envelope, not body
        agentId: "drone-1", // back-compat: defaults to auth.name when body omits
        actorId: "drone-1", // always bearer-derived for audit trail
        sequenceObservedByClient: 1,
        intentHint: "review",
      }),
    );
  });

  it("body-supplied agentId flows through to storage; actorId stays bearer-derived (#522)", async () => {
    // Subscriber-mode: a runner sharing a bearer with siblings sends
    // its own per-runner identity as agentId. The first-wins gate
    // distinguishes runners by agentId; the audit trail uses the
    // bearer name as actorId.
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedPresent.mockResolvedValue(3);
    await POST(
      makeRequest({
        sequenceObservedByClient: 1,
        agentId: "drone-runner-host42",
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(mockedPresent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "drone-runner-host42", // body-supplied
        actorId: "drone-1",              // auth.name
      }),
    );
  });

  it("rejects non-string body agentId → 400 invalid_agent_id", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    const res = await POST(
      makeRequest({ sequenceObservedByClient: 1, agentId: 12345 }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_agent_id");
    expect(mockedPresent).not.toHaveBeenCalled();
  });

  it("rejects body agentId that fails validateRunnerFormat → 400", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    const res = await POST(
      makeRequest({
        sequenceObservedByClient: 1,
        agentId: "drone runner with spaces",  // RUNNER_FORMAT_REGEX rejects
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_agent_id");
    expect(mockedPresent).not.toHaveBeenCalled();
  });

  it("rejects missing sequenceObservedByClient → 400", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_sequence");
  });

  it("rejects negative sequence → 400", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    const res = await POST(makeRequest({ sequenceObservedByClient: -1 }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-string intentHint → 400", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    const res = await POST(
      makeRequest({ sequenceObservedByClient: 1, intentHint: 42 }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_intent_hint");
  });

  it("body=null → 400 invalid_body_shape", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    const res = await POST(makeRequest(null), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_body_shape");
    expect(mockedPresent).not.toHaveBeenCalled();
  });

  it("RoomNotFoundError → 404", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedPresent.mockRejectedValue(
      new RoomNotFoundError("12345", VALID_ROOM_ID),
    );
    const res = await POST(makeRequest({ sequenceObservedByClient: 1 }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("RoomEventIdempotencyReplayError → 200 with replay flag", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedPresent.mockRejectedValue(
      new RoomEventIdempotencyReplayError(VALID_ROOM_ID, 5),
    );
    const res = await POST(makeRequest({ sequenceObservedByClient: 1 }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sequence).toBe(5);
    expect(body.replay).toBe(true);
  });

  it("RoomEventStatusPreconditionError → 409 status_precondition_failed", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedPresent.mockRejectedValue(
      new RoomEventStatusPreconditionError(VALID_ROOM_ID, "awaiting_contributions", "closed"),
    );
    const res = await POST(makeRequest({ sequenceObservedByClient: 1 }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("status_precondition_failed");
  });

  it("RoomEventBodyTooLargeError → 400 event_body_too_large with sizeBytes (closes #521 builder R1 #2)", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedPresent.mockRejectedValue(new RoomEventBodyTooLargeError(9000));
    const res = await POST(
      makeRequest({
        sequenceObservedByClient: 1,
        intentHint: "x".repeat(9000), // overflows event-body 8 KiB cap
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("event_body_too_large");
    expect(body.sizeBytes).toBe(9000);
  });

  it("RoomParticipantOwnerConflictError → 409 owner_conflict", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedPresent.mockRejectedValue(
      new RoomParticipantOwnerConflictError(
        VALID_ROOM_ID,
        "drone",
        "other-drone",
        "drone-1",
      ),
    );
    const res = await POST(makeRequest({ sequenceObservedByClient: 1 }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("owner_conflict");
    expect(body.existingAgentId).toBe("other-drone");
  });
});
