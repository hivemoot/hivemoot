import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/task-executor-auth", () => ({
  authenticateTaskExecutorRequest: vi.fn(),
}));

vi.mock("@/server/task-store", () => ({
  claimNextPendingTask: vi.fn(),
  getTaskMessages: vi.fn(),
}));

import { authenticateTaskExecutorRequest } from "@/server/task-executor-auth";
import { claimNextPendingTask, getTaskMessages } from "@/server/task-store";
import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(authenticateTaskExecutorRequest).mockResolvedValue({
    ok: true,
    installationId: "inst-1",
    redis: {} as never,
  });

  vi.mocked(getTaskMessages).mockResolvedValue([
    { role: "user", content: "Initial prompt", created_at: "2026-03-03T12:00:00.000Z" },
  ]);
});

describe("POST /api/tasks/claim", () => {
  it("returns claimed task", async () => {
    vi.mocked(claimNextPendingTask).mockResolvedValue({
      claim_token: "claim-token-abc",
      task: {
        task_id: "abc123abc123abc123abc123",
        status: "running",
        prompt: "Deep analysis",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
        created_by: "queen",
        created_at: "2026-03-03T12:00:00.000Z",
        updated_at: "2026-03-03T12:00:00.000Z",
        started_at: "2026-03-03T12:01:00.000Z",
        progress: "Running",
      },
    });

    const req = new NextRequest("https://example.com/api/tasks/claim", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claim_token).toBe("claim-token-abc");
    expect(body.task.task_id).toBe("abc123abc123abc123abc123");
    expect(body.messages).toHaveLength(1);
    expect(body.messagesError).toBe(false);
    expect(claimNextPendingTask).toHaveBeenCalledWith("inst-1", expect.anything());
    expect(getTaskMessages).toHaveBeenCalledWith(
      "inst-1",
      "abc123abc123abc123abc123",
      expect.anything(),
    );
  });

  it("returns 204 when no task is pending", async () => {
    vi.mocked(claimNextPendingTask).mockResolvedValue(null);

    const req = new NextRequest("https://example.com/api/tasks/claim", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(204);
  });

  it("returns claimed task with messagesError when message fetch fails", async () => {
    vi.mocked(claimNextPendingTask).mockResolvedValue({
      claim_token: "claim-token-abc",
      task: {
        task_id: "abc123abc123abc123abc123",
        status: "running",
        prompt: "Deep analysis",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
        created_by: "queen",
        created_at: "2026-03-03T12:00:00.000Z",
        updated_at: "2026-03-03T12:00:00.000Z",
        started_at: "2026-03-03T12:01:00.000Z",
        progress: "Running",
      },
    });
    vi.mocked(getTaskMessages).mockRejectedValue(new Error("redis down"));

    const req = new NextRequest("https://example.com/api/tasks/claim", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.task_id).toBe("abc123abc123abc123abc123");
    expect(body.messages).toEqual([]);
    expect(body.messagesError).toBe(true);
  });

  it("forwards auth failures", async () => {
    vi.mocked(authenticateTaskExecutorRequest).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "task_not_authenticated" }, { status: 401 }),
    });

    const req = new NextRequest("https://example.com/api/tasks/claim", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(401);
  });
});
