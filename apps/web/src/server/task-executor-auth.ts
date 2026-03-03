import { type Redis } from "@upstash/redis";
import { NextRequest, NextResponse } from "next/server";
import { validateEnv } from "@/server/env";
import { getRedisClient } from "@/server/redis";
import { resolveTokenToInstallation } from "@/server/agent-token";
import { TASK_ERROR, taskError } from "@/server/task-error";

export type TaskExecutorAuthResult =
  | {
    ok: true;
    installationId: string;
    redis: Redis;
  }
  | {
    ok: false;
    response: NextResponse;
  };

function unauthorizedResponse() {
  return {
    ok: false as const,
    response: taskError(
      TASK_ERROR.NOT_AUTHENTICATED,
      "Invalid or missing executor token",
      401,
    ),
  };
}

export async function authenticateTaskExecutorRequest(
  request: NextRequest,
): Promise<TaskExecutorAuthResult> {
  const env = validateEnv();
  if (!env.ok) {
    return {
      ok: false,
      response: taskError(
        TASK_ERROR.SERVER_ERROR,
        "Server misconfiguration",
        503,
      ),
    };
  }

  const { redisRestUrl, redisRestToken } = env.config;
  if (!redisRestUrl || !redisRestToken) {
    return {
      ok: false,
      response: taskError(
        TASK_ERROR.SERVER_ERROR,
        "Redis not configured",
        503,
      ),
    };
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return unauthorizedResponse();
  }

  const rawToken = authHeader.slice("Bearer ".length).trim();
  if (!rawToken) return unauthorizedResponse();

  const redis = getRedisClient(redisRestUrl, redisRestToken);
  const installationId = await resolveTokenToInstallation(rawToken, redis);
  if (!installationId) return unauthorizedResponse();

  return {
    ok: true,
    installationId,
    redis,
  };
}
