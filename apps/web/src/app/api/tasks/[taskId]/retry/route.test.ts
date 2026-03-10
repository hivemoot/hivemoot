import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));

vi.mock("@/server/task-store", () => ({
  TASK_ID_PATTERN: /^[a-f0-9]{24}$/,
  checkTaskCreateRateLimit: vi.fn(),
  retryTask: vi.fn(),
}));

import { authenticateByokRequest } from "@/server/byok-auth";
import { checkTaskCreateRateLimit, retryTask } from "@/server/task-store";
import { POST } from "./route";

function makeRequest(taskId = "abc123abc123abc123abc123"): NextRequest {
  return new NextRequest(`https://example.com/api/tasks/${taskId}/retry`, {
    method: "POST",
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(authenticateByokRequest).mockResolvedValue({
    ok: true,
    session: {
      installationId: "inst-1",
      userId: 101,
      userLogin: "queen",
    },
    redis: {} as never,
    keyring: new Map(),
    activeKeyVersion: "v1",
  });

  vi.mocked(checkTaskCreateRateLimit).mockResolvedValue({
    allowed: true,
    retryAfterSeconds: 0,
  });

  vi.mocked(retryTask).mockResolvedValue({
    ok: true,
    task: {
      task_id: "abc123abc123abc123abc123",
      status: "pending",
      prompt: "Deep analysis",
      repos: ["hivemoot/hivemoot"],
      timeout_secs: 300,
      created_by: "queen",
      created_at: "2026-03-03T12:00:00.000Z",
      updated_at: "2026-03-03T12:00:00.000Z",
      progress: "Queued",
    },
  });
});

describe("POST /api/tasks/[taskId]/retry", () => {
  it("retries a task and returns the task payload", async () => {
    const res = await POST(makeRequest());

    expect(res.status).toBe(202);
    expect(checkTaskCreateRateLimit).toHaveBeenCalledWith(
      "inst-1",
      101,
      expect.anything(),
    );
    expect(retryTask).toHaveBeenCalledWith(
      "inst-1",
      "abc123abc123abc123abc123",
      expect.anything(),
    );

    const body = await res.json();
    expect(body.task_id).toBe("abc123abc123abc123abc123");
    expect(body.stream_url).toBe("/api/tasks/abc123abc123abc123abc123/stream");
  });

  it("returns auth failure response from auth helper", async () => {
    vi.mocked(authenticateByokRequest).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "byok_not_authenticated" }, { status: 401 }),
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid task id", async () => {
    const res = await POST(makeRequest("not-valid"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_task_id");
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(checkTaskCreateRateLimit).mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 42,
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
    expect(retryTask).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.code).toBe("task_rate_limited");
    expect(body.retry_after_secs).toBe(42);
  });

  it("returns 404 when original task is missing", async () => {
    vi.mocked(retryTask).mockResolvedValue({
      ok: false,
      reason: "not_found",
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("task_not_found");
  });

  it("returns 409 for invalid retry transition", async () => {
    vi.mocked(retryTask).mockResolvedValue({
      ok: false,
      reason: "invalid_transition",
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_transition");
  });

  it("returns 429 for concurrency limit", async () => {
    vi.mocked(retryTask).mockResolvedValue({
      ok: false,
      reason: "concurrency_limited",
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("task_concurrency_limited");
  });

  it("returns 500 when retry throws", async () => {
    vi.mocked(retryTask).mockRejectedValue(new Error("redis down"));

    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("task_server_error");
  });
});
