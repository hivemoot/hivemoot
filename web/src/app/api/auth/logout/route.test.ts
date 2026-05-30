import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/server/env", () => ({ validateEnv: vi.fn() }));
vi.mock("@/server/redis", () => ({ getRedisClient: vi.fn() }));
vi.mock("@/server/setup-session", () => ({
  deleteSetupSession: vi.fn(),
  SETUP_SESSION_COOKIE: "setup_session",
}));

import { validateEnv } from "@/server/env";
import { getRedisClient } from "@/server/redis";
import { deleteSetupSession } from "@/server/setup-session";
import { REMEMBERED_USER_COOKIE } from "@/constants/cookies";
import { POST } from "./route";

const CONFIG = {
  redisRestUrl: "https://example.upstash.io",
  redisRestToken: "test-token",
};

function makeRequest({
  cookie,
  origin,
}: { cookie?: string; origin?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  // origin === null means "omit the header"; undefined means same-origin.
  if (origin === undefined) headers.origin = "https://example.com";
  else if (origin !== null) headers.origin = origin;
  return new NextRequest("https://example.com/api/auth/logout", { method: "POST", headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(validateEnv).mockReturnValue({ ok: true, config: { ...CONFIG } } as never);
  vi.mocked(getRedisClient).mockReturnValue({} as never);
  vi.mocked(deleteSetupSession).mockResolvedValue(undefined);
});

describe("POST /api/auth/logout", () => {
  it("clears both auth cookies and revokes the session", async () => {
    const res = await POST(makeRequest({ cookie: "setup_session=tok" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deleteSetupSession).toHaveBeenCalledWith("tok", expect.anything());
    expect(res.cookies.get("setup_session")?.value).toBe("");
    expect(res.cookies.get(REMEMBERED_USER_COOKIE)?.value).toBe("");
  });

  it("rejects cross-origin requests (logout CSRF) without touching the session", async () => {
    const res = await POST(makeRequest({ cookie: "setup_session=tok", origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(deleteSetupSession).not.toHaveBeenCalled();
  });

  it("allows requests with no Origin header (treated as same-origin)", async () => {
    const res = await POST(makeRequest({ cookie: "setup_session=tok", origin: null }));
    expect(res.status).toBe(200);
  });

  it("still clears cookies when there is no session cookie", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(deleteSetupSession).not.toHaveBeenCalled();
    expect(res.cookies.get("setup_session")?.value).toBe("");
  });

  it("still succeeds and clears cookies when Redis revocation fails", async () => {
    vi.mocked(deleteSetupSession).mockRejectedValue(new Error("redis down"));
    const res = await POST(makeRequest({ cookie: "setup_session=tok" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.cookies.get("setup_session")?.value).toBe("");
  });
});
