import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  validateEnv: vi.fn(),
  getRedisClient: vi.fn(),
  getSetupSession: vi.fn(),
  parseKeyring: vi.fn(),
  setByokEnvelope: vi.fn(),
  validateProviderKey: vi.fn(),
  encrypt: vi.fn(),
}));

vi.mock("@/server/env", () => ({
  validateEnv: mocks.validateEnv,
}));

vi.mock("@/server/redis", () => ({
  getRedisClient: mocks.getRedisClient,
}));

vi.mock("@/server/setup-session", () => ({
  getSetupSession: mocks.getSetupSession,
  SETUP_SESSION_COOKIE: "hivemoot_setup_session",
}));

vi.mock("@/server/crypto", async () => {
  const actual = await vi.importActual<typeof import("@/server/crypto")>("@/server/crypto");
  return {
    ...actual,
    parseKeyring: mocks.parseKeyring,
    encrypt: mocks.encrypt,
  };
});

vi.mock("@/server/byok-store", () => ({
  setByokEnvelope: mocks.setByokEnvelope,
}));

vi.mock("@/server/provider-validation", () => ({
  validateProviderKey: mocks.validateProviderKey,
}));

import { BYOK_ERROR } from "@/server/byok-error";
import { POST } from "./route";

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
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: "hivemoot_setup_session=session-token",
    },
    body: JSON.stringify({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-ant-test1234",
    }),
  });
}

describe("POST /api/byok/config auth failure path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateEnv.mockReturnValue({ ok: true, config: VALID_ENV_CONFIG });
    mocks.parseKeyring.mockReturnValue(new Map([["v1", Buffer.alloc(32)]]));
    mocks.getRedisClient.mockReturnValue({} as never);
    mocks.validateProviderKey.mockResolvedValue({ valid: true });
    mocks.encrypt.mockReturnValue({
      ciphertext: "ciphertext",
      iv: "iv",
      tag: "tag",
      keyVersion: "v1",
    });
  });

  it("returns structured BYOK JSON when session lookup throws before the route body runs", async () => {
    const error = new Error("redis unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getSetupSession.mockRejectedValue(error);

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: BYOK_ERROR.SERVER_MISCONFIGURATION,
      message: "Internal server error",
    });
    expect(mocks.validateProviderKey).not.toHaveBeenCalled();
    expect(mocks.setByokEnvelope).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[byok-auth] Failed to load setup session",
      expect.objectContaining({
        code: BYOK_ERROR.SERVER_MISCONFIGURATION,
        error,
      }),
    );
  });
});
