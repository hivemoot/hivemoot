import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { TASK_ERROR, taskError } from "@/server/task-error";
import { extractTaskId } from "@/server/task-route-utils";
import { checkTaskCreateRateLimit, retryTask, TASK_ID_PATTERN } from "@/server/task-store";

export async function POST(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const { pathname } = new URL(request.url);
  const taskId = extractTaskId(pathname);

  if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
    return taskError(TASK_ERROR.INVALID_TASK_ID, "Invalid task id", 400);
  }

  try {
    const rateLimit = await checkTaskCreateRateLimit(
      auth.session.installationId,
      auth.session.userId,
      auth.redis,
    );

    if (!rateLimit.allowed) {
      return taskError(
        TASK_ERROR.RATE_LIMITED,
        "Too many task create requests. Please retry shortly.",
        429,
        { retry_after_secs: rateLimit.retryAfterSeconds },
      );
    }

    const result = await retryTask(auth.session.installationId, taskId, auth.redis);

    if (!result.ok) {
      if (result.reason === "not_found") {
        return taskError(TASK_ERROR.TASK_NOT_FOUND, "Task not found", 404);
      }
      if (result.reason === "concurrency_limited") {
        return taskError(
          TASK_ERROR.CONCURRENCY_LIMITED,
          "Maximum concurrent tasks reached (3)",
          429,
        );
      }
      return taskError(
        TASK_ERROR.INVALID_TRANSITION,
        "Only failed or timed-out tasks can be retried",
        409,
      );
    }

    return NextResponse.json(
      {
        task_id: result.task.task_id,
        status: result.task.status,
        timeout_secs: result.task.timeout_secs,
        stream_url: `/api/tasks/${result.task.task_id}/stream`,
        task: result.task,
      },
      { status: 202 },
    );
  } catch (error) {
    console.error("[tasks] Failed to retry task", {
      installationId: auth.session.installationId,
      taskId,
      error,
    });

    return taskError(TASK_ERROR.SERVER_ERROR, "Failed to retry task", 500);
  }
}
