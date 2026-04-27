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

  it("auditEntry passed with action=rotate + operator's fingerprint", async () => {
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
    expect(callArgs.auditEntry?.action).toBe("rotate");
    expect(callArgs.auditEntry?.fingerprint).toBe("deadbeef"); // operator's
    expect(callArgs.auditEntry?.name).toBe("worker"); // subject
    expect(callArgs.auditEntry?.actor).toBe("admin"); // operator's name
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
