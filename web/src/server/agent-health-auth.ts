/**
 * Bearer token authentication for agent health reports.
 *
 * Agents send `Authorization: Bearer <token>` on POST /api/agent-health.
 * The token is hashed (SHA-256) and looked up in the reverse index created
 * by the agent-token module. No decryption is needed on the hot path.
 */

import { type Redis } from "@upstash/redis";
import { NextRequest, NextResponse } from "next/server";
import { validateEnv } from "@/server/env";
import { getRedisClient } from "@/server/redis";
import {
  AgentTokenExpiredError,
  resolveTokenToInstallationAndPolicy,
  type AgentTokenPolicy,
} from "@/server/agent-token";
import { AGENT_HEALTH_ERROR, agentHealthError } from "@/server/agent-health-error";

type AgentAuthSuccess = {
  ok: true;
  installationId: string;
  /** Per-token policy, or `undefined` for legacy tokens (created
   * pre-V1.5, no policy field). Callers that gate authorization on
   * the policy must distinguish `undefined` (legacy permissive) from
   * `{ allowed_repos: [] }` (explicit reject-all). */
  policy: AgentTokenPolicy | undefined;
  redis: Redis;
};

type AgentAuthFailure = {
  ok: false;
  response: NextResponse;
};

export type AgentAuthResult = AgentAuthSuccess | AgentAuthFailure;

function unauthenticatedResponse() {
  return {
    ok: false as const,
    response: agentHealthError(
      AGENT_HEALTH_ERROR.NOT_AUTHENTICATED,
      "Invalid or missing agent token",
      401,
    ),
  };
}

function tokenExpiredResponse() {
  return {
    ok: false as const,
    response: agentHealthError(
      AGENT_HEALTH_ERROR.TOKEN_EXPIRED,
      "Agent token expired",
      401,
    ),
  };
}

/**
 * Authenticates an incoming agent request via Bearer token.
 * Returns the installationId on success or a pre-built error response.
 */
export async function authenticateAgentRequest(
  request: NextRequest,
): Promise<AgentAuthResult> {
  const env = validateEnv();
  if (!env.ok) {
    return {
      ok: false,
      response: agentHealthError(
        AGENT_HEALTH_ERROR.SERVER_MISCONFIGURATION,
        "Server misconfiguration",
        503,
      ),
    };
  }

  const { redisRestUrl, redisRestToken } = env.config;
  if (!redisRestUrl || !redisRestToken) {
    return {
      ok: false,
      response: agentHealthError(
        AGENT_HEALTH_ERROR.SERVER_MISCONFIGURATION,
        "Redis not configured",
        503,
      ),
    };
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return unauthenticatedResponse();

  const rawToken = authHeader.slice("Bearer ".length).trim();
  if (!rawToken) return unauthenticatedResponse();

  const redis = getRedisClient(redisRestUrl, redisRestToken);
  let resolved: Awaited<ReturnType<typeof resolveTokenToInstallationAndPolicy>>;
  try {
    resolved = await resolveTokenToInstallationAndPolicy(rawToken, redis);
  } catch (err) {
    if (err instanceof AgentTokenExpiredError) return tokenExpiredResponse();
    throw err;
  }

  if (resolved === null) return unauthenticatedResponse();

  return {
    ok: true,
    installationId: resolved.installationId,
    policy: resolved.policy,
    redis,
  };
}
