import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));

vi.mock("@/server/task-store", () => ({
  TASK_ID_PATTERN: /^[a-f0-9]{24}$/,
  getTask: vi.fn(),
  getTaskMessages: vi.fn(),
}));

import { authenticateByokRequest } from "@/server/byok-auth";
import { getTask, getTaskMessages } from "@/server/task-store";
import { GET } from "./route";

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

  vi.mocked(getTask).mockResolvedValue({
    task_id: TASK_ID,
    status: "running",
    prompt: "Investigate",
    repos: ["hivemoot/hivemoot"],
    timeout_secs: 300,
    created_by: "queen",
    created_at: "2026-03-03T12:00:00.000Z",
    updated_at: "2026-03-03T12:01:00.000Z",
  });

  vi.mocked(getTaskMessages).mockResolvedValue([
    { role: "user", content: "Investigate", created_at: "2026-03-03T12:00:00.000Z" },
    { role: "agent", content: "Working on it", created_at: "2026-03-03T12:01:00.000Z" },
  ]);
});

function makeRequest(taskId = TASK_ID) {
  return new NextRequest(`https://example.com/api/tasks/${taskId}/messages`, {
    method: "GET",
  });
}

describe("GET /api/tasks/[taskId]/messages", () => {
  it("returns messages for a valid task", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].role).toBe("agent");
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(authenticateByokRequest).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "not_authenticated" }, { status: 401 }),
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid task id", async () => {
    const res = await GET(makeRequest("bad-id"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_task_id");
  });

  it("returns 404 when task not found", async () => {
    vi.mocked(getTask).mockResolvedValue(null);

    const res = await GET(makeRequest());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("task_not_found");
  });

  it("returns empty array when task has no messages", async () => {
    vi.mocked(getTaskMessages).mockResolvedValue([]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });
});
