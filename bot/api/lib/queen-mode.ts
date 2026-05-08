/**
 * Probot 60s TTL cache for the per-installation `queen_mode` flag (D15).
 *
 * Webhook handlers and `queen-tick` read this on every event entry to
 * decide whether to skip the cloud-mode synthesis path. A naive read
 * would cost one Redis roundtrip per event; this wrapper keeps a
 * process-local in-memory cache with a 60-second TTL so a hot path
 * stays free of network IO.
 *
 * **G7 fail-closed semantics**: any error from the underlying Redis
 * read is logged and `cloud` is returned. The invariant is that the
 * cloud path NEVER stops claiming/synthesizing because of an unrelated
 * Redis blip — local mode is opt-in and only takes effect when we can
 * positively confirm the operator chose it.
 *
 * Cache key is per-installation. Mode-flips (PR 1's `setQueenSettings`)
 * happen through the web endpoint, which writes to Redis; the bot's
 * cached value goes stale for at most TTL seconds. That's the
 * intentional propagation budget — operators who want immediate effect
 * can wait one minute or restart the bot.
 *
 * Test entry points: `__resetQueenModeCacheForTests` clears state.
 * `getQueenModeCacheTtlMs` returns the configured TTL (so tests don't
 * have to know it's 60_000).
 */

import { type Redis } from "@upstash/redis";

const KEY_PREFIX = "hive:v1:installation:";
const KEY_SUFFIX = ":queen-settings";
const FIELD_QUEEN_MODE = "queen_mode";

const QUEEN_MODE_VALUES = ["cloud", "local"] as const;
export type QueenMode = (typeof QUEEN_MODE_VALUES)[number];

const DEFAULT_QUEEN_MODE: QueenMode = "cloud";
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: QueenMode;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function settingsKey(installationId: string): string {
  return `${KEY_PREFIX}${installationId}${KEY_SUFFIX}`;
}

function isQueenMode(value: unknown): value is QueenMode {
  return typeof value === "string" && (QUEEN_MODE_VALUES as readonly string[]).includes(value);
}

/**
 * Returns the cached queen_mode for `installationId`, refreshing from
 * Redis on miss/expiry. NEVER throws: any Redis or parsing error logs
 * and returns `cloud` (G7).
 */
export async function getQueenModeCached(
  installationId: string,
  redis: Redis,
  now: () => number = Date.now,
): Promise<QueenMode> {
  const cached = cache.get(installationId);
  const t = now();
  if (cached && cached.expiresAt > t) return cached.value;

  let mode: QueenMode = DEFAULT_QUEEN_MODE;
  try {
    const value = await redis.hget<string>(settingsKey(installationId), FIELD_QUEEN_MODE);
    if (isQueenMode(value)) {
      mode = value;
    } else if (value !== null && value !== undefined) {
      console.error("[queen-mode] Unexpected queen_mode value in Redis — defaulting to cloud", {
        installationId,
        value,
      });
    }
  } catch (error) {
    // G7: never let a Redis blip silently flip mode. Log and fall back.
    console.error("[queen-mode] Redis read failed — defaulting to cloud", {
      installationId,
      error,
    });
  }

  cache.set(installationId, { value: mode, expiresAt: t + CACHE_TTL_MS });
  return mode;
}

/**
 * Test-only: clears the in-memory cache so each test starts from a
 * known state.
 */
export function __resetQueenModeCacheForTests(): void {
  cache.clear();
}

/**
 * Returns the configured TTL in milliseconds. Exposed so tests can
 * advance fake clocks past the boundary without hard-coding the value.
 */
export function getQueenModeCacheTtlMs(): number {
  return CACHE_TTL_MS;
}
