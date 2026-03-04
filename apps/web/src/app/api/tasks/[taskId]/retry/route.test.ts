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

const TASK_ID = "abc123abc123abc123abc123";

function makeRequest(): NextRequest {
  return new NextRequest(`https://example.com/api/tasks/${TASK_ID}/retry`, {
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
      task_id: "newid123newid123newid123",
      status: "pending",
      engine: "codex",
      prompt: "Re-run analysis",
      repos: ["hivemoot/hivemoot"],
      timeout_secs: 300,
      created_by: "queen",
      created_at: "2026-03-04T12:00:00.000Z",
      updated_at: "2026-03-04T12:00:00.000Z",
    },
  });
});

describe("POST /api/tasks/[taskId]/retry", () => {
  it("retries a task and returns new task id and stream url", async () => {
    const res = await POST(makeRequest());

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.task_id).toBe("newid123newid123newid123");
    expect(body.stream_url).toBe("/api/tasks/newid123newid123newid123/stream");
    expect(body.status).toBe("pending");
  });

  it("forwards auth failures", async () => {
    vi.mocked(authenticateByokRequest).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "byok_not_authenticated" }, { status: 401 }),
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid task id", async () => {
    const req = new NextRequest("https://example.com/api/tasks/not-valid/retry", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_task_id");
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(checkTaskCreateRateLimit).mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 30,
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("task_rate_limited");
    expect(body.retry_after_secs).toBe(30);
  });

  it("returns 404 when task not found", async () => {
    vi.mocked(retryTask).mockResolvedValue({ ok: false, reason: "not_found" });

    const res = await POST(makeRequest());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("task_not_found");
  });

  it("returns 429 when concurrency limit is hit", async () => {
    vi.mocked(retryTask).mockResolvedValue({ ok: false, reason: "concurrency_limited" });

    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("task_concurrency_limited");
  });

  it("returns 409 when task is not retriable", async () => {
    vi.mocked(retryTask).mockResolvedValue({ ok: false, reason: "invalid_transition" });

    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_transition");
  });
});
