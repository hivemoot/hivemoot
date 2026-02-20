/**
 * Shared session + keyring auth helper for BYOK routes.
 *
 * Extracts the common boilerplate: read cookie, validate session, parse
 * keyring from env. Returns a typed result so each route can branch on
 * `ok` without duplicating validation logic.
 */

import { NextRequest, NextResponse } from "next/server";
import type Redis from "ioredis";
import { validateEnv } from "@/server/env";
import { getRedisClient } from "@/server/redis";
import { getSetupSession } from "@/server/setup-session";
import { parseKeyring } from "@/server/crypto";
import { BYOK_ERROR, byokError } from "@/server/byok-error";
import type { SetupSessionPayload } from "@/server/setup-session";

const SETUP_SESSION_COOKIE = "setup_session";

type AuthSuccess = {
  ok: true;
  session: SetupSessionPayload;
  keyring: Map<string, Buffer>;
  activeKeyVersion: string;
  redis: Redis;
};

type AuthFailure = {
  ok: false;
  response: NextResponse;
};

export type ByokAuthResult = AuthSuccess | AuthFailure;

type RuntimeConfigSuccess = {
  ok: true;
  redisUrl: string;
  keyring: Map<string, Buffer>;
  activeKeyVersion: string;
};

type RuntimeConfigFailure = {
  ok: false;
  code: (typeof BYOK_ERROR)[keyof typeof BYOK_ERROR];
  message: string;
  status: number;
};

type RuntimeConfig = RuntimeConfigSuccess | RuntimeConfigFailure;

let cachedRuntimeConfig: RuntimeConfig | null = null;

function loadRuntimeConfig(): RuntimeConfig {
  const env = validateEnv();
  if (!env.ok) {
    return {
      ok: false,
      code: BYOK_ERROR.SERVER_MISCONFIGURATION,
      message: "Server misconfiguration",
      status: 503,
    };
  }

  const { redisUrl, byokActiveKeyVersion, byokMasterKeysJson } = env.config;

  if (!redisUrl) {
    return {
      ok: false,
      code: BYOK_ERROR.SESSION_STORAGE_NOT_CONFIGURED,
      message: "Session storage is not configured",
      status: 503,
    };
  }

  if (!byokActiveKeyVersion || !byokMasterKeysJson) {
    return {
      ok: false,
      code: BYOK_ERROR.ENCRYPTION_NOT_CONFIGURED,
      message: "Encryption is not configured",
      status: 503,
    };
  }

  let keyring: Map<string, Buffer>;
  try {
    keyring = parseKeyring(byokMasterKeysJson);
  } catch {
    return {
      ok: false,
      code: BYOK_ERROR.ENCRYPTION_CONFIG_INVALID,
      message: "Invalid encryption configuration",
      status: 503,
    };
  }

  if (!keyring.has(byokActiveKeyVersion)) {
    return {
      ok: false,
      code: BYOK_ERROR.ACTIVE_KEY_VERSION_UNAVAILABLE,
      message: "Active key version not in keyring",
      status: 503,
    };
  }

  return {
    ok: true,
    redisUrl,
    keyring,
    activeKeyVersion: byokActiveKeyVersion,
  };
}

function getRuntimeConfig(): RuntimeConfig {
  if (!cachedRuntimeConfig) {
    // Parse env + keyring once per server process to keep request auth path lean.
    cachedRuntimeConfig = loadRuntimeConfig();
  }
  return cachedRuntimeConfig;
}

/**
 * Authenticates a BYOK request by validating the session cookie and
 * parsing the master keyring from environment variables.
 */
export async function authenticateByokRequest(
  request: NextRequest,
): Promise<ByokAuthResult> {
  const runtimeConfig = getRuntimeConfig();
  if (!runtimeConfig.ok) {
    return {
      ok: false,
      response: byokError(runtimeConfig.code, runtimeConfig.message, runtimeConfig.status),
    };
  }

  const redis = getRedisClient(runtimeConfig.redisUrl);
  const token = request.cookies.get(SETUP_SESSION_COOKIE)?.value;

  if (!token) {
    return {
      ok: false,
      response: byokError(BYOK_ERROR.NOT_AUTHENTICATED, "Not authenticated", 401),
    };
  }

  const session = await getSetupSession(token, redis);
  if (!session) {
    return {
      ok: false,
      response: byokError(BYOK_ERROR.SESSION_INVALID, "Session expired or invalid", 401),
    };
  }

  return {
    ok: true,
    session,
    keyring: runtimeConfig.keyring,
    activeKeyVersion: runtimeConfig.activeKeyVersion,
    redis,
  };
}
