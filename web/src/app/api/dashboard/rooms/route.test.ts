import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
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

import { authenticateByokRequest } from "@/server/byok-auth";
import {
  listRooms,
  createRoom,
  RoomSubjectRefError,
  RoomSubjectAlreadyOpenError,
} from "@hivemoot/war-room";
import { GET, POST } from "./route";

const mockedAuth = vi.mocked(authenticateByokRequest);
const mockedList = vi.mocked(listRooms);
const mockedCreate = vi.mocked(createRoom);

function makeRequest(url = "https://www.hivemoot.dev/api/dashboard/rooms"): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("https://www.hivemoot.dev/api/dashboard/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeAuth(installationId: string | null) {
  return {
    ok: true as const,
    session: {
      installationId,
      userId: 101,
      userLogin: "queen",
    },
    redis: {} as never,
    keyring: new Map(),
    activeKeyVersion: "v1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/dashboard/rooms", () => {
  it("returns 401 when session auth fails", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 401 }),
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("returns empty list when session has no installationId", async () => {
    mockedAuth.mockResolvedValue(makeAuth(null));
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rooms: [] });
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("returns rooms scoped to session installationId", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedList.mockResolvedValue([
      {
        roomId: "01234567-89ab-4cde-9012-3456789abcde",
        manager: "bot-queen",
        subject_type: "pr_review",
        subject_ref: "owner/repo#42",
        status: "awaiting_contributions",
        opened_at: "2026-04-28T20:00:00Z",
        timing_config: {
          max_age_secs: 3600,
          drop_threshold_secs: 600,
          quiet_period_secs: 600,
        },
      },
    ]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].roomId).toBe("01234567-89ab-4cde-9012-3456789abcde");
    expect(mockedList).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "12345",
        limit: 50, // default
      }),
    );
  });

  it("respects ?limit query param within bounds", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedList.mockResolvedValue([]);
    await GET(
      makeRequest("https://www.hivemoot.dev/api/dashboard/rooms?limit=25"),
    );
    expect(mockedList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25 }),
    );
  });

  it("clamps ?limit above MAX_LIMIT to 200", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedList.mockResolvedValue([]);
    await GET(
      makeRequest("https://www.hivemoot.dev/api/dashboard/rooms?limit=9999"),
    );
    expect(mockedList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 }),
    );
  });

  it("clamps ?limit below 1 to 1", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedList.mockResolvedValue([]);
    await GET(
      makeRequest("https://www.hivemoot.dev/api/dashboard/rooms?limit=0"),
    );
    expect(mockedList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 }),
    );
  });

  it("ignores non-numeric ?limit and uses default", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedList.mockResolvedValue([]);
    await GET(
      makeRequest("https://www.hivemoot.dev/api/dashboard/rooms?limit=abc"),
    );
    expect(mockedList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("returns 500 when storage throws", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedList.mockRejectedValue(new Error("Redis down"));
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("list_rooms_failed");
  });
});

describe("POST /api/dashboard/rooms — operator-driven create", () => {
  it("returns 401 when session auth fails", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 401 }),
    });
    const res = await POST(makePostRequest({
      subject_type: "general",
      subject_ref: "Plan the release",
    }));
    expect(res.status).toBe(401);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("returns 403 when session has no installationId", async () => {
    mockedAuth.mockResolvedValue(makeAuth(null));
    const res = await POST(makePostRequest({
      subject_type: "general",
      subject_ref: "Plan the release",
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("no_installation");
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("returns 400 on malformed JSON body", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    const res = await POST(makePostRequest("not-json"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_body");
  });

  it("returns 400 when subject_type is missing", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    const res = await POST(makePostRequest({
      subject_ref: "Plan the release",
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_body");
  });

  it("rejects pr_review (only `general` is allowed for manual creation)", async () => {
    // Repo-anchored types are bot-driven with deterministic roomIds —
    // letting an operator create one would risk colliding with a
    // future bot create. Tightening the allowlist here is the gate.
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    const res = await POST(makePostRequest({
      subject_type: "pr_review",
      subject_ref: "owner/repo#42",
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("subject_type_not_allowed");
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when subject_ref is empty / non-string", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    const res1 = await POST(makePostRequest({
      subject_type: "general",
      subject_ref: "",
    }));
    expect(res1.status).toBe(400);

    const res2 = await POST(makePostRequest({
      subject_type: "general",
      subject_ref: 42,
    }));
    expect(res2.status).toBe(400);
  });

  it("happy path: creates a general room and returns 201 with roomId + room", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedCreate.mockResolvedValue({
      manager: "operator-queen",
      subject_type: "general",
      subject_ref: "Plan the release",
      status: "awaiting_contributions",
      opened_at: "2026-05-04T15:00:00Z",
      timing_config: {
        max_age_secs: 3600,
        drop_threshold_secs: 1200,
        quiet_period_secs: 600,
      },
    });
    const res = await POST(makePostRequest({
      subject_type: "general",
      subject_ref: "Plan the release",
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.roomId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(body.room.subject_type).toBe("general");
    expect(body.room.subject_ref).toBe("Plan the release");
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "12345",
        manager: "operator-queen",
        subject: { type: "general", ref: "Plan the release" },
      }),
    );
  });

  it("translates RoomSubjectRefError to 400 invalid_subject_ref", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedCreate.mockRejectedValue(
      new RoomSubjectRefError(
        "general",
        "x".repeat(201),
        "max 200 chars",
      ),
    );
    const res = await POST(makePostRequest({
      subject_type: "general",
      subject_ref: "x".repeat(201),
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_subject_ref");
  });

  it("translates RoomSubjectAlreadyOpenError to 409", async () => {
    // Defensive: with the current allowlist (general only) this code
    // path can't actually fire — general's lock key is per-roomId
    // so collisions are impossible. The mapping is here so widening
    // the allowlist later doesn't surface the raw error as a 500.
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedCreate.mockRejectedValue(
      new RoomSubjectAlreadyOpenError(
        "12345",
        "general",
        "shared title",
        "01234567-89ab-4cde-9012-3456789abcde",
      ),
    );
    const res = await POST(makePostRequest({
      subject_type: "general",
      subject_ref: "shared title",
    }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("subject_already_open");
    expect(body.existingRoomId).toBe("01234567-89ab-4cde-9012-3456789abcde");
  });

  it("returns 500 on unexpected storage failure", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedCreate.mockRejectedValue(new Error("Redis down"));
    const res = await POST(makePostRequest({
      subject_type: "general",
      subject_ref: "Plan the release",
    }));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("create_failed");
  });
});
