import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { TASK_ERROR, taskError } from "@/server/task-error";
import { extractTaskId } from "@/server/task-route-utils";
import { getTask, getTaskMessages, TASK_ID_PATTERN } from "@/server/task-store";

export async function GET(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const { pathname } = new URL(request.url);
  const taskId = extractTaskId(pathname);
  if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
    return taskError(TASK_ERROR.INVALID_TASK_ID, "Invalid task id", 400);
  }

  const task = await getTask(auth.session.installationId, taskId, auth.redis);
  if (!task) {
    return taskError(TASK_ERROR.TASK_NOT_FOUND, "Task not found", 404);
  }

  const messages = await getTaskMessages(
    auth.session.installationId,
    taskId,
    auth.redis,
  );

  return NextResponse.json({ messages });
}
