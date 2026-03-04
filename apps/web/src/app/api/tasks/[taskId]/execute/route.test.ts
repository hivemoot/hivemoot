import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/task-executor-auth", () => ({
  authenticateTaskExecutorRequest: vi.fn(),
}));

vi.mock("@/server/task-store", () => ({
  TASK_ID_PATTERN: /^[a-f0-9]{24}$/,
  getTask: vi.fn(),
  verifyTaskClaimToken: vi.fn(),
  setTaskProgress: vi.fn(),
  heartbeatTask: vi.fn(),
  completeTask: vi.fn(),
  failTask: vi.fn(),
  timeoutTask: vi.fn(),
  requestFollowUp: vi.fn(),
}));

import { authenticateTaskExecutorRequest } from "@/server/task-executor-auth";
import {
  getTask,
  verifyTaskClaimToken,
  setTaskProgress,
  heartbeatTask,
  completeTask,
  failTask,
  timeoutTask,
  requestFollowUp,
} from "@/server/task-store";
import { POST } from "./route";

const BASE_TASK = {
  task_id: "abc123abc123abc123abc123",
  status: "running" as const,
  prompt: "Deep analysis",
  repos: ["hivemoot/hivemoot"],
  timeout_secs: 300,
  created_by: "queen",
  created_at: "2026-03-03T12:00:00.000Z",
  updated_at: "2026-03-03T12:01:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(authenticateTaskExecutorRequest).mockResolvedValue({
    ok: true,
    installationId: "inst-1",
    redis: {} as never,
  });

  vi.mocked(getTask).mockResolvedValue(BASE_TASK);
  vi.mocked(verifyTaskClaimToken).mockResolvedValue(true);
  vi.mocked(setTaskProgress).mockResolvedValue({ ok: true, task: { ...BASE_TASK, progress: "step" } });
  vi.mocked(heartbeatTask).mockResolvedValue({ ok: true, task: { ...BASE_TASK } });
  vi.mocked(completeTask).mockResolvedValue({ ok: true, task: { ...BASE_TASK, status: "completed" } });
  vi.mocked(failTask).mockResolvedValue({ ok: true, task: { ...BASE_TASK, status: "failed" } });
  vi.mocked(timeoutTask).mockResolvedValue({ ok: true, task: { ...BASE_TASK, status: "timed_out" } });
  vi.mocked(requestFollowUp).mockResolvedValue({ ok: true, task: { ...BASE_TASK, status: "needs_follow_up" } });
});

function makeRequest(body: unknown, claimToken = "claim-token-1") {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (claimToken) {
    headers.set("x-task-claim-token", claimToken);
  }

  return new NextRequest("https://example.com/api/tasks/abc123abc123abc123abc123/execute", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/tasks/[taskId]/execute", () => {
  it("accepts progress updates for executor", async () => {
    const res = await POST(makeRequest({ action: "progress", progress: "Scanning" }));
    expect(res.status).toBe(200);
    expect(setTaskProgress).toHaveBeenCalledWith(
      "inst-1",
      "abc123abc123abc123abc123",
      "Scanning",
      expect.anything(),
    );
    expect(verifyTaskClaimToken).toHaveBeenCalledWith(
      "inst-1",
      "abc123abc123abc123abc123",
      "claim-token-1",
      expect.anything(),
    );
  });

  it("accepts completion updates for executor", async () => {
    const res = await POST(makeRequest({ action: "complete", result: "done" }));
    expect(res.status).toBe(200);
    expect(completeTask).toHaveBeenCalled();
  });

  it("accepts heartbeat updates for executor", async () => {
    const res = await POST(makeRequest({ action: "heartbeat" }));
    expect(res.status).toBe(200);
    expect(heartbeatTask).toHaveBeenCalledWith(
      "inst-1",
      "abc123abc123abc123abc123",
      expect.anything(),
    );
  });

  it("returns 401 when executor token is invalid", async () => {
    vi.mocked(authenticateTaskExecutorRequest).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "task_not_authenticated" }, { status: 401 }),
    });

    const res = await POST(makeRequest({ action: "progress", progress: "Scanning" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid task action", async () => {
    const res = await POST(makeRequest({ action: "unknown" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_action");
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await POST(makeRequest({ action: "complete" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_missing_fields");
  });

  it("returns 404 when task is missing for installation", async () => {
    vi.mocked(getTask).mockResolvedValue(null);
    const res = await POST(makeRequest({ action: "progress", progress: "Scanning" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("task_not_found");
  });

  it("returns 409 on invalid transition", async () => {
    vi.mocked(completeTask).mockResolvedValue({
      ok: false,
      reason: "invalid_transition",
    });

    const res = await POST(makeRequest({ action: "complete", result: "done" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_transition");
  });

  it("accepts request_follow_up action", async () => {
    const res = await POST(makeRequest({ action: "request_follow_up", message: "Need API key" }));
    expect(res.status).toBe(200);
    expect(requestFollowUp).toHaveBeenCalledWith(
      "inst-1",
      "abc123abc123abc123abc123",
      "Need API key",
      expect.anything(),
    );
  });

  it("returns 400 when message is missing for request_follow_up", async () => {
    const res = await POST(makeRequest({ action: "request_follow_up" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_missing_fields");
  });

  it("returns 409 when request_follow_up hits invalid_transition", async () => {
    vi.mocked(requestFollowUp).mockResolvedValue({
      ok: false,
      reason: "invalid_transition",
    });

    const res = await POST(makeRequest({ action: "request_follow_up", message: "Need info" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_transition");
  });

  it("returns 429 when concurrency limited", async () => {
    vi.mocked(setTaskProgress).mockResolvedValue({
      ok: false,
      reason: "concurrency_limited",
    });

    const res = await POST(makeRequest({ action: "progress", progress: "Scanning" }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("task_concurrency_limited");
  });

  it("returns 403 when claim token is missing", async () => {
    const res = await POST(makeRequest({ action: "progress", progress: "Scanning" }, ""));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("task_forbidden");
    expect(verifyTaskClaimToken).not.toHaveBeenCalled();
  });

  it("returns 403 when claim token is invalid", async () => {
    vi.mocked(verifyTaskClaimToken).mockResolvedValue(false);
    const res = await POST(makeRequest({ action: "progress", progress: "Scanning" }, "bad-token"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("task_forbidden");
  });
});
