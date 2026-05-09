import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));

vi.mock("@/server/queen-settings-store", async () => {
  const real = await vi.importActual<typeof import("@/server/queen-settings-store")>(
    "@/server/queen-settings-store",
  );
  return {
    ...real,
    getQueenSettings: vi.fn(),
    setQueenSettings: vi.fn(),
  };
});

import { authenticateByokRequest } from "@/server/byok-auth";
import { getQueenSettings, setQueenSettings } from "@/server/queen-settings-store";
import { GET, POST } from "./route";

const mockedAuth = vi.mocked(authenticateByokRequest);
const mockedGet = vi.mocked(getQueenSettings);
const mockedSet = vi.mocked(setQueenSettings);

function makeGetRequest(): NextRequest {
  return new NextRequest("https://www.hivemoot.dev/api/dashboard/queen-settings", {
    method: "GET",
  });
}

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("https://www.hivemoot.dev/api/dashboard/queen-settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeAuth(installationId: string | null) {
  return {
    ok: true as const,
    session: {
      installationId,
      userId: 101,
      userLogin: "alice",
    },
    redis: {} as never,
    keyring: new Map(),
    activeKeyVersion: "v1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/dashboard/queen-settings", () => {
  it("returns 401 when session auth fails", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 401 }),
    });
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("returns 403 no_installation when session has no installationId", async () => {
    mockedAuth.mockResolvedValue(makeAuth(null));
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "no_installation" });
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("returns the settings for the linked installation", async () => {
    mockedAuth.mockResolvedValue(makeAuth("42"));
    mockedGet.mockResolvedValue({
      queen_mode: "local",
      queen_prompt_override: "merge_conventions: squash-only",
    });
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      installation_id: "42",
      queen_mode: "local",
      queen_prompt_override: "merge_conventions: squash-only",
    });
  });

  it("returns 500 on storage failure", async () => {
    mockedAuth.mockResolvedValue(makeAuth("42"));
    mockedGet.mockRejectedValue(new Error("redis down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "storage_failure" });
    errSpy.mockRestore();
  });
});

describe("POST /api/dashboard/queen-settings", () => {
  it("requires a fresh session (passes requireFresh: true)", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "fresh_session_required" }, { status: 403 }),
    });
    const res = await POST(makePostRequest({ queen_mode: "local" }));
    expect(res.status).toBe(403);
    expect(mockedAuth).toHaveBeenCalledWith(expect.any(NextRequest), { requireFresh: true });
  });

  it("returns 403 no_installation when session has no installationId", async () => {
    mockedAuth.mockResolvedValue(makeAuth(null));
    const res = await POST(makePostRequest({ queen_mode: "local" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "no_installation" });
  });

  it("rejects invalid queen_mode values", async () => {
    mockedAuth.mockResolvedValue(makeAuth("42"));
    const res = await POST(makePostRequest({ queen_mode: "ditto" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_body" });
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON body", async () => {
    mockedAuth.mockResolvedValue(makeAuth("42"));
    const res = await POST(makePostRequest("not-valid-json{{{"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_body" });
  });

  it("rejects non-string non-null override values", async () => {
    mockedAuth.mockResolvedValue(makeAuth("42"));
    const res = await POST(
      makePostRequest({ queen_mode: "local", queen_prompt_override: 12345 }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_body" });
  });

  it("normalizes empty-string override to null (guard B3 — round-trip symmetry)", async () => {
    mockedAuth.mockResolvedValue(makeAuth("42"));
    mockedSet.mockResolvedValue({
      ok: true,
      previous: { queen_mode: "cloud", queen_prompt_override: null },
      current: { queen_mode: "cloud", queen_prompt_override: null },
    });
    await POST(
      makePostRequest({ queen_mode: "cloud", queen_prompt_override: "" }),
    );
    expect(mockedSet).toHaveBeenCalledWith(
      expect.objectContaining({
        next: expect.objectContaining({ queen_prompt_override: null }),
      }),
    );
  });

  it("rejects override over 16 KiB cap (guard B1 — bounded storage)", async () => {
    mockedAuth.mockResolvedValue(makeAuth("42"));
    const huge = "x".repeat(16 * 1024 + 1);
    const res = await POST(
      makePostRequest({ queen_mode: "cloud", queen_prompt_override: huge }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_body" });
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("counts UTF-8 bytes, not chars (smiley inflation can't sneak past the cap)", async () => {
    mockedAuth.mockResolvedValue(makeAuth("42"));
    // each smiley is 4 bytes (surrogate pair); 4097 smileys = 16,388 bytes
    const blob = "🎉".repeat(4097);
    const res = await POST(
      makePostRequest({ queen_mode: "cloud", queen_prompt_override: blob }),
    );
    expect(res.status).toBe(400);
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("accepts override exactly at the 16 KiB boundary", async () => {
    mockedAuth.mockResolvedValue(makeAuth("42"));
    mockedSet.mockResolvedValue({
      ok: true,
      previous: { queen_mode: "cloud", queen_prompt_override: null },
      current: { queen_mode: "cloud", queen_prompt_override: "x".repeat(16 * 1024) },
    });
    const res = await POST(
      makePostRequest({
        queen_mode: "cloud",
        queen_prompt_override: "x".repeat(16 * 1024),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("writes settings and returns the new state", async () => {
    mockedAuth.mockResolvedValue(makeAuth("42"));
    mockedSet.mockResolvedValue({
      ok: true,
      previous: { queen_mode: "cloud", queen_prompt_override: null },
      current: { queen_mode: "local", queen_prompt_override: "test" },
    });
    const res = await POST(
      makePostRequest({ queen_mode: "local", queen_prompt_override: "test" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      installation_id: "42",
      queen_mode: "local",
      queen_prompt_override: "test",
    });
    expect(mockedSet).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "42",
        next: { queen_mode: "local", queen_prompt_override: "test" },
      }),
    );
  });

  it("returns 409 mode_flip_blocked when precheck (PR 2) blocks", async () => {
    mockedAuth.mockResolvedValue(makeAuth("42"));
    mockedSet.mockResolvedValue({
      ok: false,
      blocked: { reason: "rooms_in_flight", count: 2 },
    });
    const res = await POST(makePostRequest({ queen_mode: "local" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "mode_flip_blocked",
      blocked: { reason: "rooms_in_flight", count: 2 },
    });
  });

  it("returns 500 on storage failure", async () => {
    mockedAuth.mockResolvedValue(makeAuth("42"));
    mockedSet.mockRejectedValue(new Error("lock timeout"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(makePostRequest({ queen_mode: "local" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "storage_failure" });
    errSpy.mockRestore();
  });
});
