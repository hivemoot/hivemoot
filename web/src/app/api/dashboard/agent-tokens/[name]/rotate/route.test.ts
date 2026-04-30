/**
 * Tests for POST /api/dashboard/agent-tokens/{name}/rotate.
 * Mirrors the issuance test shape — auth gate, name validation,
 * successful rotation (new bearer in response), TokenNotFoundError
 * mapping for nonexistent names.
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
    rotateAgentToken: vi.fn(),
  };
});

import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import {
  rotateAgentToken,
  TokenNotFoundError,
} from "@/server/agent-token-v1";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateByokRequest);
const mockedRequireInstallation = vi.mocked(requireInstallation);
const mockedRotate = vi.mocked(rotateAgentToken);

function makeRequest(): NextRequest {
  return new NextRequest(
    "https://www.hivemoot.dev/api/dashboard/agent-tokens/queen/rotate",
    { method: "POST", headers: { cookie: "session=mock" } },
  );
}

function makeParams(name = "queen") {
  return { params: Promise.resolve({ name }) };
}

function makeByokAuthOk() {
  return {
    ok: true as const,
    session: {
      userLogin: "operator-gh-login",
      installationId: "12345",
    } as never,
    keyring: new Map<string, Buffer>([["v1", Buffer.alloc(32)]]),
    activeKeyVersion: "v1",
    redis: {} as never,
  };
}

function makeRotated() {
  return {
    token: "hmt_freshly_rotated_queen_bearer",
    name: "queen",
    agent_role: "queen",
    capabilities: ["rooms.create", "rooms.read"],
    fingerprint: "rotfp001",
    expiresAt: null as string | null,
  };
}

beforeEach(() => {
  mockedAuth.mockReset();
  mockedRequireInstallation.mockReset();
  mockedRotate.mockReset();
});

describe("POST /api/dashboard/agent-tokens/{name}/rotate — auth + path", () => {
  it("byok auth failure → no rotate call", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "byok_session_invalid" }, { status: 401 }),
    } as never);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(401);
    expect(mockedRotate).not.toHaveBeenCalled();
  });

  it("requireInstallation failure → no rotate call", async () => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: false,
      response: NextResponse.json({ code: "installation_required" }, { status: 409 }),
    } as never);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(409);
    expect(mockedRotate).not.toHaveBeenCalled();
  });

  it("empty path name → 400 INVALID_NAME", async () => {
    const res = await POST(makeRequest(), makeParams(""));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_name");
    expect(mockedRotate).not.toHaveBeenCalled();
  });

  it("malformed path name (capitals) → 400 INVALID_NAME", async () => {
    const res = await POST(makeRequest(), makeParams("Queen"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent_tokens_v1_invalid_name");
    expect(mockedRotate).not.toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/agent-tokens/{name}/rotate — success", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: true,
      installationId: "12345",
    } as never);
  });

  it("returns the new bearer + metadata + audit context uses dashboard convention", async () => {
    mockedRotate.mockResolvedValue(makeRotated() as never);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe("hmt_freshly_rotated_queen_bearer");
    expect(body.fingerprint).toBe("rotfp001");
    expect(body.name).toBe("queen");
    expect(body.capabilities).toEqual(["rooms.create", "rooms.read"]);
    expect(body.message).toMatch(/store it in the target/i);

    // Audit context is the cookie-auth convention
    const call = mockedRotate.mock.calls[0][0];
    expect(call.auditContext?.operator).toEqual({
      fingerprint: "",
      name: "dashboard",
    });
    expect(call.auditContext?.detailExtras).toEqual({
      rotated_by: "operator-gh-login",
    });
  });
});

describe("POST /api/dashboard/agent-tokens/{name}/rotate — error mapping", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeByokAuthOk());
    mockedRequireInstallation.mockReturnValue({
      ok: true,
      installationId: "12345",
    } as never);
  });

  it("nonexistent name → TokenNotFoundError → 404", async () => {
    mockedRotate.mockRejectedValue(new TokenNotFoundError("12345", "queen"));
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(404);
  });

  it("generic storage error → 500", async () => {
    mockedRotate.mockRejectedValue(new Error("redis dropped"));
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(500);
  });
});
