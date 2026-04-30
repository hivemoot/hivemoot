/**
 * Tests for /api/rooms — list (GET) and create (POST) war rooms.
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
    listRooms: vi.fn(),
    createRoom: vi.fn(),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  listRooms,
  createRoom,
  RoomSubjectAlreadyOpenError,
  RoomSubjectRefError,
  RoomIdTakenError,
} from "@hivemoot/war-room";
import { GET, POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedListRooms = vi.mocked(listRooms);
const mockedCreateRoom = vi.mocked(createRoom);

function makeRequest(url: string = "https://www.hivemoot.dev/api/rooms"): NextRequest {
  return new NextRequest(url, {
    method: "GET",
    headers: { authorization: "Bearer hmt_test" },
  });
}

function makeAuthOk(overrides?: { installationId?: string }) {
  return {
    ok: true as const,
    installationId: overrides?.installationId ?? "12345",
    name: "queen",
    agent_role: "queen",
    capabilities: ["rooms.read_all"],
    redis: {} as never,
    envelope: { fingerprint: "fp", expiresAt: null } as never,
  };
}

describe("GET /api/rooms", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    mockedListRooms.mockReset();
  });

  it("delegates 401 to auth middleware on missing/invalid bearer", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "agent_auth_v1_missing_bearer" }, { status: 401 }),
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockedListRooms).not.toHaveBeenCalled();
  });

  it("requires rooms.read capability (passed to authenticateAgentRequestV1)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedListRooms.mockResolvedValue([]);
    await GET(makeRequest());
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      { requires: "rooms.read_all" },
    );
  });

  it("returns rooms scoped to the bearer's installation (no cross-installation read)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk({ installationId: "12345" }));
    const fakeRooms = [{ status: "awaiting_rsvp" } as never];
    mockedListRooms.mockResolvedValue(fakeRooms);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms).toEqual(fakeRooms);
    expect(mockedListRooms).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "12345" }),
    );
  });

  it("ignores client-supplied installationId — bearer's installation wins", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk({ installationId: "BEARER_INSTALL" }));
    mockedListRooms.mockResolvedValue([]);
    await GET(makeRequest("https://www.hivemoot.dev/api/rooms?installationId=ATTACKER_INSTALL"));
    expect(mockedListRooms).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "BEARER_INSTALL" }),
    );
  });

  it("default limit is 50 when query omitted", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedListRooms.mockResolvedValue([]);
    await GET(makeRequest());
    expect(mockedListRooms).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("respects valid limit query param", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedListRooms.mockResolvedValue([]);
    await GET(makeRequest("https://www.hivemoot.dev/api/rooms?limit=20"));
    expect(mockedListRooms).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
    );
  });

  it("clamps limit to MAX_LIMIT (200) on huge values", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedListRooms.mockResolvedValue([]);
    await GET(makeRequest("https://www.hivemoot.dev/api/rooms?limit=10000"));
    expect(mockedListRooms).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 }),
    );
  });

  it("clamps limit to 1 on zero/negative", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedListRooms.mockResolvedValue([]);
    await GET(makeRequest("https://www.hivemoot.dev/api/rooms?limit=-5"));
    expect(mockedListRooms).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 }),
    );
  });

  it("falls back to default on non-numeric limit", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedListRooms.mockResolvedValue([]);
    await GET(makeRequest("https://www.hivemoot.dev/api/rooms?limit=abc"));
    expect(mockedListRooms).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });
});

describe("POST /api/rooms (D.1.b-ii — create room)", () => {
  function makePostRequest(body: unknown): NextRequest {
    return new NextRequest("https://www.hivemoot.dev/api/rooms", {
      method: "POST",
      headers: {
        authorization: "Bearer hmt_test",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  function makeQueenAuth() {
    return {
      ok: true as const,
      installationId: "12345",
      name: "bot-queen",
      agent_role: "queen",
      capabilities: ["rooms.create", "rooms.read_all"],
      redis: {} as never,
      envelope: { fingerprint: "fp", expiresAt: null } as never,
    };
  }

  beforeEach(() => {
    mockedAuth.mockReset();
    mockedListRooms.mockReset();
    mockedCreateRoom.mockReset();
  });

  it("requires rooms.create capability", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { code: "agent_auth_v1_missing_capability", missing: "rooms.create" },
        { status: 403 },
      ),
    });
    const res = await POST(
      makePostRequest({
        subject: { type: "pr_review", ref: "hivemoot/hivemoot#1" },
      }),
    );
    expect(res.status).toBe(403);
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      { requires: "rooms.create" },
    );
    expect(mockedCreateRoom).not.toHaveBeenCalled();
  });

  it("creates a room scoped to the bearer's installation (no client-supplied installation override)", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedCreateRoom.mockResolvedValue({
      manager: "bot-queen",
      subject_type: "pr_review",
      subject_ref: "hivemoot/hivemoot#1",
      status: "awaiting_rsvp",
    } as never);
    const res = await POST(
      makePostRequest({
        subject: { type: "pr_review", ref: "hivemoot/hivemoot#1" },
      }),
    );
    expect(res.status).toBe(201);
    expect(mockedCreateRoom).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "12345" }),
    );
  });

  it("auto-mints a UUIDv4 roomId when caller omits one", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedCreateRoom.mockResolvedValue({} as never);
    await POST(
      makePostRequest({
        subject: { type: "pr_review", ref: "hivemoot/hivemoot#1" },
      }),
    );
    const calledWith = mockedCreateRoom.mock.calls[0][0];
    expect(calledWith.roomId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("respects caller-supplied roomId when present", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedCreateRoom.mockResolvedValue({} as never);
    await POST(
      makePostRequest({
        subject: { type: "pr_review", ref: "hivemoot/hivemoot#1" },
        roomId: "01234567-89ab-4cde-9012-3456789abcde",
      }),
    );
    expect(mockedCreateRoom).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "01234567-89ab-4cde-9012-3456789abcde",
      }),
    );
  });

  it("manager defaults to bearer's name when omitted", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedCreateRoom.mockResolvedValue({} as never);
    await POST(
      makePostRequest({
        subject: { type: "pr_review", ref: "hivemoot/hivemoot#1" },
      }),
    );
    expect(mockedCreateRoom).toHaveBeenCalledWith(
      expect.objectContaining({ manager: "bot-queen" }),
    );
  });

  it("body=null → 400 invalid_body_shape (closes #519 builder R1)", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    const res = await POST(makePostRequest(null));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_body_shape");
    expect(mockedCreateRoom).not.toHaveBeenCalled();
  });

  it("body=array → 400 invalid_body_shape", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    const res = await POST(
      makePostRequest([{ subject: { type: "pr_review", ref: "x/y#1" } }]),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_body_shape");
    expect(mockedCreateRoom).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON body → 400 invalid_json", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    const req = new NextRequest("https://www.hivemoot.dev/api/rooms", {
      method: "POST",
      headers: {
        authorization: "Bearer hmt_test",
        "content-type": "application/json",
      },
      body: "not json{{{",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_json");
  });

  it("rejects missing subject → 400 invalid_subject", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    const res = await POST(makePostRequest({}));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_subject");
  });

  it("rejects unknown subject_type → 400 invalid_subject_type", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    const res = await POST(
      makePostRequest({
        subject: { type: "release_review", ref: "hivemoot/hivemoot#1" },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_subject_type");
  });

  it("RoomSubjectAlreadyOpenError → 409 with existingRoomId", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedCreateRoom.mockRejectedValue(
      new RoomSubjectAlreadyOpenError(
        "12345",
        "pr_review",
        "hivemoot/hivemoot#1",
        "OLD_ROOM_ID",
      ),
    );
    const res = await POST(
      makePostRequest({
        subject: { type: "pr_review", ref: "hivemoot/hivemoot#1" },
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("subject_already_open");
    expect(body.existingRoomId).toBe("OLD_ROOM_ID");
  });

  it("RoomSubjectRefError → 400 invalid_subject_ref", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedCreateRoom.mockRejectedValue(
      new RoomSubjectRefError(
        "pr_review",
        "malformed-ref",
        "owner/repo#NNN",
      ),
    );
    const res = await POST(
      makePostRequest({
        subject: { type: "pr_review", ref: "malformed-ref" },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_subject_ref");
  });

  it("RoomIdTakenError → 409 room_id_taken", async () => {
    mockedAuth.mockResolvedValue(makeQueenAuth());
    mockedCreateRoom.mockRejectedValue(
      new RoomIdTakenError("12345", "01234567-89ab-4cde-9012-3456789abcde"),
    );
    const res = await POST(
      makePostRequest({
        subject: { type: "pr_review", ref: "hivemoot/hivemoot#1" },
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("room_id_taken");
  });
});

describe("R2 worker-vs-queen capability enforcement (closes #517 builder R1)", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    mockedListRooms.mockReset();
  });

  it("rejects with 403 when bearer's only rooms-cap is `rooms.read` (worker preset)", async () => {
    // Simulate the middleware's behavior when a worker bearer
    // (capabilities=[rooms.read, rooms.watch, rooms.contribute]) hits
    // the list endpoint requiring rooms.read_all. Middleware returns
    // 403 with a missing-capability error code.
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        {
          code: "agent_auth_v1_missing_capability",
          missing: "rooms.read_all",
        },
        { status: 403 },
      ),
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(mockedListRooms).not.toHaveBeenCalled();
  });

  it("queen / monitoring bearer (with rooms.read_all) succeeds", async () => {
    // Both queen and monitoring presets include rooms.read_all per
    // PRESETS in agent-token-capabilities.ts.
    mockedAuth.mockResolvedValue({
      ok: true as const,
      installationId: "12345",
      name: "monitor",
      agent_role: "monitoring",
      capabilities: ["rooms.read", "rooms.read_all", "agent_health.read", "tasks.read"],
      redis: {} as never,
      envelope: { fingerprint: "fp", expiresAt: null } as never,
    });
    mockedListRooms.mockResolvedValue([]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
  });
});
