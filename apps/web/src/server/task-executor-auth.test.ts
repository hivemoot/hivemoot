import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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
import { authenticateTaskExecutorRequest } from "@/server/task-executor-auth";

function makeRequest(authHeader?: string) {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers.authorization = authHeader;

  return new NextRequest("https://example.com/api/tasks/claim", {
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

describe("authenticateTaskExecutorRequest", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const result = await authenticateTaskExecutorRequest(makeRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.code).toBe("task_not_authenticated");
    }
  });

  it("returns 401 when token is unknown", async () => {
    vi.mocked(resolveTokenToInstallation).mockResolvedValue(null);

    const result = await authenticateTaskExecutorRequest(makeRequest("Bearer nope"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it("returns installation on valid token", async () => {
    vi.mocked(resolveTokenToInstallation).mockResolvedValue("inst-1");

    const result = await authenticateTaskExecutorRequest(makeRequest("Bearer valid-token"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installationId).toBe("inst-1");
    }
  });
});
