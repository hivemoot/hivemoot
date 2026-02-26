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
  reserveHealthReportIdempotency: vi.fn(),
  releaseHealthReportIdempotency: vi.fn(),
}));

import { authenticateAgentRequest } from "@/server/agent-health-auth";
import {
  validateReport,
  checkRateLimit,
  recordHealthReport,
  reserveHealthReportIdempotency,
  releaseHealthReportIdempotency,
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

function makeRawPostRequest(bodyText: string, extraHeaders?: Record<string, string>) {
  return new NextRequest("https://example.com/api/agent-health", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
      ...(extraHeaders ?? {}),
    },
    body: bodyText,
  });
}

const VALID_REQUEST_BODY = {
  agent_id: "bee-1",
  repo: "hivemoot/sandbox",
  run_id: "20260224-100000-claude-bee-1",
  outcome: "success" as const,
  duration_secs: 42,
  consecutive_failures: 0,
};

const VALID_REPORT = {
  ...VALID_REQUEST_BODY,
  received_at: "2026-02-24T10:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthSuccess();
  vi.mocked(validateReport).mockReturnValue({
    ok: true,
    report: VALID_REPORT,
  });
  vi.mocked(reserveHealthReportIdempotency).mockResolvedValue({
    kind: "new",
    receivedAt: VALID_REPORT.received_at,
  });
  vi.mocked(checkRateLimit).mockResolvedValue(true);
  vi.mocked(recordHealthReport).mockResolvedValue(undefined);
  vi.mocked(releaseHealthReportIdempotency).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/agent-health", () => {
  it("accepts a valid report and returns confirmation", async () => {
    const res = await POST(makePostRequest(VALID_REQUEST_BODY));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
    expect(body.received_at).toBeDefined();
  });

  it("calls recordHealthReport with validated report", async () => {
    await POST(makePostRequest(VALID_REQUEST_BODY));

    expect(recordHealthReport).toHaveBeenCalledWith(
      "inst-1",
      VALID_REPORT,
      expect.anything(),
    );
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthFailure(401, "agent_health_not_authenticated", "Invalid token");

    const res = await POST(makePostRequest(VALID_REQUEST_BODY));
    expect(res.status).toBe(401);
  });

  it("returns 400 when body is not valid JSON", async () => {
    mockAuthSuccess();

    const req = makeRawPostRequest("not-json{{{");

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("agent_health_invalid_json");
    expect(authenticateAgentRequest).not.toHaveBeenCalled();
  });

  it("returns 400 when validation fails", async () => {
    vi.mocked(validateReport).mockReturnValue({
      ok: false,
      message: "run_id is required",
    });

    const res = await POST(makePostRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("agent_health_validation_failed");
    expect(body.message).toContain("run_id");
    expect(authenticateAgentRequest).not.toHaveBeenCalled();
  });

  it("returns 413 when Content-Length exceeds 10KB", async () => {
    const req = makeRawPostRequest("{}", {
      "Content-Length": String((10 * 1024) + 1),
    });

    const res = await POST(req);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe("agent_health_payload_too_large");
    expect(authenticateAgentRequest).not.toHaveBeenCalled();
  });

  it("returns 413 when actual body exceeds 10KB even with spoofed Content-Length", async () => {
    const largeBody = JSON.stringify({
      ...VALID_REQUEST_BODY,
      error: "x".repeat((10 * 1024) + 200),
    });
    const req = makeRawPostRequest(largeBody, {
      "Content-Length": "16",
    });

    const res = await POST(req);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe("agent_health_payload_too_large");
    expect(authenticateAgentRequest).not.toHaveBeenCalled();
  });

  it("returns 429 when rate-limited", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue(false);

    const res = await POST(makePostRequest(VALID_REQUEST_BODY));

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("agent_health_rate_limited");
  });

  it("does not call recordHealthReport when rate-limited", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue(false);

    await POST(makePostRequest(VALID_REQUEST_BODY));

    expect(recordHealthReport).not.toHaveBeenCalled();
  });

  it("returns 200 duplicate=true when run_id is retried with same payload", async () => {
    vi.mocked(reserveHealthReportIdempotency).mockResolvedValue({
      kind: "duplicate",
      receivedAt: "2026-02-24T10:00:00Z",
    });

    const res = await POST(makePostRequest(VALID_REQUEST_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
    expect(body.received_at).toBe("2026-02-24T10:00:00Z");
    expect(body.duplicate).toBe(true);
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(recordHealthReport).not.toHaveBeenCalled();
  });

  it("returns 409 when run_id is reused with a different payload", async () => {
    vi.mocked(reserveHealthReportIdempotency).mockResolvedValue({
      kind: "conflict",
    });

    const res = await POST(makePostRequest(VALID_REQUEST_BODY));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("agent_health_idempotency_conflict");
    expect(recordHealthReport).not.toHaveBeenCalled();
  });

  it("releases idempotency reservation when rate-limited", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue(false);

    await POST(makePostRequest(VALID_REQUEST_BODY));

    expect(releaseHealthReportIdempotency).toHaveBeenCalledWith(
      "inst-1",
      VALID_REPORT,
      expect.anything(),
    );
  });

  it("releases idempotency reservation when write fails", async () => {
    vi.mocked(recordHealthReport).mockRejectedValue(new Error("redis write failed"));

    await expect(POST(makePostRequest(VALID_REQUEST_BODY))).rejects.toThrow(
      "redis write failed",
    );
    expect(releaseHealthReportIdempotency).toHaveBeenCalledWith(
      "inst-1",
      VALID_REPORT,
      expect.anything(),
    );
  });
});
