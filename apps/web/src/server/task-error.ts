import { NextResponse } from "next/server";

export const TASK_ERROR = {
  INVALID_JSON: "task_invalid_json",
  PAYLOAD_TOO_LARGE: "task_payload_too_large",
  VALIDATION_FAILED: "task_validation_failed",
  MISSING_FIELDS: "task_missing_fields",
  INVALID_ACTION: "task_invalid_action",
  INVALID_TRANSITION: "task_invalid_transition",
  INVALID_TASK_ID: "task_invalid_task_id",
  NOT_AUTHENTICATED: "task_not_authenticated",
  FORBIDDEN: "task_forbidden",
  TASK_NOT_FOUND: "task_not_found",
  RATE_LIMITED: "task_rate_limited",
  CONCURRENCY_LIMITED: "task_concurrency_limited",
  FOLLOW_UP_NOT_ALLOWED: "task_follow_up_not_allowed",
  SERVER_ERROR: "task_server_error",
} as const;

export type TaskErrorCode = (typeof TASK_ERROR)[keyof typeof TASK_ERROR];

export function taskError(
  code: TaskErrorCode,
  message: string,
  status: number,
  details?: Record<string, unknown>,
) {
  return NextResponse.json(
    {
      code,
      message,
      ...(details ?? {}),
    },
    { status },
  );
}
