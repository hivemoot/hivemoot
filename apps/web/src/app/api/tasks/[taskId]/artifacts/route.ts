import { NextRequest, NextResponse } from "next/server";
import { extractTaskId } from "@/server/task-route-utils";
import { authenticateTaskExecutorRequest } from "@/server/task-executor-auth";
import { TASK_ERROR, taskError } from "@/server/task-error";
import {
  addTaskArtifacts,
  getTask,
  TASK_ID_PATTERN,
  validateTaskArtifacts,
  verifyTaskClaimToken,
} from "@/server/task-store";

export async function POST(request: NextRequest) {
  const auth = await authenticateTaskExecutorRequest(request);
  if (!auth.ok) return auth.response;

  const { pathname } = new URL(request.url);
  const taskId = extractTaskId(pathname);
  if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
    return taskError(TASK_ERROR.INVALID_TASK_ID, "Invalid task id", 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return taskError(TASK_ERROR.INVALID_JSON, "Invalid JSON body", 400);
  }

  const validated = validateTaskArtifacts(body);
  if (!validated.ok) {
    return taskError(TASK_ERROR.VALIDATION_FAILED, validated.message, 400);
  }

  try {
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
      validated.artifacts,
      auth.redis,
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return taskError(TASK_ERROR.TASK_NOT_FOUND, "Task not found", 404);
      }
      if (result.reason === "invalid_url") {
        return taskError(
          TASK_ERROR.VALIDATION_FAILED,
          "Artifact URLs must be scoped to the task's repos",
          422,
        );
      }
      if (result.reason === "artifact_cap_exceeded") {
        return taskError(
          TASK_ERROR.VALIDATION_FAILED,
          "Artifact cap reached (max 20 per task)",
          409,
        );
      }
      return taskError(TASK_ERROR.LOCK_TIMEOUT, "Task state is temporarily busy, retry shortly", 429);
    }

    return NextResponse.json({ task: result.task });
  } catch (error) {
    console.error("[tasks] Failed to add artifacts", {
      installationId: auth.installationId,
      taskId,
      error,
    });
    return taskError(TASK_ERROR.SERVER_ERROR, "Failed to add artifacts", 500);
  }
}
