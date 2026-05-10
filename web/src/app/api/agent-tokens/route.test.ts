/**
 * Tests for POST /api/agent-tokens (issue) and GET /api/agent-tokens
 * (list). Phase B.1.d-ii.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/server/agent-token-v1-auth", () => ({
  authenticateAgentRequestV1: vi.fn(),
  loadV1MintKeyring: vi.fn(),
  AGENT_AUTH_V1_ERROR: {
    MISSING_BEARER: "agent_auth_v1_missing_bearer",
    UNKNOWN_BEARER: "agent_auth_v1_unknown_bearer",
    TOKEN_EXPIRED: "agent_auth_v1_token_expired",
    MISSING_CAPABILITY: "agent_auth_v1_missing_capability",
    SERVER_MISCONFIGURATION: "agent_auth_v1_server_misconfiguration",
  },
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

vi.mock("@/server/agent-token-v1-audit", () => ({
  auditAppend: vi.fn(async () => undefined),
}));

import {
  authenticateAgentRequestV1,
  loadV1MintKeyring,
} from "@/server/agent-token-v1-auth";
import {
  issueAgentToken,
  listAgentTokens,
  TokenNameTakenError,
  TokenLimitReachedError,
  type IssuedAgentTokenV1,
  type AgentTokenSummaryV1,
} from "@/server/agent-token-v1";
import { auditAppend } from "@/server/agent-token-v1-audit";
import { POST, GET } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedKeyring = vi.mocked(loadV1MintKeyring);
const mockedIssue = vi.mocked(issueAgentToken);
const mockedList = vi.mocked(listAgentTokens);
const mockedAuditAppend = vi.mocked(auditAppend);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRequest(method: "POST" | "GET", body?: unknown): NextRequest {
  return new NextRequest("https://www.hivemoot.dev/api/agent-tokens", {
    method,
    headers: { authorization: "Bearer hmt_admin", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function makeAuthOk(overrides: { name?: string } = {}) {
  return {
    ok: true as const,
    installationId: "12345",
    name: overrides.name ?? "admin",
    agent_role: "admin",
    capabilities: ["*", "agent_tokens.manage"],
    envelope: {
      ciphertext: "ct",
      iv: "iv",
      tag: "tag",
      keyVersion: "v1",
      tokenHash: "deadbeef00000000",
      fingerprint: "deadbeef",
      createdAt: "2026-04-27T10:00:00.000Z",
      createdBy: "bootstrap",
      expiresAt: null,
      name: overrides.name ?? "admin",
      agent_role: "admin",
      capabilities: ["*", "agent_tokens.manage"],
    },
    redis: {} as never,
  };
}

function makeKeyringOk() {
  return {
    ok: true as const,
    keyring: new Map<string, Buffer>([["v1", Buffer.alloc(32)]]),
    keyVersion: "v1",
  };
}

function makeIssued(overrides: Partial<IssuedAgentTokenV1> = {}): IssuedAgentTokenV1 {
  return {
    token: "hmt_brand_new_bearer",
    name: overrides.name ?? "worker",
    agent_role: overrides.agent_role ?? "drone",
    capabilities: overrides.capabilities ?? ["agent_health.report", "tasks.claim"],
    fingerprint: overrides.fingerprint ?? "abcd1234",
    expiresAt: overrides.expiresAt ?? null,
  };
}

function makeAuthFailure(status = 401) {
  return {
    ok: false as const,
    response: NextResponse.json({ code: "denied" }, { status }),
  };
}

beforeEach(() => {
  mockedAuth.mockReset();
  mockedKeyring.mockReset();
  mockedIssue.mockReset();
  mockedList.mockReset();
  mockedAuditAppend.mockReset();
});

// ---------------------------------------------------------------------------
// POST /api/agent-tokens — auth + keyring failures
// ---------------------------------------------------------------------------

describe("POST /api/agent-tokens — auth + keyring failures", () => {
  it("auth failure → middleware response surfaces", async () => {
    mockedAuth.mockResolvedValue(makeAuthFailure(403));
    const res = await POST(makeRequest("POST", { name: "x", agent_role: "y" }));
    expect(res.status).toBe(403);
    expect(mockedKeyring).not.toHaveBeenCalled();
  });

  it("keyring misconfiguration → 503 surfaces, issue not called", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedKeyring.mockReturnValue({
      ok: false,
      response: NextResponse.json(
        { code: "agent_auth_v1_server_misconfiguration" },
        { status: 503 },
      ),
    });
    const res = await POST(makeRequest("POST", { name: "x", agent_role: "y" }));
    expect(res.status).toBe(503);
    expect(mockedIssue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent-tokens — body validation
// ---------------------------------------------------------------------------

describe("POST /api/agent-tokens — body validation", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedKeyring.mockReturnValue(makeKeyringOk());
  });

  it("missing name → 400 INVALID_NAME", async () => {
    const res = await POST(makeRequest("POST", { agent_role: "drone", preset: "worker" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_name");
  });

  it("missing agent_role → 400 INVALID_AGENT_ROLE (no implicit default)", async () => {
    const res = await POST(makeRequest("POST", { name: "worker", preset: "worker" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_agent_role");
  });

  it("invalid name format → 400 INVALID_NAME", async () => {
    const res = await POST(
      makeRequest("POST", { name: "Worker!", agent_role: "drone", preset: "worker" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_name");
  });

  it("preset + capabilities both provided → 400 INVALID_CAPABILITIES", async () => {
    const res = await POST(
      makeRequest("POST", {
        name: "worker",
        agent_role: "drone",
        preset: "worker",
        capabilities: ["tasks.claim"],
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_capabilities");
  });

  it("unknown preset → 400 INVALID_PRESET", async () => {
    const res = await POST(
      makeRequest("POST", { name: "worker", agent_role: "drone", preset: "unicorn" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_preset");
  });

  it("neither preset nor capabilities → 400 INVALID_CAPABILITIES", async () => {
    const res = await POST(
      makeRequest("POST", { name: "worker", agent_role: "drone" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_capabilities");
  });

  it("empty capabilities array → 400 INVALID_CAPABILITIES", async () => {
    const res = await POST(
      makeRequest("POST", {
        name: "worker",
        agent_role: "drone",
        capabilities: [],
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_capabilities");
  });

  it("bare '*' without allowWildcards → 400 WILDCARD_NOT_ALLOWED", async () => {
    const res = await POST(
      makeRequest("POST", {
        name: "super",
        agent_role: "admin",
        capabilities: ["*", "agent_tokens.manage"],
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_wildcard_not_allowed");
  });

  it("invalid expiresIn → 400 INVALID_EXPIRES_IN", async () => {
    const res = await POST(
      makeRequest("POST", {
        name: "worker",
        agent_role: "drone",
        preset: "worker",
        expiresIn: "forever",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_expires_in");
  });

  it("V1.6-only policy (no allowedRepos) → 400 INVALID_POLICY", async () => {
    const res = await POST(
      makeRequest("POST", {
        name: "worker",
        agent_role: "drone",
        preset: "worker",
        policy: { allowedPermissions: { contents: "read" } },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_policy");
  });

  // PR 645 builder pass-1 B1 — issue-time gate on mint-capable presets.
  // The gate fires AFTER capability resolution + policy parse but
  // BEFORE the storage write. Same INVALID_POLICY error code as the
  // V1.6 schema check so callers can branch on a single envelope.

  it("preset 'local_queen' without policy → 400 INVALID_POLICY (mint gate)", async () => {
    const res = await POST(
      makeRequest("POST", {
        name: "queen-hive-1",
        agent_role: "local_queen",
        preset: "local_queen",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("agent_tokens_v1_invalid_policy");
    expect(body.message).toMatch(/installation_token\.mint/);
    expect(body.message).toMatch(/policy\.allowedRepos/);
  });

  it("preset 'local_queen' with empty allowedRepos → 400 (gate enforces non-empty list)", async () => {
    const res = await POST(
      makeRequest("POST", {
        name: "queen-hive-1",
        agent_role: "local_queen",
        preset: "local_queen",
        policy: { allowedRepos: [], allowedPermissions: { contents: "read" } },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_policy");
  });

  it("explicit capabilities including installation_token.mint without policy → 400 (label-laundering attempt)", async () => {
    // An operator might try to bypass the local_queen preset gate by
    // passing the same caps + a non-apiarist role explicitly. Gate
    // is capability-based, so it still fires.
    const res = await POST(
      makeRequest("POST", {
        name: "minty",
        agent_role: "custom_minter",
        capabilities: ["installation_token.mint", "rooms.read"],
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_policy");
  });

  it("preset 'apiarist' without policy → 200 (legacy carve-out preserved)", async () => {
    // Apiarist tokens predate the policy model; tightening would
    // break existing operator scripts. Confirms the gate's exemption
    // is wired at the route layer.
    mockedKeyring.mockReturnValue(makeKeyringOk());
    mockedIssue.mockResolvedValue(
      makeIssued({ name: "ap-1", agent_role: "apiarist", capabilities: ["installation_token.mint"] }),
    );
    const res = await POST(
      makeRequest("POST", {
        name: "ap-1",
        agent_role: "apiarist",
        preset: "apiarist",
      }),
    );
    // 201 is the success code — confirms the gate did NOT short-
    // circuit the request to 400.
    expect(res.status).toBe(201);
  });

  it("preset 'local_queen' with allowedRepos but NO allowedPermissions → 400 (pass-3 D10 half 2)", async () => {
    // Pass-2 accepted this shape; pass-3 rejects because the mint
    // endpoint falls back to V1_PERMISSIONS (which includes
    // contents:read) when allowedPermissions is omitted, violating
    // RFC D10's permission-scope half.
    const res = await POST(
      makeRequest("POST", {
        name: "queen-hive-1",
        agent_role: "local_queen",
        preset: "local_queen",
        policy: { allowedRepos: ["hivemoot/colony"] },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("agent_tokens_v1_invalid_policy");
    expect(body.message).toMatch(/allowedPermissions/);
    expect(body.message).toMatch(/contents/);
  });

  it("preset 'local_queen' with allowedPermissions including contents → 400 (D10 forbids contents)", async () => {
    const res = await POST(
      makeRequest("POST", {
        name: "queen-hive-1",
        agent_role: "local_queen",
        preset: "local_queen",
        policy: {
          allowedRepos: ["hivemoot/colony"],
          allowedPermissions: {
            pull_requests: "write",
            issues: "write",
            metadata: "read",
            contents: "read",
          },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_policy");
  });

  it("preset 'local_queen' with EXACT D10 policy (allowedRepos + allowedPermissions) → 201 (happy path)", async () => {
    // Pin the canonical D10 shape that survives the gate. If a
    // future change tightens the gate further, this test catches
    // it before it breaks the local_queen issuance path.
    mockedKeyring.mockReturnValue(makeKeyringOk());
    mockedIssue.mockResolvedValue(
      makeIssued({
        name: "queen-hive-1",
        agent_role: "local_queen",
        capabilities: ["installation_token.mint", "rooms.synthesize"],
      }),
    );
    const res = await POST(
      makeRequest("POST", {
        name: "queen-hive-1",
        agent_role: "local_queen",
        preset: "local_queen",
        policy: {
          allowedRepos: ["hivemoot/colony"],
          allowedPermissions: {
            pull_requests: "write",
            issues: "write",
            metadata: "read",
          },
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(mockedIssue).toHaveBeenCalled();
  });

  it("wildcard 'installation_token.*' without policy → 400 (pass-3 wildcard-aware mint gate)", async () => {
    // Pre-pass-3, a literal `.includes("installation_token.mint")`
    // missed wildcard forms. Now `bearerHasCapability` expansion
    // catches it.
    const res = await POST(
      makeRequest("POST", {
        name: "minty",
        agent_role: "minty",
        capabilities: ["installation_token.*", "rooms.read"],
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_policy");
    expect(mockedIssue).not.toHaveBeenCalled();
  });

  it("wildcard 'installation_token.*' with full D10 policy → 201 (gate is policy-based)", async () => {
    mockedKeyring.mockReturnValue(makeKeyringOk());
    mockedIssue.mockResolvedValue(
      makeIssued({
        name: "wildcard-mint",
        agent_role: "wildcard-mint",
        capabilities: ["installation_token.*", "rooms.read"],
      }),
    );
    const res = await POST(
      makeRequest("POST", {
        name: "wildcard-mint",
        agent_role: "wildcard-mint",
        capabilities: ["installation_token.*", "rooms.read"],
        policy: {
          allowedRepos: ["hivemoot/colony"],
          allowedPermissions: {
            pull_requests: "write",
            issues: "write",
            metadata: "read",
          },
        },
      }),
    );
    expect(res.status).toBe(201);
  });

  it("admin chain-root '*' + allowWildcards still permitted (legacy carve-out preserved)", async () => {
    // Pre-existing test pinned this; pass-3 added the explicit
    // carve-out so it keeps working.
    mockedKeyring.mockReturnValue(makeKeyringOk());
    mockedIssue.mockResolvedValue(
      makeIssued({ name: "admin-1", agent_role: "admin", capabilities: ["*"] }),
    );
    const res = await POST(
      makeRequest("POST", {
        name: "admin-1",
        agent_role: "admin",
        capabilities: ["*"],
        allowWildcards: true,
      }),
    );
    expect(res.status).toBe(201);
  });

  it("label-laundering — explicit capabilities with agent_role=apiarist → 400 (builder pass-2 fix)", async () => {
    // Pass-1 carve-out trusted operator-supplied agent_role; an
    // attacker could submit explicit installation_token.mint caps
    // with agent_role=apiarist and the gate would return ok with
    // policy: null. Pass-2: the carve-out keys ONLY on the
    // server-resolved preset name (null on this path), so the
    // gate fires regardless of the operator's role label.
    const res = await POST(
      makeRequest("POST", {
        name: "ap-fake",
        agent_role: "apiarist", // operator-supplied — must NOT grant exemption
        capabilities: ["installation_token.mint", "rooms.read"],
        // No preset → presetName is null → exemption does not fire.
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("agent_tokens_v1_invalid_policy");
    expect(body.message).toMatch(/installation_token\.mint/);
    expect(mockedIssue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent-tokens — happy paths
// ---------------------------------------------------------------------------

describe("POST /api/agent-tokens — happy paths", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedKeyring.mockReturnValue(makeKeyringOk());
  });

  it("preset 'worker' → 201 with bearer + canonical caps", async () => {
    mockedIssue.mockResolvedValue(
      makeIssued({
        capabilities: [
          "agent_health.report",
          "tasks.claim",
          "tasks.progress",
          "tasks.complete",
          "rooms.watch",
          "rooms.read",
          "rooms.contribute",
        ],
      }),
    );
    const res = await POST(
      makeRequest("POST", {
        name: "worker",
        agent_role: "drone",
        preset: "worker",
        expiresIn: "30d",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toBe("hmt_brand_new_bearer");
    expect(body.fingerprint).toBe("abcd1234");
    expect(body.capabilities).toContain("agent_health.report");
    expect(body.message).toMatch(/ONCE/);
    expect(body.policy).toBeNull();
  });

  it("explicit capabilities → 201 with the same list back", async () => {
    mockedIssue.mockResolvedValue(
      makeIssued({ capabilities: ["agent_health.report", "tasks.claim"] }),
    );
    const res = await POST(
      makeRequest("POST", {
        name: "worker",
        agent_role: "drone",
        capabilities: ["agent_health.report", "tasks.claim"],
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.capabilities).toEqual(["agent_health.report", "tasks.claim"]);
  });

  it("V1.5 policy round-trips as camelCase on response", async () => {
    mockedIssue.mockResolvedValue(makeIssued());
    const res = await POST(
      makeRequest("POST", {
        name: "worker",
        agent_role: "drone",
        preset: "worker",
        policy: { allowedRepos: ["hivemoot/foxstoria"] },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.policy).toEqual({ allowedRepos: ["hivemoot/foxstoria"] });
    // Storage call received snake_case
    expect(mockedIssue.mock.calls[0][0].policy).toEqual({
      allowed_repos: ["hivemoot/foxstoria"],
    });
  });

  it("V1.6 policy (allowedRepos + allowedPermissions) round-trips", async () => {
    mockedIssue.mockResolvedValue(makeIssued());
    const res = await POST(
      makeRequest("POST", {
        name: "worker",
        agent_role: "drone",
        preset: "worker",
        policy: {
          allowedRepos: ["hivemoot/foxstoria"],
          allowedPermissions: { contents: "read" },
        },
      }),
    );
    const body = await res.json();
    expect(body.policy).toEqual({
      allowedRepos: ["hivemoot/foxstoria"],
      allowedPermissions: { contents: "read" },
    });
    expect(mockedIssue.mock.calls[0][0].policy).toEqual({
      allowed_repos: ["hivemoot/foxstoria"],
      allowed_permissions: { contents: "read" },
    });
  });

  it("bare '*' WITH allowWildcards: true → 201 (deliberate opt-in)", async () => {
    mockedIssue.mockResolvedValue(
      makeIssued({ capabilities: ["*", "agent_tokens.manage"] }),
    );
    const res = await POST(
      makeRequest("POST", {
        name: "super",
        agent_role: "admin",
        capabilities: ["*", "agent_tokens.manage"],
        allowWildcards: true,
      }),
    );
    expect(res.status).toBe(201);
  });

  it("auditContext passed to storage with operator's identity (storage builds entry internally)", async () => {
    mockedIssue.mockResolvedValue(makeIssued());
    await POST(
      makeRequest("POST", {
        name: "worker",
        agent_role: "drone",
        preset: "worker",
      }),
    );
    const callArgs = mockedIssue.mock.calls[0][0];
    expect(callArgs.auditContext).toBeDefined();
    // operator's fingerprint (from auth.envelope.fingerprint)
    expect(callArgs.auditContext?.operator.fingerprint).toBe("deadbeef");
    // operator's name (from auth.name)
    expect(callArgs.auditContext?.operator.name).toBe("admin");
    // Storage will fill in action="issue", subject=name, and the
    // detail object including the new token's fingerprint — none
    // of which the route layer should pre-compute.
  });

  it("issue response surfaces policy back to caller (no extra GET needed)", async () => {
    mockedIssue.mockResolvedValue({
      ...makeIssued(),
      policy: {
        allowed_repos: ["hivemoot/foxstoria"],
        allowed_permissions: { contents: "read" },
      },
    });
    const res = await POST(
      makeRequest("POST", {
        name: "worker",
        agent_role: "drone",
        preset: "worker",
        policy: {
          allowedRepos: ["hivemoot/foxstoria"],
          allowedPermissions: { contents: "read" },
        },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.policy).toEqual({
      allowedRepos: ["hivemoot/foxstoria"],
      allowedPermissions: { contents: "read" },
    });
  });

  it("emits auth.success to :auth stream via auditAppend", async () => {
    mockedIssue.mockResolvedValue(makeIssued());
    await POST(
      makeRequest("POST", {
        name: "worker",
        agent_role: "drone",
        preset: "worker",
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockedAuditAppend).toHaveBeenCalled();
    const entry = mockedAuditAppend.mock.calls[0][0].entry;
    expect(entry.action).toBe("auth.success");
    if (entry.action === "auth.success" || entry.action === "auth.failure") {
      expect(entry.endpoint).toBe("POST /api/agent-tokens");
      expect(entry.required_capability).toBe("agent_tokens.manage");
    }
  });

  it("SECURITY: response never contains envelope ciphertext / tokenHash", async () => {
    mockedIssue.mockResolvedValue(makeIssued());
    const res = await POST(
      makeRequest("POST", {
        name: "worker",
        agent_role: "drone",
        preset: "worker",
      }),
    );
    const raw = await res.text();
    expect(raw).not.toContain("ciphertext");
    expect(raw).not.toContain("deadbeef00000000"); // operator's tokenHash
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent-tokens — storage error mapping
// ---------------------------------------------------------------------------

describe("POST /api/agent-tokens — storage errors", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedKeyring.mockReturnValue(makeKeyringOk());
  });

  it("TokenNameTakenError → 409 NAME_TAKEN", async () => {
    mockedIssue.mockRejectedValue(new TokenNameTakenError("12345", "worker"));
    const res = await POST(
      makeRequest("POST", {
        name: "worker",
        agent_role: "drone",
        preset: "worker",
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("agent_tokens_v1_name_taken");
  });

  it("TokenLimitReachedError → 422 TOKEN_LIMIT_REACHED", async () => {
    mockedIssue.mockRejectedValue(new TokenLimitReachedError("12345", 20));
    const res = await POST(
      makeRequest("POST", {
        name: "worker",
        agent_role: "drone",
        preset: "worker",
      }),
    );
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// GET /api/agent-tokens — list
// ---------------------------------------------------------------------------

describe("GET /api/agent-tokens — list", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeAuthOk());
  });

  it("auth failure → middleware response surfaces", async () => {
    mockedAuth.mockResolvedValue(makeAuthFailure(403));
    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(403);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("empty installation → tokens: []", async () => {
    mockedList.mockResolvedValue([]);
    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tokens: [] });
  });

  it("populated installation → projects each summary to camelCase wire shape", async () => {
    const summaries: AgentTokenSummaryV1[] = [
      {
        name: "worker",
        agent_role: "drone",
        capabilities: ["agent_health.report", "tasks.claim"],
        fingerprint: "01234567",
        createdAt: "2026-04-27T10:00:00.000Z",
        createdBy: "admin",
        expiresAt: null,
        policy: {
          allowed_repos: ["hivemoot/foxstoria"],
          allowed_permissions: { contents: "read" },
        },
      },
    ];
    mockedList.mockResolvedValue(summaries);
    const res = await GET(makeRequest("GET"));
    const body = await res.json();
    expect(body.tokens[0].policy).toEqual({
      allowedRepos: ["hivemoot/foxstoria"],
      allowedPermissions: { contents: "read" },
    });
  });

  it("emits auth.success audit", async () => {
    mockedList.mockResolvedValue([]);
    await GET(makeRequest("GET"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockedAuditAppend).toHaveBeenCalled();
    const entry = mockedAuditAppend.mock.calls[0][0].entry;
    if (entry.action === "auth.success" || entry.action === "auth.failure") {
      expect(entry.endpoint).toBe("GET /api/agent-tokens");
    }
  });

  it("SECURITY: response never contains envelope ciphertext / tokenHash for any token", async () => {
    mockedList.mockResolvedValue([
      {
        name: "worker",
        agent_role: "drone",
        capabilities: ["agent_health.report"],
        fingerprint: "01234567",
        createdAt: "2026-04-27T10:00:00.000Z",
        createdBy: "admin",
        expiresAt: null,
      },
    ]);
    const res = await GET(makeRequest("GET"));
    const raw = await res.text();
    expect(raw).not.toContain("ciphertext");
    expect(raw).not.toContain("tokenHash");
  });
});
