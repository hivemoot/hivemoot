import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));
vi.mock("@/server/agent-token", () => ({
  generateAgentToken: vi.fn(),
  getAgentToken: vi.fn(),
  revokeAgentToken: vi.fn(),
}));

import { authenticateByokRequest } from "@/server/byok-auth";
import { generateAgentToken, getAgentToken, revokeAgentToken } from "@/server/agent-token";
import { POST, GET, DELETE } from "./route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SESSION = {
  installationId: "inst-123",
  userId: 1,
  userLogin: "alice",
  expiresAt: Date.now() + 60_000,
};

const MOCK_KEYRING = new Map([["v1", Buffer.alloc(32)]]);

function mockAuthSuccess() {
  vi.mocked(authenticateByokRequest).mockResolvedValue({
    ok: true,
    session: MOCK_SESSION,
    keyring: MOCK_KEYRING,
    activeKeyVersion: "v1",
    redis: {} as never,
  });
}

function mockAuthFailure(status: number, code: string, message: string) {
  vi.mocked(authenticateByokRequest).mockResolvedValue({
    ok: false,
    response: NextResponse.json({ code, message }, { status }),
  });
}

function makeRequest(method: string) {
  return new NextRequest(`https://example.com/api/agent-token`, { method });
}

const TOKEN_RESULT = {
  token: "a".repeat(64),
  fingerprint: "aaaa",
  createdAt: "2026-02-25T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthSuccess();
});

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

describe("POST /api/agent-token", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuthFailure(401, "byok_not_authenticated", "Not authenticated");
    const res = await POST(makeRequest("POST"));
    expect(res.status).toBe(401);
  });

  it("generates new token, returns 201", async () => {
    vi.mocked(getAgentToken).mockResolvedValue(null); // no existing token
    vi.mocked(generateAgentToken).mockResolvedValue(TOKEN_RESULT);

    const res = await POST(makeRequest("POST"));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toBe(TOKEN_RESULT.token);
    expect(body.fingerprint).toBe(TOKEN_RESULT.fingerprint);
    expect(body.created_at).toBe(TOKEN_RESULT.createdAt);
  });

  it("rotates existing token, returns 200", async () => {
    vi.mocked(getAgentToken).mockResolvedValue(TOKEN_RESULT); // existing token
    vi.mocked(generateAgentToken).mockResolvedValue({
      ...TOKEN_RESULT,
      token: "b".repeat(64),
      fingerprint: "bbbb",
    });

    const res = await POST(makeRequest("POST"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe("b".repeat(64));
  });

  it("returns 500 when generateAgentToken throws", async () => {
    vi.mocked(getAgentToken).mockResolvedValue(null);
    vi.mocked(generateAgentToken).mockRejectedValue(new Error("Redis failure"));

    const res = await POST(makeRequest("POST"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("agent_health_server_error");
  });
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

describe("GET /api/agent-token", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuthFailure(401, "byok_not_authenticated", "Not authenticated");
    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(401);
  });

  it("returns token when it exists", async () => {
    vi.mocked(getAgentToken).mockResolvedValue(TOKEN_RESULT);

    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe(TOKEN_RESULT.token);
    expect(body.fingerprint).toBe(TOKEN_RESULT.fingerprint);
    expect(body.created_at).toBe(TOKEN_RESULT.createdAt);
  });

  it("returns 404 when no token exists", async () => {
    vi.mocked(getAgentToken).mockResolvedValue(null);

    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("agent_token_not_found");
  });

  it("returns 500 when getAgentToken throws", async () => {
    vi.mocked(getAgentToken).mockRejectedValue(new Error("Redis failure"));

    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("agent_health_server_error");
  });
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

describe("DELETE /api/agent-token", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuthFailure(401, "byok_not_authenticated", "Not authenticated");
    const res = await DELETE(makeRequest("DELETE"));
    expect(res.status).toBe(401);
  });

  it("revokes token, returns 200", async () => {
    vi.mocked(revokeAgentToken).mockResolvedValue(true);

    const res = await DELETE(makeRequest("DELETE"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revoked).toBe(true);
  });

  it("returns 404 when no token exists", async () => {
    vi.mocked(revokeAgentToken).mockResolvedValue(false);

    const res = await DELETE(makeRequest("DELETE"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("agent_token_not_found");
  });

  it("returns 500 when revokeAgentToken throws", async () => {
    vi.mocked(revokeAgentToken).mockRejectedValue(new Error("Redis failure"));

    const res = await DELETE(makeRequest("DELETE"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("agent_health_server_error");
  });
});
