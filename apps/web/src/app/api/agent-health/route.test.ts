import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));
vi.mock("@/server/agent-health-auth", () => ({
  authenticateAgentRequest: vi.fn(),
}));
vi.mock("@/server/agent-health-store", () => ({
  AGENT_ID_PATTERN: /^[a-z0-9_-]+$/,
  validateReport: vi.fn(),
  checkRateLimit: vi.fn(),
  recordHealthReport: vi.fn(),
  reserveHealthReportIdempotency: vi.fn(),
  commitHealthReportIdempotency: vi.fn(),
  releaseHealthReportIdempotency: vi.fn(),
  getOverview: vi.fn(),
  getHistory: vi.fn(),
}));
vi.mock("@/server/agent-health-error", async () => {
  const { NextResponse } = await import("next/server");
  return {
    AGENT_HEALTH_ERROR: {
      INVALID_JSON: "agent_health_invalid_json",
      PAYLOAD_TOO_LARGE: "agent_health_payload_too_large",
      MISSING_FIELDS: "agent_health_missing_fields",
      NOT_AUTHENTICATED: "agent_health_not_authenticated",
      SERVER_MISCONFIGURATION: "agent_health_server_misconfiguration",
      TOKEN_ALREADY_EXISTS: "agent_health_token_already_exists",
      TOKEN_NOT_FOUND: "agent_health_token_not_found",
      IDEMPOTENCY_CONFLICT: "agent_health_idempotency_conflict",
      IDEMPOTENCY_PENDING: "agent_health_idempotency_pending",
      RATE_LIMITED: "agent_health_rate_limited",
      VALIDATION_FAILED: "agent_health_validation_failed",
    },
    agentHealthError: (code: string, message: string, status: number, details?: Record<string, unknown>) =>
      NextResponse.json({ code, message, ...(details ?? {}) }, { status }),
  };
});

import { authenticateByokRequest } from "@/server/byok-auth";
import { authenticateAgentRequest } from "@/server/agent-health-auth";
import {
  validateReport,
  checkRateLimit,
  recordHealthReport,
  reserveHealthReportIdempotency,
  commitHealthReportIdempotency,
  releaseHealthReportIdempotency,
  getOverview,
  getHistory,
} from "@/server/agent-health-store";
import { POST, GET } from "./route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SESSION = {
  installationId: "inst-1",
  userId: 1,
  userLogin: "alice",
};

const MOCK_KEYRING = new Map([["v1", Buffer.alloc(32)]]);

function mockAgentAuthSuccess(installationId = "inst-1") {
  vi.mocked(authenticateAgentRequest).mockResolvedValue({
    ok: true,
    installationId,
    redis: {} as never,
  });
}

function mockAgentAuthFailure(status: number, code: string, message: string) {
  vi.mocked(authenticateAgentRequest).mockResolvedValue({
    ok: false,
    response: NextResponse.json({ code, message }, { status }),
  });
}

function mockSessionAuthSuccess() {
  vi.mocked(authenticateByokRequest).mockResolvedValue({
    ok: true,
    session: MOCK_SESSION,
    keyring: MOCK_KEYRING,
    activeKeyVersion: "v1",
    redis: {} as never,
  });
}

function mockSessionAuthFailure(status: number, code: string, message: string) {
  vi.mocked(authenticateByokRequest).mockResolvedValue({
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

function makeGetRequest(params?: Record<string, string>) {
  const url = new URL("https://example.com/api/agent-health");
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return new NextRequest(url.toString(), { method: "GET" });
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
  mockAgentAuthSuccess();
  mockSessionAuthSuccess();
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
  vi.mocked(commitHealthReportIdempotency).mockResolvedValue(undefined);
  vi.mocked(releaseHealthReportIdempotency).mockResolvedValue(undefined);
  vi.mocked(getOverview).mockResolvedValue([]);
  vi.mocked(getHistory).mockResolvedValue([]);
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

  it("commits idempotency after a successful write", async () => {
    await POST(makePostRequest(VALID_REQUEST_BODY));

    expect(commitHealthReportIdempotency).toHaveBeenCalledWith(
      "inst-1",
      VALID_REPORT,
      expect.anything(),
    );
  });

  it("returns 401 when not authenticated", async () => {
    mockAgentAuthFailure(401, "agent_health_not_authenticated", "Invalid token");

    const res = await POST(makePostRequest(VALID_REQUEST_BODY));
    expect(res.status).toBe(401);
  });

  it("returns 400 when body is not valid JSON", async () => {
    mockAgentAuthSuccess();

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

  it("returns 409 when a matching run_id is still pending commit", async () => {
    vi.mocked(reserveHealthReportIdempotency).mockResolvedValue({
      kind: "pending",
    });

    const res = await POST(makePostRequest(VALID_REQUEST_BODY));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("agent_health_idempotency_pending");
    expect(checkRateLimit).not.toHaveBeenCalled();
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

  it("does not release reservation when write succeeded but commit update fails", async () => {
    vi.mocked(commitHealthReportIdempotency).mockRejectedValue(
      new Error("idempotency commit failed"),
    );

    await expect(POST(makePostRequest(VALID_REQUEST_BODY))).rejects.toThrow(
      "idempotency commit failed",
    );
    expect(releaseHealthReportIdempotency).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — GET
// ---------------------------------------------------------------------------

describe("GET /api/agent-health", () => {
  it("returns overview when no query params are provided", async () => {
    vi.mocked(getOverview).mockResolvedValue([
      {
        agent_id: "bee-1",
        repo: "hivemoot/sandbox",
        run_id: "20260224-100000-claude-bee-1",
        outcome: "success",
        duration_secs: 42,
        consecutive_failures: 0,
        received_at: "2026-02-24T10:00:00Z",
        status: "ok",
      },
    ]);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].agent_id).toBe("bee-1");
  });

  it("returns history when agent_id and repo are provided", async () => {
    vi.mocked(getHistory).mockResolvedValue([
      {
        agent_id: "bee-1",
        repo: "hivemoot/sandbox",
        run_id: "20260224-100000-claude-bee-1",
        outcome: "success",
        duration_secs: 42,
        consecutive_failures: 0,
        received_at: "2026-02-24T10:00:00Z",
      },
    ]);

    const res = await GET(makeGetRequest({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agent_id).toBe("bee-1");
    expect(body.repo).toBe("hivemoot/sandbox");
    expect(body.history).toHaveLength(1);
    expect(body.runs).toHaveLength(1);
  });

  it("returns history when history=true is provided", async () => {
    vi.mocked(getHistory).mockResolvedValue([
      {
        agent_id: "bee-1",
        repo: "hivemoot/sandbox",
        run_id: "20260224-100000-claude-bee-1",
        outcome: "success",
        duration_secs: 42,
        consecutive_failures: 0,
        received_at: "2026-02-24T10:00:00Z",
      },
    ]);

    const res = await GET(makeGetRequest({
      history: "true",
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.history).toHaveLength(1);
    expect(body.runs).toHaveLength(1);
  });

  it("returns 400 when history=true is missing agent_id", async () => {
    const res = await GET(makeGetRequest({
      history: "true",
      repo: "hivemoot/sandbox",
    }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("agent_health_missing_fields");
  });

  it("returns 400 when history=true is missing repo", async () => {
    const res = await GET(makeGetRequest({
      history: "true",
      agent_id: "bee-1",
    }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("agent_health_missing_fields");
  });

  it("returns 400 when only agent_id is provided", async () => {
    const res = await GET(makeGetRequest({ agent_id: "bee-1" }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("agent_health_missing_fields");
  });

  it("returns 400 when only repo is provided", async () => {
    const res = await GET(makeGetRequest({ repo: "hivemoot/sandbox" }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("agent_health_missing_fields");
  });

  it("returns auth error when session is invalid", async () => {
    mockSessionAuthFailure(401, "byok_not_authenticated", "Not authenticated");

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it("passes installationId from session to getOverview", async () => {
    await GET(makeGetRequest());
    expect(getOverview).toHaveBeenCalledWith("inst-1", expect.anything());
  });

  // --- GET input validation tests ---

  it("returns 400 when agent_id contains invalid characters", async () => {
    const res = await GET(makeGetRequest({
      agent_id: "bee 1; DROP TABLE",
      repo: "hivemoot/sandbox",
    }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("agent_health_validation_failed");
    expect(body.message).toContain("agent_id");
  });

  it("returns 400 when agent_id exceeds 64 characters", async () => {
    const res = await GET(makeGetRequest({
      agent_id: "a".repeat(65),
      repo: "hivemoot/sandbox",
    }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("agent_health_validation_failed");
  });

  it("returns 400 when repo is missing slash", async () => {
    const res = await GET(makeGetRequest({
      agent_id: "bee-1",
      repo: "noseparator",
    }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("agent_health_validation_failed");
    expect(body.message).toContain("repo");
  });

  it("returns 400 when repo exceeds 200 characters", async () => {
    const res = await GET(makeGetRequest({
      agent_id: "bee-1",
      repo: "a".repeat(100) + "/" + "b".repeat(101),
    }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("agent_health_validation_failed");
  });

  it("returns 500 when getOverview throws", async () => {
    vi.mocked(getOverview).mockRejectedValue(new Error("redis down"));

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("agent_health_server_misconfiguration");
  });

  it("returns 500 when getHistory throws", async () => {
    vi.mocked(getHistory).mockRejectedValue(new Error("redis down"));

    const res = await GET(makeGetRequest({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
    }));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("agent_health_server_misconfiguration");
  });

  it("accepts valid agent_id with underscores and hyphens", async () => {
    vi.mocked(getHistory).mockResolvedValue([]);

    const res = await GET(makeGetRequest({
      agent_id: "bee_worker-1",
      repo: "hivemoot/sandbox",
    }));
    expect(res.status).toBe(200);
  });
});
