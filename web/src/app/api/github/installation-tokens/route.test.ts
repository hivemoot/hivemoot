import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/server/agent-token-v1-auth", () => ({
  authenticateAgentRequestV1: vi.fn(),
}));
vi.mock("@/server/github-installation-token", async () => {
  // Re-export the typed errors from the real module so tests can
  // construct realistic instances; only mint itself is mocked.
  const real = await vi.importActual<
    typeof import("@/server/github-installation-token")
  >("@/server/github-installation-token");
  return {
    ...real,
    mintInstallationToken: vi.fn(),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  mintInstallationToken,
  AppCredentialError,
  InstallationNotCoverageError,
  GitHubRateLimitedError,
  GitHubUnavailableError,
  InvalidMintRequestError,
} from "@/server/github-installation-token";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedMint = vi.mocked(mintInstallationToken);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown, opts: { json?: boolean } = {}): NextRequest {
  // Note: don't annotate as RequestInit — Next.js's spec-extension type
  // differs slightly from the DOM lib's (signal nullability), and TS
  // strict mode rejects the cross-type assignment. Inline the object.
  const reqBody = opts.json !== false ? JSON.stringify(body) : (body as BodyInit);
  return new NextRequest(
    "https://www.hivemoot.dev/api/github/installation-tokens",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: reqBody,
    },
  );
}

function authOk(
  installationId = "67890",
  policy:
    | {
        allowed_repos: string[];
        // V1.6: optional allowed_permissions narrows GitHub permission
        // scope at mint time. Tests can pass it through to exercise the
        // route's V1.6 wiring (auth.policy?.allowed_permissions →
        // mintInstallationToken's allowedPermissions param).
        allowed_permissions?: Record<string, "read" | "write" | "admin">;
      }
    | undefined = undefined,
  roleAndCaps: {
    agent_role?: string;
    capabilities?: string[];
  } = {},
) {
  const agentRole = roleAndCaps.agent_role ?? "worker";
  const capabilities = roleAndCaps.capabilities ?? ["installation_token.mint"];
  return {
    ok: true as const,
    installationId,
    name: "test-agent",
    agent_role: agentRole,
    capabilities,
    envelope: {
      // Encryption fields required by AgentTokenEnvelopeV1 type even
      // though tests don't decrypt — vitest hoisted-mock would also
      // accept `as never`, but explicit stubs survive strict tsc in CI.
      ciphertext: "stub-ct",
      iv: "stub-iv",
      tag: "stub-tag",
      keyVersion: "v1",
      tokenHash: "stub",
      fingerprint: "stub0001",
      createdAt: "2026-04-30T00:00:00Z",
      createdBy: "test",
      expiresAt: null,
      name: "test-agent",
      agent_role: agentRole,
      capabilities,
      ...(policy ? { policy } : {}),
    },
    redis: {} as never,
  };
}

const LOCAL_QUEEN_MERGE_POLICY = {
  allowed_repos: ["owner/repo"],
  allowed_permissions: {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    metadata: "read",
  },
} satisfies {
  allowed_repos: string[];
  allowed_permissions: Record<string, "read" | "write" | "admin">;
};

function authFailure(status = 401, code = "agent_health_not_authenticated") {
  return {
    ok: false as const,
    response: NextResponse.json({ code, message: "denied" }, { status }),
  };
}

function successMint(
  overrides: Partial<{
    token: string;
    expires_at: string;
    installation_id: string;
    permissions: Record<string, string>;
    repositories: Array<{ full_name: string; id: number }>;
    hashed_token: string;
  }> = {},
) {
  return {
    token: "ghs_e2e_test_token",
    expires_at: "2026-04-25T19:30:00Z",
    installation_id: "67890",
    permissions: {
      contents: "read",
      pull_requests: "write",
      issues: "write",
      metadata: "read",
    },
    repositories: [{ full_name: "owner/repo", id: 12345 }],
    hashed_token: "FAKE_BASE64_SHA256_HASH=",
    ...overrides,
  };
}

// Stash original env so per-test mutations don't bleed.
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  mockedAuth.mockReset();
  mockedMint.mockReset();
  // Provide minimum env so server-misconfig branch doesn't fire.
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_APP_PRIVATE_KEY = "fake-pem";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// Auth (runs first — must reject before body inspection)
// ---------------------------------------------------------------------------

describe("POST /api/github/installation-tokens — auth", () => {
  it("returns 401 when bearer auth fails", async () => {
    mockedAuth.mockResolvedValue(authFailure());

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(401);
    expect(mockedMint).not.toHaveBeenCalled();
  });

  it("authenticates BEFORE inspecting body — bad auth + bad body yields 401", async () => {
    mockedAuth.mockResolvedValue(authFailure());

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

describe("POST /api/github/installation-tokens — body validation", () => {
  it("returns 400 when body is malformed JSON", async () => {
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(makeRequest("not-json", { json: false }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_request");
    expect(mockedMint).not.toHaveBeenCalled();
  });

  it("returns 400 when repo field is missing", async () => {
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(400);
  });

  it("returns 400 when repo field is empty / whitespace", async () => {
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(makeRequest({ repo: "   " }));

    expect(res.status).toBe(400);
  });

  it("returns 400 when repo field is wrong type", async () => {
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(makeRequest({ repo: 12345 }));

    expect(res.status).toBe(400);
  });

  it("trims surrounding whitespace from repo before passing to mint", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockResolvedValue(successMint());

    await POST(makeRequest({ repo: "  owner/repo  " }));

    expect(mockedMint).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "owner/repo" }),
    );
  });

  it("rejects 400 when agent_id is the wrong type", async () => {
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(
      makeRequest({ repo: "owner/repo", agent_id: 12345 }),
    );

    expect(res.status).toBe(400);
  });

  it("accepts optional agent_id field as a string", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockResolvedValue(successMint());

    const res = await POST(
      makeRequest({ repo: "owner/repo", agent_id: "builder-claude" }),
    );

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Server-config gate
// ---------------------------------------------------------------------------

describe("POST /api/github/installation-tokens — server config", () => {
  it("returns 503 when GITHUB_APP_ID env is missing", async () => {
    delete process.env.GITHUB_APP_ID;
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("server_misconfiguration");
    expect(mockedMint).not.toHaveBeenCalled();
  });

  it("returns 503 when GITHUB_APP_PRIVATE_KEY env is missing", async () => {
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Token-policy enforcement (V1.5)
// ---------------------------------------------------------------------------

describe("POST /api/github/installation-tokens — token-policy enforcement", () => {
  it("rejects 403 with policy_violation when repo not in allowed_repos", async () => {
    mockedAuth.mockResolvedValue(
      authOk("67890", { allowed_repos: ["other-owner/other-repo"] }),
    );

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("policy_violation");
    expect(body.message).toContain("owner/repo");
    expect(body.message).toMatch(/allowed_repos/);
    expect(mockedMint).not.toHaveBeenCalled();
  });

  it("proceeds with mint when repo IS in allowed_repos", async () => {
    mockedAuth.mockResolvedValue(
      authOk("67890", { allowed_repos: ["owner/repo", "another/repo"] }),
    );
    mockedMint.mockResolvedValue(successMint());

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(200);
    expect(mockedMint).toHaveBeenCalledTimes(1);
  });

  it("rejects 403 when policy.allowed_repos is empty (intentional reject-all)", async () => {
    // Empty array distinguishes from `undefined` (legacy permissive).
    // Operator deliberately set "no repos" to disable minting on this
    // token without revoking it.
    mockedAuth.mockResolvedValue(authOk("67890", { allowed_repos: [] }));

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("policy_violation");
  });

  it("legacy token (policy: undefined) is permissive — mint proceeds", async () => {
    // Pre-V1.5 tokens have no policy field on the envelope. They MUST
    // continue working (legacy-permissive) so existing agents don't
    // break on V1.5 ship. The route logs a console.warn pointing at
    // setAgentTokenPolicy as the remediation.
    mockedAuth.mockResolvedValue(authOk("67890", undefined));
    mockedMint.mockResolvedValue(successMint());

    const res = await POST(makeRequest({ repo: "any/repo" }));

    expect(res.status).toBe(200);
    expect(mockedMint).toHaveBeenCalledTimes(1);
  });

  it("policy check runs BEFORE env validation — wrong env still rejects on policy", async () => {
    // Defense-in-depth ordering: policy violation rejects before we
    // leak any signal about server config (env-missing → 503).
    delete process.env.GITHUB_APP_ID;
    mockedAuth.mockResolvedValue(
      authOk("67890", { allowed_repos: ["other/repo"] }),
    );

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("policy_violation");
    // NOT 503 server_misconfiguration — caller doesn't get to
    // distinguish based on a request they're not authorized to make.
  });
});

// ---------------------------------------------------------------------------
// Mint success
// ---------------------------------------------------------------------------

describe("POST /api/github/installation-tokens — happy path", () => {
  it("returns 200 with the mint response", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockResolvedValue(successMint());

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe("ghs_e2e_test_token");
    expect(body.expires_at).toBe("2026-04-25T19:30:00Z");
    expect(body.installation_id).toBe("67890");
    expect(body.permissions).toEqual({
      contents: "read",
      pull_requests: "write",
      issues: "write",
      metadata: "read",
    });
    expect(body.repositories).toEqual([{ full_name: "owner/repo", id: 12345 }]);
    expect(body.hashed_token).toBe("FAKE_BASE64_SHA256_HASH=");
  });

  it("passes installation_id from auth + repo from body to mintInstallationToken", async () => {
    mockedAuth.mockResolvedValue(authOk("99999"));
    mockedMint.mockResolvedValue(successMint());

    await POST(makeRequest({ repo: "hivemoot/hivemoot" }));

    expect(mockedMint).toHaveBeenCalledWith({
      installationId: "99999",
      repo: "hivemoot/hivemoot",
      appId: "12345",
      appPrivateKeyPem: "fake-pem",
    });
  });

  it("uses merge-capable ceiling when bearer has pull_requests.merge", async () => {
    mockedAuth.mockResolvedValue(
      authOk("99999", LOCAL_QUEEN_MERGE_POLICY, {
        agent_role: "local_queen",
        capabilities: [
          "installation_token.mint",
          "pull_requests.merge",
        ],
      }),
    );
    mockedMint.mockResolvedValue(
      successMint({
        permissions: {
          contents: "write",
          pull_requests: "write",
          issues: "write",
          metadata: "read",
        },
      }),
    );

    await POST(makeRequest({ repo: "owner/repo" }));

    expect(mockedMint).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "99999",
        repo: "owner/repo",
        allowedPermissions: LOCAL_QUEEN_MERGE_POLICY.allowed_permissions,
        permissionCeiling: LOCAL_QUEEN_MERGE_POLICY.allowed_permissions,
      }),
    );
  });

  it("rejects pull_requests.merge without matching local queen policy", async () => {
    mockedAuth.mockResolvedValue(
      authOk("99999", { allowed_repos: ["owner/repo"] }, {
        agent_role: "local_queen",
        capabilities: [
          "installation_token.mint",
          "pull_requests.merge",
        ],
      }),
    );

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(403);
    expect((await res.json()).message).toMatch(/pull_requests\.merge/);
    expect(mockedMint).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Mint error mapping
// ---------------------------------------------------------------------------

describe("POST /api/github/installation-tokens — mint error mapping", () => {
  it("InstallationNotCoverageError → 403 with structured envelope", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockRejectedValue(new InstallationNotCoverageError("owner/repo"));

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("installation_not_coverage");
    expect(body.message).toContain("owner/repo");
  });

  it("GitHubRateLimitedError → 429", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockRejectedValue(new GitHubRateLimitedError());

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("github_rate_limited");
  });

  it("AppCredentialError → 503 (server misconfig)", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockRejectedValue(new AppCredentialError("Bad credentials"));

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("app_credential_invalid");
  });

  it("GitHubUnavailableError → 502", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockRejectedValue(new GitHubUnavailableError("HTTP 503"));

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("github_unavailable");
  });

  it("InvalidMintRequestError → 400", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockRejectedValue(new InvalidMintRequestError("malformed"));

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(400);
  });

  it("unexpected non-MintError → 500 (caught + logged, not leaked)", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockRejectedValue(new Error("totally unexpected"));

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal_error");
    // Critically: the unexpected error message is NOT echoed in the response,
    // only logged. Backend doesn't leak internals to apiarist.
    expect(body.message).not.toContain("totally unexpected");
  });
});

// ---------------------------------------------------------------------------
// V1.6 — allowed_permissions wiring (closes guard G2)
// ---------------------------------------------------------------------------
//
// These tests close the gap between the unit tests on intersectPermissions
// and the actual route. They assert that the route forwards
// auth.policy.allowed_permissions into mintInstallationToken's
// allowedPermissions param, and that the audit log surfaces the right
// signals (policyHasAllowedPermissions + scopeReduced).

describe("POST /api/github/installation-tokens — V1.6 allowed_permissions wiring", () => {
  beforeEach(() => {
    mockedAuth.mockClear();
    mockedMint.mockClear();
  });

  it("V1.5 path: no allowed_permissions on policy → mint called WITHOUT allowedPermissions", async () => {
    mockedAuth.mockResolvedValue(
      authOk("67890", { allowed_repos: ["owner/repo"] }),
    );
    mockedMint.mockResolvedValue(successMint());

    await POST(makeRequest({ repo: "owner/repo" }));

    expect(mockedMint).toHaveBeenCalledTimes(1);
    const call = mockedMint.mock.calls[0][0];
    expect(call.allowedPermissions).toBeUndefined();
  });

  it("V1.6 path: allowed_permissions on policy → forwarded to mint as allowedPermissions", async () => {
    const readOnly = {
      contents: "read" as const,
      pull_requests: "read" as const,
      issues: "read" as const,
      metadata: "read" as const,
    };
    mockedAuth.mockResolvedValue(
      authOk("67890", {
        allowed_repos: ["owner/repo"],
        allowed_permissions: readOnly,
      }),
    );
    mockedMint.mockResolvedValue(
      successMint({ permissions: readOnly }),
    );

    await POST(makeRequest({ repo: "owner/repo" }));

    expect(mockedMint).toHaveBeenCalledTimes(1);
    const call = mockedMint.mock.calls[0][0];
    expect(call.allowedPermissions).toEqual(readOnly);
  });

  it("audit log: policyHasAllowedPermissions=false when policy.allowed_permissions undefined", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    mockedAuth.mockResolvedValue(
      authOk("67890", { allowed_repos: ["owner/repo"] }),
    );
    mockedMint.mockResolvedValue(successMint());

    await POST(makeRequest({ repo: "owner/repo" }));

    expect(consoleLog).toHaveBeenCalledWith(
      "[installation-tokens] minted",
      expect.objectContaining({ policyHasAllowedPermissions: false }),
    );
    consoleLog.mockRestore();
  });

  it("audit log: policyHasAllowedPermissions=true AND scopeReduced=true when narrowing actually applied", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    mockedAuth.mockResolvedValue(
      authOk("67890", {
        allowed_repos: ["owner/repo"],
        allowed_permissions: { pull_requests: "read" },
      }),
    );
    // Mocked mint returns the narrowed scope (pull_requests=read instead
    // of write). Real intersectPermissions runs in the unit-test suite.
    mockedMint.mockResolvedValue(
      successMint({
        permissions: {
          contents: "read",
          pull_requests: "read",   // narrowed
          issues: "write",
          metadata: "read",
        },
      }),
    );

    await POST(makeRequest({ repo: "owner/repo" }));

    expect(consoleLog).toHaveBeenCalledWith(
      "[installation-tokens] minted",
      expect.objectContaining({
        policyHasAllowedPermissions: true,
        scopeReduced: true,
      }),
    );
    consoleLog.mockRestore();
  });

  it("audit log: scopeReduced=false when policy is set but matches V1_PERMISSIONS exactly (no-op narrowing)", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    // Policy "narrows" to exactly the same scope as V1_PERMISSIONS.
    // policyHasAllowedPermissions=true (operator did configure it), but
    // scopeReduced=false (no actual reduction happened) — distinct signals.
    mockedAuth.mockResolvedValue(
      authOk("67890", {
        allowed_repos: ["owner/repo"],
        allowed_permissions: {
          contents: "read",
          pull_requests: "write",
          issues: "write",
          metadata: "read",
        },
      }),
    );
    mockedMint.mockResolvedValue(successMint());

    await POST(makeRequest({ repo: "owner/repo" }));

    expect(consoleLog).toHaveBeenCalledWith(
      "[installation-tokens] minted",
      expect.objectContaining({
        policyHasAllowedPermissions: true,
        scopeReduced: false,
      }),
    );
    consoleLog.mockRestore();
  });

  it("audit log: scopeReduced=false when GitHub returns V1_PERMISSIONS in DIFFERENT KEY ORDER (regression on guard G3-R2)", async () => {
    // R2 follow-up regression: prior implementation used
    // JSON.stringify(...)===JSON.stringify(...), which is
    // order-sensitive. GitHub may emit permissions in different
    // key order than V1_PERMISSIONS declares; without
    // order-insensitive comparison the audit log would falsely
    // report scopeReduced=true on a no-op narrowing.
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    mockedAuth.mockResolvedValue(
      authOk("67890", { allowed_repos: ["owner/repo"] }),
    );
    // Same permissions as V1_PERMISSIONS, intentionally rearranged
    // (issues + pull_requests + metadata + contents instead of the
    // canonical contents/pull_requests/issues/metadata).
    mockedMint.mockResolvedValue(
      successMint({
        permissions: {
          issues: "write",
          pull_requests: "write",
          metadata: "read",
          contents: "read",
        },
      }),
    );

    await POST(makeRequest({ repo: "owner/repo" }));

    expect(consoleLog).toHaveBeenCalledWith(
      "[installation-tokens] minted",
      expect.objectContaining({ scopeReduced: false }),
    );
    consoleLog.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// permissionsEqual unit tests
// ---------------------------------------------------------------------------

import { permissionsEqual } from "./route";

describe("permissionsEqual (route helper)", () => {
  it("identical maps in identical order → true", () => {
    expect(
      permissionsEqual(
        { contents: "read", pull_requests: "write" },
        { contents: "read", pull_requests: "write" },
      ),
    ).toBe(true);
  });

  it("same keys + values, DIFFERENT insertion order → true (order-insensitive)", () => {
    expect(
      permissionsEqual(
        { contents: "read", pull_requests: "write" },
        { pull_requests: "write", contents: "read" },
      ),
    ).toBe(true);
  });

  it("same keys, ONE differing value → false", () => {
    expect(
      permissionsEqual(
        { contents: "read", pull_requests: "write" },
        { contents: "read", pull_requests: "read" },
      ),
    ).toBe(false);
  });

  it("a has extra key → false", () => {
    expect(
      permissionsEqual(
        { contents: "read", pull_requests: "write" },
        { contents: "read" },
      ),
    ).toBe(false);
  });

  it("b has extra key → false", () => {
    expect(
      permissionsEqual(
        { contents: "read" },
        { contents: "read", pull_requests: "write" },
      ),
    ).toBe(false);
  });

  it("both empty → true", () => {
    expect(permissionsEqual({}, {})).toBe(true);
  });

  it("prototype member name on b doesn't false-positive", () => {
    // Defense against a's key matching Object.prototype member name
    // that could exist on b's prototype chain (toString etc.).
    expect(
      permissionsEqual(
        { contents: "read", toString: "read" },
        { contents: "read" },
      ),
    ).toBe(false);
  });
});
