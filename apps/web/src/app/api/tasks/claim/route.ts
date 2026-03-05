import { NextRequest, NextResponse } from "next/server";
import { authenticateTaskExecutorRequest } from "@/server/task-executor-auth";
import { TASK_ERROR, taskError } from "@/server/task-error";
import { claimNextPendingTask, getTaskMessages } from "@/server/task-store";

export async function POST(request: NextRequest) {
  const auth = await authenticateTaskExecutorRequest(request);
  if (!auth.ok) return auth.response;

  try {
    const claimed = await claimNextPendingTask(auth.installationId, auth.redis);
    if (!claimed) {
      return new NextResponse(null, { status: 204 });
    }

    // Include full message history so the agent has conversation context
    // (especially important for follow-up and revived terminal tasks).
    // Best-effort: if message retrieval fails, return the task anyway
    // since the agent can still use task.prompt for the initial instruction.
    let messages: Awaited<ReturnType<typeof getTaskMessages>> = [];
    try {
      messages = await getTaskMessages(auth.installationId, claimed.task.task_id, auth.redis);
    } catch (error) {
      console.error("[tasks] Failed to fetch messages for claimed task", {
        installationId: auth.installationId,
        taskId: claimed.task.task_id,
        error,
      });
    }

    return NextResponse.json({ ...claimed, messages });
  } catch (error) {
    console.error("[tasks] Failed to claim pending task", {
      installationId: auth.installationId,
      error,
    });

    return taskError(
      TASK_ERROR.SERVER_ERROR,
      "Failed to claim task",
      500,
    );
  }
}
