/**
 * Tests for POST /api/rooms/:roomId/decide — claim synthesis.
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
    claimSynthesis: vi.fn(),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  claimSynthesis,
  RoomNotFoundError,
  RoomClaimAlreadyHeldError,
  RoomTransitionInvalidStatusError,
  RoomClaimPayloadCorruptError,
  RoomRunnerFormatError,
} from "@hivemoot/war-room";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedClaim = vi.mocked(claimSynthesis);

const VALID_ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    `https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/decide`,
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
    capabilities: ["rooms.decide"],
    redis: {} as never,
    envelope: { fingerprint: "fp", expiresAt: null } as never,
  };
}

describe("POST /api/rooms/:roomId/decide", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    mockedClaim.mockReset();
  });

  it("requires rooms.decide capability", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { code: "agent_auth_v1_missing_capability" },
        { status: 403 },
      ),
    });
    const res = await POST(makeRequest({ queenRunner: "queen-A" }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(403);
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      { requires: "rooms.decide" },
    );
    expect(mockedClaim).not.toHaveBeenCalled();
  });

  it("happy path → returns throughSequence + claimTtlSecs", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedClaim.mockResolvedValue({ throughSequence: 7, claimTtlSecs: 360 });
    const res = await POST(makeRequest({ queenRunner: "queen-A" }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ throughSequence: 7, claimTtlSecs: 360 });
    expect(mockedClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "12345",
        roomId: VALID_ROOM_ID,
        queenRunner: "queen-A",
      }),
    );
  });

  it("respects optional claimTtlSecs override", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedClaim.mockResolvedValue({ throughSequence: 1, claimTtlSecs: 120 });
    await POST(makeRequest({ queenRunner: "queen-A", claimTtlSecs: 120 }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(mockedClaim).toHaveBeenCalledWith(
      expect.objectContaining({ claimTtlSecs: 120 }),
    );
  });

  it("rejects missing queenRunner → 400", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_queen_runner");
  });

  it("rejects negative claimTtlSecs → 400", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    const res = await POST(
      makeRequest({ queenRunner: "queen-A", claimTtlSecs: -10 }),
      { params: Promise.resolve({ roomId: VALID_ROOM_ID }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_claim_ttl");
  });

  it("RoomRunnerFormatError → 400 invalid_queen_runner", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedClaim.mockRejectedValue(
      new RoomRunnerFormatError("queen__SEQ__bad", "sentinel collision"),
    );
    const res = await POST(makeRequest({ queenRunner: "queen__SEQ__bad" }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_queen_runner");
  });

  it("RoomNotFoundError → 404", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedClaim.mockRejectedValue(
      new RoomNotFoundError("12345", VALID_ROOM_ID),
    );
    const res = await POST(makeRequest({ queenRunner: "queen-A" }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("RoomClaimAlreadyHeldError → 409 with holder identity + throughSequence", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedClaim.mockRejectedValue(
      new RoomClaimAlreadyHeldError(VALID_ROOM_ID, "queen-other", 5),
    );
    const res = await POST(makeRequest({ queenRunner: "queen-A" }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("claim_already_held");
    expect(body.heldByRunner).toBe("queen-other");
    expect(body.throughSequence).toBe(5);
  });

  it("RoomTransitionInvalidStatusError → 409 with actualStatus", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedClaim.mockRejectedValue(
      new RoomTransitionInvalidStatusError(
        VALID_ROOM_ID,
        "claim_synthesis",
        ["awaiting_contributions"],
        "deciding",
      ),
    );
    const res = await POST(makeRequest({ queenRunner: "queen-A" }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("invalid_status_for_claim");
    expect(body.actualStatus).toBe("deciding");
  });

  it("body=null → 400 invalid_body_shape (closes #519 builder R1)", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    const res = await POST(makeRequest(null), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_body_shape");
    expect(mockedClaim).not.toHaveBeenCalled();
  });

  it("body=array → 400 invalid_body_shape", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    const res = await POST(makeRequest([{ queenRunner: "q" }]), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_body_shape");
    expect(mockedClaim).not.toHaveBeenCalled();
  });

  it("RoomClaimPayloadCorruptError → 409 claim_payload_corrupt", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedClaim.mockRejectedValue(new RoomClaimPayloadCorruptError(VALID_ROOM_ID));
    const res = await POST(makeRequest({ queenRunner: "queen-A" }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("claim_payload_corrupt");
  });
});
