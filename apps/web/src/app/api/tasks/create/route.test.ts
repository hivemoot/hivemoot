import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));

vi.mock("@/server/task-store", () => ({
  checkTaskCreateRateLimit: vi.fn(),
  createTask: vi.fn(),
  validateCreateTaskRequest: vi.fn(),
}));

import { authenticateByokRequest } from "@/server/byok-auth";
import {
  checkTaskCreateRateLimit,
  createTask,
  validateCreateTaskRequest,
} from "@/server/task-store";
import { POST } from "./route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("https://example.com/api/tasks/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

  vi.mocked(validateCreateTaskRequest).mockReturnValue({
    ok: true,
    request: {
      prompt: "Deep analysis",
      repos: ["hivemoot/hivemoot"],
      engine: "codex",
      timeout_secs: 300,
    },
  });

  vi.mocked(checkTaskCreateRateLimit).mockResolvedValue({
    allowed: true,
    retryAfterSeconds: 0,
  });

  vi.mocked(createTask).mockResolvedValue({
    ok: true,
    task: {
      task_id: "abc123abc123abc123abc123",
      status: "pending",
      engine: "codex",
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

describe("POST /api/tasks/create", () => {
  it("creates a task and returns stream url", async () => {
    const res = await POST(makeRequest({ prompt: "Deep analysis", repos: ["hivemoot/hivemoot"] }));
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.task_id).toBe("abc123abc123abc123abc123");
    expect(body.stream_url).toBe("/api/tasks/abc123abc123abc123abc123/stream");
  });

  it("returns auth failure response from auth helper", async () => {
    vi.mocked(authenticateByokRequest).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "byok_not_authenticated" }, { status: 401 }),
    });

    const res = await POST(makeRequest({ prompt: "Deep analysis", repos: ["hivemoot/hivemoot"] }));
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid body", async () => {
    vi.mocked(validateCreateTaskRequest).mockReturnValue({
      ok: false,
      message: "prompt must not be empty",
    });

    const res = await POST(makeRequest({ prompt: "", repos: ["hivemoot/hivemoot"] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_validation_failed");
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(checkTaskCreateRateLimit).mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 60,
    });

    const res = await POST(makeRequest({ prompt: "Deep analysis", repos: ["hivemoot/hivemoot"] }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("task_rate_limited");
  });

  it("returns 429 when concurrent cap is hit", async () => {
    vi.mocked(createTask).mockResolvedValue({
      ok: false,
      reason: "concurrency_limited",
    });

    const res = await POST(makeRequest({ prompt: "Deep analysis", repos: ["hivemoot/hivemoot"] }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("task_concurrency_limited");
  });

  it("returns 400 for invalid json", async () => {
    const req = new NextRequest("https://example.com/api/tasks/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{{{",
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_json");
  });

  it("returns 403 for cross-origin create requests", async () => {
    const req = new NextRequest("https://example.com/api/tasks/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ prompt: "Deep analysis", repos: ["hivemoot/hivemoot"] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("task_forbidden");
  });
});
