import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));

vi.mock("@/server/task-store", () => ({
  TASK_ID_PATTERN: /^[a-f0-9]{24}$/,
  getTask: vi.fn(),
}));

import { authenticateByokRequest } from "@/server/byok-auth";
import { getTask } from "@/server/task-store";
import { GET } from "./route";

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

  vi.mocked(getTask).mockResolvedValue({
    task_id: "abc123abc123abc123abc123",
    status: "completed",
    prompt: "Deep analysis",
    repos: ["hivemoot/hivemoot"],
    timeout_secs: 300,
    created_by: "queen",
    created_at: "2026-03-03T12:00:00.000Z",
    updated_at: "2026-03-03T12:00:00.000Z",
    finished_at: "2026-03-03T12:01:00.000Z",
    result: "done",
  });
});

describe("GET /api/tasks/[taskId]/stream", () => {
  it("returns SSE snapshot and done events for terminal task", async () => {
    const req = new NextRequest("https://example.com/api/tasks/abc123abc123abc123abc123/stream");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("event: snapshot");
    expect(text).toContain("event: done");
  });

  it("returns SSE snapshot and done events for needs_follow_up task", async () => {
    vi.mocked(getTask).mockResolvedValue({
      task_id: "abc123abc123abc123abc123",
      status: "needs_follow_up",
        prompt: "Deep analysis",
      repos: ["hivemoot/hivemoot"],
      timeout_secs: 300,
      created_by: "queen",
      created_at: "2026-03-03T12:00:00.000Z",
      updated_at: "2026-03-03T12:00:00.000Z",
      progress: "Need more context",
    });

    const req = new NextRequest("https://example.com/api/tasks/abc123abc123abc123abc123/stream");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: snapshot");
    expect(text).toContain("event: done");
  });

  it("returns 400 for invalid task id", async () => {
    const req = new NextRequest("https://example.com/api/tasks/not-valid/stream");
    const res = await GET(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_task_id");
  });

  it("returns 404 when task does not exist", async () => {
    vi.mocked(getTask).mockResolvedValue(null);

    const req = new NextRequest("https://example.com/api/tasks/abc123abc123abc123abc123/stream");
    const res = await GET(req);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("task_not_found");
  });

  it("forwards auth failures", async () => {
    vi.mocked(authenticateByokRequest).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "byok_not_authenticated" }, { status: 401 }),
    });

    const req = new NextRequest("https://example.com/api/tasks/abc123abc123abc123abc123/stream");
    const res = await GET(req);

    expect(res.status).toBe(401);
  });
});
