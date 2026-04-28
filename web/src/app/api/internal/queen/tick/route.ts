/**
 * GET / POST /api/internal/queen/tick — Vercel Cron-driven war-room watchdog.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` per Vercel's
 * documented cron pattern. NOT V1 capability auth — this is a
 * platform-level invocation, no user-bearer involved (closes
 * design L963-969). Missing or mismatched bearer → 401 with no body
 * so an external caller can't probe for the env var. Misconfig
 * (CRON_SECRET unset) ALSO returns 401 with the misconfig logged
 * server-side (closes #524 guard B2 — no oracle for "fresh
 * deployment" vs "wrong bearer").
 *
 * Method:
 *   - **GET** — Vercel Cron's actual invocation method. Reads
 *     `installationId` from the query string (`?installationId=X`)
 *     so the cron entry in `web/vercel.json` can fully specify the
 *     target. Closes #524 builder B3 — Vercel Cron sends GET, not
 *     POST, and supplies no body. The prior POST-only route was
 *     untriggerable in production.
 *   - **POST** — manual/test invocation. Reads `installationId`
 *     from JSON body. Same auth + lock semantics.
 *
 * Per-installation serialization: SET key runnerId NX EX 55 +
 * compare-and-DEL Lua release. Overlapping fires no-op cleanly
 * (200 with `skipped` field set), no double-work.
 *
 * Response: `{ skipped: boolean, result?: QueenTickResult }`
 *
 * Errors:
 *   - 401 — no/wrong bearer OR CRON_SECRET unset (empty body, no oracle)
 *   - 400 — malformed body / missing installationId / wrong shape
 *   - 500 — unhandled error during tick (logged structured)
 */

import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { parseJsonBody } from "@/server/request-utils";
import {
  runQueenTick,
  queenTickLockKey,
  QUEEN_TICK_LOCK_RELEASE_SCRIPT,
  QUEEN_TICK_LOCK_TTL_SECS,
} from "@/server/queen-tick";

interface TickRequestBody {
  installationId?: string;
}

/** GitHub installation IDs are numeric. Pinning the format prevents
 * non-numeric values from reaching `listRooms` / lock-key
 * interpolation (closes #524 guard N4 — defense-in-depth even
 * though the cron-bearer holder is trusted). */
const INSTALLATION_ID_REGEX = /^\d+$/;

function getCronSecret(): string | null {
  const v = process.env.CRON_SECRET;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function getRedis(): Redis {
  return Redis.fromEnv();
}

function makeRunnerId(): string {
  return `vercel.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
}

/** Auth check shared by both verbs. Returns the validated CRON_SECRET
 * on success, or a NextResponse to short-circuit on failure.
 *
 * The misconfig path (CRON_SECRET unset) also returns 401 — same
 * response as wrong-bearer — so an external probe can't differentiate
 * "deployment isn't configured" from "your bearer is wrong" (closes
 * #524 guard B2). The misconfig is logged server-side so ops sees it
 * via Vercel logs / dashboard.
 */
function checkCronAuth(request: NextRequest): NextResponse | null {
  const expected = getCronSecret();
  if (expected === null) {
    console.error(
      "[queen-tick] CRON_SECRET is not set in this deployment — refusing all requests. Add CRON_SECRET to the env (Vercel dashboard → Settings → Environment Variables).",
    );
    return new NextResponse(null, { status: 401 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${expected}`) {
    return new NextResponse(null, { status: 401 });
  }
  return null;
}

function rejectInvalidInstallationId(
  installationId: string | null | undefined,
): NextResponse | null {
  if (
    typeof installationId !== "string" ||
    installationId.length === 0 ||
    !INSTALLATION_ID_REGEX.test(installationId)
  ) {
    return NextResponse.json(
      {
        code: "invalid_installation_id",
        message:
          "installationId must be a non-empty numeric string (GitHub installation IDs).",
      },
      { status: 400 },
    );
  }
  return null;
}

/**
 * Run the tick under the per-installation lock, return the response.
 * Shared body for GET + POST so both verbs run identical logic.
 */
async function runTickWithLock(installationId: string): Promise<NextResponse> {
  const redis = getRedis();
  const lockKey = queenTickLockKey(installationId);
  const runnerId = makeRunnerId();

  const acquired = await redis.set(lockKey, runnerId, {
    nx: true,
    ex: QUEEN_TICK_LOCK_TTL_SECS,
  });
  if (acquired === null) {
    return NextResponse.json(
      { skipped: true, reason: "lock_contention" },
      { status: 200 },
    );
  }

  try {
    const result = await runQueenTick({ installationId, redis });
    return NextResponse.json(
      { skipped: false, runnerId, result },
      { status: 200 },
    );
  } catch (err) {
    console.error(
      `[queen-tick] unhandled error installation=${installationId} runner=${runnerId}:`,
      err,
    );
    return NextResponse.json(
      {
        code: "tick_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  } finally {
    try {
      await redis.eval(
        QUEEN_TICK_LOCK_RELEASE_SCRIPT,
        [lockKey],
        [runnerId],
      );
    } catch (releaseErr) {
      console.warn(
        `[queen-tick] lock release error installation=${installationId} runner=${runnerId}:`,
        releaseErr,
      );
    }
  }
}

/**
 * GET — Vercel Cron's actual entry point. `installationId` from
 * query string lets the `vercel.json` `crons` entry fully specify
 * the target via path: `path: "/api/internal/queen/tick?installationId=12345"`.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const authReject = checkCronAuth(request);
  if (authReject) return authReject;

  const url = new URL(request.url);
  const installationId = url.searchParams.get("installationId");
  const reject = rejectInvalidInstallationId(installationId);
  if (reject) return reject;

  return await runTickWithLock(installationId as string);
}

/**
 * POST — manual/test invocation. Reads `installationId` from JSON
 * body. Same auth + lock as GET.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const authReject = checkCronAuth(request);
  if (authReject) return authReject;

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) {
    return NextResponse.json(
      { code: parsed.code, message: parsed.message },
      { status: 400 },
    );
  }
  const body = parsed.body as TickRequestBody;
  const reject = rejectInvalidInstallationId(body.installationId);
  if (reject) return reject;

  return await runTickWithLock(body.installationId as string);
}
