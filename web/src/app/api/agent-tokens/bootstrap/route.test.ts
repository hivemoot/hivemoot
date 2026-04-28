/**
 * Tests for POST /api/agent-tokens/bootstrap. Phase B.1.d-iii.
 *
 * Bootstrap is the chain-root admin token endpoint: cookie auth
 * (not bearer), hardcoded admin preset, capped 24h expiry, atomic
 * audit emit (`bootstrap` action class), AWAITED auth.success
 * audit (Vercel-safe, not fire-and-forget).
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
  };
});

vi.mock("@/server/agent-token-v1-audit", () => ({
  auditAppend: vi.fn(async () => undefined),
}));

import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import {
  issueAgentToken,
  TokenNameTakenError,
} from "@/server/agent-token-v1";
import { auditAppend } from "@/server/agent-token-v1-audit";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateByokRequest);
const mockedRequireInstallation = vi.mocked(requireInstallation);
const mockedIssue = vi.mocked(issueAgentToken);
const mockedAuditAppend = vi.mocked(auditAppend);

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest("https://www.hivemoot.dev/api/agent-tokens/bootstrap", {
    method: "POST",
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

function makeIssued(name = "bootstrap-admin") {
  return {
    token: "hmt_brand_new_admin_bearer",
    name,
    agent_role: "admin",
    capabilities: ["*", "agent_tokens.manage"],
    fingerprint: "bootfp01",
    expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString(),
  };
}

beforeEach(() => {
  mockedAuth.mockReset();
  mockedRequireInstallation.mockReset();
  mockedIssue.mockReset();
  mockedAuditAppend.mockReset();
});

// ---------------------------------------------------------------------------
// Auth + installation context
// ---------------------------------------------------------------------------

describe("POST /api/agent-tokens/bootstrap — auth + installation", () => {
  it("byok auth failure → middleware response surfaces", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "byok_session_invalid" }, { status: 401 }),
    } as never);
    const res = await POST(makeRequest({ name: "bootstrap-admin" }));
    expect(res.status).toBe(401);
    expect(mockedIssue).not.toHaveBeenCalled();
  });

  it("requireInstallation failure → response surfaces", async () => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: false,
      response: NextResponse.json({ code: "missing_installation" }, { status: 400 }),
    } as never);
    const res = await POST(makeRequest({ name: "bootstrap-admin" }));
    expect(res.status).toBe(400);
    expect(mockedIssue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

describe("POST /api/agent-tokens/bootstrap — body validation", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({ ok: true, installationId: "12345" } as never);
  });

  it("missing name → 400 INVALID_NAME", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_name");
  });

  it("expiresIn longer than 24h → 400 INVALID_EXPIRES_IN", async () => {
    const res = await POST(
      makeRequest({ name: "bootstrap-admin", expiresIn: "30d" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("agent_tokens_v1_invalid_expires_in");
    expect(body.message).toMatch(/24h/);
  });

  it("expiresIn: null is treated as 'use default 24h' (bootstrap remaps the no-expiry semantic)", async () => {
    // Distinct from POST /api/agent-tokens (the regular issue endpoint)
    // where `expiresIn: null` means "no expiry". Bootstrap REQUIRES a
    // bounded expiry to limit the one-time-display exposure window —
    // operators sending null get the 24h default rather than an
    // unbounded admin token.
    mockedIssue.mockResolvedValue(makeIssued());
    const res = await POST(
      makeRequest({ name: "bootstrap-admin", expiresIn: null }),
    );
    expect(res.status).toBe(201);
    const expiresAt = mockedIssue.mock.calls[0][0].expiresAt;
    expect(expiresAt).not.toBeNull();
    const ms = new Date(expiresAt!).getTime() - Date.now();
    expect(ms).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
  });

  it("expiresIn shorter than 24h is allowed (e.g., '1h' for quick recovery)", async () => {
    mockedIssue.mockResolvedValue(makeIssued());
    const res = await POST(
      makeRequest({ name: "bootstrap-admin", expiresIn: "1h" }),
    );
    expect(res.status).toBe(201);
    // Verify storage call got the 1h-from-now expiresAt, not 24h
    const expiresAt = mockedIssue.mock.calls[0][0].expiresAt;
    expect(expiresAt).not.toBeNull();
    const ms = new Date(expiresAt!).getTime() - Date.now();
    expect(ms).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
    expect(ms).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1000);
  });

  it("default expiresIn is 24h when caller omits the field", async () => {
    mockedIssue.mockResolvedValue(makeIssued());
    await POST(makeRequest({ name: "bootstrap-admin" }));
    const expiresAt = mockedIssue.mock.calls[0][0].expiresAt;
    const ms = new Date(expiresAt!).getTime() - Date.now();
    // ~24h ± slack
    expect(ms).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("POST /api/agent-tokens/bootstrap — happy paths", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({ ok: true, installationId: "12345" } as never);
  });

  it("issues admin-preset token, returns bearer ONCE + bootstrappedBy attribution", async () => {
    mockedIssue.mockResolvedValue(makeIssued());
    const res = await POST(makeRequest({ name: "bootstrap-admin" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toBe("hmt_brand_new_admin_bearer");
    expect(body.fingerprint).toBe("bootfp01");
    expect(body.capabilities).toEqual(["*", "agent_tokens.manage"]);
    expect(body.agent_role).toBe("admin");
    expect(body.bootstrappedBy).toBe("operator-gh-login");
    expect(body.message).toMatch(/ONCE/);
    expect(body.message).toMatch(/24h/);
  });

  it("hardcodes admin preset capabilities (operator can't override)", async () => {
    mockedIssue.mockResolvedValue(makeIssued());
    await POST(
      makeRequest({
        name: "bootstrap-admin",
        // These should be IGNORED — bootstrap doesn't accept caps overrides
        capabilities: ["tasks.claim"],
        preset: "worker",
      }),
    );
    const callArgs = mockedIssue.mock.calls[0][0];
    expect(callArgs.capabilities).toEqual(["*", "agent_tokens.manage"]);
    expect(callArgs.agent_role).toBe("admin");
  });

  it("auditContext with actionOverride: 'bootstrap' (storage emits 'bootstrap' action class)", async () => {
    mockedIssue.mockResolvedValue(makeIssued());
    await POST(makeRequest({ name: "bootstrap-admin" }));
    const callArgs = mockedIssue.mock.calls[0][0];
    expect(callArgs.auditContext?.actionOverride).toBe("bootstrap");
    // Cookie auth → no bearer fingerprint to record
    expect(callArgs.auditContext?.operator.fingerprint).toBe("");
    // actor = "dashboard" per design (cookie-auth path marker)
    expect(callArgs.auditContext?.operator.name).toBe("dashboard");
    // GitHub user identity goes in detailExtras for attribution
    expect(callArgs.auditContext?.detailExtras).toEqual({
      bootstrapped_by: "operator-gh-login",
    });
  });

  it("emits AWAITED auth.success audit (Vercel suspension safety)", async () => {
    mockedIssue.mockResolvedValue(makeIssued());
    await POST(makeRequest({ name: "bootstrap-admin" }));
    // Notice: no setImmediate flush needed — audit was awaited.
    // If the implementation regresses to fire-and-forget,
    // mockedAuditAppend might still report a call here, but the
    // `await` semantic is verified by the route.ts source pattern;
    // this test pins the OBSERVABLE behavior (audit was emitted)
    // and lets the implementation comment carry the rationale.
    expect(mockedAuditAppend).toHaveBeenCalledTimes(1);
    const entry = mockedAuditAppend.mock.calls[0][0].entry;
    expect(entry.action).toBe("auth.success");
    if (entry.action === "auth.success" || entry.action === "auth.failure") {
      expect(entry.endpoint).toBe("POST /api/agent-tokens/bootstrap");
      expect(entry.fingerprint).toBe(""); // cookie auth, no bearer
      expect(entry.required_capability).toBeNull();
    }
  });

  it("createdBy = operator's GitHub login (not 'dashboard') so the envelope's attribution is human-readable", async () => {
    mockedIssue.mockResolvedValue(makeIssued());
    await POST(makeRequest({ name: "bootstrap-admin" }));
    expect(mockedIssue.mock.calls[0][0].createdBy).toBe("operator-gh-login");
  });

  it("SECURITY: response never contains envelope crypto material", async () => {
    mockedIssue.mockResolvedValue(makeIssued());
    const res = await POST(makeRequest({ name: "bootstrap-admin" }));
    const raw = await res.text();
    expect(raw).not.toContain("ciphertext");
    expect(raw).not.toContain("tokenHash");
    // The bearer string IS in the response (one-time display) but
    // its hash isn't.
  });
});

// ---------------------------------------------------------------------------
// Storage error mapping
// ---------------------------------------------------------------------------

describe("POST /api/agent-tokens/bootstrap — storage errors", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({ ok: true, installationId: "12345" } as never);
  });

  it("name conflict → 409 NAME_TAKEN (operator must pick a different name)", async () => {
    mockedIssue.mockRejectedValue(
      new TokenNameTakenError("12345", "bootstrap-admin"),
    );
    const res = await POST(makeRequest({ name: "bootstrap-admin" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("agent_tokens_v1_name_taken");
  });
});
