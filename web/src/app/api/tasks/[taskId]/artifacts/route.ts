import { NextRequest, NextResponse } from "next/server";
import { parseContentLength } from "@/server/request-utils";
import { extractTaskId } from "@/server/task-route-utils";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { TASK_ERROR, taskError } from "@/server/task-error";
import {
  addTaskArtifacts,
  getTask,
  MAX_ARTIFACTS_PER_TASK,
  TASK_ID_PATTERN,
  validateTaskArtifacts,
  verifyTaskClaimToken,
} from "@/server/task-store";

// Matches the execute route's ceiling — artifact batches are tiny, but the
// shared limit keeps the agent-facing task API consistent.
const MAX_PAYLOAD_BYTES = 128 * 1024;
const textEncoder = new TextEncoder();

/**
 * POST /api/tasks/{taskId}/artifacts — agents declare structured GitHub
 * outputs (PRs, issues, comments, commits) they produced while working a task
 * (#332).
 *
 * Auth mirrors the execute route: a `tasks.progress` bearer plus the per-task
 * `x-task-claim-token` proving the caller is the agent currently working this
 * task. Append-only and deduped by URL, so mid-task retries are idempotent.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateAgentRequestV1(request, {
    requires: "tasks.progress",
  });
  if (!auth.ok) return auth.response;

  const { pathname } = new URL(request.url);
  const taskId = extractTaskId(pathname);
  if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
    return taskError(TASK_ERROR.INVALID_TASK_ID, "Invalid task id", 400);
  }

  const contentLength = parseContentLength(request.headers.get("content-length"));
  if (contentLength !== null && contentLength > MAX_PAYLOAD_BYTES) {
    return taskError(TASK_ERROR.PAYLOAD_TOO_LARGE, "Payload too large (max 128KB)", 413);
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return taskError(TASK_ERROR.INVALID_JSON, "Invalid JSON body", 400);
  }

  if (textEncoder.encode(bodyText).length > MAX_PAYLOAD_BYTES) {
    return taskError(TASK_ERROR.PAYLOAD_TOO_LARGE, "Payload too large (max 128KB)", 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return taskError(TASK_ERROR.INVALID_JSON, "Invalid JSON body", 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return taskError(TASK_ERROR.VALIDATION_FAILED, "Body must be a JSON object", 400);
  }

  const obj = body as Record<string, unknown>;

  // Validate URLs/shape before any Redis work. Scope to the bearer's
  // allowed_repos when its policy declares them (additive to the
  // installation boundary the lookup already enforces).
  const validation = validateTaskArtifacts(obj.artifacts, {
    allowedRepos: auth.envelope.policy?.allowed_repos,
  });
  if (!validation.ok) {
    return taskError(TASK_ERROR.VALIDATION_FAILED, validation.message, 400);
  }

  try {
    // Installation scoping from the executor token enforces tenant isolation.
    const existingTask = await getTask(auth.installationId, taskId, auth.redis);
    if (!existingTask) {
      return taskError(TASK_ERROR.TASK_NOT_FOUND, "Task not found", 404);
    }

    const claimToken = request.headers.get("x-task-claim-token")?.trim() ?? "";
    if (!claimToken) {
      return taskError(TASK_ERROR.FORBIDDEN, "Missing task claim token", 403);
    }

    const validClaimToken = await verifyTaskClaimToken(
      auth.installationId,
      taskId,
      claimToken,
      auth.redis,
    );
    if (!validClaimToken) {
      return taskError(TASK_ERROR.FORBIDDEN, "Invalid or expired task claim token", 403);
    }

    const result = await addTaskArtifacts(
      auth.installationId,
      taskId,
      validation.artifacts,
      auth.redis,
    );

    if (result.ok) {
      return NextResponse.json({ task: result.task, added: result.added });
    }

    if (result.reason === "not_found") {
      return taskError(TASK_ERROR.TASK_NOT_FOUND, "Task not found", 404);
    }
    if (result.reason === "invalid_transition") {
      return taskError(
        TASK_ERROR.INVALID_TRANSITION,
        "Artifacts can only be reported while the task is running",
        409,
      );
    }
    if (result.reason === "limit_exceeded") {
      return taskError(
        TASK_ERROR.ARTIFACT_LIMIT_EXCEEDED,
        `Task already has the maximum of ${MAX_ARTIFACTS_PER_TASK} artifacts`,
        409,
      );
    }
    return taskError(
      TASK_ERROR.LOCK_TIMEOUT,
      "Task state is temporarily busy, retry shortly",
      429,
    );
  } catch (error) {
    console.error("[tasks] Failed to record task artifacts", {
      installationId: auth.installationId,
      taskId,
      error,
    });
    return taskError(TASK_ERROR.SERVER_ERROR, "Failed to record task artifacts", 500);
  }
}
