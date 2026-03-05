import { NextRequest, NextResponse } from "next/server";
import { parseContentLength } from "@/server/request-utils";
import { extractTaskId } from "@/server/task-route-utils";
import { authenticateTaskExecutorRequest } from "@/server/task-executor-auth";
import { TASK_ERROR, taskError } from "@/server/task-error";
import {
  completeTask,
  failTask,
  getTask,
  requestFollowUp,
  heartbeatTask,
  setTaskProgress,
  TASK_ID_PATTERN,
  timeoutTask,
  verifyTaskClaimToken,
  type TaskTransitionResult,
} from "@/server/task-store";

const MAX_PAYLOAD_BYTES = 128 * 1024;
const textEncoder = new TextEncoder();

type ExecuteAction = "progress" | "complete" | "fail" | "timeout" | "heartbeat" | "request_follow_up";

function parseAction(value: unknown): ExecuteAction | null {
  if (
    value === "progress"
    || value === "complete"
    || value === "fail"
    || value === "timeout"
    || value === "heartbeat"
    || value === "request_follow_up"
  ) {
    return value;
  }
  return null;
}

function toTransitionResponse(result: TaskTransitionResult) {
  if (result.ok) {
    return NextResponse.json({ task: result.task });
  }

  if (result.reason === "not_found") {
    return taskError(TASK_ERROR.TASK_NOT_FOUND, "Task not found", 404);
  }

  if (result.reason === "invalid_transition") {
    return taskError(
      TASK_ERROR.INVALID_TRANSITION,
      "Task is not in a valid state for this action",
      409,
    );
  }

  return taskError(
    TASK_ERROR.CONCURRENCY_LIMITED,
    "Maximum concurrent tasks reached (3)",
    429,
  );
}

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
    return taskError(
      TASK_ERROR.PAYLOAD_TOO_LARGE,
      "Payload too large (max 128KB)",
      413,
    );
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return taskError(TASK_ERROR.INVALID_JSON, "Invalid JSON body", 400);
  }

  if (textEncoder.encode(bodyText).length > MAX_PAYLOAD_BYTES) {
    return taskError(
      TASK_ERROR.PAYLOAD_TOO_LARGE,
      "Payload too large (max 128KB)",
      413,
    );
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

  const action = parseAction((body as Record<string, unknown>).action);
  if (!action) {
    return taskError(
      TASK_ERROR.INVALID_ACTION,
      "action must be one of: progress, complete, fail, timeout, heartbeat, request_follow_up",
      400,
    );
  }

  // Installation scoping from executor token enforces tenant isolation.
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

  const obj = body as Record<string, unknown>;

  switch (action) {
    case "progress": {
      if (typeof obj.progress !== "string" || obj.progress.trim().length === 0) {
        return taskError(TASK_ERROR.MISSING_FIELDS, "progress is required for action=progress", 400);
      }
      const updated = await setTaskProgress(auth.installationId, taskId, obj.progress, auth.redis);
      return toTransitionResponse(updated);
    }

    case "complete": {
      if (typeof obj.result !== "string" || obj.result.trim().length === 0) {
        return taskError(TASK_ERROR.MISSING_FIELDS, "result is required for action=complete", 400);
      }
      const completed = await completeTask(auth.installationId, taskId, obj.result, auth.redis);
      return toTransitionResponse(completed);
    }

    case "fail": {
      if (typeof obj.error !== "string" || obj.error.trim().length === 0) {
        return taskError(TASK_ERROR.MISSING_FIELDS, "error is required for action=fail", 400);
      }
      const failed = await failTask(auth.installationId, taskId, obj.error, auth.redis);
      return toTransitionResponse(failed);
    }

    case "timeout": {
      const timedOut = await timeoutTask(auth.installationId, taskId, auth.redis);
      return toTransitionResponse(timedOut);
    }

    case "heartbeat": {
      const heartbeat = await heartbeatTask(auth.installationId, taskId, auth.redis);
      return toTransitionResponse(heartbeat);
    }

    case "request_follow_up": {
      if (typeof obj.message !== "string" || obj.message.trim().length === 0) {
        return taskError(TASK_ERROR.MISSING_FIELDS, "message is required for action=request_follow_up", 400);
      }
      const followUp = await requestFollowUp(auth.installationId, taskId, obj.message.trim(), auth.redis);
      return toTransitionResponse(followUp);
    }

    default:
      return taskError(TASK_ERROR.INVALID_ACTION, "Unsupported action", 400);
  }
}
