import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the route
// ---------------------------------------------------------------------------

vi.mock("@/server/env", () => ({
  validateEnv: vi.fn(),
}));

vi.mock("@/server/redis", () => ({
  getRedisClient: vi.fn(),
}));

vi.mock("@/server/setup-session", () => ({
  createOAuthState: vi.fn(),
  OAUTH_STATE_BINDING_COOKIE: "oauth_state_binding",
}));

import { validateEnv } from "@/server/env";
import { getRedisClient } from "@/server/redis";
import { createOAuthState, OAUTH_STATE_BINDING_COOKIE } from "@/server/setup-session";
import { GET } from "./route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CONFIG = {
  githubClientId: "Iv1.test",
  githubClientSecret: "secret",
  redisRestUrl: "https://example.upstash.io",
  redisRestToken: "test-token",
  siteUrl: "https://example.com",
  nodeEnv: "production",
  githubAppId: "99",
  githubAppPrivateKey: "-----BEGIN RSA PRIVATE KEY-----",
  byokActiveKeyVersion: "v1",
  byokMasterKeysJson: '{"v1":"' + "a".repeat(64) + '"}',
  redisClient: {} as ReturnType<typeof getRedisClient>,
};

function makeRequest(url: string) {
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(validateEnv).mockReturnValue({ ok: true, config: { ...VALID_CONFIG } });
  vi.mocked(getRedisClient).mockReturnValue({} as ReturnType<typeof getRedisClient>);
  vi.mocked(createOAuthState).mockResolvedValue({
    state: "deadbeef".repeat(8),
    stateBinding: "cafebabe".repeat(8),
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/auth/github/start", () => {
  it("redirects to GitHub OAuth URL with state when installation_id is valid", async () => {
    const req = makeRequest("https://example.com/api/auth/github/start?installation_id=12345");
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/);
    expect(location).toContain("client_id=Iv1.test");
    expect(location).toContain("state=deadbeef");
    expect(location).toContain("scope=read%3Aorg");

    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain(`${OAUTH_STATE_BINDING_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
  });

  it("redirects to /setup when installation_id is missing", async () => {
    const req = makeRequest("https://example.com/api/auth/github/start");
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/setup");
  });

  it("redirects to /setup when installation_id is not numeric", async () => {
    const req = makeRequest("https://example.com/api/auth/github/start?installation_id=abc");
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/setup");
  });

  it("redirects to /setup/error when GitHub OAuth is not configured", async () => {
    vi.mocked(validateEnv).mockReturnValue({
      ok: true,
      config: { ...VALID_CONFIG, githubClientId: undefined, githubClientSecret: undefined },
    });
    const req = makeRequest("https://example.com/api/auth/github/start?installation_id=1");
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/setup/error");
    expect(location.searchParams.get("code")).toBe("server_misconfiguration");
  });

  it("redirects to /setup/error when Redis is not configured", async () => {
    vi.mocked(validateEnv).mockReturnValue({
      ok: true,
      config: { ...VALID_CONFIG, redisRestUrl: undefined, redisRestToken: undefined },
    });
    const req = makeRequest("https://example.com/api/auth/github/start?installation_id=1");
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/setup/error");
    expect(location.searchParams.get("code")).toBe("server_misconfiguration");
  });

  it("redirects to /setup/error when env validation fails", async () => {
    vi.mocked(validateEnv).mockReturnValue({ ok: false, missing: ["HIVEMOOT_REDIS_REST_URL"] });
    const req = makeRequest("https://example.com/api/auth/github/start?installation_id=1");
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/setup/error");
    expect(location.searchParams.get("code")).toBe("server_misconfiguration");
  });

  it("redirects to /setup/error with oauth_state_store_failed when state storage fails", async () => {
    vi.mocked(createOAuthState).mockRejectedValue(new Error("redis down"));

    const req = makeRequest("https://example.com/api/auth/github/start?installation_id=1");
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/setup/error");
    expect(location.searchParams.get("code")).toBe("oauth_state_store_failed");
    expect(location.searchParams.get("installation_id")).toBe("1");
  });

  it("includes the callback redirect_uri scoped to siteUrl", async () => {
    const req = makeRequest("https://example.com/api/auth/github/start?installation_id=99");
    const res = await GET(req);
    const location = res.headers.get("location")!;
    expect(location).toContain(encodeURIComponent("https://example.com/api/auth/github/callback"));
  });
});
