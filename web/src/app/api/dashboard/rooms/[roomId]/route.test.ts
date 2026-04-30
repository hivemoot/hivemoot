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
    getRoomCore: vi.fn(),
    getRoomParticipants: vi.fn(),
    getRoomContributions: vi.fn(),
    listRecentRoomEvents: vi.fn(),
  };
});

import { authenticateByokRequest } from "@/server/byok-auth";
import {
  getRoomCore,
  getRoomContributions,
  getRoomParticipants,
  listRecentRoomEvents,
  RoomNotFoundError,
  RoomIdFormatError,
} from "@hivemoot/war-room";
import { GET } from "./route";

const ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";
const mockedAuth = vi.mocked(authenticateByokRequest);
const mockedGetCore = vi.mocked(getRoomCore);
const mockedGetParticipants = vi.mocked(getRoomParticipants);
const mockedGetContributions = vi.mocked(getRoomContributions);
const mockedListEvents = vi.mocked(listRecentRoomEvents);

function makeRequest(url = `https://www.hivemoot.dev/api/dashboard/rooms/${ROOM_ID}`): NextRequest {
  return new NextRequest(url, { method: "GET" });
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

const FAKE_CORE = {
  manager: "bot-queen",
  subject_type: "pr_review" as const,
  subject_ref: "owner/repo#42",
  status: "deciding" as const,
  opened_at: "2026-04-28T20:00:00Z",
  timing_config: {
    max_age_secs: 3600,
    rsvp_deadline_secs: 600,
    contribution_deadline_secs: 1200,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/dashboard/rooms/:roomId", () => {
  it("returns 401 when session auth fails", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 401 }),
    });
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: ROOM_ID }),
    });
    expect(res.status).toBe(401);
    expect(mockedGetCore).not.toHaveBeenCalled();
  });

  it("returns 404 when session has no installationId (same shape as cross-install)", async () => {
    // Important: we don't return a different shape for unscoped vs
    // not-found, otherwise an unauthenticated probe could
    // distinguish the two and discover roomIds.
    mockedAuth.mockResolvedValue(makeAuth(null));
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: ROOM_ID }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("room_not_found");
    expect(mockedGetCore).not.toHaveBeenCalled();
  });

  it("returns 404 with code room_not_found when storage RoomNotFoundError", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedGetCore.mockRejectedValue(new RoomNotFoundError("12345", ROOM_ID));
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: ROOM_ID }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("room_not_found");
  });

  it("returns 404 on RoomIdFormatError (malformed roomId)", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedGetCore.mockRejectedValue(new RoomIdFormatError("malformed"));
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: "malformed" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("room_not_found");
  });

  it("happy path returns composite { roomId, core, participants, contributions, events, eventLimit }", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedGetCore.mockResolvedValue(FAKE_CORE);
    mockedGetParticipants.mockResolvedValue({
      drone: {
        agent_id: "drone-1",
        role: "drone",
        status: "resolved",
        rsvp_at: "2026-04-28T20:01:00Z",
      },
    });
    mockedGetContributions.mockResolvedValue({
      drone: {
        body: { verdict: "APPROVE", summary: "lgtm" },
        raw_md: "LGTM",
        contributed_at: "2026-04-28T20:05:00Z",
      },
    });
    mockedListEvents.mockResolvedValue([
      {
        seq: 1,
        timestamp: "2026-04-28T20:00:00Z",
        event_type: "room_opened",
        actor_role: "manager",
        actor_id: "bot-queen",
        body: {},
      },
    ]);
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: ROOM_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      roomId: ROOM_ID,
      core: FAKE_CORE,
      participants: expect.any(Object),
      contributions: expect.any(Object),
      events: expect.any(Array),
      eventLimit: 100, // default
    });
    expect(body.participants.drone.role).toBe("drone");
    expect(body.events).toHaveLength(1);
  });

  it("scopes core read to session installationId (cross-install isolation)", async () => {
    mockedAuth.mockResolvedValue(makeAuth("99999"));
    mockedGetCore.mockResolvedValue(FAKE_CORE);
    mockedGetParticipants.mockResolvedValue({});
    mockedGetContributions.mockResolvedValue({});
    mockedListEvents.mockResolvedValue([]);
    await GET(makeRequest(), {
      params: Promise.resolve({ roomId: ROOM_ID }),
    });
    expect(mockedGetCore).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "99999",
        roomId: ROOM_ID,
      }),
    );
  });

  it("respects ?eventLimit query param within bounds", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedGetCore.mockResolvedValue(FAKE_CORE);
    mockedGetParticipants.mockResolvedValue({});
    mockedGetContributions.mockResolvedValue({});
    mockedListEvents.mockResolvedValue([]);
    await GET(
      makeRequest(
        `https://www.hivemoot.dev/api/dashboard/rooms/${ROOM_ID}?eventLimit=25`,
      ),
      { params: Promise.resolve({ roomId: ROOM_ID }) },
    );
    expect(mockedListEvents).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25 }),
    );
  });

  it("clamps ?eventLimit above MAX to 500", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedGetCore.mockResolvedValue(FAKE_CORE);
    mockedGetParticipants.mockResolvedValue({});
    mockedGetContributions.mockResolvedValue({});
    mockedListEvents.mockResolvedValue([]);
    await GET(
      makeRequest(
        `https://www.hivemoot.dev/api/dashboard/rooms/${ROOM_ID}?eventLimit=9999`,
      ),
      { params: Promise.resolve({ roomId: ROOM_ID }) },
    );
    expect(mockedListEvents).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 500 }),
    );
  });

  it("calls listRecentRoomEvents (tail) NOT listRoomEvents (since=0) — closes #551 builder R1 #2", async () => {
    // Pin the contract: events response is the TAIL of the log
    // (most-recent up to limit, chronological), not the head. This
    // matters for rooms with > eventLimit events where the dashboard
    // detail page needs to show recent close/recovery/subject_updated
    // activity, not just the room_opened event from N days ago.
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedGetCore.mockResolvedValue(FAKE_CORE);
    mockedGetParticipants.mockResolvedValue({});
    mockedGetContributions.mockResolvedValue({});
    // Storage returns recent events in chronological order.
    mockedListEvents.mockResolvedValue([
      {
        seq: 999,
        timestamp: "2026-04-28T20:30:00Z",
        event_type: "room_decided",
        actor_role: "manager",
        actor_id: "queen",
        body: {},
      },
    ]);
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: ROOM_ID }),
    });
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].seq).toBe(999); // recent event surfaced
    // Verify the tail-reading function was called, NOT the
    // head-reading listRoomEvents.
    expect(mockedListEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: ROOM_ID,
        limit: 100,
      }),
    );
    // Make sure no `since` arg was passed (would imply head-read).
    const args = mockedListEvents.mock.calls[0][0];
    expect("since" in args).toBe(false);
  });

  it("returns 500 on unexpected storage error (not RoomNotFound)", async () => {
    mockedAuth.mockResolvedValue(makeAuth("12345"));
    mockedGetCore.mockRejectedValue(new Error("Redis down"));
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ roomId: ROOM_ID }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("load_room_failed");
  });
});
