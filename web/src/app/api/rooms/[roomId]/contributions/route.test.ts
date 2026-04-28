/**
 * Tests for /api/rooms/:roomId/contributions — GET (D.1.b-i),
 * POST + DELETE (D.1.b-iii).
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
    submitContribution: vi.fn(),
    withdrawContribution: vi.fn(),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  getRoomCore,
  getRoomContributions,
  submitContribution,
  withdrawContribution,
  RoomNotFoundError,
  RoomIdFormatError,
  RoomEventIdempotencyReplayError,
  RoomParticipantNotFoundError,
  RoomParticipantStatePreconditionError,
  RoomContributionTooLargeError,
  ContributionValidationError,
} from "@/server/war-room";
import { GET, POST, DELETE } from "./route";

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

// ---------------------------------------------------------------------------
// POST + DELETE (D.1.b-iii — rooms.contribute)
// ---------------------------------------------------------------------------

const mockedSubmit = vi.mocked(submitContribution);
const mockedWithdraw = vi.mocked(withdrawContribution);

function makeWriteRequest(method: "POST" | "DELETE", body: unknown): NextRequest {
  return new NextRequest(
    `https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/contributions`,
    {
      method,
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

const VALID_BODY = { verdict: "APPROVE", summary: "looks good" };

describe("POST /api/rooms/:roomId/contributions", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    mockedSubmit.mockReset();
  });

  it("requires rooms.contribute", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 403 }),
    });
    const res = await POST(
      makeWriteRequest("POST", {
        sequenceObservedByClient: 1,
        body: VALID_BODY,
        rawMd: "# ok",
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(403);
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      { requires: "rooms.contribute" },
    );
  });

  it("happy path → returns sequence; role/agentId server-derived", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedSubmit.mockResolvedValue(5);
    const res = await POST(
      makeWriteRequest("POST", {
        sequenceObservedByClient: 1,
        body: VALID_BODY,
        rawMd: "# Verdict\nApprove.",
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).sequence).toBe(5);
    expect(mockedSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "drone",
        agentId: "drone-1",
        body: VALID_BODY,
      }),
    );
  });

  it("rejects missing rawMd → 400", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    const res = await POST(
      makeWriteRequest("POST", {
        sequenceObservedByClient: 1,
        body: VALID_BODY,
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_raw_md");
  });

  it("ContributionValidationError → 400 invalid_contribution_body", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedSubmit.mockRejectedValue(
      new ContributionValidationError("verdict", "approve", "uppercase"),
    );
    const res = await POST(
      makeWriteRequest("POST", {
        sequenceObservedByClient: 1,
        body: { verdict: "approve", summary: "ok" }, // lowercase!
        rawMd: "x",
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_contribution_body");
  });

  it("RoomContributionTooLargeError → 400 raw_md_too_large with sizeBytes", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedSubmit.mockRejectedValue(new RoomContributionTooLargeError(40000));
    const res = await POST(
      makeWriteRequest("POST", {
        sequenceObservedByClient: 1,
        body: VALID_BODY,
        rawMd: "x".repeat(40000),
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(400);
    const respBody = await res.json();
    expect(respBody.code).toBe("raw_md_too_large");
    expect(respBody.sizeBytes).toBe(40000);
  });

  it("RoomParticipantNotFoundError → 409 participant_not_found", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedSubmit.mockRejectedValue(
      new RoomParticipantNotFoundError(VALID_ROOM_ID, "drone"),
    );
    const res = await POST(
      makeWriteRequest("POST", {
        sequenceObservedByClient: 1,
        body: VALID_BODY,
        rawMd: "x",
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("participant_not_found");
  });

  it("idempotency replay → 200 with replay flag", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedSubmit.mockRejectedValue(
      new RoomEventIdempotencyReplayError(VALID_ROOM_ID, 5),
    );
    const res = await POST(
      makeWriteRequest("POST", {
        sequenceObservedByClient: 1,
        body: VALID_BODY,
        rawMd: "x",
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).replay).toBe(true);
  });

  it("body=null → 400 invalid_body_shape", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    const res = await POST(makeWriteRequest("POST", null), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_body_shape");
  });
});

describe("DELETE /api/rooms/:roomId/contributions", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    mockedWithdraw.mockReset();
  });

  it("requires rooms.contribute", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 403 }),
    });
    const res = await DELETE(makeWriteRequest("DELETE", { sequenceObservedByClient: 1 }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(403);
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      { requires: "rooms.contribute" },
    );
  });

  it("happy path → returns sequence", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedWithdraw.mockResolvedValue(7);
    const res = await DELETE(
      makeWriteRequest("DELETE", {
        sequenceObservedByClient: 2,
        reason: "found regression",
      }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).sequence).toBe(7);
  });

  it("RoomParticipantStatePreconditionError → 409 participant_state_precondition", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedWithdraw.mockRejectedValue(
      new RoomParticipantStatePreconditionError(
        VALID_ROOM_ID,
        "drone",
        ["resolved"],
        "pending",
      ),
    );
    const res = await DELETE(
      makeWriteRequest("DELETE", { sequenceObservedByClient: 1 }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(409);
    const respBody = await res.json();
    expect(respBody.code).toBe("participant_state_precondition");
    expect(respBody.actualState).toBe("pending");
  });

  it("body=null → 400", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    const res = await DELETE(makeWriteRequest("DELETE", null), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(400);
  });
});
