import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));

vi.mock("@/server/task-store", () => ({
  TASK_ID_PATTERN: /^[a-f0-9]{24}$/,
  resumeTaskWithFollowUp: vi.fn(),
}));

import { authenticateByokRequest } from "@/server/byok-auth";
import { resumeTaskWithFollowUp } from "@/server/task-store";
import { POST } from "./route";

const TASK_ID = "abc123abc123abc123abc123";

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(authenticateByokRequest).mockResolvedValue({
    ok: true,
    session: { installationId: "inst-1" } as never,
    keyring: new Map(),
    activeKeyVersion: "v1",
    redis: {} as never,
  });

  vi.mocked(resumeTaskWithFollowUp).mockResolvedValue({
    ok: true,
    task: {
      task_id: TASK_ID,
      status: "pending",
      engine: "codex",
      prompt: "Task",
      repos: ["hivemoot/hivemoot"],
      timeout_secs: 300,
      created_by: "queen",
      created_at: "2026-03-03T12:00:00.000Z",
      updated_at: "2026-03-03T12:05:00.000Z",
      progress: "Re-queued after follow-up",
    },
  });
});

function makeRequest(body: unknown) {
  return new NextRequest(`https://example.com/api/tasks/${TASK_ID}/follow-up`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tasks/[taskId]/follow-up", () => {
  it("resumes a task with a follow-up message", async () => {
    const res = await POST(makeRequest({ message: "Here is more context" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.task.status).toBe("pending");
    expect(resumeTaskWithFollowUp).toHaveBeenCalledWith(
      "inst-1",
      TASK_ID,
      "Here is more context",
      expect.anything(),
    );
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(authenticateByokRequest).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "not_authenticated" }, { status: 401 }),
    });

    const res = await POST(makeRequest({ message: "info" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid task id", async () => {
    const req = new NextRequest("https://example.com/api/tasks/bad-id/follow-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "info" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_task_id");
  });

  it("returns 400 when message is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_missing_fields");
  });

  it("returns 400 when message is empty", async () => {
    const res = await POST(makeRequest({ message: "  " }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_missing_fields");
  });

  it("returns 404 when task not found", async () => {
    vi.mocked(resumeTaskWithFollowUp).mockResolvedValue({
      ok: false,
      reason: "not_found",
    });

    const res = await POST(makeRequest({ message: "info" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("task_not_found");
  });

  it("returns 409 when task is not in needs_follow_up state", async () => {
    vi.mocked(resumeTaskWithFollowUp).mockResolvedValue({
      ok: false,
      reason: "invalid_transition",
    });

    const res = await POST(makeRequest({ message: "info" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("task_follow_up_not_allowed");
  });

  it("returns 429 when concurrency limited", async () => {
    vi.mocked(resumeTaskWithFollowUp).mockResolvedValue({
      ok: false,
      reason: "concurrency_limited",
    });

    const res = await POST(makeRequest({ message: "info" }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("task_concurrency_limited");
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest(`https://example.com/api/tasks/${TASK_ID}/follow-up`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_json");
  });

  it("returns 400 when body is an array", async () => {
    const req = new NextRequest(`https://example.com/api/tasks/${TASK_ID}/follow-up`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ message: "info" }]),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_validation_failed");
  });
});
