/**
 * Tests for the Redis client factory.
 *
 * Two branches under test:
 *   1. Missing HIVEMOOT_REDIS_REST_URL / _TOKEN → throws with a
 *      helpful message (consumed by `tryConstructStore` in
 *      war-room-routing.ts to produce a `no_config` skip).
 *   2. Cache hit on second call (singleton across the request).
 *
 * The reset helper exists for test isolation; pinning that it
 * works ensures future test additions can rely on it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRedisClient, _resetRedisClientForTesting } from "./redis.js";

const ORIGINAL_URL = process.env.HIVEMOOT_REDIS_REST_URL;
const ORIGINAL_TOKEN = process.env.HIVEMOOT_REDIS_REST_TOKEN;

beforeEach(() => {
  _resetRedisClientForTesting();
});

afterEach(() => {
  // Restore env so the global setupFile defaults don't get clobbered
  // for downstream tests in the same process.
  if (ORIGINAL_URL !== undefined) process.env.HIVEMOOT_REDIS_REST_URL = ORIGINAL_URL;
  else delete process.env.HIVEMOOT_REDIS_REST_URL;
  if (ORIGINAL_TOKEN !== undefined) process.env.HIVEMOOT_REDIS_REST_TOKEN = ORIGINAL_TOKEN;
  else delete process.env.HIVEMOOT_REDIS_REST_TOKEN;
  _resetRedisClientForTesting();
});

describe("getRedisClient", () => {
  it("throws with a helpful message when HIVEMOOT_REDIS_REST_URL is missing", () => {
    delete process.env.HIVEMOOT_REDIS_REST_URL;
    process.env.HIVEMOOT_REDIS_REST_TOKEN = "tok";
    expect(() => getRedisClient()).toThrow(/HIVEMOOT_REDIS_REST_URL/);
  });

  it("throws when HIVEMOOT_REDIS_REST_TOKEN is missing", () => {
    process.env.HIVEMOOT_REDIS_REST_URL = "https://redis.example/test";
    delete process.env.HIVEMOOT_REDIS_REST_TOKEN;
    expect(() => getRedisClient()).toThrow(/HIVEMOOT_REDIS_REST_TOKEN/);
  });

  it("constructs and caches a client when both env vars are set", () => {
    process.env.HIVEMOOT_REDIS_REST_URL = "https://redis.example/test";
    process.env.HIVEMOOT_REDIS_REST_TOKEN = "tok";
    const a = getRedisClient();
    const b = getRedisClient();
    // Same instance across calls (singleton — no per-request
    // reconnect cost on the cron + webhook hot paths).
    expect(a).toBe(b);
  });

  it("_resetRedisClientForTesting forces a fresh construction", () => {
    process.env.HIVEMOOT_REDIS_REST_URL = "https://redis.example/test";
    process.env.HIVEMOOT_REDIS_REST_TOKEN = "tok";
    const a = getRedisClient();
    _resetRedisClientForTesting();
    const b = getRedisClient();
    // Reset breaks the singleton (test-only — the production code
    // path keeps the cache across calls).
    expect(a).not.toBe(b);
  });
});
