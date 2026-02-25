import { NextResponse } from "next/server";

export const AGENT_HEALTH_ERROR = {
  UNAUTHORIZED: "agent_health_unauthorized",
  NOT_FOUND: "agent_token_not_found",
  INVALID_JSON: "agent_health_invalid_json",
  SCHEMA_VIOLATION: "agent_health_schema_violation",
  PAYLOAD_TOO_LARGE: "agent_health_payload_too_large",
  RATE_LIMITED: "agent_health_rate_limited",
  INVALID_PARAM: "agent_health_invalid_param",
  SERVER_ERROR: "agent_health_server_error",
} as const;

export type AgentHealthErrorCode = (typeof AGENT_HEALTH_ERROR)[keyof typeof AGENT_HEALTH_ERROR];

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
