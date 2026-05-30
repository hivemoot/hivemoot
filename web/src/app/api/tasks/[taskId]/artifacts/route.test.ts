import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/agent-token-v1-auth", () => ({
  authenticateAgentRequestV1: vi.fn(),
}));

vi.mock("@/server/task-store", () => ({
  TASK_ID_PATTERN: /^[a-f0-9]{24}$/,
  MAX_ARTIFACTS_PER_TASK: 20,
  getTask: vi.fn(),
  verifyTaskClaimToken: vi.fn(),
  validateTaskArtifacts: vi.fn(),
  addTaskArtifacts: vi.fn(),
}));

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  getTask,
  verifyTaskClaimToken,
  validateTaskArtifacts,
  addTaskArtifacts,
} from "@/server/task-store";
import { POST } from "./route";

const TASK_ID = "abc123abc123abc123abc123";
const PR_URL = "https://github.com/hivemoot/hivemoot/pull/312";

const BASE_TASK = {
  task_id: TASK_ID,
  status: "running" as const,
  prompt: "Build it",
  timeout_secs: 300,
  created_by: "queen",
  created_at: "2026-03-03T12:00:00.000Z",
  updated_at: "2026-03-03T12:01:00.000Z",
};

const NORMALIZED = [{ type: "pull_request" as const, url: PR_URL, number: 312 }];

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(authenticateAgentRequestV1).mockResolvedValue({
    ok: true,
    installationId: "inst-1",
    name: "test-worker",
    agent_role: "worker",
    capabilities: ["tasks.progress"],
    envelope: {
      installationId: "inst-1",
      name: "test-worker",
      agent_role: "worker",
      capabilities: ["tasks.progress"],
      tokenHash: "stub",
      fingerprint: "stub0001",
      createdAt: "2026-04-30T00:00:00Z",
      createdBy: "test",
      expiresAt: null,
    } as never,
    redis: {} as never,
  } as never);

  vi.mocked(getTask).mockResolvedValue(BASE_TASK);
  vi.mocked(verifyTaskClaimToken).mockResolvedValue(true);
  vi.mocked(validateTaskArtifacts).mockReturnValue({ ok: true, artifacts: NORMALIZED });
  vi.mocked(addTaskArtifacts).mockResolvedValue({
    ok: true,
    task: { ...BASE_TASK, artifacts: [{ ...NORMALIZED[0], created_at: BASE_TASK.updated_at }] },
    added: 1,
  });
});

function makeRequest(body: unknown, { claimToken = "claim-token-1", taskId = TASK_ID } = {}) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (claimToken) headers.set("x-task-claim-token", claimToken);

  return new NextRequest(`https://example.com/api/tasks/${taskId}/artifacts`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/tasks/[taskId]/artifacts", () => {
  it("records artifacts and returns the updated task", async () => {
    const res = await POST(makeRequest({ artifacts: [{ type: "pull_request", url: PR_URL }] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(1);
    expect(body.task.artifacts).toHaveLength(1);
    expect(addTaskArtifacts).toHaveBeenCalledWith("inst-1", TASK_ID, NORMALIZED, expect.anything());
    expect(verifyTaskClaimToken).toHaveBeenCalledWith("inst-1", TASK_ID, "claim-token-1", expect.anything());
  });

  it("returns 401 when the agent token is invalid", async () => {
    vi.mocked(authenticateAgentRequestV1).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "agent_auth_v1_missing_bearer" }, { status: 401 }),
    });
    const res = await POST(makeRequest({ artifacts: [{ type: "pull_request", url: PR_URL }] }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for an invalid task id", async () => {
    const res = await POST(makeRequest({ artifacts: [] }, { taskId: "not-a-task" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_task_id");
  });

  it("returns 400 when the body is not an object", async () => {
    const res = await POST(makeRequest([1, 2, 3]));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_validation_failed");
  });

  it("returns 400 when artifact validation fails", async () => {
    vi.mocked(validateTaskArtifacts).mockReturnValue({
      ok: false,
      message: "artifacts[0]: url must be on github.com",
    });
    const res = await POST(makeRequest({ artifacts: [{ type: "issue", url: "https://evil.test/x" }] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_validation_failed");
    expect(body.message).toContain("github.com");
    expect(addTaskArtifacts).not.toHaveBeenCalled();
  });

  it("returns 404 when the task is missing for the installation", async () => {
    vi.mocked(getTask).mockResolvedValue(null);
    const res = await POST(makeRequest({ artifacts: [{ type: "pull_request", url: PR_URL }] }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("task_not_found");
  });

  it("returns 403 when the claim token is missing", async () => {
    const res = await POST(makeRequest({ artifacts: [{ type: "pull_request", url: PR_URL }] }, { claimToken: "" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("task_forbidden");
    expect(verifyTaskClaimToken).not.toHaveBeenCalled();
  });

  it("returns 403 when the claim token is invalid", async () => {
    vi.mocked(verifyTaskClaimToken).mockResolvedValue(false);
    const res = await POST(makeRequest({ artifacts: [{ type: "pull_request", url: PR_URL }] }, { claimToken: "bad" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("task_forbidden");
    expect(addTaskArtifacts).not.toHaveBeenCalled();
  });

  it("returns 409 when the task is not running", async () => {
    vi.mocked(addTaskArtifacts).mockResolvedValue({ ok: false, reason: "invalid_transition" });
    const res = await POST(makeRequest({ artifacts: [{ type: "pull_request", url: PR_URL }] }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_transition");
  });

  it("returns 409 with a distinct code when the artifact cap is hit", async () => {
    vi.mocked(addTaskArtifacts).mockResolvedValue({ ok: false, reason: "limit_exceeded" });
    const res = await POST(makeRequest({ artifacts: [{ type: "pull_request", url: PR_URL }] }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("task_artifact_limit_exceeded");
  });

  it("returns 429 when the lock acquisition times out", async () => {
    vi.mocked(addTaskArtifacts).mockResolvedValue({ ok: false, reason: "lock_timeout" });
    const res = await POST(makeRequest({ artifacts: [{ type: "pull_request", url: PR_URL }] }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("task_lock_timeout");
  });

  it("returns 500 when getTask throws", async () => {
    vi.mocked(getTask).mockRejectedValue(new Error("redis down"));
    const res = await POST(makeRequest({ artifacts: [{ type: "pull_request", url: PR_URL }] }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("task_server_error");
  });
});
