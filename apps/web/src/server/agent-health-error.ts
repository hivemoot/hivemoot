/**
 * Error codes and response builder for the Agent Health API.
 *
 * Mirrors the byok-error.ts pattern — a const object of namespaced error
 * codes, a derived union type, and a helper that returns NextResponse.json().
 */

import { NextResponse } from "next/server";

export const AGENT_HEALTH_ERROR = {
  INVALID_JSON: "agent_health_invalid_json",
  PAYLOAD_TOO_LARGE: "agent_health_payload_too_large",
  MISSING_FIELDS: "agent_health_missing_fields",
  NOT_AUTHENTICATED: "agent_health_not_authenticated",
  SERVER_MISCONFIGURATION: "agent_health_server_misconfiguration",
  TOKEN_ALREADY_EXISTS: "agent_health_token_already_exists",
  TOKEN_NOT_FOUND: "agent_health_token_not_found",
  IDEMPOTENCY_CONFLICT: "agent_health_idempotency_conflict",
  IDEMPOTENCY_PENDING: "agent_health_idempotency_pending",
  RATE_LIMITED: "agent_health_rate_limited",
  VALIDATION_FAILED: "agent_health_validation_failed",
} as const;

export type AgentHealthErrorCode =
  (typeof AGENT_HEALTH_ERROR)[keyof typeof AGENT_HEALTH_ERROR];

export function agentHealthError(
  code: AgentHealthErrorCode,
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
