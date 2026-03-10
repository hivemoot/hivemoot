import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { TaskArtifact } from "@/server/task-store";

vi.mock("@/server/task-executor-auth", () => ({
  authenticateTaskExecutorRequest: vi.fn(),
}));

vi.mock("@/server/task-store", () => ({
  TASK_ID_PATTERN: /^[a-f0-9]{24}$/,
  getTask: vi.fn(),
  verifyTaskClaimToken: vi.fn(),
  appendTaskArtifacts: vi.fn(),
}));

import { authenticateTaskExecutorRequest } from "@/server/task-executor-auth";
import { getTask, verifyTaskClaimToken, appendTaskArtifacts } from "@/server/task-store";
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
  type: "pull_request",
  url: "https://github.com/hivemoot/hivemoot/pull/1",
};

const STORED_ARTIFACTS: TaskArtifact[] = [{ type: "pull_request", url: "https://github.com/hivemoot/hivemoot/pull/1" }];

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
  it("appends artifacts and returns current artifact list", async () => {
    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.artifacts).toEqual(STORED_ARTIFACTS);
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
  });

  it("returns 404 when task does not exist — before claim-token check", async () => {
    vi.mocked(getTask).mockResolvedValue(null);
    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("task_not_found");
    // verifyTaskClaimToken must not have been called — a missing task should not
    // produce a misleading 403 from a failed token lookup.
    expect(verifyTaskClaimToken).not.toHaveBeenCalled();
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
    const body = await res.json();
    expect(body.code).toBe("task_forbidden");
    expect(verifyTaskClaimToken).not.toHaveBeenCalled();
  });

  it("returns 403 when claim token is invalid", async () => {
    vi.mocked(verifyTaskClaimToken).mockResolvedValue(false);
    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }, "bad-token"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("task_forbidden");
  });

  it("returns 413 when content-length header exceeds limit", async () => {
    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }, "claim-token-1", 33 * 1024));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe("task_payload_too_large");
  });

  it("returns 400 for invalid JSON body", async () => {
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

  it("returns 400 when artifacts field is missing", async () => {
    const res = await POST(makeRequest({ other: "field" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_missing_fields");
  });

  it("returns 400 when artifacts array is empty", async () => {
    const res = await POST(makeRequest({ artifacts: [] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_validation_failed");
  });

  it("returns 400 when artifacts array exceeds 20 entries per request", async () => {
    const tooMany = Array.from({ length: 21 }, () => VALID_ARTIFACT);
    const res = await POST(makeRequest({ artifacts: tooMany }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_validation_failed");
  });

  it("returns 409 when task artifact cap is reached", async () => {
    vi.mocked(appendTaskArtifacts).mockResolvedValue({ ok: false, reason: "cap_exceeded" });
    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("task_validation_failed");
  });

  it("returns 404 when appendTaskArtifacts reports task not found", async () => {
    vi.mocked(appendTaskArtifacts).mockResolvedValue({ ok: false, reason: "not_found" });
    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("task_not_found");
  });

  it("returns 400 when appendTaskArtifacts reports validation_failed", async () => {
    vi.mocked(appendTaskArtifacts).mockResolvedValue({ ok: false, reason: "validation_failed" });
    const res = await POST(makeRequest({ artifacts: [{ type: "pull_request", url: "https://evil.com/x" }] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_validation_failed");
  });
});
