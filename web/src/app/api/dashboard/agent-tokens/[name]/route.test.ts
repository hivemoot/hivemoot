/**
 * Tests for the per-name dashboard cookie-auth wrappers (GET summary,
 * DELETE revoke). The 404 branch on revoke is route-synthesized
 * (storage returns `null` → route emits TOKEN_NOT_FOUND) — distinct
 * from the `mapV1StorageErrorToResponse` path that handles thrown
 * storage errors. Both branches are tested explicitly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));

vi.mock("@/server/require-installation", () => ({
  requireInstallation: vi.fn(),
}));

vi.mock("@/server/agent-token-v1", async () => {
  const real =
    await vi.importActual<typeof import("@/server/agent-token-v1")>(
      "@/server/agent-token-v1",
    );
  return {
    ...real,
    getAgentTokenSummary: vi.fn(),
    revokeAgentToken: vi.fn(),
  };
});

import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import {
  getAgentTokenSummary,
  revokeAgentToken,
  TokenNotFoundError,
} from "@/server/agent-token-v1";
import { GET, DELETE } from "./route";

const mockedAuth = vi.mocked(authenticateByokRequest);
const mockedRequireInstallation = vi.mocked(requireInstallation);
const mockedGetSummary = vi.mocked(getAgentTokenSummary);
const mockedRevoke = vi.mocked(revokeAgentToken);

function makeRequest(method: "GET" | "DELETE"): NextRequest {
  return new NextRequest(
    "https://www.hivemoot.dev/api/dashboard/agent-tokens/queen",
    {
      method,
      headers: { cookie: "session=mock" },
    },
  );
}

function makeParams(name = "queen") {
  return { params: Promise.resolve({ name }) };
}

function makeByokAuthOk() {
  return {
    ok: true as const,
    session: {
      userLogin: "operator-gh-login",
      installationId: "12345",
    } as never,
    keyring: new Map<string, Buffer>([["v1", Buffer.alloc(32)]]),
    activeKeyVersion: "v1",
    redis: {} as never,
  };
}

function makeSummary() {
  return {
    name: "queen",
    agent_role: "queen",
    capabilities: ["rooms.create", "rooms.read"],
    fingerprint: "queenfp1",
    createdAt: "2026-04-30T07:00:00.000Z",
    createdBy: "operator-gh-login",
    expiresAt: null as string | null,
  };
}

beforeEach(() => {
  mockedAuth.mockReset();
  mockedRequireInstallation.mockReset();
  mockedGetSummary.mockReset();
  mockedRevoke.mockReset();
});

// ---------------------------------------------------------------------------
// Path validation (shared between GET/DELETE)
// ---------------------------------------------------------------------------

describe("path-name validation", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
  });

  it("rejects empty name → 400 INVALID_NAME (no auth call needed for the empty case, but the handler runs auth first; either way 400 surfaces)", async () => {
    const res = await GET(makeRequest("GET"), makeParams(""));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_name");
  });

  it("rejects malformed name (capital letters) → 400 INVALID_NAME", async () => {
    const res = await GET(makeRequest("GET"), makeParams("QUEEN"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_name");
  });
});

// ---------------------------------------------------------------------------
// GET — summary
// ---------------------------------------------------------------------------

describe("GET /api/dashboard/agent-tokens/{name}", () => {
  it("byok auth failure → no summary call", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "byok_session_invalid" }, { status: 401 }),
    } as never);
    const res = await GET(makeRequest("GET"), makeParams());
    expect(res.status).toBe(401);
    expect(mockedGetSummary).not.toHaveBeenCalled();
  });

  it("requireInstallation failure → no summary call", async () => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: false,
      response: NextResponse.json({ code: "installation_required" }, { status: 409 }),
    } as never);
    const res = await GET(makeRequest("GET"), makeParams());
    expect(res.status).toBe(409);
    expect(mockedGetSummary).not.toHaveBeenCalled();
  });

  it("returns summary on success", async () => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: true,
      installationId: "12345",
    } as never);
    mockedGetSummary.mockResolvedValue(makeSummary() as never);
    const res = await GET(makeRequest("GET"), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("queen");
    expect(body.capabilities).toEqual(["rooms.create", "rooms.read"]);
    // No raw bearer in summary
    expect(body.token).toBeUndefined();
  });

  it("token not found → mapV1StorageErrorToResponse handles it (404)", async () => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: true,
      installationId: "12345",
    } as never);
    mockedGetSummary.mockRejectedValue(new TokenNotFoundError("12345", "queen"));
    const res = await GET(makeRequest("GET"), makeParams());
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE — revoke
// ---------------------------------------------------------------------------

describe("DELETE /api/dashboard/agent-tokens/{name}", () => {
  it("byok auth failure → no revoke call", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "byok_session_invalid" }, { status: 401 }),
    } as never);
    const res = await DELETE(makeRequest("DELETE"), makeParams());
    expect(res.status).toBe(401);
    expect(mockedRevoke).not.toHaveBeenCalled();
  });

  it("requireInstallation failure → no revoke call", async () => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: false,
      response: NextResponse.json({ code: "installation_required" }, { status: 409 }),
    } as never);
    const res = await DELETE(makeRequest("DELETE"), makeParams());
    expect(res.status).toBe(409);
    expect(mockedRevoke).not.toHaveBeenCalled();
  });

  it("successful revoke → 200 with `revoked: true`", async () => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: true,
      installationId: "12345",
    } as never);
    mockedRevoke.mockResolvedValue(true as never);
    const res = await DELETE(makeRequest("DELETE"), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revoked).toBe(true);
    expect(body.name).toBe("queen");
    // Audit context uses dashboard convention
    const call = mockedRevoke.mock.calls[0][0];
    expect(call.auditContext?.operator).toEqual({
      fingerprint: "",
      name: "dashboard",
    });
    expect(call.auditContext?.detailExtras).toEqual({
      revoked_by: "operator-gh-login",
    });
  });

  it("storage returns null (token never existed) → 404 TOKEN_NOT_FOUND (route-synthesized)", async () => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: true,
      installationId: "12345",
    } as never);
    mockedRevoke.mockResolvedValue(false as never);
    const res = await DELETE(makeRequest("DELETE"), makeParams());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("agent_tokens_v1_token_not_found");
    expect(body.message).toMatch(/queen/);
  });

  it("storage throws → mapV1StorageErrorToResponse handles it", async () => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: true,
      installationId: "12345",
    } as never);
    mockedRevoke.mockRejectedValue(new Error("storage exploded"));
    const res = await DELETE(makeRequest("DELETE"), makeParams());
    // Generic non-typed errors map to 500 in mapV1StorageErrorToResponse
    expect(res.status).toBe(500);
  });
});
