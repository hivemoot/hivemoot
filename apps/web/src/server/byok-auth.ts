/**
 * Shared session + keyring auth helper for BYOK routes.
 *
 * Extracts the common boilerplate: read cookie, validate session, parse
 * keyring from env. Returns a typed result so each route can branch on
 * `ok` without duplicating validation logic.
 */

import { NextRequest, NextResponse } from "next/server";
import { type Redis } from "@upstash/redis";
import { validateEnv } from "@/server/env";
import { getRedisClient } from "@/server/redis";
import { getSetupSession, isSessionFresh, SETUP_SESSION_COOKIE } from "@/server/setup-session";
import { parseKeyring } from "@/server/crypto";
import { BYOK_ERROR, byokError } from "@/server/byok-error";
import type { SetupSessionPayload } from "@/server/setup-session";

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
  redisRestUrl: string;
  redisRestToken: string;
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
    console.error("[byok-auth] Server misconfiguration: env validation failed", {
      code: BYOK_ERROR.SERVER_MISCONFIGURATION,
    });
    return {
      ok: false,
      code: BYOK_ERROR.SERVER_MISCONFIGURATION,
      message: "Server misconfiguration",
      status: 503,
    };
  }

  const { redisRestUrl, redisRestToken, byokActiveKeyVersion, byokMasterKeysJson } = env.config;

  if (!redisRestUrl || !redisRestToken) {
    console.error("[byok-auth] Session storage not configured: REDIS_REST_URL or REDIS_REST_TOKEN missing", {
      code: BYOK_ERROR.SESSION_STORAGE_NOT_CONFIGURED,
    });
    return {
      ok: false,
      code: BYOK_ERROR.SESSION_STORAGE_NOT_CONFIGURED,
      message: "Session storage is not configured",
      status: 503,
    };
  }

  if (!byokActiveKeyVersion || !byokMasterKeysJson) {
    console.error("[byok-auth] Encryption not configured: BYOK_ACTIVE_KEY_VERSION or BYOK_MASTER_KEYS missing", {
      code: BYOK_ERROR.ENCRYPTION_NOT_CONFIGURED,
    });
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
  } catch (err) {
    console.error("[byok-auth] Failed to parse BYOK_MASTER_KEYS keyring", {
      code: BYOK_ERROR.ENCRYPTION_CONFIG_INVALID,
      error: err,
    });
    return {
      ok: false,
      code: BYOK_ERROR.ENCRYPTION_CONFIG_INVALID,
      message: "Invalid encryption configuration",
      status: 503,
    };
  }

  if (!keyring.has(byokActiveKeyVersion)) {
    console.error("[byok-auth] Active key version not found in keyring", {
      code: BYOK_ERROR.ACTIVE_KEY_VERSION_UNAVAILABLE,
      activeKeyVersion: byokActiveKeyVersion,
    });
    return {
      ok: false,
      code: BYOK_ERROR.ACTIVE_KEY_VERSION_UNAVAILABLE,
      message: "Active key version not in keyring",
      status: 503,
    };
  }

  return {
    ok: true,
    redisRestUrl,
    redisRestToken,
    keyring,
    activeKeyVersion: byokActiveKeyVersion,
  };
}

function getRuntimeConfig(): RuntimeConfig {
  if (!cachedRuntimeConfig || !cachedRuntimeConfig.ok) {
    // Only cache successful config. On failure, retry each request so a
    // transient misconfiguration (e.g. env vars mid-deploy) resolves once
    // the environment stabilises, without requiring a container restart.
    const result = loadRuntimeConfig();
    if (result.ok) {
      cachedRuntimeConfig = result;
    }
    return result;
  }
  return cachedRuntimeConfig;
}

/**
 * Authenticates a BYOK request by validating the session cookie and
 * parsing the master keyring from environment variables.
 *
 * Pass `{ requireFresh: true }` for mutating routes (config, revoke, rotate,
 * re-encrypt) so that a valid-but-stale session is rejected with 401, matching
 * the step-up gate enforced by the credentials page.
 */
export async function authenticateByokRequest(
  request: NextRequest,
  options?: { requireFresh?: boolean },
): Promise<ByokAuthResult> {
  const runtimeConfig = getRuntimeConfig();
  if (!runtimeConfig.ok) {
    return {
      ok: false,
      response: byokError(runtimeConfig.code, runtimeConfig.message, runtimeConfig.status),
    };
  }

  const redis = getRedisClient(runtimeConfig.redisRestUrl, runtimeConfig.redisRestToken);
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

  if (options?.requireFresh && !isSessionFresh(session)) {
    return {
      ok: false,
      response: byokError(BYOK_ERROR.SESSION_STALE, "Re-authentication required", 401),
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
