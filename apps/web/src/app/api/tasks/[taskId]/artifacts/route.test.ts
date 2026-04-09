import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { TaskArtifact } from "@/server/task-store";

vi.mock("@/server/task-executor-auth", () => ({
  authenticateTaskExecutorRequest: vi.fn(),
}));

vi.mock("@/server/task-store", () => ({
  TASK_ID_PATTERN: /^[a-f0-9]{24}$/,
  appendTaskArtifacts: vi.fn(),
  getTask: vi.fn(),
  verifyTaskClaimToken: vi.fn(),
}));

import { authenticateTaskExecutorRequest } from "@/server/task-executor-auth";
import { appendTaskArtifacts, getTask, verifyTaskClaimToken } from "@/server/task-store";
import { POST } from "./route";

const BASE_TASK = {
  task_id: "abc123abc123abc123abc123",
  status: "running" as const,
  prompt: "Report outputs",
  repos: ["hivemoot/hivemoot"],
  timeout_secs: 300,
  created_by: "queen",
  created_at: "2026-03-03T12:00:00.000Z",
  updated_at: "2026-03-03T12:01:00.000Z",
};

const VALID_ARTIFACT = {
  url: "https://github.com/hivemoot/hivemoot/pull/1",
};

const STORED_ARTIFACTS: TaskArtifact[] = [
  {
    type: "pull_request",
    url: "https://github.com/hivemoot/hivemoot/pull/1",
    number: 1,
  },
];

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(authenticateTaskExecutorRequest).mockResolvedValue({
    ok: true,
    installationId: "inst-1",
    redis: {} as never,
  });

  vi.mocked(getTask).mockResolvedValue(BASE_TASK);
  vi.mocked(verifyTaskClaimToken).mockResolvedValue(true);
  vi.mocked(appendTaskArtifacts).mockResolvedValue({ ok: true, artifacts: STORED_ARTIFACTS });
});

function makeRequest(body: unknown, claimToken = "claim-token-1", contentLength?: number) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (claimToken) {
    headers.set("x-task-claim-token", claimToken);
  }
  if (contentLength !== undefined) {
    headers.set("content-length", String(contentLength));
  }

  return new NextRequest("https://example.com/api/tasks/abc123abc123abc123abc123/artifacts", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/tasks/[taskId]/artifacts", () => {
  it("appends artifacts and returns the current artifact list", async () => {
    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }));

    expect(res.status).toBe(200);
    expect(appendTaskArtifacts).toHaveBeenCalledWith(
      "inst-1",
      "abc123abc123abc123abc123",
      [VALID_ARTIFACT],
      expect.anything(),
    );
    expect(verifyTaskClaimToken).toHaveBeenCalledWith(
      "inst-1",
      "abc123abc123abc123abc123",
      "claim-token-1",
      expect.anything(),
    );

    const body = await res.json();
    expect(body.artifacts).toEqual(STORED_ARTIFACTS);
  });

  it("returns 404 for missing tasks before claim-token verification", async () => {
    vi.mocked(getTask).mockResolvedValue(null);

    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }));

    expect(res.status).toBe(404);
    expect(verifyTaskClaimToken).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.code).toBe("task_not_found");
  });

  it("returns 401 when executor auth fails", async () => {
    vi.mocked(authenticateTaskExecutorRequest).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "task_not_authenticated" }, { status: 401 }),
    });

    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }));
    expect(res.status).toBe(401);
  });

  it("returns 403 when claim token is missing", async () => {
    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }, ""));

    expect(res.status).toBe(403);
    expect(verifyTaskClaimToken).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.code).toBe("task_forbidden");
  });

  it("returns 403 when claim token is invalid", async () => {
    vi.mocked(verifyTaskClaimToken).mockResolvedValue(false);

    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }, "bad-token"));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("task_forbidden");
  });

  it("returns 413 when payload exceeds the byte limit", async () => {
    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }, "claim-token-1", 33 * 1024));

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe("task_payload_too_large");
  });

  it("returns 400 for invalid JSON", async () => {
    const headers = new Headers({
      "Content-Type": "application/json",
      "x-task-claim-token": "claim-token-1",
    });
    const req = new NextRequest("https://example.com/api/tasks/abc123abc123abc123abc123/artifacts", {
      method: "POST",
      headers,
      body: "not-json{",
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_json");
  });

  it("returns 400 when body is not a JSON object", async () => {
    const res = await POST(makeRequest([VALID_ARTIFACT]));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_validation_failed");
  });

  it("returns 400 when artifacts is missing", async () => {
    const res = await POST(makeRequest({}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_missing_fields");
  });

  it("returns 400 when artifacts is empty", async () => {
    const res = await POST(makeRequest({ artifacts: [] }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_validation_failed");
  });

  it("returns 400 when a request contains more than 20 artifacts", async () => {
    const artifacts = Array.from({ length: 21 }, () => VALID_ARTIFACT);

    const res = await POST(makeRequest({ artifacts }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_validation_failed");
  });

  it("returns 409 when the per-task artifact cap has been reached", async () => {
    vi.mocked(appendTaskArtifacts).mockResolvedValue({ ok: false, reason: "cap_exceeded" });

    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("task_validation_failed");
  });

  it("returns 400 when artifact validation fails", async () => {
    vi.mocked(appendTaskArtifacts).mockResolvedValue({ ok: false, reason: "validation_failed" });

    const res = await POST(makeRequest({ artifacts: [{ url: "https://evil.example.com/pr/1" }] }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_validation_failed");
  });

  it("returns 429 on task lock contention", async () => {
    vi.mocked(appendTaskArtifacts).mockResolvedValue({ ok: false, reason: "lock_timeout" });

    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }));

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("task_lock_timeout");
  });

  it("returns 500 when appendTaskArtifacts throws unexpectedly", async () => {
    vi.mocked(appendTaskArtifacts).mockRejectedValue(new Error("redis down"));

    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("task_server_error");
  });
});
