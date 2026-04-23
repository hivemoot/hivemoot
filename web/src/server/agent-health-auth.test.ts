import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/server/env", () => ({
  validateEnv: vi.fn(),
}));
vi.mock("@/server/redis", () => ({
  getRedisClient: vi.fn(() => ({} as never)),
}));
vi.mock("@/server/agent-token", () => ({
  resolveTokenToInstallation: vi.fn(),
}));

import { validateEnv } from "@/server/env";
import { resolveTokenToInstallation } from "@/server/agent-token";
import { authenticateAgentRequest } from "./agent-health-auth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(authHeader?: string) {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) {
    headers["authorization"] = authHeader;
  }
  return new NextRequest("https://example.com/api/agent-health", {
    method: "POST",
    headers,
  });
}

function mockEnvOk() {
  vi.mocked(validateEnv).mockReturnValue({
    ok: true,
    config: {
      redisRestUrl: "https://redis.example.com",
      redisRestToken: "token",
      githubAppId: undefined,
      githubAppPrivateKey: undefined,
      githubClientId: undefined,
      githubClientSecret: undefined,
      byokActiveKeyVersion: undefined,
      byokMasterKeysJson: undefined,
      siteUrl: "http://localhost:3000",
      nodeEnv: "test",
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnvOk();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("authenticateAgentRequest", () => {
  it("returns 503 when env validation fails", async () => {
    vi.mocked(validateEnv).mockReturnValue({
      ok: false,
      missing: ["HIVEMOOT_REDIS_REST_URL"],
    });

    const result = await authenticateAgentRequest(makeRequest("Bearer tok"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const body = await result.response.json();
      expect(result.response.status).toBe(503);
      expect(body.code).toBe("agent_health_server_misconfiguration");
    }
  });

  it("returns 503 when Redis is not configured", async () => {
    vi.mocked(validateEnv).mockReturnValue({
      ok: true,
      config: {
        redisRestUrl: undefined,
        redisRestToken: undefined,
        githubAppId: undefined,
        githubAppPrivateKey: undefined,
        githubClientId: undefined,
        githubClientSecret: undefined,
        byokActiveKeyVersion: undefined,
        byokMasterKeysJson: undefined,
        siteUrl: "http://localhost:3000",
        nodeEnv: "test",
      },
    });

    const result = await authenticateAgentRequest(makeRequest("Bearer tok"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
    }
  });

  it("returns 401 when Authorization header is missing", async () => {
    const result = await authenticateAgentRequest(makeRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.code).toBe("agent_health_not_authenticated");
      expect(body.message).toBe("Invalid or missing agent token");
    }
  });

  it("returns 401 when Authorization header is not Bearer", async () => {
    const result = await authenticateAgentRequest(makeRequest("Basic abc"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it("returns 401 when Bearer token is empty", async () => {
    const result = await authenticateAgentRequest(makeRequest("Bearer "));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it("returns 401 when token is not recognized", async () => {
    vi.mocked(resolveTokenToInstallation).mockResolvedValue(null);

    const result = await authenticateAgentRequest(makeRequest("Bearer unknown-token"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.message).toBe("Invalid or missing agent token");
    }
  });

  it("returns identical 401 response body for all auth failures", async () => {
    vi.mocked(resolveTokenToInstallation).mockResolvedValue(null);

    const missingHeader = await authenticateAgentRequest(makeRequest());
    const wrongScheme = await authenticateAgentRequest(makeRequest("Basic abc"));
    const emptyToken = await authenticateAgentRequest(makeRequest("Bearer   "));
    const unknownToken = await authenticateAgentRequest(makeRequest("Bearer unknown-token"));

    expect(missingHeader.ok).toBe(false);
    expect(wrongScheme.ok).toBe(false);
    expect(emptyToken.ok).toBe(false);
    expect(unknownToken.ok).toBe(false);

    if (!missingHeader.ok && !wrongScheme.ok && !emptyToken.ok && !unknownToken.ok) {
      const missingBody = await missingHeader.response.json();
      const wrongSchemeBody = await wrongScheme.response.json();
      const emptyBody = await emptyToken.response.json();
      const unknownBody = await unknownToken.response.json();

      expect(wrongSchemeBody).toStrictEqual(missingBody);
      expect(emptyBody).toStrictEqual(missingBody);
      expect(unknownBody).toStrictEqual(missingBody);
    }
  });

  it("returns success with installationId when token is valid", async () => {
    vi.mocked(resolveTokenToInstallation).mockResolvedValue("inst-42");

    const result = await authenticateAgentRequest(makeRequest("Bearer valid-token"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installationId).toBe("inst-42");
    }
  });
});
