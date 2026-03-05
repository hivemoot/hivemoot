import { NextRequest, NextResponse } from "next/server";
import { authenticateTaskExecutorRequest } from "@/server/task-executor-auth";
import { TASK_ERROR, taskError } from "@/server/task-error";
import { claimNextPendingTask } from "@/server/task-store";

export async function POST(request: NextRequest) {
  const auth = await authenticateTaskExecutorRequest(request);
  if (!auth.ok) return auth.response;

  try {
    const claimed = await claimNextPendingTask(auth.installationId, auth.redis);
    if (!claimed) {
      return new NextResponse(null, { status: 204 });
    }

    return NextResponse.json(claimed);
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
