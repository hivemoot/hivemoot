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

/**
 * Authenticates a BYOK request by validating the session cookie and
 * parsing the master keyring from environment variables.
 */
export async function authenticateByokRequest(
  request: NextRequest,
): Promise<ByokAuthResult> {
  const env = validateEnv();
  if (!env.ok) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Server misconfiguration" }, { status: 503 }),
    };
  }

  const { redisUrl, byokActiveKeyVersion, byokMasterKeysJson } = env.config;

  if (!redisUrl) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Session storage is not configured" },
        { status: 503 },
      ),
    };
  }

  if (!byokActiveKeyVersion || !byokMasterKeysJson) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Encryption is not configured" },
        { status: 503 },
      ),
    };
  }

  let keyring: Map<string, Buffer>;
  try {
    keyring = parseKeyring(byokMasterKeysJson);
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Invalid encryption configuration" },
        { status: 503 },
      ),
    };
  }

  if (!keyring.has(byokActiveKeyVersion)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Active key version not in keyring" },
        { status: 503 },
      ),
    };
  }

  const redis = getRedisClient(redisUrl);
  const token = request.cookies.get(SETUP_SESSION_COOKIE)?.value;

  if (!token) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Not authenticated" }, { status: 401 }),
    };
  }

  const session = await getSetupSession(token, redis);
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Session expired or invalid" }, { status: 401 }),
    };
  }

  return {
    ok: true,
    session,
    keyring,
    activeKeyVersion: byokActiveKeyVersion,
    redis,
  };
}
