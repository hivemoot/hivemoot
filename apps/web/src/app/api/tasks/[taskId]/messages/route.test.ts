import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));

vi.mock("@/server/task-store", () => ({
  TASK_ID_PATTERN: /^[a-f0-9]{24}$/,
  addUserMessage: vi.fn(),
  getTask: vi.fn(),
  getTaskMessages: vi.fn(),
}));

import { authenticateByokRequest } from "@/server/byok-auth";
import { addUserMessage, getTask, getTaskMessages } from "@/server/task-store";
import { GET, POST } from "./route";

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

  vi.mocked(addUserMessage).mockResolvedValue({
    ok: true,
    task: {
      task_id: TASK_ID,
      status: "pending",
      prompt: "Investigate",
      repos: ["hivemoot/hivemoot"],
      timeout_secs: 300,
      created_by: "queen",
      created_at: "2026-03-03T12:00:00.000Z",
      updated_at: "2026-03-03T12:10:00.000Z",
      progress: "Re-queued with new message",
    },
  });
});

function makeGetRequest(taskId = TASK_ID) {
  return new NextRequest(`https://example.com/api/tasks/${taskId}/messages`, {
    method: "GET",
  });
}

function makePostRequest(
  body: unknown,
  taskId = TASK_ID,
  headers: Record<string, string> = {},
) {
  return new NextRequest(`https://example.com/api/tasks/${taskId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /api/tasks/[taskId]/messages", () => {
  it("returns messages for a valid task", async () => {
    const res = await GET(makeGetRequest());
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

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid task id", async () => {
    const res = await GET(makeGetRequest("bad-id"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_task_id");
  });

  it("returns 404 when task not found", async () => {
    vi.mocked(getTask).mockResolvedValue(null);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("task_not_found");
  });

  it("returns empty array when task has no messages", async () => {
    vi.mocked(getTaskMessages).mockResolvedValue([]);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });

  it("returns structured 500 when message retrieval fails unexpectedly", async () => {
    vi.mocked(getTaskMessages).mockRejectedValue(new Error("redis down"));

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("task_server_error");
  });
});

describe("POST /api/tasks/[taskId]/messages", () => {
  it("adds a user message for an eligible task", async () => {
    const res = await POST(makePostRequest({ message: "  More context please  " }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.task.task_id).toBe(TASK_ID);
    expect(addUserMessage).toHaveBeenCalledWith(
      "inst-1",
      TASK_ID,
      "More context please",
      expect.anything(),
    );
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(authenticateByokRequest).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "not_authenticated" }, { status: 401 }),
    });

    const res = await POST(makePostRequest({ message: "info" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid task id", async () => {
    const res = await POST(makePostRequest({ message: "info" }, "bad-id"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_task_id");
  });

  it("returns 413 when content-length exceeds max payload", async () => {
    const res = await POST(
      makePostRequest(
        { message: "ok" },
        TASK_ID,
        { "content-length": String(65 * 1024) },
      ),
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe("task_payload_too_large");
  });

  it("returns 413 when JSON body bytes exceed max payload", async () => {
    const res = await POST(makePostRequest({ message: "x".repeat(70 * 1024) }));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe("task_payload_too_large");
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await POST(makePostRequest("not json"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_json");
  });

  it("returns 400 when body is not an object", async () => {
    const res = await POST(makePostRequest([{ message: "info" }]));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_validation_failed");
  });

  it("returns 400 when message is missing", async () => {
    const res = await POST(makePostRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_missing_fields");
  });

  it("returns 400 when message is empty", async () => {
    const res = await POST(makePostRequest({ message: "   " }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_missing_fields");
  });

  it("returns 404 when task is not found", async () => {
    vi.mocked(addUserMessage).mockResolvedValue({ ok: false, reason: "not_found" });

    const res = await POST(makePostRequest({ message: "info" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("task_not_found");
  });

  it("returns 409 when task is in an invalid state", async () => {
    vi.mocked(addUserMessage).mockResolvedValue({ ok: false, reason: "invalid_transition" });

    const res = await POST(makePostRequest({ message: "info" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("task_follow_up_not_allowed");
  });

  it("returns 429 when concurrency limited", async () => {
    vi.mocked(addUserMessage).mockResolvedValue({ ok: false, reason: "concurrency_limited" });

    const res = await POST(makePostRequest({ message: "info" }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("task_concurrency_limited");
  });

  it("returns structured 500 when message persistence throws", async () => {
    vi.mocked(addUserMessage).mockRejectedValue(new Error("simulated write failure"));

    const res = await POST(makePostRequest({ message: "info" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("task_server_error");
  });
});
