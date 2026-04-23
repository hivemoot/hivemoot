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

    // Include full message history so the agent has conversation context.
    // If this fetch fails, explicitly signal degraded context to the agent.
    let messages: Awaited<ReturnType<typeof getTaskMessages>> = [];
    let messagesError = false;
    try {
      messages = await getTaskMessages(auth.installationId, claimed.task.task_id, auth.redis);
    } catch (error) {
      messagesError = true;
      console.error("[tasks] Failed to fetch messages for claimed task", {
        installationId: auth.installationId,
        taskId: claimed.task.task_id,
        error,
      });
    }

    return NextResponse.json({ ...claimed, messages, messagesError });
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
