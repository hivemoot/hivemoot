/**
 * Setup session management.
 *
 * Two concepts live here:
 *
 * 1. **OAuth state** — a random nonce stored in Redis before the OAuth redirect.
 *    Validated on callback to prevent CSRF. Deleted after single use.
 *
 * 2. **Setup session token** — an opaque random token issued after successful
 *    OAuth + admin verification. Stored in Redis with a 24-hour TTL. Required
 *    on all subsequent /api/byok/* calls (Phase 3).
 */

import { randomBytes } from "crypto";
import { type Redis } from "@upstash/redis";
import { OAUTH_STATE_BINDING_COOKIE, SETUP_SESSION_COOKIE } from "@/constants/cookies";

export { OAUTH_STATE_BINDING_COOKIE, SETUP_SESSION_COOKIE };

const STATE_TTL_SECONDS = 600;
export const SESSION_TTL_SECONDS = 86400;
export const SESSION_FRESHNESS_SECONDS = 15 * 60;

const STATE_KEY_PREFIX = "oauth-state:";
const SESSION_KEY_PREFIX = "setup-session:";

/**
 * Sentinel value used as the installationId in OAuth state when the user
 * starts the "already installed" discovery flow. The callback detects this
 * and resolves the real installationId via `GET /user/installations`.
 */
export const DISCOVER_SENTINEL = "discover";

interface OAuthStatePayload {
  installationId: string;
  stateBinding: string;
  next?: string;
  /**
   * When true, paired with the DISCOVER_SENTINEL installationId, the callback
   * tolerates "user has zero installations" and issues a session with
   * `installationId: null` instead of redirecting with auth=not_installed.
   * Used by the "skip install, just sign in" entry point.
   */
  allowEmpty?: boolean;
}

export interface OAuthStateRecord {
  state: string;
  stateBinding: string;
}

export interface OAuthStateValidationResult {
  installationId: string;
  next?: string;
  allowEmpty?: boolean;
}

export async function createOAuthState(
  installationId: string,
  redis: Redis,
  next?: string,
  options?: { allowEmpty?: boolean },
): Promise<OAuthStateRecord> {
  const state = randomBytes(32).toString("hex");
  const stateBinding = randomBytes(32).toString("hex");
  const payload: OAuthStatePayload = { installationId, stateBinding };
  if (next) payload.next = next;
  if (options?.allowEmpty) payload.allowEmpty = true;
  await redis.set(
    `${STATE_KEY_PREFIX}${state}`,
    payload,
    { ex: STATE_TTL_SECONDS },
  );
  return { state, stateBinding };
}

export async function validateOAuthState(
  state: string,
  stateBinding: string | undefined,
  redis: Redis,
): Promise<OAuthStateValidationResult | null> {
  if (!stateBinding) return null;

  // GETDEL is a single atomic command (Redis 6.2+) — guarantees strict one-time
  // nonce semantics even under concurrent callbacks.
  const payload = await redis.getdel<Partial<OAuthStatePayload>>(`${STATE_KEY_PREFIX}${state}`);
  if (!payload) return null;

  if (
    typeof payload.installationId !== "string"
    || typeof payload.stateBinding !== "string"
  ) {
    return null;
  }

  if (payload.stateBinding !== stateBinding) return null;
  const result: OAuthStateValidationResult = { installationId: payload.installationId };
  if (payload.next) result.next = payload.next;
  if (payload.allowEmpty === true) result.allowEmpty = true;
  return result;
}

export interface SetupSessionPayload {
  /**
   * null when the user signed in via OAuth without having the GitHub App
   * installed on any repo. Governance features that require repo access
   * (BYOK config, roles editing, task dispatch) should return
   * "installation_required" until the user installs the app.
   */
  installationId: string | null;
  userId: number;
  userLogin: string;
}

export interface SetupSessionResult extends SetupSessionPayload {
  expiresAt: number;
  /** Unix timestamp (ms) when the session was issued. 0 for legacy sessions without iat. */
  iat: number;
}

/**
 * Returns true when the session was issued within SESSION_FRESHNESS_SECONDS.
 * Legacy sessions without an iat field are treated as stale (fail-closed).
 */
export function isSessionFresh(session: SetupSessionResult): boolean {
  if (!session.iat) return false;
  return Date.now() - session.iat < SESSION_FRESHNESS_SECONDS * 1000;
}

export async function createSetupSession(
  payload: SetupSessionPayload,
  redis: Redis,
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const iat = Date.now();
  await redis.set(
    `${SESSION_KEY_PREFIX}${token}`,
    { ...payload, exp: iat + SESSION_TTL_SECONDS * 1000, iat },
    { ex: SESSION_TTL_SECONDS },
  );
  return token;
}

export async function getSetupSession(
  token: string,
  redis: Redis,
): Promise<SetupSessionResult | null> {
  const data = await redis.get<SetupSessionPayload & { exp: number; iat?: number }>(`${SESSION_KEY_PREFIX}${token}`);
  if (!data) return null;

  if (typeof data.exp !== "number" || Date.now() > data.exp) {
    await redis.del(`${SESSION_KEY_PREFIX}${token}`);
    return null;
  }

  return {
    installationId: data.installationId,
    userId: data.userId,
    userLogin: data.userLogin,
    expiresAt: data.exp,
    iat: data.iat ?? 0,
  };
}

/**
 * Revoke a setup session server-side so the token cannot be reused after
 * sign-out. Idempotent — deleting an already-absent key is a no-op.
 */
export async function deleteSetupSession(
  token: string,
  redis: Redis,
): Promise<void> {
  await redis.del(`${SESSION_KEY_PREFIX}${token}`);
}
