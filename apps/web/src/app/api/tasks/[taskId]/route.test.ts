import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));

vi.mock("@/server/task-store", () => ({
  TASK_ID_PATTERN: /^[a-f0-9]{24}$/,
  deleteTask: vi.fn(),
  getTask: vi.fn(),
}));

import { authenticateByokRequest } from "@/server/byok-auth";
import { deleteTask, getTask } from "@/server/task-store";
import { DELETE, GET } from "./route";

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
    status: "pending",
    prompt: "Deep analysis",
    repos: ["hivemoot/hivemoot"],
    timeout_secs: 300,
    created_by: "queen",
    created_at: "2026-03-03T12:00:00.000Z",
    updated_at: "2026-03-03T12:00:00.000Z",
  });

  vi.mocked(deleteTask).mockResolvedValue({ ok: true });
});

describe("GET /api/tasks/[taskId]", () => {
  it("returns task details", async () => {
    const req = new NextRequest("https://example.com/api/tasks/abc123abc123abc123abc123");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(getTask).toHaveBeenCalledWith(
      "inst-1",
      "abc123abc123abc123abc123",
      expect.anything(),
    );

    const body = await res.json();
    expect(body.task.task_id).toBe("abc123abc123abc123abc123");
  });

  it("returns 400 on invalid task id", async () => {
    const req = new NextRequest("https://example.com/api/tasks/not-valid");
    const res = await GET(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_task_id");
  });

  it("returns 404 if task is missing", async () => {
    vi.mocked(getTask).mockResolvedValue(null);

    const req = new NextRequest("https://example.com/api/tasks/abc123abc123abc123abc123");
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

    const req = new NextRequest("https://example.com/api/tasks/abc123abc123abc123abc123");
    const res = await GET(req);

    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/tasks/[taskId]", () => {
  it("deletes a task", async () => {
    const req = new NextRequest("https://example.com/api/tasks/abc123abc123abc123abc123", {
      method: "DELETE",
    });
    const res = await DELETE(req);

    expect(res.status).toBe(200);
    expect(deleteTask).toHaveBeenCalledWith(
      "inst-1",
      "abc123abc123abc123abc123",
      expect.anything(),
    );

    const body = await res.json();
    expect(body).toEqual({ deleted: true });
  });

  it("returns 400 on invalid task id", async () => {
    const req = new NextRequest("https://example.com/api/tasks/not-valid", {
      method: "DELETE",
    });
    const res = await DELETE(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_task_id");
  });

  it("returns 404 when task is missing", async () => {
    vi.mocked(deleteTask).mockResolvedValue({ ok: false, reason: "not_found" });

    const req = new NextRequest("https://example.com/api/tasks/abc123abc123abc123abc123", {
      method: "DELETE",
    });
    const res = await DELETE(req);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("task_not_found");
  });

  it("returns 409 when task cannot be deleted", async () => {
    vi.mocked(deleteTask).mockResolvedValue({ ok: false, reason: "invalid_transition" });

    const req = new NextRequest("https://example.com/api/tasks/abc123abc123abc123abc123", {
      method: "DELETE",
    });
    const res = await DELETE(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_transition");
  });

  it("forwards auth failures", async () => {
    vi.mocked(authenticateByokRequest).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "byok_not_authenticated" }, { status: 401 }),
    });

    const req = new NextRequest("https://example.com/api/tasks/abc123abc123abc123abc123", {
      method: "DELETE",
    });
    const res = await DELETE(req);

    expect(res.status).toBe(401);
  });
});
