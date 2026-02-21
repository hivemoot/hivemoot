/**
 * Redis client factory.
 *
 * Uses a process-global singleton to avoid creating multiple TCP connections
 * across Next.js hot reloads in development. Unlike the previous @upstash/redis
 * HTTP client, ioredis maintains a persistent TCP connection that needs
 * lifecycle management — lazyConnect defers the handshake until the first
 * command, and dead-client detection prevents reusing a torn-down socket.
 */

import Redis from "ioredis";

declare global {
  var __redis: Redis | undefined;
}

/**
 * Returns the shared Redis client, creating it on first call.
 *
 * Matches the bot's connection settings: lazyConnect, 5 s command timeout,
 * 1 retry per request, 5 s connect timeout.
 */
export function getRedisClient(url: string): Redis {
  if (
    global.__redis
    && global.__redis.status !== "end"
    && global.__redis.status !== "close"
  ) {
    return global.__redis;
  }

  const client = new Redis(url, {
    lazyConnect: true,
    commandTimeout: 5000,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    // ioredis sets tls to boolean `true` for rediss:// URLs, but
    // Node's tls.connect needs an object — pass {} explicitly so
    // the TLS handshake actually runs with default cert verification.
    ...(url.startsWith("rediss://") ? { tls: {} } : {}),
  });

  client.on("error", (err) => {
    console.error("[redis] connection error:", err.message);
  });

  global.__redis = client;
  return client;
}

/**
 * Resets the singleton — used only in tests to get a fresh client per test.
 */
export function resetRedisClient(): void {
  if (global.__redis) {
    global.__redis.disconnect();
  }
  global.__redis = undefined;
}
