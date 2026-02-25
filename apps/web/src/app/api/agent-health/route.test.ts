import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/server/agent-health-auth", () => ({
  authenticateAgentRequest: vi.fn(),
}));
vi.mock("@/server/agent-health-store", () => ({
  validateReport: vi.fn(),
  checkRateLimit: vi.fn(),
  recordHealthReport: vi.fn(),
}));

import { authenticateAgentRequest } from "@/server/agent-health-auth";
import {
  validateReport,
  checkRateLimit,
  recordHealthReport,
} from "@/server/agent-health-store";
import { POST } from "./route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockAuthSuccess(installationId = "inst-1") {
  vi.mocked(authenticateAgentRequest).mockResolvedValue({
    ok: true,
    installationId,
    redis: {} as never,
  });
}

function mockAuthFailure(status: number, code: string, message: string) {
  vi.mocked(authenticateAgentRequest).mockResolvedValue({
    ok: false,
    response: NextResponse.json({ code, message }, { status }),
  });
}

function makePostRequest(body: unknown) {
  return new NextRequest("https://example.com/api/agent-health", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    },
    body: JSON.stringify(body),
  });
}

const VALID_REPORT = {
  agent_id: "bee-1",
  repo: "hivemoot/sandbox",
  status: "idle" as const,
  received_at: "2026-02-24T10:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthSuccess();
  vi.mocked(validateReport).mockReturnValue({
    ok: true,
    report: VALID_REPORT,
  });
  vi.mocked(checkRateLimit).mockResolvedValue(true);
  vi.mocked(recordHealthReport).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/agent-health", () => {
  it("accepts a valid report and returns confirmation", async () => {
    const res = await POST(makePostRequest({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      status: "idle",
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
    expect(body.received_at).toBeDefined();
  });

  it("calls recordHealthReport with validated report", async () => {
    await POST(makePostRequest({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      status: "idle",
    }));

    expect(recordHealthReport).toHaveBeenCalledWith(
      "inst-1",
      VALID_REPORT,
      expect.anything(),
    );
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthFailure(401, "agent_health_not_authenticated", "Invalid token");

    const res = await POST(makePostRequest({ agent_id: "bee-1", repo: "r", status: "idle" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when body is not valid JSON", async () => {
    mockAuthSuccess();

    const req = new NextRequest("https://example.com/api/agent-health", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: "not-json{{{",
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("agent_health_invalid_json");
  });

  it("returns 400 when validation fails", async () => {
    vi.mocked(validateReport).mockReturnValue({
      ok: false,
      message: "agent_id is required",
    });

    const res = await POST(makePostRequest({ status: "idle" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("agent_health_validation_failed");
    expect(body.message).toContain("agent_id");
  });

  it("returns 429 when rate-limited", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue(false);

    const res = await POST(makePostRequest({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      status: "idle",
    }));

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("agent_health_rate_limited");
  });

  it("does not call recordHealthReport when rate-limited", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue(false);

    await POST(makePostRequest({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      status: "idle",
    }));

    expect(recordHealthReport).not.toHaveBeenCalled();
  });
});
