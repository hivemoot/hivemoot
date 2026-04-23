import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/server/env", () => ({
  validateEnv: vi.fn(),
}));

vi.mock("@/server/redis", () => ({
  getRedisClient: vi.fn(),
}));

vi.mock("@/server/setup-session", () => ({
  createOAuthState: vi.fn(),
  getSetupSession: vi.fn(),
  DISCOVER_SENTINEL: "discover",
  OAUTH_STATE_BINDING_COOKIE: "oauth_state_binding",
  SETUP_SESSION_COOKIE: "setup_session",
}));

vi.mock("@/server/byok-store", () => ({
  hasByokEnvelope: vi.fn(),
}));

import { validateEnv } from "@/server/env";
import { getRedisClient } from "@/server/redis";
import {
  createOAuthState,
  getSetupSession,
  OAUTH_STATE_BINDING_COOKIE,
} from "@/server/setup-session";
import { hasByokEnvelope } from "@/server/byok-store";
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
};

function makeRequest(search = "") {
  return new NextRequest(`https://example.com/api/auth/github/start-discover${search}`);
}

function makeRequestWithCookie(cookie: string, search = "") {
  return new NextRequest(`https://example.com/api/auth/github/start-discover${search}`, {
    headers: { cookie },
  });
}

const VALID_SESSION = {
  installationId: "inst-1",
  userId: 42,
  userLogin: "alice",
  expiresAt: Date.now() + 86400 * 1000,
  iat: Date.now(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(validateEnv).mockReturnValue({ ok: true, config: { ...VALID_CONFIG } });
  vi.mocked(getRedisClient).mockReturnValue({} as ReturnType<typeof getRedisClient>);
  vi.mocked(createOAuthState).mockResolvedValue({
    state: "deadbeef".repeat(8),
    stateBinding: "cafebabe".repeat(8),
  });
  vi.mocked(getSetupSession).mockResolvedValue(null);
  vi.mocked(hasByokEnvelope).mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/auth/github/start-discover", () => {
  it("redirects to GitHub OAuth URL with state — no installation_id required", async () => {
    const req = makeRequest();
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

  it("returns 503 when env validation fails", async () => {
    vi.mocked(validateEnv).mockReturnValue({ ok: false, missing: ["HIVEMOOT_REDIS_REST_URL"] });
    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(503);
  });

  it("returns 503 when GitHub OAuth is not configured", async () => {
    vi.mocked(validateEnv).mockReturnValue({
      ok: true,
      config: { ...VALID_CONFIG, githubClientId: undefined, githubClientSecret: undefined },
    });
    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(503);
  });

  it("returns 503 when Redis is not configured", async () => {
    vi.mocked(validateEnv).mockReturnValue({
      ok: true,
      config: { ...VALID_CONFIG, redisRestUrl: undefined, redisRestToken: undefined },
    });
    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(503);
  });

  it("returns 503 with stable code when OAuth state storage fails", async () => {
    vi.mocked(createOAuthState).mockRejectedValue(new Error("redis down"));
    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("oauth_state_store_failed");
  });

  it("includes the callback redirect_uri scoped to siteUrl", async () => {
    const req = makeRequest();
    const res = await GET(req);
    const location = res.headers.get("location")!;
    expect(location).toContain(encodeURIComponent("https://example.com/api/auth/github/callback"));
  });

  it("passes the discover sentinel as installationId to createOAuthState", async () => {
    const req = makeRequest();
    await GET(req);
    expect(createOAuthState).toHaveBeenCalledWith("discover", expect.anything(), undefined);
  });

  it("passes safeNext to createOAuthState when next param is provided", async () => {
    const req = makeRequest("?next=/dashboard/credentials");
    await GET(req);
    expect(createOAuthState).toHaveBeenCalledWith("discover", expect.anything(), "/dashboard/credentials");
  });

  it("ignores unsafe next params (protocol-relative URLs)", async () => {
    const req = makeRequest("?next=//evil.com/steal");
    await GET(req);
    expect(createOAuthState).toHaveBeenCalledWith("discover", expect.anything(), undefined);
  });

  it("ignores unsafe next params (backslash-relative URLs)", async () => {
    const req = makeRequest("?next=/\\evil.com/steal");
    await GET(req);
    expect(createOAuthState).toHaveBeenCalledWith("discover", expect.anything(), undefined);
  });
});

describe("GET /api/auth/github/start-discover — fast-path (valid session)", () => {
  it("redirects to dashboard when session is valid and BYOK configured", async () => {
    vi.mocked(getSetupSession).mockResolvedValue(VALID_SESSION);
    vi.mocked(hasByokEnvelope).mockResolvedValue(true);

    const req = makeRequestWithCookie("setup_session=valid-token");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    expect(createOAuthState).not.toHaveBeenCalled();
  });

  it("redirects to setup when session is valid but BYOK not configured", async () => {
    vi.mocked(getSetupSession).mockResolvedValue(VALID_SESSION);
    vi.mocked(hasByokEnvelope).mockResolvedValue(false);

    const req = makeRequestWithCookie("setup_session=valid-token");
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("/setup");
    expect(createOAuthState).not.toHaveBeenCalled();
  });

  it("redirects to next param when session is valid and next is safe", async () => {
    vi.mocked(getSetupSession).mockResolvedValue(VALID_SESSION);
    vi.mocked(hasByokEnvelope).mockResolvedValue(true);

    const req = makeRequestWithCookie("setup_session=valid-token", "?next=/dashboard/credentials");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard/credentials");
  });

  it("bypasses fast-path and starts OAuth when force=1", async () => {
    vi.mocked(getSetupSession).mockResolvedValue(VALID_SESSION);

    const req = makeRequestWithCookie("setup_session=valid-token", "?force=1");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("github.com/login/oauth/authorize");
    expect(createOAuthState).toHaveBeenCalled();
  });

  it("falls through to OAuth when session cookie is absent", async () => {
    const req = makeRequest();
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("github.com/login/oauth/authorize");
  });

  it("falls through to OAuth when getSetupSession returns null (expired)", async () => {
    vi.mocked(getSetupSession).mockResolvedValue(null);
    const req = makeRequestWithCookie("setup_session=expired-token");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("github.com/login/oauth/authorize");
  });
});
