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
import { resolveTokenToInstallation } from "@/server/agent-token";
import { AGENT_HEALTH_ERROR, agentHealthError } from "@/server/agent-health-error";

type AgentAuthSuccess = {
  ok: true;
  installationId: string;
  redis: Redis;
};

type AgentAuthFailure = {
  ok: false;
  response: NextResponse;
};

export type AgentAuthResult = AgentAuthSuccess | AgentAuthFailure;

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
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      ok: false,
      response: agentHealthError(
        AGENT_HEALTH_ERROR.NOT_AUTHENTICATED,
        "Missing or invalid Authorization header",
        401,
      ),
    };
  }

  const rawToken = authHeader.slice("Bearer ".length);
  if (!rawToken) {
    return {
      ok: false,
      response: agentHealthError(
        AGENT_HEALTH_ERROR.NOT_AUTHENTICATED,
        "Empty Bearer token",
        401,
      ),
    };
  }

  const redis = getRedisClient(redisRestUrl, redisRestToken);
  const installationId = await resolveTokenToInstallation(rawToken, redis);

  if (!installationId) {
    return {
      ok: false,
      response: agentHealthError(
        AGENT_HEALTH_ERROR.NOT_AUTHENTICATED,
        "Invalid or revoked token",
        401,
      ),
    };
  }

  return { ok: true, installationId, redis };
}
