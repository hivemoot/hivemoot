import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/server/agent-health-auth", () => ({
  authenticateAgentRequest: vi.fn(),
}));

import { authenticateAgentRequest } from "@/server/agent-health-auth";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequest);

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

function authOk(installationId = "67890") {
  // Return value shape per AgentAuthResult in agent-health-auth.ts —
  // the route only reads `ok` so a minimal shape suffices for this test.
  return {
    ok: true as const,
    installationId,
    redis: {} as never,
  };
}

function authFailure(status = 401, code = "agent_health_not_authenticated") {
  return {
    ok: false as const,
    response: NextResponse.json({ code, message: "denied" }, { status }),
  };
}

beforeEach(() => {
  mockedAuth.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/github/installation-tokens", () => {
  it("returns 401 when bearer auth fails", async () => {
    mockedAuth.mockResolvedValue(authFailure());

    const res = await POST(makeRequest({ repo: "dkjazz/the-storytimes-firebase" }));

    expect(res.status).toBe(401);
  });

  it("returns 400 when body is malformed JSON", async () => {
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(makeRequest("not-json", { json: false }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_request");
  });

  it("returns 400 when repo field is missing", async () => {
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_request");
  });

  it("returns 400 when repo field is empty string", async () => {
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(makeRequest({ repo: "   " }));

    expect(res.status).toBe(400);
  });

  it("returns 400 when repo field is wrong type", async () => {
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(makeRequest({ repo: 12345 }));

    expect(res.status).toBe(400);
  });

  it("returns 501 with structured envelope on valid request", async () => {
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(
      makeRequest({ repo: "dkjazz/the-storytimes-firebase" }),
    );

    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toBe("not_implemented");
    expect(body.message).toMatch(/scaffolded/i);
    expect(body.message).toMatch(/DESIGN\.md/);
  });

  it("authenticates BEFORE inspecting body — bad auth + bad body yields 401", async () => {
    // Order matters: an unauthenticated caller must not learn anything
    // about the body-validation contract. 401 wins over 400.
    mockedAuth.mockResolvedValue(authFailure());

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(401);
  });
});
