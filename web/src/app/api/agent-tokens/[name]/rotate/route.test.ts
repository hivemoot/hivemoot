/**
 * Tests for POST /api/agent-tokens/{name}/rotate. Phase B.1.d-ii.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

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
    rotateAgentToken: vi.fn(),
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
  rotateAgentToken,
  TokenNotFoundError,
  TokenExpiredForMutationError,
} from "@/server/agent-token-v1";
import { auditAppend } from "@/server/agent-token-v1-audit";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedKeyring = vi.mocked(loadV1MintKeyring);
const mockedRotate = vi.mocked(rotateAgentToken);
const mockedAuditAppend = vi.mocked(auditAppend);

function makeRequest(): NextRequest {
  return new NextRequest(
    "https://www.hivemoot.dev/api/agent-tokens/worker/rotate",
    {
      method: "POST",
      headers: { authorization: "Bearer hmt_admin" },
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

function makeKeyringOk() {
  return {
    ok: true as const,
    keyring: new Map<string, Buffer>([["v1", Buffer.alloc(32)]]),
    keyVersion: "v1",
  };
}

function makeContext(name: string) {
  return { params: Promise.resolve({ name }) };
}

beforeEach(() => {
  mockedAuth.mockReset();
  mockedKeyring.mockReset();
  mockedRotate.mockReset();
  mockedAuditAppend.mockReset();
});

describe("POST /api/agent-tokens/{name}/rotate", () => {
  it("auth failure → middleware response surfaces", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "denied" }, { status: 403 }),
    });
    const res = await POST(makeRequest(), makeContext("worker"));
    expect(res.status).toBe(403);
    expect(mockedRotate).not.toHaveBeenCalled();
  });

  it("self-rotate → 409 SELF_OP_REFUSED", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk({ name: "self-admin" }));
    const res = await POST(makeRequest(), makeContext("self-admin"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("agent_tokens_v1_self_op_refused");
    expect(mockedRotate).not.toHaveBeenCalled();
  });

  it("keyring misconfigured → 503 surfaces", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedKeyring.mockReturnValue({
      ok: false,
      response: NextResponse.json(
        { code: "agent_auth_v1_server_misconfiguration" },
        { status: 503 },
      ),
    });
    const res = await POST(makeRequest(), makeContext("worker"));
    expect(res.status).toBe(503);
    expect(mockedRotate).not.toHaveBeenCalled();
  });

  it("happy path → 200 with new bearer + same caps + ONCE message", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedKeyring.mockReturnValue(makeKeyringOk());
    mockedRotate.mockResolvedValue({
      token: "hmt_rotated_bearer",
      name: "worker",
      agent_role: "drone",
      capabilities: ["agent_health.report", "tasks.claim"],
      fingerprint: "newfp001",
      expiresAt: "2026-05-27T10:00:00.000Z",
    });
    const res = await POST(makeRequest(), makeContext("worker"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe("hmt_rotated_bearer");
    expect(body.fingerprint).toBe("newfp001");
    expect(body.capabilities).toEqual(["agent_health.report", "tasks.claim"]);
    expect(body.message).toMatch(/ONCE/);
    expect(body.message).toMatch(/Old bearer is already invalid/);
  });

  it("auditContext passed with operator identity (storage builds entry with old + new fingerprints)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedKeyring.mockReturnValue(makeKeyringOk());
    mockedRotate.mockResolvedValue({
      token: "hmt_rotated",
      name: "worker",
      agent_role: "drone",
      capabilities: ["tasks.claim"],
      fingerprint: "newfp001",
      expiresAt: null,
    });
    await POST(makeRequest(), makeContext("worker"));
    const callArgs = mockedRotate.mock.calls[0][0];
    expect(callArgs.auditContext).toBeDefined();
    expect(callArgs.auditContext?.operator.fingerprint).toBe("deadbeef");
    expect(callArgs.auditContext?.operator.name).toBe("admin");
    // Storage builds the entry with detail.fingerprint_old +
    // fingerprint_new from the locked envelope state.
  });

  it("rotate response surfaces preserved policy (B2 regression)", async () => {
    // Closes #506 builder R1 #2: previously rotate always returned
    // policy: null, falsely advertising policy-narrowed tokens as
    // legacy-permissive. Storage now round-trips policy on
    // IssuedAgentTokenV1 from the existing envelope.
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedKeyring.mockReturnValue(makeKeyringOk());
    mockedRotate.mockResolvedValue({
      token: "hmt_rotated",
      name: "worker",
      agent_role: "drone",
      capabilities: ["tasks.claim"],
      fingerprint: "newfp001",
      expiresAt: null,
      policy: {
        allowed_repos: ["hivemoot/foxstoria"],
        allowed_permissions: { contents: "read" },
      },
    });
    const res = await POST(makeRequest(), makeContext("worker"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy).toEqual({
      allowedRepos: ["hivemoot/foxstoria"],
      allowedPermissions: { contents: "read" },
    });
  });

  it("rotate response policy: null when token genuinely has no policy", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedKeyring.mockReturnValue(makeKeyringOk());
    mockedRotate.mockResolvedValue({
      token: "hmt_rotated",
      name: "worker",
      agent_role: "drone",
      capabilities: ["tasks.claim"],
      fingerprint: "newfp001",
      expiresAt: null,
      // no policy field
    });
    const res = await POST(makeRequest(), makeContext("worker"));
    const body = await res.json();
    expect(body.policy).toBeNull();
  });

  it("expired-target rotate → 410 TOKEN_EXPIRED_FOR_MUTATION (B1)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedKeyring.mockReturnValue(makeKeyringOk());
    mockedRotate.mockRejectedValue(
      new TokenExpiredForMutationError(
        "12345",
        "old-worker",
        "2026-04-26T00:00:00.000Z",
      ),
    );
    const res = await POST(makeRequest(), makeContext("old-worker"));
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.code).toBe("agent_tokens_v1_token_expired_for_mutation");
    expect(body.expiredAt).toBe("2026-04-26T00:00:00.000Z");
  });

  it("token not found → 404 TOKEN_NOT_FOUND", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedKeyring.mockReturnValue(makeKeyringOk());
    mockedRotate.mockRejectedValue(new TokenNotFoundError("12345", "missing"));
    const res = await POST(makeRequest(), makeContext("missing"));
    expect(res.status).toBe(404);
  });

  it("emits auth.success audit", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedKeyring.mockReturnValue(makeKeyringOk());
    mockedRotate.mockResolvedValue({
      token: "hmt_rotated",
      name: "worker",
      agent_role: "drone",
      capabilities: ["tasks.claim"],
      fingerprint: "newfp001",
      expiresAt: null,
    });
    await POST(makeRequest(), makeContext("worker"));
    await new Promise((resolve) => setImmediate(resolve));
    const entry = mockedAuditAppend.mock.calls[0][0].entry;
    if (entry.action === "auth.success" || entry.action === "auth.failure") {
      expect(entry.endpoint).toBe("POST /api/agent-tokens/{name}/rotate");
    }
  });

  it("SECURITY: response never contains operator's tokenHash", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedKeyring.mockReturnValue(makeKeyringOk());
    mockedRotate.mockResolvedValue({
      token: "hmt_rotated",
      name: "worker",
      agent_role: "drone",
      capabilities: ["tasks.claim"],
      fingerprint: "newfp001",
      expiresAt: null,
    });
    const res = await POST(makeRequest(), makeContext("worker"));
    const raw = await res.text();
    expect(raw).not.toContain("deadbeef00000000"); // operator's tokenHash
    expect(raw).not.toContain("ciphertext");
  });
});
