import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));
vi.mock("@/server/agent-token", () => {
  class LockTimeoutError extends Error {
    constructor(installationId: string) {
      super(`Timed out acquiring agent-token lock for installation ${installationId}`);
      this.name = "LockTimeoutError";
    }
  }

  return {
    generateAgentToken: vi.fn(),
    getAgentToken: vi.fn(),
    revokeAgentToken: vi.fn(),
    LockTimeoutError,
  };
});

vi.mock("@/server/agent-health-error", async () => {
  const { NextResponse } = await import("next/server");
  return {
    AGENT_HEALTH_ERROR: {
      INVALID_JSON: "agent_health_invalid_json",
      PAYLOAD_TOO_LARGE: "agent_health_payload_too_large",
      MISSING_FIELDS: "agent_health_missing_fields",
      NOT_AUTHENTICATED: "agent_health_not_authenticated",
      SERVER_MISCONFIGURATION: "agent_health_server_misconfiguration",
      TOKEN_ALREADY_EXISTS: "agent_health_token_already_exists",
      TOKEN_NOT_FOUND: "agent_health_token_not_found",
      LOCK_TIMEOUT: "agent_health_lock_timeout",
      IDEMPOTENCY_CONFLICT: "agent_health_idempotency_conflict",
      IDEMPOTENCY_PENDING: "agent_health_idempotency_pending",
      RATE_LIMITED: "agent_health_rate_limited",
      VALIDATION_FAILED: "agent_health_validation_failed",
    },
    agentHealthError: (code: string, message: string, status: number, details?: Record<string, unknown>) =>
      NextResponse.json({ code, message, ...(details ?? {}) }, { status }),
  };
});

import { authenticateByokRequest } from "@/server/byok-auth";
import {
  generateAgentToken,
  getAgentToken,
  LockTimeoutError,
  revokeAgentToken,
} from "@/server/agent-token";
import { POST, GET, DELETE } from "./route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SESSION = {
  installationId: "123",
  userId: 1,
  userLogin: "alice",
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
  return new NextRequest("https://example.com/api/agent-token", { method });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthSuccess();
});

// ---------------------------------------------------------------------------
// Tests — POST
// ---------------------------------------------------------------------------

describe("POST /api/agent-token", () => {
  it("generates a token and returns it with fingerprint", async () => {
    const fakeToken = "a".repeat(64);
    vi.mocked(generateAgentToken).mockResolvedValue(fakeToken);

    const res = await POST(makeRequest("POST"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.token).toBe(fakeToken);
    expect(body.fingerprint).toBe(fakeToken.slice(-8));
    expect(body.message).toContain("Store this token securely");
  });

  it("passes session context to generateAgentToken", async () => {
    vi.mocked(generateAgentToken).mockResolvedValue("b".repeat(64));
    await POST(makeRequest("POST"));

    expect(generateAgentToken).toHaveBeenCalledWith(
      "123",
      "alice",
      "v1",
      MOCK_KEYRING,
      expect.anything(),
    );
  });

  it("returns auth error when not authenticated", async () => {
    mockAuthFailure(401, "byok_not_authenticated", "Not authenticated");
    const res = await POST(makeRequest("POST"));
    expect(res.status).toBe(401);
  });

  it("returns 503 with lock-timeout code when token lock cannot be acquired", async () => {
    vi.mocked(generateAgentToken).mockRejectedValue(new LockTimeoutError("123"));

    const res = await POST(makeRequest("POST"));
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.code).toBe("agent_health_lock_timeout");
  });

  it("returns 500 when generateAgentToken throws", async () => {
    vi.mocked(generateAgentToken).mockRejectedValue(new Error("crypto failure"));

    const res = await POST(makeRequest("POST"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("agent_health_server_misconfiguration");
    expect(body.message).toContain("Failed to generate");
  });
});

// ---------------------------------------------------------------------------
// Tests — GET
// ---------------------------------------------------------------------------

describe("GET /api/agent-token", () => {
  it("returns token and metadata", async () => {
    vi.mocked(getAgentToken).mockResolvedValue({
      token: "a".repeat(64),
      fingerprint: "abcd1234",
      createdAt: "2026-02-24T00:00:00Z",
      createdBy: "alice",
    });

    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.token).toBe("a".repeat(64));
    expect(body.fingerprint).toBe("abcd1234");
    expect(body.createdBy).toBe("alice");
  });

  it("passes keyring context to getAgentToken", async () => {
    vi.mocked(getAgentToken).mockResolvedValue({
      token: "b".repeat(64),
      fingerprint: "bbbbbbbb",
      createdAt: "2026-02-24T00:00:00Z",
      createdBy: "alice",
    });

    await GET(makeRequest("GET"));
    expect(getAgentToken).toHaveBeenCalledWith("123", MOCK_KEYRING, expect.anything());
  });

  it("returns 404 when no token exists", async () => {
    vi.mocked(getAgentToken).mockResolvedValue(null);
    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("agent_health_token_not_found");
  });

  it("returns auth error when not authenticated", async () => {
    mockAuthFailure(401, "byok_not_authenticated", "Not authenticated");
    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(401);
  });

  it("returns 500 when getAgentToken throws", async () => {
    vi.mocked(getAgentToken).mockRejectedValue(new Error("decrypt failure"));

    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("agent_health_server_misconfiguration");
    expect(body.message).toContain("Failed to retrieve");
  });
});

// ---------------------------------------------------------------------------
// Tests — DELETE
// ---------------------------------------------------------------------------

describe("DELETE /api/agent-token", () => {
  it("revokes the token and returns confirmation", async () => {
    vi.mocked(revokeAgentToken).mockResolvedValue(true);
    const res = await DELETE(makeRequest("DELETE"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.revoked).toBe(true);
  });

  it("returns 404 when no token to revoke", async () => {
    vi.mocked(revokeAgentToken).mockResolvedValue(false);
    const res = await DELETE(makeRequest("DELETE"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("agent_health_token_not_found");
  });

  it("returns auth error when not authenticated", async () => {
    mockAuthFailure(401, "byok_not_authenticated", "Not authenticated");
    const res = await DELETE(makeRequest("DELETE"));
    expect(res.status).toBe(401);
  });

  it("returns 503 with lock-timeout code when token lock cannot be acquired", async () => {
    vi.mocked(revokeAgentToken).mockRejectedValue(new LockTimeoutError("123"));

    const res = await DELETE(makeRequest("DELETE"));
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.code).toBe("agent_health_lock_timeout");
  });

  it("returns 500 when revokeAgentToken throws", async () => {
    vi.mocked(revokeAgentToken).mockRejectedValue(new Error("redis failure"));

    const res = await DELETE(makeRequest("DELETE"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("agent_health_server_misconfiguration");
    expect(body.message).toContain("Failed to revoke");
  });
});
