/**
 * Redis client factory.
 *
 * Uses a process-global singleton to avoid creating multiple connections
 * across Next.js hot reloads in development. The global is typed via
 * declaration merging so TypeScript stays happy.
 */

import Redis from "ioredis";

declare global {
  var __redis: Redis | undefined;
}

/**
 * Returns the shared Redis client, creating it on first call.
 * Throws if `redisUrl` is undefined (dev mode with no Redis configured).
 */
export function getRedisClient(redisUrl: string): Redis {
  if (!global.__redis) {
    global.__redis = new Redis(redisUrl, {
      // Fail fast — don't silently retry forever
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
  }
  return global.__redis;
}

/**
 * Resets the singleton — used only in tests to get a fresh client per test.
 */
export function resetRedisClient(): void {
  global.__redis = undefined;
}
