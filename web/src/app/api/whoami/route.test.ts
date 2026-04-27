/**
 * Tests for GET /api/whoami — agent-token introspection.
 *
 * Covers:
 *   - Unauthenticated request → 401 (delegated to middleware)
 *   - Authenticated request → 200 with the snapshot shape
 *   - lastUsedAt is read from :meta and surfaced in the response
 *   - skipLastUsedAtWrite is passed through (no side effect on
 *     the meta hash from the introspection itself)
 *   - auth.success audit event emitted to the :auth stream
 *   - POST /api/whoami → 405
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/server/agent-token-v1-auth", () => ({
  authenticateAgentRequestV1: vi.fn(),
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
    envelopeMetaKey: real.envelopeMetaKey,
  };
});

vi.mock("@/server/agent-token-v1-audit", () => ({
  auditAppend: vi.fn(async () => undefined),
}));

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { auditAppend } from "@/server/agent-token-v1-audit";
import { GET, POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedAuditAppend = vi.mocked(auditAppend);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRequest(token: string | null): NextRequest {
  const headers = new Headers();
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return new NextRequest("https://www.hivemoot.dev/api/whoami", {
    method: "GET",
    headers,
  });
}

function makeAuthOk(overrides: Partial<{
  installationId: string;
  name: string;
  agent_role: string;
  capabilities: string[];
  fingerprint: string;
  expiresAt: string | null;
  // Mirrors AgentTokenPolicy from agent-token.ts: allowed_repos is
  // required when policy is present (empty [] = reject all; field
  // absence on envelope = legacy permissive). allowed_permissions
  // is optional (V1.6+).
  policy: {
    allowed_repos: string[];
    allowed_permissions?: Record<string, "read" | "write" | "admin">;
  };
}> = {}) {
  const fakeRedis = {
    hget: vi.fn(async (_key: string, _field: string) => "2026-04-27T12:00:00.000Z"),
  };
  return {
    ok: true as const,
    installationId: overrides.installationId ?? "12345",
    name: overrides.name ?? "worker",
    agent_role: overrides.agent_role ?? "drone",
    capabilities: overrides.capabilities ?? [
      "agent_health.report",
      "tasks.claim",
    ],
    envelope: {
      ciphertext: "base64-ciphertext",
      iv: "base64-iv",
      tag: "base64-tag",
      keyVersion: "v1",
      tokenHash: "0123456789abcdef",
      fingerprint: overrides.fingerprint ?? "01234567",
      createdAt: "2026-04-27T10:00:00.000Z",
      createdBy: "operator",
      expiresAt: overrides.expiresAt ?? null,
      name: overrides.name ?? "worker",
      agent_role: overrides.agent_role ?? "drone",
      capabilities: overrides.capabilities ?? [
        "agent_health.report",
        "tasks.claim",
      ],
      ...(overrides.policy ? { policy: overrides.policy } : {}),
    },
    redis: fakeRedis as never,
  };
}

function makeAuthFailure(status = 401) {
  return {
    ok: false as const,
    response: NextResponse.json(
      { code: "agent_auth_v1_missing_bearer", message: "denied" },
      { status },
    ),
  };
}

beforeEach(() => {
  mockedAuth.mockReset();
  mockedAuditAppend.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/whoami — unauthenticated", () => {
  it("missing bearer → middleware's 401 surfaces directly", async () => {
    mockedAuth.mockResolvedValue(makeAuthFailure(401));
    const res = await GET(makeRequest(null));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/whoami — happy path", () => {
  it("returns the full snapshot shape", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    const res = await GET(makeRequest("any-bearer"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      name: "worker",
      agent_role: "drone",
      installationId: "12345",
      capabilities: ["agent_health.report", "tasks.claim"],
      fingerprint: "01234567",
      expiresAt: null,
      lastUsedAt: "2026-04-27T12:00:00.000Z",
      // Default makeAuthOk() does not set a policy — legacy / V1.5-pre
      // tokens have no policy field on the envelope, so /whoami surfaces
      // null rather than an empty object.
      policy: null,
    });
  });

  it("middleware called with requires=null + skipLastUsedAtWrite=true (snapshot has no side effects)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    await GET(makeRequest("any-bearer"));
    expect(mockedAuth).toHaveBeenCalledTimes(1);
    const opts = mockedAuth.mock.calls[0][1];
    expect(opts.requires).toBeNull();
    expect(opts.skipLastUsedAtWrite).toBe(true);
  });

  it("lastUsedAt: null when :meta has no entry yet (newly issued, never auth'd elsewhere)", async () => {
    const auth = makeAuthOk();
    (auth.redis as unknown as { hget: ReturnType<typeof vi.fn> }).hget =
      vi.fn(async () => null);
    mockedAuth.mockResolvedValue(auth);
    const res = await GET(makeRequest("any-bearer"));
    const body = await res.json();
    expect(body.lastUsedAt).toBeNull();
  });

  it("emits auth.success to :auth stream via auditAppend", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    await GET(makeRequest("any-bearer"));
    // auditAppend is fire-and-forget; allow microtask to flush
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockedAuditAppend).toHaveBeenCalledTimes(1);
    const call = mockedAuditAppend.mock.calls[0][0];
    expect(call.installationId).toBe("12345");
    expect(call.entry.action).toBe("auth.success");
    if (call.entry.action === "auth.success" || call.entry.action === "auth.failure") {
      expect(call.entry.endpoint).toBe("GET /api/whoami");
      expect(call.entry.required_capability).toBeNull();
      expect(call.entry.outcome).toBe("ok");
      // Security invariant: never log raw bearer
      expect(call.entry.fingerprint).toBe("01234567");
      expect("token" in call.entry).toBe(false);
    }
  });

  it("survives :meta read failure — lastUsedAt becomes null but response still 200", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const auth = makeAuthOk();
    (auth.redis as unknown as { hget: ReturnType<typeof vi.fn> }).hget =
      vi.fn(async () => {
        throw new Error("Redis blip");
      });
    mockedAuth.mockResolvedValue(auth);
    const res = await GET(makeRequest("any-bearer"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lastUsedAt).toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(
      "[whoami] meta read failed",
      expect.any(Error),
    );
    consoleWarn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Policy projection — V1.5 (allowedRepos) + V1.6 (allowedPermissions).
//
// Per CAPABILITIES_DESIGN.md §`/api/whoami` introspection endpoint, the
// response includes a sanitized `policy` so operators can verify token
// narrowing without having to query Redis directly.
//
// **WIRE SHAPE IS camelCase, STORAGE IS snake_case** — the handler
// translates `envelope.policy.allowed_repos` → `policy.allowedRepos`
// and `envelope.policy.allowed_permissions` → `policy.allowedPermissions`.
// Tests below assert the camelCase wire shape; the helper feeds
// snake_case (mirroring envelope storage) to exercise the translation.
//
// This describe block pins:
//   1. legacy (no policy field on envelope) → response has policy: null
//   2. V1.5 token (allowed_repos only) → response has allowedRepos,
//      no allowedPermissions key
//   3. V1.6 token (allowed_repos + allowed_permissions) → both round-trip
//      under their camelCase names
//   4. empty allowed_repos (intentional reject-all) → allowedRepos: []
//   5. SECURITY: response NEVER contains envelope ciphertext / iv /
//      tag / tokenHash / createdBy — only the sanitized projection
//   6. SECURITY: response NEVER contains the snake_case keys themselves
//      (would indicate a passthrough leak rather than projection)
//
// Note: there's no "V1.6-only" case in the type system — `policy.allowed_repos`
// is required when `policy` is present (empty array is the canonical
// reject-all). V1.6 is purely additive: it ADDS `allowed_permissions`
// to an already-mandatory `allowed_repos`.
// ---------------------------------------------------------------------------

describe("GET /api/whoami — policy projection", () => {
  it("envelope without policy field → response has policy: null", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    const res = await GET(makeRequest("any-bearer"));
    const body = await res.json();
    expect(body.policy).toBeNull();
  });

  it("V1.5 token (snake_case allowed_repos) → camelCase allowedRepos on wire, omits allowedPermissions", async () => {
    mockedAuth.mockResolvedValue(
      makeAuthOk({
        policy: { allowed_repos: ["hivemoot/foxstoria"] },
      }),
    );
    const res = await GET(makeRequest("any-bearer"));
    const body = await res.json();
    expect(body.policy).toEqual({
      allowedRepos: ["hivemoot/foxstoria"],
    });
    // Projection only copies present fields, so JSON.stringify
    // does NOT emit allowedPermissions: undefined as a wire field.
    expect("allowedPermissions" in body.policy).toBe(false);
  });

  it("V1.6 token (snake_case allowed_repos + allowed_permissions) → camelCase wire shape", async () => {
    mockedAuth.mockResolvedValue(
      makeAuthOk({
        policy: {
          allowed_repos: ["hivemoot/foxstoria", "hivemoot/colony"],
          allowed_permissions: { contents: "read", issues: "write" },
        },
      }),
    );
    const res = await GET(makeRequest("any-bearer"));
    const body = await res.json();
    expect(body.policy).toEqual({
      allowedRepos: ["hivemoot/foxstoria", "hivemoot/colony"],
      allowedPermissions: { contents: "read", issues: "write" },
    });
  });

  it("intentional reject-all (allowed_repos: []) → allowedRepos: [] on wire", async () => {
    // Per the AgentTokenPolicy doc: empty array is intentional — the
    // token is provisioned but currently denied for all mints. /whoami
    // must surface this faithfully so operators see the lockout state
    // rather than confusing it with "policy not set".
    mockedAuth.mockResolvedValue(
      makeAuthOk({
        policy: { allowed_repos: [] },
      }),
    );
    const res = await GET(makeRequest("any-bearer"));
    const body = await res.json();
    expect(body.policy).toEqual({ allowedRepos: [] });
  });

  it("SECURITY: response never contains envelope crypto material, even when policy is present", async () => {
    // Threat model: a sloppy projection (e.g. `...auth.envelope`) would
    // leak ciphertext / iv / tag / tokenHash / createdBy through /whoami.
    // Pin that the sanitized projection is the only path — by checking
    // the literal serialized response for those substrings.
    mockedAuth.mockResolvedValue(
      makeAuthOk({
        policy: {
          allowed_repos: ["hivemoot/foxstoria"],
          allowed_permissions: { contents: "read" },
        },
      }),
    );
    const res = await GET(makeRequest("any-bearer"));
    const raw = await res.text();
    expect(raw).not.toContain("ciphertext");
    expect(raw).not.toContain("base64-ciphertext");
    expect(raw).not.toContain("base64-iv");
    expect(raw).not.toContain("base64-tag");
    expect(raw).not.toContain("0123456789abcdef"); // tokenHash from envelope
    expect(raw).not.toContain("createdBy");
    expect(raw).not.toContain("operator");
    // Carry-forward from #505 guard R2 N2: complete the envelope-fields
    // blacklist. keyVersion + createdAt aren't in the projection by
    // construction, but pinning their absence catches a future refactor
    // that accidentally widens the projection.
    expect(raw).not.toContain('"keyVersion"');
    expect(raw).not.toContain('"createdAt"');
    expect(raw).not.toContain("2026-04-27T10:00:00.000Z"); // mock createdAt
    // Sanity — the legitimate (camelCase) fields ARE there
    expect(raw).toContain("allowedRepos");
    expect(raw).toContain("allowedPermissions");
    expect(raw).toContain("01234567"); // fingerprint is a legit field
  });

  it("SECURITY: response never contains snake_case storage keys (passthrough-leak detector)", async () => {
    // Belt-and-suspenders for the storage→wire rename. If anyone
    // accidentally spreads the envelope policy directly (`...policy`)
    // instead of going through the projection, the snake_case keys
    // would surface — this test fails loudly in that case.
    mockedAuth.mockResolvedValue(
      makeAuthOk({
        policy: {
          allowed_repos: ["hivemoot/foxstoria"],
          allowed_permissions: { contents: "read" },
        },
      }),
    );
    const res = await GET(makeRequest("any-bearer"));
    const raw = await res.text();
    expect(raw).not.toContain("allowed_repos");
    expect(raw).not.toContain("allowed_permissions");
  });
});

describe("POST /api/whoami → 405", () => {
  it("returns Method Not Allowed with Allow: GET", async () => {
    const res = await POST();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("uses code: method_not_allowed (not an auth error code) — drone R1 D1", async () => {
    // Wrong-verb is not wrong-credentials, so reusing
    // `agent_auth_v1_missing_bearer` would mislead clients into auth
    // retries. Pin the semantic code.
    const res = await POST();
    const body = await res.json();
    expect(body.code).toBe("method_not_allowed");
    expect(body.code).not.toMatch(/agent_auth_v1_/);
  });
});
