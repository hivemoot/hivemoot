/**
 * Tests for POST /api/rooms/:roomId/force-close — operator terminate.
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
    terminateRoom: vi.fn(),
    getRoomCore: vi.fn(),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  terminateRoom,
  getRoomCore,
  RoomNotFoundError,
  RoomAlreadyClosedError,
} from "@/server/war-room";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedTerm = vi.mocked(terminateRoom);
const mockedGetCore = vi.mocked(getRoomCore);

const VALID_ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest(
    `https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/force-close`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer hmt_test",
        "content-type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : "",
    },
  );
}

function makeAdminAuth() {
  return {
    ok: true as const,
    installationId: "12345",
    name: "operator-1",
    agent_role: "admin",
    capabilities: ["rooms.force_close"],
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

describe("POST /api/rooms/:roomId/force-close", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    mockedTerm.mockReset();
    mockedGetCore.mockReset();
  });

  it("requires rooms.force_close capability", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 403 }),
    });
    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(403);
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      { requires: "rooms.force_close" },
    );
  });

  it("happy path with default reason `force_close`", async () => {
    mockedAuth.mockResolvedValue(makeAdminAuth());
    mockedGetCore.mockResolvedValue(makeFakeRoom());
    mockedTerm.mockResolvedValue(8);
    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sequence).toBe(8);
    expect(body.reason).toBe("force_close");
    expect(mockedTerm).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "force_close",
        actorRole: "admin",
        actorId: "operator-1",
      }),
    );
  });

  it("respects explicit reason from body", async () => {
    mockedAuth.mockResolvedValue(makeAdminAuth());
    mockedGetCore.mockResolvedValue(makeFakeRoom());
    mockedTerm.mockResolvedValue(8);
    const res = await POST(makeRequest({ reason: "manual" }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBe("manual");
    expect(mockedTerm).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "manual" }),
    );
  });

  it("rejects invalid reason → 400", async () => {
    mockedAuth.mockResolvedValue(makeAdminAuth());
    const res = await POST(makeRequest({ reason: "bogus" }), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_reason");
  });

  it("RoomNotFoundError on getRoomCore → 404 (no terminate attempt)", async () => {
    mockedAuth.mockResolvedValue(makeAdminAuth());
    mockedGetCore.mockRejectedValue(
      new RoomNotFoundError("12345", VALID_ROOM_ID),
    );
    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(404);
    expect(mockedTerm).not.toHaveBeenCalled();
  });

  it("RoomAlreadyClosedError → 409 room_already_closed (idempotent operator double-tap)", async () => {
    mockedAuth.mockResolvedValue(makeAdminAuth());
    mockedGetCore.mockResolvedValue(makeFakeRoom());
    mockedTerm.mockRejectedValue(
      new RoomAlreadyClosedError(VALID_ROOM_ID, "closed"),
    );
    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("room_already_closed");
    expect(body.status).toBe("closed");
  });

  it("subject is fetched server-side from room hash (no caller-supplied subject)", async () => {
    mockedAuth.mockResolvedValue(makeAdminAuth());
    mockedGetCore.mockResolvedValue(makeFakeRoom());
    mockedTerm.mockResolvedValue(8);
    await POST(makeRequest({}), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(mockedTerm).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: { type: "pr_review", ref: "hivemoot/hivemoot#1" },
      }),
    );
  });

  it("empty body (no reason) defaults to force_close (operator panic-button compat)", async () => {
    mockedAuth.mockResolvedValue(makeAdminAuth());
    mockedGetCore.mockResolvedValue(makeFakeRoom());
    mockedTerm.mockResolvedValue(8);
    // POST with content-length: 0 — no body parsed
    const req = new NextRequest(
      `https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/force-close`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer hmt_test",
          "content-length": "0",
        },
      },
    );
    const res = await POST(req, {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(200);
    expect(mockedTerm).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "force_close" }),
    );
  });

  it("BLOCKING regression #519 R1: malformed JSON → 400, terminateRoom NEVER called", async () => {
    mockedAuth.mockResolvedValue(makeAdminAuth());
    // Operator request with truncated/garbage body must NOT silently
    // fall back to defaults and trigger a real terminal state change.
    const req = new NextRequest(
      `https://www.hivemoot.dev/api/rooms/${VALID_ROOM_ID}/force-close`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer hmt_test",
          "content-type": "application/json",
        },
        body: "not json at all{{{",
      },
    );
    const res = await POST(req, {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_json");
    // CRITICAL: room is NOT actually terminated.
    expect(mockedTerm).not.toHaveBeenCalled();
    expect(mockedGetCore).not.toHaveBeenCalled();
  });

  it("body=null → 400 invalid_body_shape (closes #519 R1 cast-bypass)", async () => {
    mockedAuth.mockResolvedValue(makeAdminAuth());
    const res = await POST(makeRequest(null), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_body_shape");
    expect(mockedTerm).not.toHaveBeenCalled();
  });

  it("body=array → 400 invalid_body_shape", async () => {
    mockedAuth.mockResolvedValue(makeAdminAuth());
    const res = await POST(makeRequest([{ reason: "manual" }]), {
      params: Promise.resolve({ roomId: VALID_ROOM_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_body_shape");
    expect(mockedTerm).not.toHaveBeenCalled();
  });
});
