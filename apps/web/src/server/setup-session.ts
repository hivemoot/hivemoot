/**
 * Setup session management.
 *
 * Two concepts live here:
 *
 * 1. **OAuth state** — a random nonce stored in Redis before the OAuth redirect.
 *    Validated on callback to prevent CSRF. Deleted after single use.
 *
 * 2. **Setup session token** — an opaque random token issued after successful
 *    OAuth + admin verification. Stored in Redis with a 30-minute TTL. Required
 *    on all subsequent /api/byok/* calls (Phase 3).
 */

import { randomBytes } from "crypto";
import type Redis from "ioredis";

const STATE_TTL_SECONDS = 600;
export const SESSION_TTL_SECONDS = 1800;

const STATE_KEY_PREFIX = "oauth-state:";
const SESSION_KEY_PREFIX = "setup-session:";

/**
 * Browser binding cookie for OAuth state.
 *
 * The callback must present both:
 * - URL `state`
 * - this cookie value
 * and they must match the server-side state record.
 */
export const OAUTH_STATE_BINDING_COOKIE = "oauth_state_binding";

/** Cookie name for the short-lived setup session token. */
export const SETUP_SESSION_COOKIE = "setup_session";

/**
 * Sentinel value used as the installationId in OAuth state when the user
 * starts the "already installed" discovery flow. The callback detects this
 * and resolves the real installationId via `GET /user/installations`.
 */
export const DISCOVER_SENTINEL = "discover";

interface OAuthStatePayload {
  installationId: string;
  stateBinding: string;
}

export interface OAuthStateRecord {
  state: string;
  stateBinding: string;
}

export async function createOAuthState(
  installationId: string,
  redis: Redis,
): Promise<OAuthStateRecord> {
  const state = randomBytes(32).toString("hex");
  const stateBinding = randomBytes(32).toString("hex");
  const payload: OAuthStatePayload = { installationId, stateBinding };
  await redis.set(
    `${STATE_KEY_PREFIX}${state}`,
    JSON.stringify(payload),
    "EX",
    STATE_TTL_SECONDS,
  );
  return { state, stateBinding };
}

export async function validateOAuthState(
  state: string,
  stateBinding: string | undefined,
  redis: Redis,
): Promise<string | null> {
  if (!stateBinding) return null;

  // GETDEL is a single atomic command (Redis 6.2+) — guarantees strict one-time
  // nonce semantics even under concurrent callbacks.
  const raw = await redis.getdel(`${STATE_KEY_PREFIX}${state}`);
  if (!raw) return null;

  let payload: Partial<OAuthStatePayload>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof payload.installationId !== "string"
    || typeof payload.stateBinding !== "string"
  ) {
    return null;
  }

  if (payload.stateBinding !== stateBinding) return null;
  return payload.installationId;
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

  let data: SetupSessionPayload & { exp: number };
  try {
    data = JSON.parse(raw);
  } catch {
    // Corrupted data — fail closed and clean up
    await redis.del(`${SESSION_KEY_PREFIX}${token}`);
    return null;
  }

  if (typeof data.exp !== "number" || Date.now() > data.exp) {
    await redis.del(`${SESSION_KEY_PREFIX}${token}`);
    return null;
  }

  return { installationId: data.installationId, userId: data.userId, userLogin: data.userLogin };
}
