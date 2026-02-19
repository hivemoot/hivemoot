import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/server/env", () => ({ validateEnv: vi.fn() }));
vi.mock("@/server/redis", () => ({ getRedisClient: vi.fn() }));
vi.mock("@/server/github-auth", () => ({
  exchangeOAuthCode: vi.fn(),
  generateAppJwt: vi.fn(),
  getAuthenticatedUser: vi.fn(),
  getInstallation: vi.fn(),
  checkOrgAdmin: vi.fn(),
}));
vi.mock("@/server/setup-session", () => ({
  validateOAuthState: vi.fn(),
  createSetupSession: vi.fn(),
}));

import { validateEnv } from "@/server/env";
import { getRedisClient } from "@/server/redis";
import {
  exchangeOAuthCode,
  generateAppJwt,
  getAuthenticatedUser,
  getInstallation,
  checkOrgAdmin,
} from "@/server/github-auth";
import { validateOAuthState, createSetupSession } from "@/server/setup-session";
import { GET, SETUP_SESSION_COOKIE } from "./route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CONFIG = {
  githubClientId: "Iv1.test",
  githubClientSecret: "secret",
  githubAppId: "99",
  githubAppPrivateKey: "-----BEGIN RSA PRIVATE KEY-----",
  redisUrl: "redis://localhost:6379",
  siteUrl: "https://example.com",
  nodeEnv: "production",
  encryptionKey: "a".repeat(64),
};

function makeRequest(params: Record<string, string>) {
  const url = new URL("https://example.com/api/auth/github/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url.toString());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(validateEnv).mockReturnValue({ ok: true, config: { ...VALID_CONFIG } });
  vi.mocked(getRedisClient).mockReturnValue({} as ReturnType<typeof getRedisClient>);
  vi.mocked(generateAppJwt).mockReturnValue("app-jwt");
  vi.mocked(exchangeOAuthCode).mockResolvedValue("user-token");
  vi.mocked(getAuthenticatedUser).mockResolvedValue({ login: "alice", id: 1 });
  vi.mocked(validateOAuthState).mockResolvedValue("12345");
  vi.mocked(createSetupSession).mockResolvedValue("session-token-abc");
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("GET /api/auth/github/callback — happy paths", () => {
  it("issues session and redirects for a user installation (owner match)", async () => {
    vi.mocked(getInstallation).mockResolvedValue({
      account: { login: "alice", type: "User" },
    });

    const req = makeRequest({ code: "gh-code", state: "valid-state" });
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("auth=ok");
    expect(location).toContain("installation_id=12345");

    // Session cookie must be set
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain(SETUP_SESSION_COOKIE);
    expect(setCookie).toContain("session-token-abc");
    expect(setCookie).toContain("HttpOnly");
  });

  it("issues session and redirects for an org installation (admin user)", async () => {
    vi.mocked(getInstallation).mockResolvedValue({
      account: { login: "my-org", type: "Organization" },
    });
    vi.mocked(checkOrgAdmin).mockResolvedValue(true);

    const req = makeRequest({ code: "gh-code", state: "valid-state" });
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("auth=ok");
    expect(checkOrgAdmin).toHaveBeenCalledWith("user-token", "my-org");
  });
});

// ---------------------------------------------------------------------------
// Error / rejection cases
// ---------------------------------------------------------------------------

describe("GET /api/auth/github/callback — rejections", () => {
  it("returns 400 on state mismatch (CSRF protection)", async () => {
    vi.mocked(validateOAuthState).mockResolvedValue(null);

    const req = makeRequest({ code: "gh-code", state: "tampered-state" });
    const res = await GET(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/state/i);
  });

  it("returns 503 with a stable code when OAuth state lookup fails", async () => {
    vi.mocked(validateOAuthState).mockRejectedValue(new Error("redis unavailable"));

    const req = makeRequest({ code: "gh-code", state: "valid-state" });
    const res = await GET(req);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("oauth_state_read_failed");
  });

  it("returns 400 when code or state are missing", async () => {
    const req = makeRequest({});
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("redirects with forbidden reason when org user is not admin", async () => {
    vi.mocked(getInstallation).mockResolvedValue({
      account: { login: "my-org", type: "Organization" },
    });
    vi.mocked(checkOrgAdmin).mockResolvedValue(false);

    const req = makeRequest({ code: "gh-code", state: "valid-state" });
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("auth=forbidden");
    expect(location).toContain("reason=not_org_admin");
  });

  it("redirects with forbidden reason on user install mismatch", async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ login: "eve", id: 2 });
    vi.mocked(getInstallation).mockResolvedValue({
      account: { login: "alice", type: "User" },
    });

    const req = makeRequest({ code: "gh-code", state: "valid-state" });
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("auth=forbidden");
    expect(location).toContain("reason=user_mismatch");
  });

  it("cross-installation write attempt is blocked (installationId from state, not URL)", async () => {
    // Attacker sets state=legit-state but the URL has a different installation_id.
    // The route ignores any installation_id in the URL and uses only the one from Redis state.
    vi.mocked(validateOAuthState).mockResolvedValue("VICTIM_INSTALL");
    vi.mocked(getInstallation).mockResolvedValue({
      account: { login: "alice", type: "User" },
    });

    const req = makeRequest({ code: "gh-code", state: "legit-state", installation_id: "ATTACKER" });
    await GET(req);

    // Session must be created with the installationId FROM REDIS, not from the URL
    expect(createSetupSession).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "VICTIM_INSTALL" }),
      expect.anything(),
    );
  });

  it("redirects with auth=denied when GitHub returns error param", async () => {
    const req = makeRequest({ error: "access_denied" });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("auth=denied");
  });

  it("returns 502 when code exchange fails", async () => {
    vi.mocked(exchangeOAuthCode).mockRejectedValue(new Error("bad_verification_code"));

    const req = makeRequest({ code: "bad-code", state: "valid-state" });
    const res = await GET(req);
    expect(res.status).toBe(502);
  });

  it("returns 503 with a stable code when setup session creation fails", async () => {
    vi.mocked(getInstallation).mockResolvedValue({
      account: { login: "alice", type: "User" },
    });
    vi.mocked(createSetupSession).mockRejectedValue(new Error("redis unavailable"));

    const req = makeRequest({ code: "gh-code", state: "valid-state" });
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("setup_session_create_failed");
  });
});
