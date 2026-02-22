/**
 * Redis client factory.
 *
 * Uses a process-global singleton to avoid creating multiple client objects
 * across Next.js hot reloads in development. The @upstash/redis client is
 * stateless (HTTP REST), so there is no connection lifecycle to manage —
 * the singleton is a lightweight object-reuse optimization only.
 */

import { Redis } from "@upstash/redis";

declare global {
  var __redis: Redis | undefined;
}

/**
 * Returns the shared Redis client, creating it on first call.
 */
export function getRedisClient(url: string, token: string): Redis {
  if (!global.__redis) {
    global.__redis = new Redis({ url, token });
  }
  return global.__redis;
}

/**
 * Resets the singleton — used only in tests to get a fresh client per test.
 */
export function resetRedisClient(): void {
  global.__redis = undefined;
}
