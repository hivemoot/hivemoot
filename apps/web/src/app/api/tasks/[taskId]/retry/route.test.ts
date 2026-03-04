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
const NEW_TASK_ID = "def456def456def456def456";

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(authenticateByokRequest).mockResolvedValue({
    ok: true,
    session: {
      installationId: "inst-1",
      userId: 101,
      userLogin: "queen",
    } as never,
    keyring: new Map(),
    activeKeyVersion: "v1",
    redis: {} as never,
  });

  vi.mocked(checkTaskCreateRateLimit).mockResolvedValue({
    allowed: true,
    retryAfterSeconds: 0,
  });

  vi.mocked(retryTask).mockResolvedValue({
    ok: true,
    task: {
      task_id: NEW_TASK_ID,
      status: "pending",
      engine: "codex",
      prompt: "Deep analysis",
      repos: ["hivemoot/hivemoot"],
      timeout_secs: 300,
      created_by: "queen",
      created_at: "2026-03-04T12:00:00.000Z",
      updated_at: "2026-03-04T12:00:00.000Z",
    },
  });
});

describe("POST /api/tasks/[taskId]/retry", () => {
  it("creates a new task and returns 202", async () => {
    const req = new NextRequest(`https://example.com/api/tasks/${TASK_ID}/retry`, {
      method: "POST",
    });
    const res = await POST(req);

    expect(res.status).toBe(202);
    expect(retryTask).toHaveBeenCalledWith("inst-1", TASK_ID, expect.anything());

    const body = await res.json();
    expect(body.task.task_id).toBe(NEW_TASK_ID);
    expect(body.task.status).toBe("pending");
  });

  it("returns 400 for invalid task id", async () => {
    const req = new NextRequest("https://example.com/api/tasks/bad-id/retry", {
      method: "POST",
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_task_id");
  });

  it("forwards auth failures", async () => {
    vi.mocked(authenticateByokRequest).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "byok_not_authenticated" }, { status: 401 }),
    });

    const req = new NextRequest(`https://example.com/api/tasks/${TASK_ID}/retry`, {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 404 when task not found", async () => {
    vi.mocked(retryTask).mockResolvedValue({ ok: false, reason: "not_found" });

    const req = new NextRequest(`https://example.com/api/tasks/${TASK_ID}/retry`, {
      method: "POST",
    });
    const res = await POST(req);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("task_not_found");
  });

  it("returns 409 when task is not in a retriable state", async () => {
    vi.mocked(retryTask).mockResolvedValue({ ok: false, reason: "invalid_transition" });

    const req = new NextRequest(`https://example.com/api/tasks/${TASK_ID}/retry`, {
      method: "POST",
    });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_transition");
  });

  it("returns 429 when concurrency limit is reached", async () => {
    vi.mocked(retryTask).mockResolvedValue({ ok: false, reason: "concurrency_limited" });

    const req = new NextRequest(`https://example.com/api/tasks/${TASK_ID}/retry`, {
      method: "POST",
    });
    const res = await POST(req);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("task_concurrency_limited");
  });

  it("returns 429 when per-minute rate limit is exceeded", async () => {
    vi.mocked(checkTaskCreateRateLimit).mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 42,
    });

    const req = new NextRequest(`https://example.com/api/tasks/${TASK_ID}/retry`, {
      method: "POST",
    });
    const res = await POST(req);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("task_rate_limited");
    expect(body.retry_after_secs).toBe(42);
    expect(retryTask).not.toHaveBeenCalled();
  });
});
