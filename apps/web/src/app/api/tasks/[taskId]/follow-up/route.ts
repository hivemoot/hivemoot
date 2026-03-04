import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { parseContentLength } from "@/server/request-utils";
import { TASK_ERROR, taskError } from "@/server/task-error";
import { extractTaskId } from "@/server/task-route-utils";
import { resumeTaskWithFollowUp, TASK_ID_PATTERN } from "@/server/task-store";

const MAX_PAYLOAD_BYTES = 64 * 1024;
const textEncoder = new TextEncoder();

export async function POST(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const { pathname } = new URL(request.url);
  const taskId = extractTaskId(pathname);
  if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
    return taskError(TASK_ERROR.INVALID_TASK_ID, "Invalid task id", 400);
  }

  const contentLength = parseContentLength(request.headers.get("content-length"));
  if (contentLength !== null && contentLength > MAX_PAYLOAD_BYTES) {
    return taskError(TASK_ERROR.PAYLOAD_TOO_LARGE, "Payload too large (max 64KB)", 413);
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return taskError(TASK_ERROR.INVALID_JSON, "Invalid JSON body", 400);
  }

  if (textEncoder.encode(bodyText).length > MAX_PAYLOAD_BYTES) {
    return taskError(TASK_ERROR.PAYLOAD_TOO_LARGE, "Payload too large (max 64KB)", 413);
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
  if (typeof obj.message !== "string" || obj.message.trim().length === 0) {
    return taskError(TASK_ERROR.MISSING_FIELDS, "message is required", 400);
  }

  const result = await resumeTaskWithFollowUp(
    auth.session.installationId,
    taskId,
    obj.message.trim(),
    auth.redis,
  );

  if (!result.ok) {
    if (result.reason === "not_found") {
      return taskError(TASK_ERROR.TASK_NOT_FOUND, "Task not found", 404);
    }
    if (result.reason === "invalid_transition") {
      return taskError(
        TASK_ERROR.FOLLOW_UP_NOT_ALLOWED,
        "Task is not in a state that accepts follow-up messages",
        409,
      );
    }
    return taskError(
      TASK_ERROR.CONCURRENCY_LIMITED,
      "Maximum concurrent tasks reached (3)",
      429,
    );
  }

  return NextResponse.json({ task: result.task });
}
