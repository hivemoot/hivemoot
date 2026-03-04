import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { parseContentLength } from "@/server/request-utils";
import { TASK_ERROR, taskError } from "@/server/task-error";
import {
  checkTaskCreateRateLimit,
  createTask,
  validateCreateTaskRequest,
} from "@/server/task-store";

const MAX_PAYLOAD_BYTES = 64 * 1024;
const textEncoder = new TextEncoder();

function payloadTooLargeResponse() {
  return taskError(
    TASK_ERROR.PAYLOAD_TOO_LARGE,
    "Payload too large (max 64KB)",
    413,
  );
}

function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}

export async function POST(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  if (!isSameOriginRequest(request)) {
    return taskError(
      TASK_ERROR.FORBIDDEN,
      "Cross-origin task creation is not allowed",
      403,
    );
  }

  const contentLength = parseContentLength(request.headers.get("content-length"));
  if (contentLength !== null && contentLength > MAX_PAYLOAD_BYTES) {
    return payloadTooLargeResponse();
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return taskError(TASK_ERROR.INVALID_JSON, "Invalid JSON body", 400);
  }

  if (textEncoder.encode(bodyText).length > MAX_PAYLOAD_BYTES) {
    return payloadTooLargeResponse();
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return taskError(TASK_ERROR.INVALID_JSON, "Invalid JSON body", 400);
  }

  const validation = validateCreateTaskRequest(body);
  if (!validation.ok) {
    return taskError(TASK_ERROR.VALIDATION_FAILED, validation.message, 400);
  }

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

  const created = await createTask(
    auth.session.installationId,
    auth.session.userLogin,
    validation.request,
    auth.redis,
  );

  if (!created.ok) {
    return taskError(
      TASK_ERROR.CONCURRENCY_LIMITED,
      "Maximum concurrent tasks reached (3)",
      429,
    );
  }

  return NextResponse.json(
    {
      task_id: created.task.task_id,
      status: created.task.status,
      timeout_secs: created.task.timeout_secs,
      stream_url: `/api/tasks/${created.task.task_id}/stream`,
      task: created.task,
    },
    { status: 202 },
  );
}
