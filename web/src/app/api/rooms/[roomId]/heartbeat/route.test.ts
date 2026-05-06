/**
 * Tests for POST /api/rooms/:roomId/heartbeat — pure-liveness ping.
 *
 * Covers the route's translation layer: capability gate, body parsing,
 * the agentId fallback to bearer name, and error → HTTP status mapping.
 * Storage-layer semantics (Lua atomicity, rsvp_at bump, no seq increment,
 * no event log entry) are pinned by war-room.test.ts.
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
    heartbeatParticipant: vi.fn(),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  heartbeatParticipant,
  RoomNotFoundError,
  RoomIdFormatError,
  RoomParticipantNotFoundError,
  RoomParticipantOwnerConflictError,
  RoomTransitionInvalidStatusError,
} from "@hivemoot/war-room";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedHeartbeat = vi.mocked(heartbeatParticipant);

const VALID_ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";
const RSVP_ISO = "2026-05-03T12:00:00.000Z";

function makeRequest(body: unknown | undefined): NextRequest {
  return new NextRequest(
    `https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/heartbeat`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer hmt_test",
        "content-type": "application/json",
      },
      body: body === undefined ? "" : JSON.stringify(body),
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

describe("POST /api/rooms/:roomId/heartbeat", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    mockedHeartbeat.mockReset();
  });

  it("requires rooms.contribute capability", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 403 }),
    });
    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(403);
    expect(mockedAuth).toHaveBeenCalledWith(expect.anything(), {
      requires: "rooms.contribute",
    });
  });

  it("happy path → 200 { rsvpAt }; agentId defaults to auth.name", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedHeartbeat.mockResolvedValue(RSVP_ISO);
    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rsvpAt: RSVP_ISO });
    expect(mockedHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "12345",
        roomId: VALID_ROOM_ID,
        role: "drone",
        agentId: "drone-1", // fallback when body omits
      }),
    );
  });

  it("empty body (no JSON at all) is accepted — RFC pins payload-free heartbeat", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedHeartbeat.mockResolvedValue(RSVP_ISO);
    const res = await POST(makeRequest(undefined), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).rsvpAt).toBe(RSVP_ISO);
  });

  it("body-supplied agentId flows through (subscriber-mode first-wins gate, #522)", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedHeartbeat.mockResolvedValue(RSVP_ISO);
    await POST(makeRequest({ agentId: "drone-runner-host42" }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(mockedHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "drone-runner-host42" }),
    );
  });

  it("non-string agentId → 400 invalid_agent_id", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    const res = await POST(makeRequest({ agentId: 12345 }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_agent_id");
    expect(mockedHeartbeat).not.toHaveBeenCalled();
  });

  it("malformed JSON body → 400 invalid_body", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    const req = new NextRequest(
      `https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/heartbeat`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer hmt_test",
          "content-type": "application/json",
        },
        body: "{not-json",
      },
    );
    const res = await POST(req, {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_body");
  });

  it("null return → 200 { skipped: 'non_pending' } (benign no-op, do not escalate)", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedHeartbeat.mockResolvedValue(null);
    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "non_pending" });
  });

  it("RoomNotFoundError → 404 room_not_found", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedHeartbeat.mockRejectedValue(
      new RoomNotFoundError("12345", VALID_ROOM_ID),
    );
    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("room_not_found");
  });

  it("RoomIdFormatError → 404 room_not_found (malformed UUID maps as not-found at the boundary)", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedHeartbeat.mockRejectedValue(new RoomIdFormatError("not-a-uuid"));
    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("room_not_found");
  });

  it("RoomTransitionInvalidStatusError → 409 status_precondition_failed", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedHeartbeat.mockRejectedValue(
      new RoomTransitionInvalidStatusError(
        VALID_ROOM_ID,
        "heartbeat",
        ["awaiting_contributions"],
        "deciding",
      ),
    );
    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("status_precondition_failed");
    expect(body.actualStatus).toBe("deciding");
  });

  it("RoomParticipantNotFoundError → 404 participant_not_found", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedHeartbeat.mockRejectedValue(
      new RoomParticipantNotFoundError(VALID_ROOM_ID, "drone"),
    );
    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("participant_not_found");
    expect(body.role).toBe("drone");
  });

  it("RoomParticipantOwnerConflictError → 409 owner_conflict (carries existingAgentId)", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedHeartbeat.mockRejectedValue(
      new RoomParticipantOwnerConflictError(
        VALID_ROOM_ID,
        "drone",
        "other-drone",
        "drone-1",
      ),
    );
    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("owner_conflict");
    expect(body.existingAgentId).toBe("other-drone");
  });

  it("unknown error rethrows (next.js handles it as 500)", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedHeartbeat.mockRejectedValue(new Error("kaboom"));
    await expect(
      POST(makeRequest({}), {
        params: Promise.resolve({ roomId: VALID_ROOM_ID }),
      }),
    ).rejects.toThrow("kaboom");
  });
});
