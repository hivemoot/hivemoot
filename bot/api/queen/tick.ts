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
 * Run one queen tick for the resolved installation. Wraps the
 * dependencies (WarRoomClient + Synthesizer + DecisionPoster) and
 * delegates to runQueenManagerLoop.
 *
 * No per-installation lock: at V1 scale (one Hive, one
 * installation) the cron interval (suggested every 2 minutes) is
 * larger than a typical tick (≪ 30s). Overlapping ticks are
 * already idempotent at the storage layer (claim_already_held +
 * sequence_drift catch any collisions). If multi-installation
 * scaling lands in V1.1, add the same compare-and-DEL Lua lock
 * pattern the watchdog uses.
 */
async function runOneTick(installationId: string): Promise<{
  runnerId: string;
  result: Awaited<ReturnType<typeof runQueenManagerLoop>>;
}> {
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
  const runnerId = makeRunnerId();

  const result = await runQueenManagerLoop({
    client,
    synthesizer,
    decisionPoster: poster,
    runnerId,
    maxRoomsPerTick: parseMaxRoomsPerTick(),
    log: {
      info: (msg) => logger.info(`[queen-tick] ${msg}`),
      warn: (msg) => logger.warn(`[queen-tick] ${msg}`),
      error: (msg) => logger.error(`[queen-tick] ${msg}`),
    },
  });

  return { runnerId, result };
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
    const { runnerId, result } = await runOneTick(idResult.installationId);
    writeJson(res, 200, {
      runnerId,
      installationId: idResult.installationId,
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
