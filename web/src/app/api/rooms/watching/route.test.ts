/**
 * Tests for GET /api/rooms/watching — role-bound watch list.
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
    listRooms: vi.fn(),
    getRoomParticipants: vi.fn(),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  listRooms,
  getRoomParticipants,
  type RoomCoreWithId,
  type RoomParticipant,
} from "@/server/war-room";
import { GET } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedListRooms = vi.mocked(listRooms);
const mockedGetParticipants = vi.mocked(getRoomParticipants);

const RID_A = "01234567-89ab-4cde-9012-3456789abcde";
const RID_B = "fedcba98-7654-4321-89ab-fedcba987654";
const RID_C = "11111111-2222-4333-9444-555555555555";

function makeRequest(): NextRequest {
  return new NextRequest("https://www.hivemoot.dev/api/rooms/watching", {
    method: "GET",
    headers: { authorization: "Bearer hmt_test" },
  });
}

function makeWorkerAuth(role = "drone") {
  const fakeRedis = {
    get: vi.fn(async (_key: string) => 5),
  } as never;
  return {
    ok: true as const,
    installationId: "12345",
    name: "drone-1",
    agent_role: role,
    capabilities: ["rooms.watch", "rooms.read", "rooms.contribute"],
    redis: fakeRedis,
    envelope: { fingerprint: "fp", expiresAt: null } as never,
  };
}

function room(
  id: string,
  status: "awaiting_rsvp" | "awaiting_contributions" | "deciding" | "closed",
): RoomCoreWithId {
  return {
    roomId: id,
    manager: "bot-queen",
    subject_type: "pr_review",
    subject_ref: `hivemoot/hivemoot#${id.slice(-3)}`,
    opened_at: "2026-04-28T07:00:00.000Z",
    timing_config: {
      max_age_secs: 3600,
      rsvp_deadline_secs: 600,
      contribution_deadline_secs: 1200,
    },
    status,
  };
}

function participant(
  role: string,
  status: RoomParticipant["status"],
  withdrew_at_sequence?: number,
): RoomParticipant {
  return {
    agent_id: `${role}-1`,
    role,
    status,
    rsvp_at: "2026-04-28T07:00:00.000Z",
    ...(withdrew_at_sequence !== undefined ? { withdrew_at_sequence } : {}),
  };
}

describe("GET /api/rooms/watching", () => {
  beforeEach(() => {
    mockedAuth.mockReset();
    mockedListRooms.mockReset();
    mockedGetParticipants.mockReset();
  });

  it("requires rooms.watch capability", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 403 }),
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      { requires: "rooms.watch" },
    );
  });

  it("excludes closed rooms — status filter applied BEFORE participant fetch", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedListRooms.mockResolvedValue([room(RID_A, "closed")]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).rooms).toEqual([]);
    // Closed room → never read participants
    expect(mockedGetParticipants).not.toHaveBeenCalled();
  });

  it("excludes deciding rooms — workers shouldn't act on synthesis-in-progress", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedListRooms.mockResolvedValue([room(RID_A, "deciding")]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.rooms).toEqual([]);
    expect(mockedGetParticipants).not.toHaveBeenCalled();
  });

  it("includes awaiting_rsvp room when role has no participant slot", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth("drone"));
    mockedListRooms.mockResolvedValue([room(RID_A, "awaiting_rsvp")]);
    mockedGetParticipants.mockResolvedValue({}); // no slot for drone
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].core.roomId).toBe(RID_A);
    expect(body.rooms[0].currentSequence).toBe(5);
  });

  it("includes awaiting_contributions room where drone is `pending`", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth("drone"));
    mockedListRooms.mockResolvedValue([room(RID_A, "awaiting_contributions")]);
    mockedGetParticipants.mockResolvedValue({
      drone: participant("drone", "pending"),
    });
    const res = await GET(makeRequest());
    expect((await res.json()).rooms).toHaveLength(1);
  });

  it("EXCLUDES room where drone is already `resolved` (already contributed)", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth("drone"));
    mockedListRooms.mockResolvedValue([room(RID_A, "awaiting_contributions")]);
    mockedGetParticipants.mockResolvedValue({
      drone: participant("drone", "resolved"),
    });
    const res = await GET(makeRequest());
    expect((await res.json()).rooms).toEqual([]);
  });

  it("EXCLUDES room where drone is `timed_out`", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth("drone"));
    mockedListRooms.mockResolvedValue([room(RID_A, "awaiting_contributions")]);
    mockedGetParticipants.mockResolvedValue({
      drone: participant("drone", "timed_out"),
    });
    const res = await GET(makeRequest());
    expect((await res.json()).rooms).toEqual([]);
  });

  it("EXCLUDES `withdrew` room when no new events past withdrew_at_sequence", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth("drone"));
    mockedListRooms.mockResolvedValue([room(RID_A, "awaiting_contributions")]);
    // withdrew_at_sequence == currentSequence (5) → no new events; excluded.
    mockedGetParticipants.mockResolvedValue({
      drone: participant("drone", "withdrew", 5),
    });
    const res = await GET(makeRequest());
    expect((await res.json()).rooms).toEqual([]);
  });

  it("INCLUDES `withdrew` room when room has new events past withdrew_at_sequence (re-RSVP eligible per design L780-783)", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth("drone"));
    mockedListRooms.mockResolvedValue([room(RID_A, "awaiting_contributions")]);
    // withdrew at seq 2; current seq is 5 → 3 new events past withdrawal.
    mockedGetParticipants.mockResolvedValue({
      drone: participant("drone", "withdrew", 2),
    });
    const res = await GET(makeRequest());
    expect((await res.json()).rooms).toHaveLength(1);
  });

  it("ROLE BOUNDARY: drone role doesn't see `builder`-resolved rooms; sees them when bearer is builder", async () => {
    // Same room state, two different bearer roles.
    mockedListRooms.mockResolvedValue([room(RID_A, "awaiting_contributions")]);
    mockedGetParticipants.mockResolvedValue({
      builder: participant("builder", "resolved"),
    });

    // Drone bearer: no slot → eligible
    mockedAuth.mockResolvedValue(makeWorkerAuth("drone"));
    const droneRes = await GET(makeRequest());
    expect((await droneRes.json()).rooms).toHaveLength(1);

    // Builder bearer: resolved → excluded
    mockedAuth.mockReset();
    mockedAuth.mockResolvedValue(makeWorkerAuth("builder"));
    mockedGetParticipants.mockReset();
    mockedGetParticipants.mockResolvedValue({
      builder: participant("builder", "resolved"),
    });
    const builderRes = await GET(makeRequest());
    expect((await builderRes.json()).rooms).toEqual([]);
  });

  it("returns enriched response (core + participants + currentSequence) so worker doesn't need follow-up reads", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth("drone"));
    mockedListRooms.mockResolvedValue([room(RID_A, "awaiting_contributions")]);
    const participants = { drone: participant("drone", "pending") };
    mockedGetParticipants.mockResolvedValue(participants);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.rooms[0]).toEqual(
      expect.objectContaining({
        core: expect.objectContaining({ roomId: RID_A, status: "awaiting_contributions" }),
        participants,
        currentSequence: 5,
      }),
    );
  });

  it("scopes to bearer's installation only", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth());
    mockedListRooms.mockResolvedValue([]);
    await GET(makeRequest());
    expect(mockedListRooms).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "12345" }),
    );
  });

  it("multi-room mix: filters per-role correctly across rooms", async () => {
    mockedAuth.mockResolvedValue(makeWorkerAuth("drone"));
    mockedListRooms.mockResolvedValue([
      room(RID_A, "awaiting_contributions"), // drone pending → include
      room(RID_B, "awaiting_contributions"), // drone resolved → exclude
      room(RID_C, "closed"),                  // closed → exclude (status filter)
    ]);
    mockedGetParticipants.mockImplementation(
      async (args: { roomId: string }): Promise<Record<string, RoomParticipant>> => {
        if (args.roomId === RID_A)
          return { drone: participant("drone", "pending") };
        if (args.roomId === RID_B)
          return { drone: participant("drone", "resolved") };
        return {};
      },
    );
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].core.roomId).toBe(RID_A);
  });
});
