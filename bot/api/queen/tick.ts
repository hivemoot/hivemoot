/**
 * GET /api/queen/tick — Vercel Cron-driven queen manager loop.
 *
 * Wires together the queen-side pieces:
 *
 *   1. WarRoomStore — direct-Redis adapter over @hivemoot/war-room
 *      (replaced the HTTP+bearer WarRoomClient when this PR landed)
 *   2. AiSdkSynthesizer / StubSynthesizer — decision-prose synthesizer;
 *      stub fallback when LLM is not configured
 *   3. GitHubDecisionPoster — posts decisions to PR threads via the
 *      App's per-installation Octokit
 *   4. runQueenManagerLoop — orchestrates the
 *      list → claim → synthesize → close → post cycle per tenant
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` per Vercel's
 * documented cron pattern. Missing or mismatched bearer → 401
 * with empty body. CRON_SECRET unset ALSO returns 401.
 *
 * Method: GET only.
 *
 * Multi-tenant iteration:
 *   On each fire, the handler iterates EVERY installation the GitHub
 *   App is on (via `app.eachInstallation()`) and runs the manager
 *   loop per installation. The bot's GitHub App identity is the
 *   load-bearing trust boundary — there is no per-tenant bearer to
 *   juggle, no env-var pin to ONE installation. Per-installation
 *   work is keyed by `installation.id` from the eachInstallation
 *   iterator AND scoped Redis-side by the same id.
 *
 *   `?installationId=X` query param remains as a single-installation
 *   override for ops smoke-testing; when set, the iterator is
 *   replaced with a one-element list.
 *
 * Required env (per deployment):
 *   - CRON_SECRET — auth bearer
 *   - APP_ID + (PRIVATE_KEY | APP_PRIVATE_KEY) — GitHub App credentials
 *   - HIVEMOOT_REDIS_REST_URL + HIVEMOOT_REDIS_REST_TOKEN — direct
 *     Redis access (already used by BYOK envelope lookup)
 *   - LLM_PROVIDER + LLM_MODEL + provider API key (optional —
 *     loop falls back to StubSynthesizer when missing)
 *
 * Optional:
 *   - HIVEMOOT_QUEEN_RUNNER_ID (default: derived from deployment)
 *   - HIVEMOOT_QUEEN_MAX_ROOMS_PER_TICK (default: 100)
 *
 * Response: `{ runnerId, installations: [...], aggregated: {...} }`
 * where `installations` is one entry per tenant scanned this fire,
 * and `aggregated` sums the per-installation `QueenManagerLoopResult`
 * fields. Operators alert on `aggregated.errors > 0` or
 * `aggregated.postsFailed > 0`.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { App } from "octokit";

import { getAppConfig } from "../lib/env-validation.js";
import { logger } from "../lib/logger.js";
import { runQueenManagerLoop } from "../lib/queen/manager-loop.js";
import { createSynthesizer } from "../lib/queen/ai-sdk-synthesizer.js";
import { GitHubDecisionPoster } from "../lib/queen/decision-poster.js";
import { WarRoomStore } from "../lib/war-room-store.js";
import { getRedisClient } from "../lib/redis.js";

/** Numeric-only check — defense-in-depth on the optional
 * `?installationId=X` override. Mirrors the watchdog's
 * INSTALLATION_ID_REGEX. */
const INSTALLATION_ID_REGEX = /^\d+$/;

function getCronSecret(): string | null {
  const v = process.env.CRON_SECRET;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function makeRunnerId(): string {
  const fromEnv = process.env.HIVEMOOT_QUEEN_RUNNER_ID;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return `vercel-queen.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
}

function parseMaxRoomsPerTick(): number | undefined {
  const v = process.env.HIVEMOOT_QUEEN_MAX_ROOMS_PER_TICK;
  if (typeof v !== "string" || v.length === 0) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/**
 * Resolve the iteration target: either the optional
 * `?installationId=X` override (single tenant — ops smoke-testing),
 * or `null` meaning "iterate every installation the App is on."
 * Validates format on the override path; the all-installations
 * path trusts whatever GitHub returns.
 */
function resolveInstallationOverride(
  url: URL,
):
  | { ok: true; installationId: string | null }
  | { ok: false; status: number; body: Record<string, unknown> } {
  const fromQuery = url.searchParams.get("installationId");
  if (fromQuery === null || fromQuery.length === 0) {
    return { ok: true, installationId: null };
  }

  if (!INSTALLATION_ID_REGEX.test(fromQuery)) {
    return {
      ok: false,
      status: 400,
      body: {
        code: "invalid_installation_id",
        message:
          "?installationId= override must be a non-empty numeric string.",
      },
    };
  }

  return { ok: true, installationId: fromQuery };
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * Build the log adapter passed to `runQueenManagerLoop`. Formats
 * any structured `meta` argument into the message string so the
 * bot's single-string Logger (which doesn't accept a meta object)
 * preserves it for ops triage.
 *
 * Closes #542 guard B1: without this, every manager-loop log site
 * (`list_rooms_failed`, `unexpected_error`, `synthesize_failed`,
 * `contributions_read_failed`, `close_failed`, `post_failed`) would
 * silently drop its roomId / error class — leaving operators
 * staring at "[queen-tick] queen.manager_loop.unexpected_error" with
 * no context when alerts fire.
 */
export function makeManagerLoopLogAdapter(): {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
} {
  const fmt = (msg: string, meta?: Record<string, unknown>): string => {
    if (!meta || Object.keys(meta).length === 0) {
      return `[queen-tick] ${msg}`;
    }
    return `[queen-tick] ${msg} ${JSON.stringify(meta)}`;
  };
  return {
    info: (msg, meta) => logger.info(fmt(msg, meta)),
    warn: (msg, meta) => logger.warn(fmt(msg, meta)),
    error: (msg, meta) => logger.error(fmt(msg, meta)),
  };
}

/**
 * Run one queen tick for the resolved installation. Wraps the
 * dependencies (WarRoomClient + Synthesizer + DecisionPoster) and
 * delegates to runQueenManagerLoop.
 *
 * Per-installation lock: SET NX EX 290 + compare-and-DEL release.
 * Closes #542 builder R1. Required by WAR_ROOM_DESIGN.md §971: at
 * 2-minute schedule with 5-minute maxDuration, overlap between
 * fires is real, and while storage-layer `claim_already_held`
 * catches correctness collisions, we still want to avoid burning
 * duplicate LLM credits on the same room. TTL of 290s leaves a
 * 10s margin under the function timeout so a runaway tick that
 * exceeds maxDuration still releases its lock before a follow-up
 * fire would block.
 *
 * Lock is best-effort in two senses:
 *   - When `HIVEMOOT_REDIS_REST_URL` / `TOKEN` env aren't configured,
 *     run unlocked (V1 single-installation dev deployments).
 *   - When Redis is unreachable mid-tick, log + run unlocked rather
 *     than skipping the tick (availability over duplicate-work
 *     prevention).
 */
async function runOneTickForInstallation(args: {
  installationId: string;
  app: App;
  runnerId: string;
}): Promise<{
  result: Awaited<ReturnType<typeof runQueenManagerLoop>>;
  skipped?: boolean;
}> {
  const { installationId, app, runnerId } = args;

  const acquired = await tryAcquireTickLock(installationId, runnerId);
  if (acquired === "contention") {
    logger.info(
      `[queen-tick] lock contention installation=${installationId} — skip`,
    );
    return { result: emptyManagerLoopResult(), skipped: true };
  }

  try {
    const octokit = await app.getInstallationOctokit(Number(installationId));

    const store = new WarRoomStore({
      installationId,
      redis: getRedisClient(),
    });
    const synthesizer = await createSynthesizer({
      installationId: Number(installationId),
    });
    const poster = new GitHubDecisionPoster({ octokit });

    const result = await runQueenManagerLoop({
      client: store,
      synthesizer,
      decisionPoster: poster,
      runnerId,
      maxRoomsPerTick: parseMaxRoomsPerTick(),
      log: makeManagerLoopLogAdapter(),
    });

    return { result };
  } finally {
    await releaseTickLock(installationId, runnerId);
  }
}

function emptyManagerLoopResult(): Awaited<
  ReturnType<typeof runQueenManagerLoop>
> {
  return {
    totalRoomsScanned: 0,
    scannedAwaitingContributions: 0,
    eligible: 0,
    quietPeriodHeld: 0,
    claimed: 0,
    closed: 0,
    conflicts: 0,
    staleClaimsAbandoned: 0,
    postsSucceeded: 0,
    postsFailed: 0,
    postsSkipped: 0,
    errors: 0,
  };
}

/** TTL on the per-installation tick lock. 290s = 10s margin under
 * the function's `maxDuration: 300` so a runaway tick releases its
 * lock by TTL-expiry before the next 2-minute fire would block. */
const TICK_LOCK_TTL_SECS = 290;

/** Canonical lock key per WAR_ROOM_DESIGN.md L999 +
 * REDIS_KEY_CONVENTION.md (the `hive:v1:lock:*` namespace is reserved
 * for distributed locks). */
function tickLockKey(installationId: string): string {
  return `hive:v1:lock:queen-tick:${installationId}`;
}

/** Compare-and-DEL Lua: only DEL the lock key if it's still owned by
 * this runner. Prevents a tick whose work outlasted the TTL from
 * releasing a follow-up runner's lock. */
const TICK_LOCK_RELEASE_SCRIPT =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

/** Returns "ok" if the lock was acquired (or skipped because no
 * Redis configured), "contention" if another runner holds it.
 *
 * Both acquire and release use Upstash REST's command-body form
 * (`POST {url}` with JSON `["CMD", args...]`) rather than the path-
 * segment form. Closes #542 builder R2: prior path-segment form
 * `/set/key/value?NX&EX=290` had ambiguous query-arg handling per
 * Upstash docs and risked degenerating into a plain `SET` (always
 * returning `{ result: "OK" }`, breaking the serialization gate).
 * Body-form keeps NX/EX as positional command args so semantics
 * are unambiguous + match the release path.
 */
async function tryAcquireTickLock(
  installationId: string,
  runnerId: string,
): Promise<"ok" | "contention"> {
  const redis = getUpstashRedisConfig();
  if (!redis) return "ok"; // No Redis → run unlocked.
  const key = tickLockKey(installationId);
  try {
    const response = await fetch(redis.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${redis.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        "SET",
        key,
        runnerId,
        "NX",
        "EX",
        String(TICK_LOCK_TTL_SECS),
      ]),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      logger.warn(
        `[queen-tick] lock acquire HTTP ${response.status} — running unlocked`,
      );
      return "ok";
    }
    const body = (await response.json()) as { result?: string | null };
    // Upstash returns { result: "OK" } on success, { result: null }
    // on NX conflict.
    return body.result === "OK" ? "ok" : "contention";
  } catch (err) {
    logger.warn(
      `[queen-tick] lock acquire error: ${err instanceof Error ? err.message : String(err)} — running unlocked`,
    );
    return "ok";
  }
}

async function releaseTickLock(
  installationId: string,
  runnerId: string,
): Promise<void> {
  const redis = getUpstashRedisConfig();
  if (!redis) return;
  const key = tickLockKey(installationId);
  try {
    const response = await fetch(redis.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${redis.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        "EVAL",
        TICK_LOCK_RELEASE_SCRIPT,
        "1",
        key,
        runnerId,
      ]),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      logger.warn(`[queen-tick] lock release HTTP ${response.status}`);
    }
  } catch (err) {
    logger.warn(
      `[queen-tick] lock release error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface UpstashRedisConfig {
  url: string;
  token: string;
}

function getUpstashRedisConfig(): UpstashRedisConfig | null {
  const url = process.env.HIVEMOOT_REDIS_REST_URL;
  const token = process.env.HIVEMOOT_REDIS_REST_TOKEN;
  if (typeof url !== "string" || url.length === 0) return null;
  if (typeof token !== "string" || token.length === 0) return null;
  return { url, token };
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Auth: CRON_SECRET bearer. Misconfig (unset) and wrong-bearer
  // both return 401 with empty body — no oracle.
  const expected = getCronSecret();
  if (expected === null) {
    logger.error(
      "[queen-tick] CRON_SECRET is not set in this deployment — refusing all requests. Add CRON_SECRET to the env (Vercel dashboard → Settings → Environment Variables).",
    );
    res.statusCode = 401;
    res.end();
    return;
  }

  const authHeader = req.headers["authorization"];
  if (authHeader !== `Bearer ${expected}`) {
    res.statusCode = 401;
    res.end();
    return;
  }

  // Method: GET only.
  if (req.method !== "GET") {
    writeJson(res, 405, {
      code: "method_not_allowed",
      message: "Only GET is accepted (Vercel Cron sends GET).",
    });
    return;
  }

  // Optional ?installationId=X override (single-tenant smoke test).
  // Empty/absent → iterate every installation the App is on.
  const url = new URL(req.url ?? "/", "http://placeholder.local");
  const overrideResult = resolveInstallationOverride(url);
  if (!overrideResult.ok) {
    writeJson(res, overrideResult.status, overrideResult.body);
    return;
  }

  const runnerId = makeRunnerId();
  let app: App;
  try {
    const appConfig = getAppConfig();
    app = new App({
      appId: String(appConfig.appId),
      privateKey: appConfig.privateKey,
    });
  } catch (err) {
    logger.error(
      `[queen-tick] failed to construct App: ${err instanceof Error ? err.message : String(err)}`,
    );
    writeJson(res, 500, {
      code: "app_init_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Build the list of installations to scan this fire.
  const installationIds: string[] = [];
  if (overrideResult.installationId !== null) {
    installationIds.push(overrideResult.installationId);
  } else {
    try {
      for await (const { installation } of app.eachInstallation.iterator()) {
        installationIds.push(String(installation.id));
      }
    } catch (err) {
      logger.error(
        `[queen-tick] eachInstallation iteration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      writeJson(res, 500, {
        code: "installations_iteration_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  // Run the tick per installation. Aggregate results so operators
  // can alert on totals; per-installation rows let them attribute.
  const perInstallation: Array<{
    installationId: string;
    skipped?: boolean;
    reason?: string;
    error?: string;
    result?: Awaited<ReturnType<typeof runQueenManagerLoop>>;
  }> = [];
  const aggregated = emptyManagerLoopResult();
  for (const installationId of installationIds) {
    try {
      const { result, skipped } = await runOneTickForInstallation({
        installationId,
        app,
        runnerId,
      });
      perInstallation.push({
        installationId,
        skipped: skipped ?? false,
        ...(skipped ? { reason: "lock_contention" } : {}),
        result,
      });
      // Aggregate the numeric counters so callers can alert on totals.
      for (const k of Object.keys(aggregated) as Array<keyof typeof aggregated>) {
        aggregated[k] += result[k] ?? 0;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        `[queen-tick] unhandled error installation=${installationId}: ${message}`,
      );
      perInstallation.push({ installationId, error: message });
      // Treat per-installation failures as one error for the
      // aggregated counter so alerting picks them up.
      aggregated.errors += 1;
    }
  }

  writeJson(res, 200, {
    runnerId,
    installations: perInstallation,
    aggregated,
  });
}
