/**
 * Shared `@upstash/redis` client factory for the bot.
 *
 * Bot uses the same Upstash REST URL + token web does. Until now
 * the only consumer was `byok.ts` (raw fetch against the REST API);
 * the war-room migration adds a second consumer that needs the
 * actual `@upstash/redis` client to call shared storage primitives,
 * so this helper standardises the read path.
 *
 * Throws at construction time if the env vars are missing — that's
 * fail-loud at request entry rather than silently returning null and
 * having callers stumble into harder-to-diagnose missing-data errors
 * deeper in the call stack.
 */

import { Redis } from "@upstash/redis";

const REDIS_URL_ENV = "HIVEMOOT_REDIS_REST_URL";
const REDIS_TOKEN_ENV = "HIVEMOOT_REDIS_REST_TOKEN";

let cached: Redis | null = null;

export function getRedisClient(): Redis {
  if (cached) return cached;

  const url = process.env[REDIS_URL_ENV];
  const token = process.env[REDIS_TOKEN_ENV];

  if (!url || !token) {
    throw new Error(
      `Bot Redis runtime is misconfigured: set both ${REDIS_URL_ENV} and ${REDIS_TOKEN_ENV}. ` +
        "Same values used by byok.ts; reusable across the bot's surface.",
    );
  }

  cached = new Redis({ url, token });
  return cached;
}

/** Test-only: reset the cached client so each test gets a fresh
 * environment read. Not exported in production paths. */
export function _resetRedisClientForTesting(): void {
  cached = null;
}
