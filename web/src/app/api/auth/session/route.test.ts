import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/server/env", () => ({ validateEnv: vi.fn() }));
vi.mock("@/server/redis", () => ({ getRedisClient: vi.fn() }));
vi.mock("@/server/setup-session", () => ({
  getSetupSession: vi.fn(),
  SETUP_SESSION_COOKIE: "setup_session",
}));

import { validateEnv } from "@/server/env";
import { getRedisClient } from "@/server/redis";
import { getSetupSession } from "@/server/setup-session";
import { GET } from "./route";

const CONFIG = {
  redisRestUrl: "https://example.upstash.io",
  redisRestToken: "test-token",
};

function makeRequest(cookie?: string) {
  return new NextRequest("https://example.com/api/auth/session", {
    headers: cookie ? { cookie } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(validateEnv).mockReturnValue({ ok: true, config: { ...CONFIG } } as never);
  vi.mocked(getRedisClient).mockReturnValue({} as never);
  vi.mocked(getSetupSession).mockResolvedValue({
    installationId: "123",
    userId: 1,
    userLogin: "alice",
    expiresAt: Date.now() + 1000,
    iat: Date.now(),
  });
});

describe("GET /api/auth/session", () => {
  it("returns logged out (no Redis call) when there is no session cookie", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ authenticated: false, login: null, hasInstallation: false });
    expect(getSetupSession).not.toHaveBeenCalled();
  });

  it("returns authenticated + login for a valid session", async () => {
    const res = await GET(makeRequest("setup_session=tok"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true, login: "alice", hasInstallation: true });
  });

  it("reports hasInstallation:false when the session has no installation", async () => {
    vi.mocked(getSetupSession).mockResolvedValue({
      installationId: null,
      userId: 1,
      userLogin: "alice",
      expiresAt: Date.now() + 1000,
      iat: Date.now(),
    });
    const res = await GET(makeRequest("setup_session=tok"));
    expect(await res.json()).toEqual({ authenticated: true, login: "alice", hasInstallation: false });
  });

  it("returns logged out when the session is invalid/expired", async () => {
    vi.mocked(getSetupSession).mockResolvedValue(null);
    const res = await GET(makeRequest("setup_session=tok"));
    expect(await res.json()).toEqual({ authenticated: false, login: null, hasInstallation: false });
  });

  it("fails closed to logged out when env is unavailable", async () => {
    vi.mocked(validateEnv).mockReturnValue({ ok: false, missing: ["HIVEMOOT_REDIS_REST_URL"] } as never);
    const res = await GET(makeRequest("setup_session=tok"));
    expect(res.status).toBe(200);
    expect((await res.json()).authenticated).toBe(false);
    expect(getSetupSession).not.toHaveBeenCalled();
  });

  it("fails closed to logged out when Redis config is missing", async () => {
    vi.mocked(validateEnv).mockReturnValue({
      ok: true,
      config: { redisRestUrl: undefined, redisRestToken: undefined },
    } as never);
    const res = await GET(makeRequest("setup_session=tok"));
    expect((await res.json()).authenticated).toBe(false);
  });

  it("fails closed to logged out when the session lookup throws", async () => {
    vi.mocked(getSetupSession).mockRejectedValue(new Error("redis down"));
    const res = await GET(makeRequest("setup_session=tok"));
    expect(res.status).toBe(200);
    expect((await res.json()).authenticated).toBe(false);
  });
});
