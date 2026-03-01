/**
 * POST / GET /api/agent-health
 *
 * POST — Accepts health reports from autonomous agents. Authenticated via
 *        Bearer token (agent token).
 *
 * GET  — Returns health overview or per-agent history. Authenticated via
 *        setup session cookie (for dashboard users).
 *        Query params:
 *          (none)                       → overview of all agents
 *          ?agent_id=X&repo=Y           → run history for one agent+repo
 *          ?history=true&agent_id=X&repo=Y
 *                                       → same as above (explicit history request)
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { authenticateAgentRequest } from "@/server/agent-health-auth";
import {
  AGENT_ID_PATTERN,
  validateReport,
  checkRateLimit,
  recordHealthReport,
  reserveHealthReportIdempotency,
  commitHealthReportIdempotency,
  releaseHealthReportIdempotency,
  getOverview,
  getHistory,
} from "@/server/agent-health-store";
import { AGENT_HEALTH_ERROR, agentHealthError } from "@/server/agent-health-error";

const MAX_PAYLOAD_BYTES = 10 * 1024;
const textEncoder = new TextEncoder();

function parseContentLength(header: string | null): number | null {
  if (!header) return null;
  const parsed = Number(header);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function payloadTooLargeResponse() {
  return agentHealthError(
    AGENT_HEALTH_ERROR.PAYLOAD_TOO_LARGE,
    "Payload too large (max 10KB)",
    413,
  );
}

export async function POST(request: NextRequest) {
  const contentLength = parseContentLength(request.headers.get("content-length"));
  if (contentLength !== null && contentLength > MAX_PAYLOAD_BYTES) {
    return payloadTooLargeResponse();
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return agentHealthError(
      AGENT_HEALTH_ERROR.INVALID_JSON,
      "Invalid JSON body",
      400,
    );
  }

  if (textEncoder.encode(bodyText).length > MAX_PAYLOAD_BYTES) {
    return payloadTooLargeResponse();
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return agentHealthError(
      AGENT_HEALTH_ERROR.INVALID_JSON,
      "Invalid JSON body",
      400,
    );
  }

  const validation = validateReport(body);
  if (!validation.ok) {
    return agentHealthError(
      AGENT_HEALTH_ERROR.VALIDATION_FAILED,
      validation.message,
      400,
    );
  }

  const auth = await authenticateAgentRequest(request);
  if (!auth.ok) return auth.response;

  const { report } = validation;
  const idempotency = await reserveHealthReportIdempotency(
    auth.installationId,
    report,
    auth.redis,
  );

  if (idempotency.kind === "duplicate") {
    return NextResponse.json({
      received: true,
      received_at: idempotency.receivedAt,
      duplicate: true,
    });
  }

  if (idempotency.kind === "conflict") {
    return agentHealthError(
      AGENT_HEALTH_ERROR.IDEMPOTENCY_CONFLICT,
      "run_id already exists with a different payload",
      409,
    );
  }

  if (idempotency.kind === "pending") {
    return agentHealthError(
      AGENT_HEALTH_ERROR.IDEMPOTENCY_PENDING,
      "run_id is currently being processed; retry shortly",
      409,
    );
  }

  const allowed = await checkRateLimit(
    auth.installationId,
    report.agent_id,
    report.repo,
    auth.redis,
  );

  if (!allowed) {
    try {
      await releaseHealthReportIdempotency(auth.installationId, report, auth.redis);
    } catch (cleanupErr) {
      console.warn("[agent-health] Best-effort idempotency cleanup failed after rate-limit", {
        installationId: auth.installationId,
        agentId: report.agent_id,
        runId: report.run_id,
        error: cleanupErr,
      });
    }
    return agentHealthError(
      AGENT_HEALTH_ERROR.RATE_LIMITED,
      "Rate limited — one report per agent per repo per 60 seconds",
      429,
    );
  }

  let persisted = false;
  try {
    await recordHealthReport(auth.installationId, report, auth.redis);
    persisted = true;
    await commitHealthReportIdempotency(auth.installationId, report, auth.redis);
  } catch (error) {
    if (!persisted) {
      try {
        await releaseHealthReportIdempotency(auth.installationId, report, auth.redis);
      } catch (cleanupErr) {
        console.error("[agent-health] Idempotency cleanup failed during write error recovery", {
          installationId: auth.installationId,
          runId: report.run_id,
          cleanupError: cleanupErr,
        });
      }
    }
    throw error;
  }

  return NextResponse.json({ received: true, received_at: report.received_at });
}

export async function GET(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agent_id");
  const repo = searchParams.get("repo");
  const historyFlag = searchParams.get("history");
  const wantsHistory = historyFlag === "true";

  if (wantsHistory && (!agentId || !repo)) {
    return agentHealthError(
      AGENT_HEALTH_ERROR.MISSING_FIELDS,
      "history=true requires both agent_id and repo",
      400,
    );
  }

  if (agentId && repo) {
    if (agentId.length < 1 || agentId.length > 64 || !AGENT_ID_PATTERN.test(agentId)) {
      return agentHealthError(
        AGENT_HEALTH_ERROR.VALIDATION_FAILED,
        "agent_id must be 1-64 chars and match [a-z0-9_-]",
        400,
      );
    }
    if (repo.length < 1 || repo.length > 200 || !repo.includes("/")) {
      return agentHealthError(
        AGENT_HEALTH_ERROR.VALIDATION_FAILED,
        "repo must be 1-200 chars in owner/name format",
        400,
      );
    }

    try {
      const history = await getHistory(
        auth.session.installationId,
        agentId,
        repo,
        auth.redis,
      );

      return NextResponse.json({
        agent_id: agentId,
        repo,
        history,
        runs: history,
      });
    } catch (err) {
      console.error("[agent-health] Failed to fetch history", {
        installationId: auth.session.installationId,
        agentId,
        repo,
        error: err,
      });
      return agentHealthError(
        AGENT_HEALTH_ERROR.SERVER_MISCONFIGURATION,
        "Failed to load agent history",
        500,
      );
    }
  }

  if (agentId || repo) {
    return agentHealthError(
      AGENT_HEALTH_ERROR.MISSING_FIELDS,
      "Both agent_id and repo are required for history queries",
      400,
    );
  }

  try {
    const overview = await getOverview(auth.session.installationId, auth.redis);
    return NextResponse.json({ agents: overview });
  } catch (err) {
    console.error("[agent-health] Failed to fetch overview", {
      installationId: auth.session.installationId,
      error: err,
    });
    return agentHealthError(
      AGENT_HEALTH_ERROR.SERVER_MISCONFIGURATION,
      "Failed to load agent health data",
      500,
    );
  }
}
