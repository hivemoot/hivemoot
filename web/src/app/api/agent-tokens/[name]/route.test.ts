/**
 * Tests for GET /api/agent-tokens/{name} (show) and
 * DELETE /api/agent-tokens/{name} (revoke). Phase B.1.d-ii.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

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
    getAgentTokenSummary: vi.fn(),
    revokeAgentToken: vi.fn(),
  };
});

vi.mock("@/server/agent-token-v1-audit", () => ({
  auditAppend: vi.fn(async () => undefined),
}));

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  getAgentTokenSummary,
  revokeAgentToken,
  TokenNotFoundError,
} from "@/server/agent-token-v1";
import { auditAppend } from "@/server/agent-token-v1-audit";
import { GET, DELETE } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedShow = vi.mocked(getAgentTokenSummary);
const mockedRevoke = vi.mocked(revokeAgentToken);
const mockedAuditAppend = vi.mocked(auditAppend);

function makeRequest(method: "GET" | "DELETE"): NextRequest {
  return new NextRequest("https://www.hivemoot.dev/api/agent-tokens/worker", {
    method,
    headers: { authorization: "Bearer hmt_admin" },
  });
}

function makeAuthOk(overrides: { name?: string } = {}) {
  return {
    ok: true as const,
    installationId: "12345",
    name: overrides.name ?? "admin",
    agent_role: "admin",
    capabilities: ["agent_tokens.manage"],
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
      capabilities: ["agent_tokens.manage"],
    },
    redis: {} as never,
  };
}

function makeAuthFailure(status = 401) {
  return {
    ok: false as const,
    response: NextResponse.json({ code: "denied" }, { status }),
  };
}

function makeContext(name: string) {
  return { params: Promise.resolve({ name }) };
}

beforeEach(() => {
  mockedAuth.mockReset();
  mockedShow.mockReset();
  mockedRevoke.mockReset();
  mockedAuditAppend.mockReset();
});

// ---------------------------------------------------------------------------
// GET /api/agent-tokens/{name}
// ---------------------------------------------------------------------------

describe("GET /api/agent-tokens/{name}", () => {
  it("invalid name format → 400 INVALID_NAME (path validation)", async () => {
    // Should not even reach auth — boundary validation first.
    const res = await GET(makeRequest("GET"), makeContext("Worker!"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_name");
    expect(mockedAuth).not.toHaveBeenCalled();
  });

  it("auth failure → middleware response surfaces", async () => {
    mockedAuth.mockResolvedValue(makeAuthFailure(403));
    const res = await GET(makeRequest("GET"), makeContext("worker"));
    expect(res.status).toBe(403);
    expect(mockedShow).not.toHaveBeenCalled();
  });

  it("happy path → 200 with camelCase wire-shape summary", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedShow.mockResolvedValue({
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
    });
    const res = await GET(makeRequest("GET"), makeContext("worker"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("worker");
    expect(body.policy).toEqual({
      allowedRepos: ["hivemoot/foxstoria"],
      allowedPermissions: { contents: "read" },
    });
  });

  it("token not found → 404 TOKEN_NOT_FOUND with name", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedShow.mockRejectedValue(new TokenNotFoundError("12345", "missing"));
    const res = await GET(makeRequest("GET"), makeContext("missing"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("agent_tokens_v1_token_not_found");
    expect(body.name).toBe("missing");
  });

  it("emits auth.success audit", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedShow.mockResolvedValue({
      name: "worker",
      agent_role: "drone",
      capabilities: ["tasks.claim"],
      fingerprint: "01234567",
      createdAt: "2026-04-27T10:00:00.000Z",
      createdBy: "admin",
      expiresAt: null,
    });
    await GET(makeRequest("GET"), makeContext("worker"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockedAuditAppend).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/agent-tokens/{name}
// ---------------------------------------------------------------------------

describe("DELETE /api/agent-tokens/{name}", () => {
  it("auth failure → middleware response surfaces", async () => {
    mockedAuth.mockResolvedValue(makeAuthFailure(403));
    const res = await DELETE(makeRequest("DELETE"), makeContext("worker"));
    expect(res.status).toBe(403);
    expect(mockedRevoke).not.toHaveBeenCalled();
  });

  it("self-revoke (auth.name === path name) → 409 SELF_OP_REFUSED", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk({ name: "self-admin" }));
    const res = await DELETE(makeRequest("DELETE"), makeContext("self-admin"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("agent_tokens_v1_self_op_refused");
    expect(mockedRevoke).not.toHaveBeenCalled();
  });

  it("happy path → 200 { revoked: true, name }", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedRevoke.mockResolvedValue(true);
    const res = await DELETE(makeRequest("DELETE"), makeContext("worker"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true, name: "worker" });
  });

  it("idempotent revoke (already gone) → 404 TOKEN_NOT_FOUND with name", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedRevoke.mockResolvedValue(false);
    const res = await DELETE(makeRequest("DELETE"), makeContext("worker"));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("agent_tokens_v1_token_not_found");
  });

  it("auditContext passed to storage with operator identity (storage builds entry)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedRevoke.mockResolvedValue(true);
    await DELETE(makeRequest("DELETE"), makeContext("worker"));
    const callArgs = mockedRevoke.mock.calls[0][0];
    expect(callArgs.auditContext).toBeDefined();
    expect(callArgs.auditContext?.operator.fingerprint).toBe("deadbeef");
    expect(callArgs.auditContext?.operator.name).toBe("admin");
  });

  it("emits auth.success audit", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedRevoke.mockResolvedValue(true);
    await DELETE(makeRequest("DELETE"), makeContext("worker"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockedAuditAppend).toHaveBeenCalled();
    const entry = mockedAuditAppend.mock.calls[0][0].entry;
    if (entry.action === "auth.success" || entry.action === "auth.failure") {
      expect(entry.endpoint).toBe("DELETE /api/agent-tokens/{name}");
    }
  });
});
