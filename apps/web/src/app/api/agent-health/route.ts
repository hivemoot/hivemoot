/**
 * POST /api/agent-health
 *
 * Accepts health reports from autonomous agents. Authenticated via Bearer
 * token (agent token, not session cookie).
 *
 * Rate-limited to one report per agent per repo per 60 seconds.
 * Retries for the same run_id are idempotent.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequest } from "@/server/agent-health-auth";
import {
  validateReport,
  checkRateLimit,
  recordHealthReport,
  reserveHealthReportIdempotency,
  releaseHealthReportIdempotency,
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

  const allowed = await checkRateLimit(
    auth.installationId,
    report.agent_id,
    report.repo,
    auth.redis,
  );

  if (!allowed) {
    try {
      await releaseHealthReportIdempotency(auth.installationId, report, auth.redis);
    } catch {
      // Best-effort cleanup only; preserve the rate-limit response.
    }
    return agentHealthError(
      AGENT_HEALTH_ERROR.RATE_LIMITED,
      "Rate limited — one report per agent per repo per 60 seconds",
      429,
    );
  }

  try {
    await recordHealthReport(auth.installationId, report, auth.redis);
  } catch (error) {
    try {
      await releaseHealthReportIdempotency(auth.installationId, report, auth.redis);
    } catch {
      // Preserve the original storage error when cleanup fails.
    }
    throw error;
  }

  return NextResponse.json({ received: true, received_at: report.received_at });
}
