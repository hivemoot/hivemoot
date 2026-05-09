/**
 * Tests for POST /api/agent-tokens/{name}/set-capabilities.
 * Phase B.1.d-ii.
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
    setAgentTokenCapabilities: vi.fn(),
  };
});

vi.mock("@/server/agent-token-v1-audit", () => ({
  auditAppend: vi.fn(async () => undefined),
}));

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  setAgentTokenCapabilities,
  TokenNotFoundError,
  TokenExpiredForMutationError,
} from "@/server/agent-token-v1";
import { auditAppend } from "@/server/agent-token-v1-audit";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedSet = vi.mocked(setAgentTokenCapabilities);
const mockedAuditAppend = vi.mocked(auditAppend);

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest(
    "https://www.hivemoot.dev/api/agent-tokens/worker/set-capabilities",
    {
      method: "POST",
      headers: {
        authorization: "Bearer hmt_admin",
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  );
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

function makeContext(name: string) {
  return { params: Promise.resolve({ name }) };
}

beforeEach(() => {
  mockedAuth.mockReset();
  mockedSet.mockReset();
  mockedAuditAppend.mockReset();
});

describe("POST /api/agent-tokens/{name}/set-capabilities", () => {
  it("auth failure → middleware response surfaces", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "denied" }, { status: 403 }),
    });
    const res = await POST(
      makeRequest({ capabilities: ["tasks.claim"] }),
      makeContext("worker"),
    );
    expect(res.status).toBe(403);
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("self-modify → 409 SELF_OP_REFUSED", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk({ name: "self-admin" }));
    const res = await POST(
      makeRequest({ capabilities: ["tasks.claim"] }),
      makeContext("self-admin"),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("agent_tokens_v1_self_op_refused");
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("missing both preset + capabilities → 400", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    const res = await POST(makeRequest({}), makeContext("worker"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_capabilities");
  });

  it("preset 'monitoring' → replaces caps with monitoring's bundle", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    // Monitoring preset includes rooms.read_all (added in #517 R2 for
    // installation-wide room listing — workers stay on rooms.read).
    const monitoringCaps = [
      "agent_health.read",
      "tasks.read",
      "rooms.read",
      "rooms.read_all",
    ];
    mockedSet.mockResolvedValue({
      name: "worker",
      agent_role: "drone",
      capabilities: monitoringCaps,
      fingerprint: "01234567",
      createdAt: "2026-04-27T10:00:00.000Z",
      createdBy: "admin",
      expiresAt: null,
    });
    const res = await POST(
      makeRequest({ preset: "monitoring" }),
      makeContext("worker"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token.capabilities).toEqual(monitoringCaps);
    expect(mockedSet.mock.calls[0][0].capabilities).toEqual(monitoringCaps);
  });

  it("explicit capabilities → 200 with same list back", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedSet.mockResolvedValue({
      name: "worker",
      agent_role: "drone",
      capabilities: ["agent_health.report", "rooms.read"],
      fingerprint: "01234567",
      createdAt: "2026-04-27T10:00:00.000Z",
      createdBy: "admin",
      expiresAt: null,
    });
    const res = await POST(
      makeRequest({ capabilities: ["agent_health.report", "rooms.read"] }),
      makeContext("worker"),
    );
    expect(res.status).toBe(200);
  });

  it("auditContext passed with operator identity (storage builds entry from locked state, B3)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedSet.mockResolvedValue({
      name: "worker",
      agent_role: "drone",
      capabilities: ["tasks.claim", "rooms.read"],
      fingerprint: "01234567",
      createdAt: "2026-04-27T10:00:00.000Z",
      createdBy: "admin",
      expiresAt: null,
    });
    await POST(
      makeRequest({ capabilities: ["tasks.claim", "rooms.read"] }),
      makeContext("worker"),
    );
    const callArgs = mockedSet.mock.calls[0][0];
    // Endpoint passes ONLY operator identity. The `from` list is
    // built INSIDE the storage layer using the locked envelope state
    // (closes #506 builder R1 #3 — pre-read race window eliminated).
    expect(callArgs.auditContext).toBeDefined();
    expect(callArgs.auditContext?.operator.fingerprint).toBe("deadbeef");
    expect(callArgs.auditContext?.operator.name).toBe("admin");
  });

  it("token not found → 404 TOKEN_NOT_FOUND", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedSet.mockRejectedValue(new TokenNotFoundError("12345", "missing"));
    const res = await POST(
      makeRequest({ capabilities: ["tasks.claim"] }),
      makeContext("missing"),
    );
    expect(res.status).toBe(404);
  });

  it("expired-target mutation → 410 TOKEN_EXPIRED_FOR_MUTATION (B1)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedSet.mockRejectedValue(
      new TokenExpiredForMutationError(
        "12345",
        "old-worker",
        "2026-04-26T00:00:00.000Z",
      ),
    );
    const res = await POST(
      makeRequest({ capabilities: ["tasks.claim"] }),
      makeContext("old-worker"),
    );
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.code).toBe("agent_tokens_v1_token_expired_for_mutation");
    expect(body.expiredAt).toBe("2026-04-26T00:00:00.000Z");
  });

  it("bare '*' without allowWildcards → 400 WILDCARD_NOT_ALLOWED", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    const res = await POST(
      makeRequest({ capabilities: ["*"] }),
      makeContext("worker"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_wildcard_not_allowed");
  });

  it("emits auth.success audit on success", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedSet.mockResolvedValue({
      name: "worker",
      agent_role: "drone",
      capabilities: ["tasks.claim", "rooms.read"],
      fingerprint: "01234567",
      createdAt: "2026-04-27T10:00:00.000Z",
      createdBy: "admin",
      expiresAt: null,
    });
    await POST(
      makeRequest({ capabilities: ["tasks.claim", "rooms.read"] }),
      makeContext("worker"),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const entry = mockedAuditAppend.mock.calls[0][0].entry;
    if (entry.action === "auth.success" || entry.action === "auth.failure") {
      expect(entry.endpoint).toBe(
        "POST /api/agent-tokens/{name}/set-capabilities",
      );
    }
  });

  // PR 645 builder pass-1 B1 — refuse to transition tokens to a
  // mint-capable shape via set-capabilities. set-capabilities does
  // not accept a policy field, so transitioning to mint without a
  // pre-existing policy.allowedRepos would create the same gap the
  // issue-time gate closes. Operators must issue a NEW token with
  // policy + revoke the old one.

  it("set preset 'local_queen' → 400 (mint-capable transition refused)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    const res = await POST(
      makeRequest({ preset: "local_queen" }),
      makeContext("worker"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("agent_tokens_v1_invalid_capabilities");
    expect(body.message).toMatch(/mint-capable shape/);
    expect(body.message).toMatch(/policy\.allowedRepos/);
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("set explicit caps including installation_token.mint → 400 (label-laundering attempt)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    const res = await POST(
      makeRequest({
        capabilities: ["installation_token.mint", "rooms.read"],
      }),
      makeContext("worker"),
    );
    expect(res.status).toBe(400);
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("set preset 'apiarist' → falls through to set (legacy carve-out)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedSet.mockResolvedValue({
      name: "ap-1",
      agent_role: "apiarist",
      capabilities: ["installation_token.mint"],
      fingerprint: "f1",
      createdAt: "2026-04-27T10:00:00.000Z",
      createdBy: "admin",
      expiresAt: null,
    });
    const res = await POST(
      makeRequest({ preset: "apiarist" }),
      makeContext("worker"),
    );
    expect(res.status).toBe(200);
    expect(mockedSet).toHaveBeenCalled();
  });
});
