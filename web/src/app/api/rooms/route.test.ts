/**
 * Tests for GET /api/rooms — list war rooms for the bearer's installation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/agent-token-v1-auth", () => ({
  authenticateAgentRequestV1: vi.fn(),
}));

vi.mock("@/server/war-room", () => ({
  listRooms: vi.fn(),
}));

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { listRooms } from "@/server/war-room";
import { GET, POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedListRooms = vi.mocked(listRooms);

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
    capabilities: ["rooms.read"],
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
      { requires: "rooms.read" },
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

describe("POST /api/rooms", () => {
  it("returns 405 method_not_allowed (room creation lands in D.1.b-ii)", async () => {
    const res = await POST();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    const body = await res.json();
    expect(body.code).toBe("method_not_allowed");
  });
});
