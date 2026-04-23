import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BYOK_ERROR } from "@/server/byok-error";

const mocks = vi.hoisted(() => ({
  validateEnv: vi.fn(),
  getRedisClient: vi.fn(),
  getSetupSession: vi.fn(),
  isSessionFresh: vi.fn(),
  parseKeyring: vi.fn(),
}));

vi.mock("@/server/env", () => ({
  validateEnv: mocks.validateEnv,
}));

vi.mock("@/server/redis", () => ({
  getRedisClient: mocks.getRedisClient,
}));

vi.mock("@/server/setup-session", () => ({
  getSetupSession: mocks.getSetupSession,
  isSessionFresh: mocks.isSessionFresh,
  SETUP_SESSION_COOKIE: "hivemoot_setup_session",
}));

vi.mock("@/server/crypto", () => ({
  parseKeyring: mocks.parseKeyring,
}));

const VALID_ENV_CONFIG = {
  redisRestUrl: "https://redis.example.com",
  redisRestToken: "redis-token",
  githubAppId: undefined,
  githubAppPrivateKey: undefined,
  githubClientId: undefined,
  githubClientSecret: undefined,
  byokActiveKeyVersion: "v1",
  byokMasterKeysJson: "{\"v1\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}",
  siteUrl: "http://localhost:3000",
  nodeEnv: "test",
};

function makeRequest(): NextRequest {
  return new NextRequest("https://example.com/api/byok/config", {
    headers: {
      cookie: "hivemoot_setup_session=session-token",
    },
  });
}

describe("authenticateByokRequest runtime config cache", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mocks.validateEnv.mockReturnValue({
      ok: true,
      config: VALID_ENV_CONFIG,
    });

    mocks.parseKeyring.mockReturnValue(new Map([["v1", Buffer.alloc(32)]]));
    mocks.getRedisClient.mockReturnValue({} as never);
    mocks.getSetupSession.mockResolvedValue({
      installationId: "123",
      userId: 1,
      userLogin: "worker",
      iat: Date.now(),
      expiresAt: Date.now() + 86400000,
    });
    mocks.isSessionFresh.mockReturnValue(true);
  });

  it("retries runtime config load after an initial misconfiguration", async () => {
    mocks.validateEnv
      .mockReturnValueOnce({ ok: false, missing: ["BYOK_ACTIVE_KEY_VERSION"] })
      .mockReturnValue({
        ok: true,
        config: VALID_ENV_CONFIG,
      });

    const { authenticateByokRequest } = await import("./byok-auth");
    const request = makeRequest();

    const first = await authenticateByokRequest(request);
    expect(first.ok).toBe(false);
    if (first.ok) {
      throw new Error("Expected an authentication failure on first call");
    }
    expect(first.response.status).toBe(503);
    await expect(first.response.json()).resolves.toMatchObject({
      code: BYOK_ERROR.SERVER_MISCONFIGURATION,
    });

    const second = await authenticateByokRequest(request);
    expect(second.ok).toBe(true);

    // First load fails, second call retries and succeeds.
    expect(mocks.validateEnv).toHaveBeenCalledTimes(2);
    expect(mocks.parseKeyring).toHaveBeenCalledTimes(1);
    expect(mocks.getRedisClient).toHaveBeenCalledTimes(1);
    expect(mocks.getSetupSession).toHaveBeenCalledTimes(1);
  });

  it("reuses successful runtime config on later requests", async () => {
    const { authenticateByokRequest } = await import("./byok-auth");
    const request = makeRequest();

    const first = await authenticateByokRequest(request);
    const second = await authenticateByokRequest(request);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    expect(mocks.validateEnv).toHaveBeenCalledTimes(1);
    expect(mocks.parseKeyring).toHaveBeenCalledTimes(1);
    expect(mocks.getSetupSession).toHaveBeenCalledTimes(2);
  });
});

describe("authenticateByokRequest freshness gate", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mocks.validateEnv.mockReturnValue({ ok: true, config: VALID_ENV_CONFIG });
    mocks.parseKeyring.mockReturnValue(new Map([["v1", Buffer.alloc(32)]]));
    mocks.getRedisClient.mockReturnValue({} as never);
    mocks.getSetupSession.mockResolvedValue({
      installationId: "123",
      userId: 1,
      userLogin: "worker",
      iat: Date.now(),
      expiresAt: Date.now() + 86400000,
    });
  });

  it("succeeds without freshness check when requireFresh is not set", async () => {
    mocks.isSessionFresh.mockReturnValue(false);
    const { authenticateByokRequest } = await import("./byok-auth");
    const result = await authenticateByokRequest(makeRequest());
    expect(result.ok).toBe(true);
    expect(mocks.isSessionFresh).not.toHaveBeenCalled();
  });

  it("succeeds when requireFresh is true and session is fresh", async () => {
    mocks.isSessionFresh.mockReturnValue(true);
    const { authenticateByokRequest } = await import("./byok-auth");
    const result = await authenticateByokRequest(makeRequest(), { requireFresh: true });
    expect(result.ok).toBe(true);
  });

  it("rejects with SESSION_STALE when requireFresh is true and session is stale", async () => {
    mocks.isSessionFresh.mockReturnValue(false);
    const { authenticateByokRequest } = await import("./byok-auth");
    const result = await authenticateByokRequest(makeRequest(), { requireFresh: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.response.status).toBe(401);
    await expect(result.response.json()).resolves.toMatchObject({
      code: "byok_session_stale",
    });
  });
});
