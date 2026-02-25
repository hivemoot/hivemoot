/**
 * POST /api/agent-health
 *
 * Accepts health reports from autonomous agents. Authenticated via Bearer
 * token (agent token, not session cookie).
 *
 * Rate-limited to one report per agent per repo per 60 seconds.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequest } from "@/server/agent-health-auth";
import {
  validateReport,
  checkRateLimit,
  recordHealthReport,
} from "@/server/agent-health-store";
import { AGENT_HEALTH_ERROR, agentHealthError } from "@/server/agent-health-error";

export async function POST(request: NextRequest) {
  const auth = await authenticateAgentRequest(request);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
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

  const { report } = validation;
  const allowed = await checkRateLimit(
    auth.installationId,
    report.agent_id,
    report.repo,
    auth.redis,
  );

  if (!allowed) {
    return agentHealthError(
      AGENT_HEALTH_ERROR.RATE_LIMITED,
      "Rate limited — one report per agent per repo per 60 seconds",
      429,
    );
  }

  await recordHealthReport(auth.installationId, report, auth.redis);

  return NextResponse.json({ received: true, received_at: report.received_at });
}
