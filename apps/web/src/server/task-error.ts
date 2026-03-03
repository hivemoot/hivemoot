import { NextResponse } from "next/server";

export const TASK_ERROR = {
  INVALID_JSON: "task_invalid_json",
  PAYLOAD_TOO_LARGE: "task_payload_too_large",
  VALIDATION_FAILED: "task_validation_failed",
  INVALID_TASK_ID: "task_invalid_task_id",
  TASK_NOT_FOUND: "task_not_found",
  RATE_LIMITED: "task_rate_limited",
  CONCURRENCY_LIMITED: "task_concurrency_limited",
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
