/**
 * GET /api/queen/tick — Vercel Cron-driven queen manager loop.
 *
 * Final slice of Phase G' (queen module). Wires together everything
 * G'.1-G'.4 built:
 *
 *   1. WarRoomClient (G'.1) — talks to hivemoot.dev /api/rooms/*
 *   2. AiSdkSynthesizer / StubSynthesizer (G'.3) — produces decision
 *      prose; stub fallback when LLM is not configured
 *   3. GitHubDecisionPoster (G'.4) — posts decisions to PR threads
 *   4. runQueenManagerLoop (G'.2) — orchestrates the
 *      list → claim → synthesize → close → post cycle
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` per Vercel's
 * documented cron pattern. NOT V1 capability auth — this is a
 * platform-level invocation. Missing or mismatched bearer → 401
 * with empty body so an external probe can't differentiate
 * "wrong bearer" from "no deployment". CRON_SECRET unset ALSO
 * returns 401 (misconfig logged server-side via console.error,
 * matches the watchdog at web/src/app/api/internal/queen/tick).
 *
 * Method: GET only (Vercel Cron sends GET, no body). POST returns
 * 405. Keeps the surface narrow — no handcrafted-test backdoor
 * to maintain.
 *
 * Installation selection (mirrors watchdog's #524 guard R2 N1):
 *   1. `?installationId=X` query param wins (manual test override)
 *   2. Otherwise read `HIVEMOOT_QUEEN_INSTALLATION_ID` env var
 *   3. Neither set → 500 misconfig (the cron-bearer holder is
 *      already authenticated, so fail-loud is acceptable)
 *
 * Required env (per deployment):
 *   - CRON_SECRET — auth bearer
 *   - APP_ID + (PRIVATE_KEY | APP_PRIVATE_KEY) — GitHub App credentials
 *   - HIVEMOOT_BOT_AGENT_TOKEN — V1 capability bearer with
 *     rooms.read_all + rooms.decide + rooms.close (queen preset)
 *   - HIVEMOOT_QUEEN_INSTALLATION_ID — target installation
 *   - LLM_PROVIDER + LLM_MODEL + provider API key (optional —
 *     loop falls back to StubSynthesizer when missing)
 *
 * Optional:
 *   - HIVEMOOT_API_BASE_URL (default: https://www.hivemoot.dev)
 *   - HIVEMOOT_QUEEN_RUNNER_ID (default: derived from deployment)
 *   - HIVEMOOT_QUEEN_MAX_ROOMS_PER_TICK (default: 100)
 *
 * Response: `{ runnerId, installationId, result }` where result is
 * `QueenManagerLoopResult`. Operators alert on `result.errors > 0`
 * or `result.postsFailed > 0`.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { App } from "octokit";

import { getAppConfig } from "../lib/env-validation.js";
import { logger } from "../lib/logger.js";
import { runQueenManagerLoop } from "../lib/queen/manager-loop.js";
import { createSynthesizer } from "../lib/queen/ai-sdk-synthesizer.js";
import { GitHubDecisionPoster } from "../lib/queen/decision-poster.js";
import { WarRoomClient } from "../lib/war-room-client.js";

/** Numeric-only check — defense-in-depth even with an authenticated
 * caller. Mirrors the watchdog's INSTALLATION_ID_REGEX. */
const INSTALLATION_ID_REGEX = /^\d+$/;

const DEFAULT_BASE_URL = "https://www.hivemoot.dev";

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
 * Resolve `installationId` from query → env. Returns
 *   - `{ ok: true, installationId }` on success
 *   - `{ ok: false, status, body }` to short-circuit the response
 */
function resolveInstallationId(
  url: URL,
):
  | { ok: true; installationId: string }
  | { ok: false; status: number; body: Record<string, unknown> } {
  const fromQuery = url.searchParams.get("installationId");
  const fromEnv = process.env.HIVEMOOT_QUEEN_INSTALLATION_ID;
  const installationId = fromQuery ?? fromEnv ?? null;

  if (installationId === null || installationId.length === 0) {
    logger.error(
      "[queen-tick] no installationId — neither ?installationId query nor HIVEMOOT_QUEEN_INSTALLATION_ID env var is set",
    );
    return {
      ok: false,
      status: 500,
      body: {
        code: "no_installation_id",
        message:
          "No installationId resolved — neither ?installationId query nor HIVEMOOT_QUEEN_INSTALLATION_ID env var is set.",
      },
    };
  }

  if (!INSTALLATION_ID_REGEX.test(installationId)) {
    return {
      ok: false,
      status: 400,
      body: {
        code: "invalid_installation_id",
        message:
          "installationId must be a non-empty numeric string (GitHub installation IDs).",
      },
    };
  }

  return { ok: true, installationId };
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
async function runOneTick(installationId: string): Promise<{
  runnerId: string;
  result: Awaited<ReturnType<typeof runQueenManagerLoop>>;
  skipped?: boolean;
}> {
  const runnerId = makeRunnerId();

  const acquired = await tryAcquireTickLock(installationId, runnerId);
  if (acquired === "contention") {
    logger.info(
      `[queen-tick] lock contention installation=${installationId} — skip`,
    );
    // Return zeroed result so caller can serialize it consistently.
    return { runnerId, result: emptyManagerLoopResult(), skipped: true };
  }

  try {
    const appConfig = getAppConfig();
    const app = new App({
      appId: String(appConfig.appId),
      privateKey: appConfig.privateKey,
    });
    const octokit = await app.getInstallationOctokit(Number(installationId));

    const baseUrl = process.env.HIVEMOOT_API_BASE_URL ?? DEFAULT_BASE_URL;
    const client = new WarRoomClient({ baseUrl });
    const synthesizer = await createSynthesizer({
      installationId: Number(installationId),
    });
    const poster = new GitHubDecisionPoster({ octokit });

    const result = await runQueenManagerLoop({
      client,
      synthesizer,
      decisionPoster: poster,
      runnerId,
      maxRoomsPerTick: parseMaxRoomsPerTick(),
      log: makeManagerLoopLogAdapter(),
    });

    return { runnerId, result };
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

  // Resolve installationId.
  // url.parse via WHATWG URL; req.url is just the path so prepend a
  // dummy origin to make WHATWG URL happy.
  const url = new URL(req.url ?? "/", "http://placeholder.local");
  const idResult = resolveInstallationId(url);
  if (!idResult.ok) {
    writeJson(res, idResult.status, idResult.body);
    return;
  }

  // Run the tick.
  try {
    const { runnerId, result, skipped } = await runOneTick(
      idResult.installationId,
    );
    writeJson(res, 200, {
      runnerId,
      installationId: idResult.installationId,
      skipped: skipped ?? false,
      ...(skipped ? { reason: "lock_contention" } : {}),
      result,
    });
  } catch (err) {
    logger.error(
      `[queen-tick] unhandled error installation=${idResult.installationId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    writeJson(res, 500, {
      code: "tick_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
