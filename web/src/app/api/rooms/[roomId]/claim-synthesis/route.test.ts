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
    claimSynthesis: vi.fn(),
    getRoomCore: vi.fn(),
    getRoomParticipants: vi.fn(),
    getRoomContributions: vi.fn(),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  claimSynthesis,
  getRoomCore,
  getRoomParticipants,
  getRoomContributions,
  RoomNotFoundError,
  RoomClaimAlreadyHeldError,
  RoomTransitionInvalidStatusError,
} from "@hivemoot/war-room";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedClaim = vi.mocked(claimSynthesis);
const mockedCore = vi.mocked(getRoomCore);
const mockedParticipants = vi.mocked(getRoomParticipants);
const mockedContributions = vi.mocked(getRoomContributions);

function makeAuthOk() {
  return {
    ok: true as const,
    installationId: "12345",
    name: "queen",
    agent_role: "local_queen",
    capabilities: ["rooms.synthesize"],
    redis: {} as never,
    envelope: { fingerprint: "fp", expiresAt: null } as never,
  };
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    "https://www.hivemoot.dev/api/rooms/rm-123/claim-synthesis",
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

const params = Promise.resolve({ roomId: "rm-123" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/rooms/:roomId/claim-synthesis", () => {
  it("delegates 401 on missing bearer", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "agent_auth_v1_missing_bearer" }, { status: 401 }),
    });
    const res = await POST(makeRequest({ queenRunner: "r1" }), { params });
    expect(res.status).toBe(401);
  });

  it("requires rooms.synthesize capability", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedClaim.mockResolvedValue({ throughSequence: 7, claimTtlSecs: 900 });
    mockedCore.mockResolvedValue({} as never);
    mockedParticipants.mockResolvedValue({});
    mockedContributions.mockResolvedValue({});
    await POST(makeRequest({ queenRunner: "r1" }), { params });
    expect(mockedAuth).toHaveBeenCalledWith(expect.any(NextRequest), {
      requires: "rooms.synthesize",
    });
  });

  it("rejects body without queenRunner", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    const res = await POST(makeRequest({}), { params });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_queen_runner" });
    expect(mockedClaim).not.toHaveBeenCalled();
  });

  it("rejects negative claimTtlSecs", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    const res = await POST(
      makeRequest({ queenRunner: "r1", claimTtlSecs: -10 }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_claim_ttl" });
  });

  it("returns the composite { claim, room, participants, contributions }", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedClaim.mockResolvedValue({ throughSequence: 11, claimTtlSecs: 900 });
    const fakeRoom = {
      manager: "bot-queen",
      subject_type: "pr_review",
      subject_ref: "owner/repo#1",
      opened_at: "2026-05-09T00:00:00Z",
      status: "deciding",
      timing_config: {
        max_age_secs: 86400,
        drop_threshold_secs: 600,
        quiet_period_secs: 60,
      },
    } as never;
    mockedCore.mockResolvedValue(fakeRoom);
    mockedParticipants.mockResolvedValue({
      builder: { actor_role: "builder", state: "resolved" } as never,
    });
    mockedContributions.mockResolvedValue({
      builder: { actor_role: "builder", raw_md: "lgtm" } as never,
    });
    const res = await POST(makeRequest({ queenRunner: "r1" }), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      claim: { throughSequence: 11, claimTtlSecs: 900 },
      room: fakeRoom,
      participants: { builder: { actor_role: "builder", state: "resolved" } },
      contributions: { builder: { actor_role: "builder", raw_md: "lgtm" } },
    });
  });

  it("returns 404 when claim raises RoomNotFoundError", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedClaim.mockRejectedValue(new RoomNotFoundError("12345", "rm-123"));
    const res = await POST(makeRequest({ queenRunner: "r1" }), { params });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "room_not_found" });
  });

  it("returns 409 claim_already_held", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    const err = new RoomClaimAlreadyHeldError(
      "rm-123",
      "other-runner",
      11,
    );
    mockedClaim.mockRejectedValue(err);
    const res = await POST(makeRequest({ queenRunner: "r1" }), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "claim_already_held",
      heldByRunner: "other-runner",
      throughSequence: 11,
    });
  });

  it("returns 409 invalid_status_for_claim", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedClaim.mockRejectedValue(
      new RoomTransitionInvalidStatusError(
        "rm-123",
        "claim",
        ["awaiting_contributions"],
        "closed",
      ),
    );
    const res = await POST(makeRequest({ queenRunner: "r1" }), { params });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "invalid_status_for_claim",
      actualStatus: "closed",
    });
  });

  it("returns 500 if composite hydration fails after successful claim", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedClaim.mockResolvedValue({ throughSequence: 7, claimTtlSecs: 900 });
    mockedCore.mockRejectedValue(new Error("redis blip"));
    mockedParticipants.mockResolvedValue({});
    mockedContributions.mockResolvedValue({});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(makeRequest({ queenRunner: "r1" }), { params });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      code: "storage_failure",
      message: expect.stringContaining("claim TTL"),
    });
    errSpy.mockRestore();
  });
});
