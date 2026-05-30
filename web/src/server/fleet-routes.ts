/**
 * Shared helpers for the fleet (agent registry) route handlers. Mirrors
 * `agent-token-v1-routes.ts` but with a fleet-namespaced error vocabulary so a
 * fleet route never leaks a token-namespaced error code.
 */

import { NextResponse } from "next/server";
import { type Redis } from "@upstash/redis";
import { LockTimeoutError } from "@hivemoot/war-room/redis-lock";
import {
  AgentNameTakenError,
  AgentNotFoundError,
  AgentLimitReachedError,
} from "@/server/fleet-store";

export const FLEET_ERROR = {
  INVALID_BODY: "fleet_invalid_body",
  VALIDATION: "fleet_validation",
  REPO_NOT_COVERED: "fleet_repo_not_covered",
  COVERAGE_CHECK_FAILED: "fleet_coverage_check_failed",
  NAME_TAKEN: "fleet_name_taken",
  NOT_FOUND: "fleet_not_found",
  AGENT_LIMIT_REACHED: "fleet_agent_limit_reached",
  RATE_LIMITED: "fleet_rate_limited",
  QUEEN_NOT_SUPPORTED: "fleet_queen_not_supported",
  LOCK_TIMEOUT: "fleet_lock_timeout",
  SERVER_ERROR: "fleet_server_error",
} as const;

export type FleetErrorCode = (typeof FLEET_ERROR)[keyof typeof FLEET_ERROR];

export function fleetError(
  code: FleetErrorCode,
  message: string,
  status: number,
  details?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ code, message, ...(details ?? {}) }, { status });
}

export type ReadJsonObjectResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: NextResponse };

/** Parse a JSON body that must be a non-array object (empty body → {}). */
export async function readJsonObject(request: Request): Promise<ReadJsonObjectResult> {
  if (request.body === null) return { ok: true, body: {} };
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: fleetError(FLEET_ERROR.INVALID_BODY, "Request body must be valid JSON.", 400) };
  }
  if (body == null) return { ok: true, body: {} };
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: fleetError(FLEET_ERROR.INVALID_BODY, "Request body must be a JSON object.", 400) };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

/**
 * Map a fleet storage-layer error to an HTTP response. Never echoes raw error
 * messages for the unexpected case (avoids internal leakage; the real error is
 * logged for ops — matches web/AGENTS.md security boundary).
 */
export function mapFleetStorageError(
  err: unknown,
  context: { route: string; installationId: string; name?: string },
): NextResponse {
  if (err instanceof AgentNameTakenError) {
    return fleetError(FLEET_ERROR.NAME_TAKEN, err.message, 409, context.name ? { name: context.name } : undefined);
  }
  if (err instanceof AgentNotFoundError) {
    return fleetError(FLEET_ERROR.NOT_FOUND, err.message, 404, context.name ? { name: context.name } : undefined);
  }
  if (err instanceof AgentLimitReachedError) {
    return fleetError(FLEET_ERROR.AGENT_LIMIT_REACHED, err.message, 409);
  }
  if (err instanceof LockTimeoutError) {
    return fleetError(FLEET_ERROR.LOCK_TIMEOUT, "Another operation is in progress for this agent. Retry in a moment.", 503);
  }
  console.error("[fleet] unexpected error", { route: context.route, installationId: context.installationId, name: context.name, error: err });
  return fleetError(FLEET_ERROR.SERVER_ERROR, "Internal server error.", 500);
}

// ---------------------------------------------------------------------------
// Create rate limit (per installation+user, per minute) — mirrors task-store.
// ---------------------------------------------------------------------------

export const FLEET_CREATE_RATE_LIMIT_PER_MINUTE = 10;

export async function checkFleetCreateRateLimit(
  installationId: string,
  userId: number,
  redis: Redis,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const key = `hive:v1:fleet:create-ratelimit:${installationId}:${userId}:${minuteBucket}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  if (count > FLEET_CREATE_RATE_LIMIT_PER_MINUTE) return { allowed: false, retryAfterSeconds: 60 };
  return { allowed: true, retryAfterSeconds: 0 };
}
