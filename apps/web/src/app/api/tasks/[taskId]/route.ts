import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { TASK_ERROR, taskError } from "@/server/task-error";
import { extractTaskId } from "@/server/task-route-utils";
import { deleteTask, getTask, TASK_ID_PATTERN } from "@/server/task-store";

export async function GET(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const { pathname } = new URL(request.url);
  const taskId = extractTaskId(pathname);

  if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
    return taskError(TASK_ERROR.INVALID_TASK_ID, "Invalid task id", 400);
  }

  try {
    const task = await getTask(auth.session.installationId, taskId, auth.redis);
    if (!task) {
      return taskError(TASK_ERROR.TASK_NOT_FOUND, "Task not found", 404);
    }
    return NextResponse.json({ task });
  } catch (error) {
    console.error("[tasks] Failed to fetch task", {
      installationId: auth.session.installationId,
      taskId,
      error,
    });

    return taskError(TASK_ERROR.SERVER_ERROR, "Failed to load task", 500);
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const { pathname } = new URL(request.url);
  const taskId = extractTaskId(pathname);

  if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
    return taskError(TASK_ERROR.INVALID_TASK_ID, "Invalid task id", 400);
  }

  try {
    const result = await deleteTask(auth.session.installationId, taskId, auth.redis);

    if (!result.ok) {
      if (result.reason === "not_found") {
        return taskError(TASK_ERROR.TASK_NOT_FOUND, "Task not found", 404);
      }
      return taskError(
        TASK_ERROR.INVALID_TRANSITION,
        "Running tasks cannot be deleted",
        409,
      );
    }

    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error("[tasks] Failed to delete task", {
      installationId: auth.session.installationId,
      taskId,
      error,
    });

    return taskError(TASK_ERROR.SERVER_ERROR, "Failed to delete task", 500);
  }
}
