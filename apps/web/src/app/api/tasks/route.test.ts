import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));

vi.mock("@/server/task-store", () => ({
  listRecentTasks: vi.fn(),
}));

import { authenticateByokRequest } from "@/server/byok-auth";
import { listRecentTasks } from "@/server/task-store";
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

  vi.mocked(listRecentTasks).mockResolvedValue([
    {
      task_id: "abc123abc123abc123abc123",
      status: "pending",
      engine: "codex",
      prompt: "Deep analysis",
      repos: ["hivemoot/hivemoot"],
      timeout_secs: 300,
      created_by: "queen",
      created_at: "2026-03-03T12:00:00.000Z",
      updated_at: "2026-03-03T12:00:00.000Z",
    },
  ]);
});

describe("GET /api/tasks", () => {
  it("returns recent tasks", async () => {
    const req = new NextRequest("https://example.com/api/tasks?limit=15");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(listRecentTasks).toHaveBeenCalledWith("inst-1", 15, expect.anything());

    const body = await res.json();
    expect(body.tasks).toHaveLength(1);
  });

  it("uses default limit when invalid", async () => {
    const req = new NextRequest("https://example.com/api/tasks?limit=abc");
    await GET(req);

    expect(listRecentTasks).toHaveBeenCalledWith("inst-1", 20, expect.anything());
  });

  it("forwards auth errors", async () => {
    vi.mocked(authenticateByokRequest).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "byok_not_authenticated" }, { status: 401 }),
    });

    const req = new NextRequest("https://example.com/api/tasks");
    const res = await GET(req);

    expect(res.status).toBe(401);
  });
});
