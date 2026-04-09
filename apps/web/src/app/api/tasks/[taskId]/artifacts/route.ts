import { NextRequest, NextResponse } from "next/server";
import { parseContentLength } from "@/server/request-utils";
import { extractTaskId } from "@/server/task-route-utils";
import { authenticateTaskExecutorRequest } from "@/server/task-executor-auth";
import { TASK_ERROR, taskError } from "@/server/task-error";
import {
  appendTaskArtifacts,
  getTask,
  TASK_ID_PATTERN,
  verifyTaskClaimToken,
} from "@/server/task-store";

const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_ARTIFACTS_PER_REQUEST = 20;
const textEncoder = new TextEncoder();

export async function POST(request: NextRequest) {
  const auth = await authenticateTaskExecutorRequest(request);
  if (!auth.ok) return auth.response;

  const { pathname } = new URL(request.url);
  const taskId = extractTaskId(pathname);
  if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
    return taskError(TASK_ERROR.INVALID_TASK_ID, "Invalid task id", 400);
  }

  const contentLength = parseContentLength(request.headers.get("content-length"));
  if (contentLength !== null && contentLength > MAX_PAYLOAD_BYTES) {
    return taskError(TASK_ERROR.PAYLOAD_TOO_LARGE, "Payload too large (max 32KB)", 413);
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return taskError(TASK_ERROR.INVALID_JSON, "Invalid JSON body", 400);
  }

  if (textEncoder.encode(bodyText).length > MAX_PAYLOAD_BYTES) {
    return taskError(TASK_ERROR.PAYLOAD_TOO_LARGE, "Payload too large (max 32KB)", 413);
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
  if (!Array.isArray(obj.artifacts)) {
    return taskError(TASK_ERROR.MISSING_FIELDS, "artifacts must be an array", 400);
  }

  if (obj.artifacts.length === 0) {
    return taskError(TASK_ERROR.VALIDATION_FAILED, "artifacts array must not be empty", 400);
  }

  if (obj.artifacts.length > MAX_ARTIFACTS_PER_REQUEST) {
    return taskError(
      TASK_ERROR.VALIDATION_FAILED,
      `artifacts array must not exceed ${MAX_ARTIFACTS_PER_REQUEST} entries per request`,
      400,
    );
  }

  try {
    const task = await getTask(auth.installationId, taskId, auth.redis);
    if (!task) {
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

    const result = await appendTaskArtifacts(
      auth.installationId,
      taskId,
      obj.artifacts,
      auth.redis,
    );

    if (!result.ok) {
      if (result.reason === "not_found") {
        return taskError(TASK_ERROR.TASK_NOT_FOUND, "Task not found", 404);
      }
      if (result.reason === "cap_exceeded") {
        return taskError(
          TASK_ERROR.VALIDATION_FAILED,
          "Artifact cap reached (max 20 per task)",
          409,
        );
      }
      if (result.reason === "lock_timeout") {
        return taskError(
          TASK_ERROR.LOCK_TIMEOUT,
          "Task state is temporarily busy, retry shortly",
          429,
        );
      }
      return taskError(
        TASK_ERROR.VALIDATION_FAILED,
        "One or more artifacts are invalid. Use github.com URLs scoped to the task repos.",
        400,
      );
    }

    return NextResponse.json({ artifacts: result.artifacts });
  } catch (error) {
    console.error("[tasks] Failed to append artifacts", {
      installationId: auth.installationId,
      taskId,
      error,
    });

    return taskError(TASK_ERROR.SERVER_ERROR, "Failed to append artifacts", 500);
  }
}
