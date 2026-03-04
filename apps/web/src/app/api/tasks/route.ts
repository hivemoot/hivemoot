import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { TASK_ERROR, taskError } from "@/server/task-error";
import { listRecentTasks } from "@/server/task-store";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return DEFAULT_LIMIT;
  if (parsed < 1) return 1;
  if (parsed > MAX_LIMIT) return MAX_LIMIT;
  return parsed;
}

export async function GET(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const limit = parseLimit(searchParams.get("limit"));

  try {
    const tasks = await listRecentTasks(auth.session.installationId, limit, auth.redis);
    return NextResponse.json({ tasks });
  } catch (error) {
    console.error("[tasks] Failed to list tasks", {
      installationId: auth.session.installationId,
      error,
    });
    return taskError(
      TASK_ERROR.SERVER_ERROR,
      "Failed to load tasks",
      500,
    );
  }
}
