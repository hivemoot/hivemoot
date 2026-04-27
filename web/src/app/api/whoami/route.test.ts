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

describe("POST /api/whoami → 405", () => {
  it("returns Method Not Allowed with Allow: GET", async () => {
    const res = await POST();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});
