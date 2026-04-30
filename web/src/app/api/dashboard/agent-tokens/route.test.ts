/**
 * Tests for the dashboard cookie-auth wrapper around the V1 capability
 * token issuance / list API. Mirrors the bootstrap test shape but
 * covers the regular `issue` action class (not `bootstrap`) with
 * preset and explicit-capabilities branches.
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
    issueAgentToken: vi.fn(),
    listAgentTokens: vi.fn(),
  };
});

import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import {
  issueAgentToken,
  listAgentTokens,
  TokenNameTakenError,
} from "@/server/agent-token-v1";
import { GET, POST } from "./route";

const mockedAuth = vi.mocked(authenticateByokRequest);
const mockedRequireInstallation = vi.mocked(requireInstallation);
const mockedIssue = vi.mocked(issueAgentToken);
const mockedList = vi.mocked(listAgentTokens);

function makeRequest(method: "GET" | "POST", body?: unknown): NextRequest {
  return new NextRequest("https://www.hivemoot.dev/api/dashboard/agent-tokens", {
    method,
    headers: { "content-type": "application/json", cookie: "session=mock" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function makeByokAuthOk(overrides: { userLogin?: string } = {}) {
  return {
    ok: true as const,
    session: {
      userLogin: overrides.userLogin ?? "operator-gh-login",
      installationId: "12345",
    } as never,
    keyring: new Map<string, Buffer>([["v1", Buffer.alloc(32)]]),
    activeKeyVersion: "v1",
    redis: {} as never,
  };
}

function makeIssued(overrides: Partial<ReturnType<typeof rawIssued>> = {}) {
  return { ...rawIssued(), ...overrides };
}
function rawIssued() {
  return {
    token: "hmt_a_brand_new_queen_bearer",
    name: "queen",
    agent_role: "queen",
    capabilities: ["rooms.create", "rooms.read", "rooms.read_all"],
    fingerprint: "queenfp1",
    expiresAt: null as string | null,
  };
}

beforeEach(() => {
  mockedAuth.mockReset();
  mockedRequireInstallation.mockReset();
  mockedIssue.mockReset();
  mockedList.mockReset();
});

// ---------------------------------------------------------------------------
// GET — list
// ---------------------------------------------------------------------------

describe("GET /api/dashboard/agent-tokens", () => {
  it("byok auth failure surfaces middleware response", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "byok_session_invalid" }, { status: 401 }),
    } as never);
    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(401);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("returns tokens + presets list on success", async () => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: true,
      installationId: "12345",
    } as never);
    mockedList.mockResolvedValue([
      {
        name: "queen",
        agent_role: "queen",
        capabilities: ["rooms.create"],
        fingerprint: "queenfp1",
        createdAt: "2026-04-30T07:00:00.000Z",
        createdBy: "operator-gh-login",
        expiresAt: null,
      },
    ] as never);

    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0].name).toBe("queen");
    // Admin filtered out per #567 builder R1 — see the "preset catalog
    // filter" describe block below for the explicit regression.
    expect(body.presets).toEqual(
      expect.arrayContaining(["queen", "worker", "apiarist"]),
    );
  });
});

// ---------------------------------------------------------------------------
// POST — issuance
// ---------------------------------------------------------------------------

describe("POST /api/dashboard/agent-tokens — auth gate", () => {
  it("byok auth failure → no issue", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "byok_session_invalid" }, { status: 401 }),
    } as never);
    const res = await POST(makeRequest("POST", { name: "queen", preset: "queen" }));
    expect(res.status).toBe(401);
    expect(mockedIssue).not.toHaveBeenCalled();
  });

  it("requireInstallation failure → no issue", async () => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: false,
      response: NextResponse.json({ code: "missing_installation" }, { status: 400 }),
    } as never);
    const res = await POST(makeRequest("POST", { name: "queen", preset: "queen" }));
    expect(res.status).toBe(400);
    expect(mockedIssue).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/agent-tokens — body validation", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: true,
      installationId: "12345",
    } as never);
  });

  it("missing name → 400 INVALID_NAME", async () => {
    const res = await POST(makeRequest("POST", { preset: "queen" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_name");
    expect(mockedIssue).not.toHaveBeenCalled();
  });

  it("malformed name → 400 INVALID_NAME (boundary validation)", async () => {
    const res = await POST(
      makeRequest("POST", { name: "QUEEN", preset: "queen" }), // capitals reject
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_name");
    expect(mockedIssue).not.toHaveBeenCalled();
  });

  it("missing both preset and capabilities → 400 INVALID_CAPABILITIES", async () => {
    const res = await POST(makeRequest("POST", { name: "queen" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_capabilities");
    expect(mockedIssue).not.toHaveBeenCalled();
  });

  it("unknown preset → 400 INVALID_CAPABILITIES (resolvePreset rejects)", async () => {
    const res = await POST(
      makeRequest("POST", { name: "queen", preset: "wizard" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_capabilities");
    expect(mockedIssue).not.toHaveBeenCalled();
  });

  it("empty capabilities array → 400 INVALID_CAPABILITIES", async () => {
    const res = await POST(
      makeRequest("POST", { name: "queen", capabilities: [] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_capabilities");
    expect(mockedIssue).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/agent-tokens — issuance success", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: true,
      installationId: "12345",
    } as never);
    mockedIssue.mockResolvedValue(makeIssued() as never);
  });

  it("preset='queen' → resolves capabilities + issues with agent_role='queen'", async () => {
    const res = await POST(
      makeRequest("POST", { name: "queen", preset: "queen" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe("hmt_a_brand_new_queen_bearer");
    expect(body.fingerprint).toBe("queenfp1");
    // The caller's preset choice flows through to issueAgentToken
    expect(mockedIssue).toHaveBeenCalledTimes(1);
    const call = mockedIssue.mock.calls[0][0];
    expect(call.name).toBe("queen");
    expect(call.agent_role).toBe("queen");
    expect(call.capabilities).toEqual(
      expect.arrayContaining(["rooms.create", "rooms.read_all"]),
    );
    // Audit context uses dashboard convention
    expect(call.auditContext?.operator).toEqual({
      fingerprint: "",
      name: "dashboard",
    });
    expect(call.auditContext?.detailExtras).toEqual({
      issued_by: "operator-gh-login",
    });
  });

  it("explicit capabilities → uses them with agent_role defaulting to name", async () => {
    const res = await POST(
      makeRequest("POST", {
        name: "custom-watcher",
        capabilities: ["rooms.watch", "rooms.read"],
      }),
    );
    expect(res.status).toBe(200);
    const call = mockedIssue.mock.calls[0][0];
    expect(call.name).toBe("custom-watcher");
    expect(call.agent_role).toBe("custom-watcher");
    expect(call.capabilities).toEqual(["rooms.watch", "rooms.read"]);
  });

  it("explicit capabilities + agent_role override → uses override", async () => {
    const res = await POST(
      makeRequest("POST", {
        name: "custom-watcher",
        capabilities: ["rooms.watch"],
        agent_role: "watcher",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockedIssue.mock.calls[0][0].agent_role).toBe("watcher");
  });

  it("response payload includes message reminder + capabilities", async () => {
    const res = await POST(
      makeRequest("POST", { name: "queen", preset: "queen" }),
    );
    const body = await res.json();
    expect(body.message).toMatch(/Store this token securely/);
    expect(body.capabilities).toEqual(
      expect.arrayContaining(["rooms.create", "rooms.read"]),
    );
  });
});

describe("POST /api/dashboard/agent-tokens — admin-class deny list (#567 builder R1)", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: true,
      installationId: "12345",
    } as never);
  });

  it("preset 'admin' → 400 INVALID_CAPABILITIES (no storage call)", async () => {
    const res = await POST(
      makeRequest("POST", { name: "evil-admin", preset: "admin" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("agent_tokens_v1_invalid_capabilities");
    expect(body.field).toBe("preset");
    expect(body.value).toBe("admin");
    expect(body.message).toMatch(/admin-class/);
    expect(body.message).toMatch(/bootstrap/); // points to the right path
    expect(mockedIssue).not.toHaveBeenCalled();
  });

  it("explicit capability '*' (wildcard) → 400 INVALID_CAPABILITIES", async () => {
    const res = await POST(
      makeRequest("POST", {
        name: "evil-wildcard",
        capabilities: ["*"],
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("agent_tokens_v1_invalid_capabilities");
    expect(body.field).toBe("capabilities");
    expect(body.value).toBe("*");
    expect(mockedIssue).not.toHaveBeenCalled();
  });

  it("explicit capability 'agent_tokens.manage' → 400 INVALID_CAPABILITIES", async () => {
    const res = await POST(
      makeRequest("POST", {
        name: "evil-mint",
        capabilities: ["agent_tokens.manage"],
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("agent_tokens_v1_invalid_capabilities");
    expect(body.field).toBe("capabilities");
    expect(body.value).toBe("agent_tokens.manage");
    expect(mockedIssue).not.toHaveBeenCalled();
  });

  it("explicit capabilities mixed with admin-class entry → 400 (rejection scans the list)", async () => {
    const res = await POST(
      makeRequest("POST", {
        name: "evil-mixed",
        capabilities: ["rooms.read", "agent_tokens.manage", "tasks.read"],
      }),
    );
    expect(res.status).toBe(400);
    expect(mockedIssue).not.toHaveBeenCalled();
  });
});

describe("GET /api/dashboard/agent-tokens — preset catalog filter", () => {
  it("excludes 'admin' from the presets list (#567 builder R1)", async () => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: true,
      installationId: "12345",
    } as never);
    mockedList.mockResolvedValue([] as never);
    const res = await GET(makeRequest("GET"));
    const body = await res.json();
    expect(body.presets).not.toContain("admin");
    // Sanity: non-admin presets are still there
    expect(body.presets).toEqual(
      expect.arrayContaining(["queen", "worker", "apiarist", "monitoring", "dispatcher"]),
    );
  });
});

describe("POST /api/dashboard/agent-tokens — storage error mapping", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: true,
      installationId: "12345",
    } as never);
  });

  it("TokenNameTakenError → 409", async () => {
    mockedIssue.mockRejectedValue(new TokenNameTakenError("12345", "queen"));
    const res = await POST(
      makeRequest("POST", { name: "queen", preset: "queen" }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("agent_tokens_v1_name_taken");
  });
});
