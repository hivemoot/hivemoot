/**
 * Setup session management.
 *
 * Two concepts live here:
 *
 * 1. **OAuth state** — a random nonce stored in Redis before the OAuth redirect.
 *    Validated on callback to prevent CSRF. Deleted after single use.
 *
 * 2. **Setup session token** — an opaque random token issued after successful
 *    OAuth + admin verification. Stored in Redis with a 10-minute TTL. Required
 *    on all subsequent /api/byok/* calls (Phase 3).
 */

import { randomBytes } from "crypto";
import type Redis from "ioredis";

const STATE_TTL_SECONDS = 600;
const SESSION_TTL_SECONDS = 600;

const STATE_KEY_PREFIX = "oauth-state:";
const SESSION_KEY_PREFIX = "setup-session:";

export async function createOAuthState(
  installationId: string,
  redis: Redis,
): Promise<string> {
  const state = randomBytes(32).toString("hex");
  await redis.set(
    `${STATE_KEY_PREFIX}${state}`,
    installationId,
    "EX",
    STATE_TTL_SECONDS,
  );
  return state;
}

export async function validateOAuthState(
  state: string,
  redis: Redis,
): Promise<string | null> {
  // GETDEL is a single atomic command (Redis 6.2+) — guarantees strict one-time
  // nonce semantics even under concurrent callbacks.
  return (await redis.getdel(`${STATE_KEY_PREFIX}${state}`)) ?? null;
}

export interface SetupSessionPayload {
  installationId: string;
  userId: number;
  userLogin: string;
}

export async function createSetupSession(
  payload: SetupSessionPayload,
  redis: Redis,
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await redis.set(
    `${SESSION_KEY_PREFIX}${token}`,
    JSON.stringify({ ...payload, exp: Date.now() + SESSION_TTL_SECONDS * 1000 }),
    "EX",
    SESSION_TTL_SECONDS,
  );
  return token;
}

export async function getSetupSession(
  token: string,
  redis: Redis,
): Promise<SetupSessionPayload | null> {
  const raw = await redis.get(`${SESSION_KEY_PREFIX}${token}`);
  if (!raw) return null;

  const data = JSON.parse(raw) as SetupSessionPayload & { exp: number };

  if (Date.now() > data.exp) {
    await redis.del(`${SESSION_KEY_PREFIX}${token}`);
    return null;
  }

  return { installationId: data.installationId, userId: data.userId, userLogin: data.userLogin };
}
