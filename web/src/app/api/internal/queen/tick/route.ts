/**
 * POST /api/internal/queen/tick — Vercel Cron-driven war-room watchdog.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` per Vercel's
 * documented cron pattern. NOT V1 capability auth — this is a
 * platform-level invocation, no user-bearer involved (closes
 * design L963-969). Missing or mismatched bearer → 401 with no body
 * so an external caller can't probe for the env var.
 *
 * Per-installation serialization: uses
 * `QUEEN_TICK_LOCK_RELEASE_SCRIPT` compare-and-DEL pattern with a
 * 55s TTL. Overlapping fires no-op cleanly (200 with `skipped`
 * field set), no double-work, no double-LLM-calls (Phase G' will
 * use this gate).
 *
 * Body: `{ installationId: string }` — caller specifies which
 * installation to tick. (Future enhancement: scan all
 * installations server-side; for V1 the cron config issues one
 * tick per installation.)
 *
 * Response: `{ skipped: boolean, result?: QueenTickResult }`
 *
 * Errors:
 *   - 401 — no/wrong bearer (response body is null per design L967)
 *   - 400 — malformed body / missing installationId
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get("authorization");
  const expected = getCronSecret();
  if (expected === null) {
    return NextResponse.json(
      {
        code: "server_misconfiguration",
        message: "CRON_SECRET is not set in this deployment.",
      },
      { status: 500 },
    );
  }
  if (authHeader !== `Bearer ${expected}`) {
    return new NextResponse(null, { status: 401 });
  }

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) {
    return NextResponse.json(
      { code: parsed.code, message: parsed.message },
      { status: 400 },
    );
  }
  const body = parsed.body as TickRequestBody;
  if (
    typeof body.installationId !== "string" ||
    body.installationId.length === 0
  ) {
    return NextResponse.json(
      {
        code: "invalid_installation_id",
        message: "Body must include `installationId` (non-empty string).",
      },
      { status: 400 },
    );
  }
  const installationId = body.installationId;

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

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      code: "method_not_allowed",
      message: "POST /api/internal/queen/tick only.",
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}
