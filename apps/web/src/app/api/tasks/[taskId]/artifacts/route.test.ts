import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/server/task-executor-auth", () => ({
  authenticateTaskExecutorRequest: vi.fn(),
}));

vi.mock("@/server/task-store", () => ({
  TASK_ID_PATTERN: /^[a-f0-9]{24}$/,
  getTask: vi.fn(),
  verifyTaskClaimToken: vi.fn(),
  validateTaskArtifacts: vi.fn(),
  addTaskArtifacts: vi.fn(),
}));

import { authenticateTaskExecutorRequest } from "@/server/task-executor-auth";
import {
  addTaskArtifacts,
  getTask,
  validateTaskArtifacts,
  verifyTaskClaimToken,
} from "@/server/task-store";
import { POST } from "./route";

const BASE_TASK = {
  task_id: "abc123abc123abc123abc123",
  status: "running" as const,
  prompt: "Open a PR fixing issue #42",
  repos: ["hivemoot/hivemoot"],
  timeout_secs: 300,
  created_by: "queen",
  created_at: "2026-03-03T12:00:00.000Z",
  updated_at: "2026-03-03T12:01:00.000Z",
};

const VALID_ARTIFACT = {
  type: "pull_request" as const,
  url: "https://github.com/hivemoot/hivemoot/pull/312",
  number: 312,
  title: "fix: resolve issue #42",
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
  vi.mocked(validateTaskArtifacts).mockReturnValue({
    ok: true,
    artifacts: [VALID_ARTIFACT],
  });
  vi.mocked(addTaskArtifacts).mockResolvedValue({
    ok: true,
    task: { ...BASE_TASK, artifacts: [VALID_ARTIFACT] },
  });
});

function makeRequest(body: unknown, claimToken = "claim-token-1") {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (claimToken) {
    headers.set("x-task-claim-token", claimToken);
  }

  return new NextRequest(
    "https://example.com/api/tasks/abc123abc123abc123abc123/artifacts",
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
}

describe("POST /api/tasks/[taskId]/artifacts", () => {
  it("returns 401 when bearer token auth fails", async () => {
    vi.mocked(authenticateTaskExecutorRequest).mockResolvedValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ code: "task_not_authenticated" }), {
        status: 401,
      }) as never,
    });

    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid task id format", async () => {
    const req = new NextRequest(
      "https://example.com/api/tasks/not-a-valid-id/artifacts",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-task-claim-token": "tok",
        },
        body: JSON.stringify({ artifacts: [VALID_ARTIFACT] }),
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_task_id");
  });

  it("returns 400 when body is not valid JSON", async () => {
    const req = new NextRequest(
      "https://example.com/api/tasks/abc123abc123abc123abc123/artifacts",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-task-claim-token": "tok",
        },
        body: "not-json{",
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_invalid_json");
  });

  it("returns 400 when artifact validation fails", async () => {
    vi.mocked(validateTaskArtifacts).mockReturnValueOnce({
      ok: false,
      message: "artifacts must be an array",
    });

    const res = await POST(makeRequest({ artifacts: "not-an-array" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("task_validation_failed");
    expect(body.message).toBe("artifacts must be an array");
  });

  it("returns 404 when task does not exist", async () => {
    vi.mocked(getTask).mockResolvedValueOnce(null);

    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("task_not_found");
  });

  it("returns 403 when claim token header is missing", async () => {
    const req = new NextRequest(
      "https://example.com/api/tasks/abc123abc123abc123abc123/artifacts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifacts: [VALID_ARTIFACT] }),
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("task_forbidden");
  });

  it("returns 403 when claim token is invalid", async () => {
    vi.mocked(verifyTaskClaimToken).mockResolvedValueOnce(false);

    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }, "wrong-token"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("task_forbidden");
  });

  it("returns 422 when artifact URL is not scoped to task repos", async () => {
    vi.mocked(addTaskArtifacts).mockResolvedValueOnce({
      ok: false,
      reason: "invalid_url",
    });

    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("task_validation_failed");
  });

  it("returns 409 when artifact cap is exceeded", async () => {
    vi.mocked(addTaskArtifacts).mockResolvedValueOnce({
      ok: false,
      reason: "artifact_cap_exceeded",
    });

    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("task_validation_failed");
  });

  it("returns 429 on lock timeout", async () => {
    vi.mocked(addTaskArtifacts).mockResolvedValueOnce({
      ok: false,
      reason: "lock_timeout",
    });

    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }));
    expect(res.status).toBe(429);
  });

  it("stores artifact and returns updated task on success", async () => {
    const res = await POST(makeRequest({ artifacts: [VALID_ARTIFACT] }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.task.artifacts).toHaveLength(1);
    expect(body.task.artifacts[0].type).toBe("pull_request");
    expect(body.task.artifacts[0].url).toBe(
      "https://github.com/hivemoot/hivemoot/pull/312",
    );

    expect(addTaskArtifacts).toHaveBeenCalledWith(
      "inst-1",
      "abc123abc123abc123abc123",
      [VALID_ARTIFACT],
      expect.anything(),
    );
  });

  it("passes validated artifacts to addTaskArtifacts, not raw body", async () => {
    const raw = { artifacts: [{ type: "issue", url: "https://github.com/hivemoot/hivemoot/issues/1" }] };
    const cleanedArtifact = { type: "issue" as const, url: "https://github.com/hivemoot/hivemoot/issues/1" };
    vi.mocked(validateTaskArtifacts).mockReturnValueOnce({ ok: true, artifacts: [cleanedArtifact] });
    vi.mocked(addTaskArtifacts).mockResolvedValueOnce({
      ok: true,
      task: { ...BASE_TASK, artifacts: [cleanedArtifact] },
    });

    await POST(makeRequest(raw));

    expect(addTaskArtifacts).toHaveBeenCalledWith(
      "inst-1",
      "abc123abc123abc123abc123",
      [cleanedArtifact],
      expect.anything(),
    );
  });
});
