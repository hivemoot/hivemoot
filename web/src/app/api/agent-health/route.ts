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
 *          ?agent_id=X                  → run history for one agent (per-agent)
 *          ?history=true&agent_id=X     → same as above (explicit history request)
 *        A `repo` param is accepted-and-ignored (health is per-agent now).
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { parseContentLength } from "@/server/request-utils";
import {
  AGENT_ID_PATTERN,
  validateReport,
  validateHeartbeat,
  checkRateLimit,
  recordHealthReport,
  recordHeartbeat,
  reserveHealthReportIdempotency,
  commitHealthReportIdempotency,
  releaseHealthReportIdempotency,
  getOverview,
  getHistory,
} from "@/server/agent-health-store";
import { AGENT_HEALTH_ERROR, agentHealthError } from "@/server/agent-health-error";

const MAX_PAYLOAD_BYTES = 10 * 1024;
const textEncoder = new TextEncoder();

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

  // Heartbeats have a separate validation + recording path (no run_id,
  // no idempotency, no run history — just refresh the latest key TTL).
  if (
    typeof body === "object" && body !== null && !Array.isArray(body)
    && (body as Record<string, unknown>).outcome === "heartbeat"
  ) {
    return handleHeartbeat(body, request);
  }

  const validation = validateReport(body);
  if (!validation.ok) {
    return agentHealthError(
      AGENT_HEALTH_ERROR.VALIDATION_FAILED,
      validation.message,
      400,
    );
  }

  const auth = await authenticateAgentRequestV1(request, {
    requires: "agent_health.report",
  });
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
      "Rate limited — one report per agent per 60 seconds",
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

async function handleHeartbeat(body: unknown, request: NextRequest) {
  const validation = validateHeartbeat(body);
  if (!validation.ok) {
    return agentHealthError(
      AGENT_HEALTH_ERROR.VALIDATION_FAILED,
      validation.message,
      400,
    );
  }

  const auth = await authenticateAgentRequestV1(request, {
    requires: "agent_health.report",
  });
  if (!auth.ok) return auth.response;

  const { heartbeat } = validation;

  const allowed = await checkRateLimit(
    auth.installationId,
    heartbeat.agent_id,
    auth.redis,
  );

  if (!allowed) {
    return agentHealthError(
      AGENT_HEALTH_ERROR.RATE_LIMITED,
      "Rate limited — one report per agent per 60 seconds",
      429,
    );
  }

  await recordHeartbeat(auth.installationId, heartbeat, auth.redis);

  return NextResponse.json({ received: true, received_at: heartbeat.received_at });
}

// ---------------------------------------------------------------------------
// Demo mode — local development without Redis/auth
// ---------------------------------------------------------------------------

function demoOverview() {
  const now = new Date().toISOString();
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const future = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();

  return [
    {
      agent_id: "builder", outcome: "success" as const,
      status: "ok" as const, received_at: ago(3), next_run_at: future(280),
      duration_secs: 542, consecutive_failures: 0, run_id: "20260321-151241-claude-builder",
      trigger: "mention" as const,
      run_summary: "Reviewed PR #420 — all 13 CI checks pass including Docker Build & Security Scan. Approved at current head `0c9dbf24`. Ready to merge.",
      token_usage: {
        input_tokens: 62, output_tokens: 25749,
        cache_read_input_tokens: 3697965, cache_creation_input_tokens: 82114,
        cost_usd: 1.80, num_turns: 76,
        model_breakdown: { "claude-sonnet-4-6": { input_tokens: 62, output_tokens: 25749, cache_read_input_tokens: 3697965, cache_creation_input_tokens: 82114, cost_usd: 1.80 } },
      },
    },
    {
      agent_id: "drone", outcome: "success" as const,
      status: "ok" as const, received_at: ago(12), next_run_at: future(240),
      duration_secs: 798, consecutive_failures: 0, run_id: "20260321-143022-claude-drone",
      trigger: "scheduled" as const,
      run_summary: "Opened PR #458 — fix(merge-readiness): skip label eval on passing check_run conclusions. All 1659 tests pass.",
      token_usage: {
        input_tokens: 340, output_tokens: 18200,
        cache_read_input_tokens: 2100000, cache_creation_input_tokens: 45000,
        cost_usd: 1.42, num_turns: 42,
        model_breakdown: { "claude-sonnet-4-6": { input_tokens: 340, output_tokens: 18200, cache_read_input_tokens: 2100000, cache_creation_input_tokens: 45000, cost_usd: 1.42 } },
      },
    },
    {
      agent_id: "guard", outcome: "success" as const,
      status: "ok" as const, received_at: ago(5), next_run_at: future(290),
      duration_secs: 114, consecutive_failures: 0, run_id: "20260321-151241-codex-guard",
      trigger: "mention" as const,
      token_usage: {
        input_tokens: 420000, output_tokens: 4000,
        cache_read_input_tokens: 380000, cache_creation_input_tokens: null,
        cost_usd: null, num_turns: 1, model_breakdown: null,
      },
    },
    {
      agent_id: "forager", outcome: "success" as const,
      status: "ok" as const, received_at: ago(45), next_run_at: future(200),
      duration_secs: 620, consecutive_failures: 0, run_id: "20260321-140500-claude-sonnet-forager",
      trigger: "scheduled" as const,
      run_summary: "Audited 3 dependency updates. No security issues found. Created issue #612 for optional lodash removal.",
      token_usage: {
        input_tokens: 180, output_tokens: 12400,
        cache_read_input_tokens: 1500000, cache_creation_input_tokens: 32000,
        cost_usd: 0.95, num_turns: 28,
        model_breakdown: { "claude-sonnet-4-6": { input_tokens: 180, output_tokens: 12400, cache_read_input_tokens: 1500000, cache_creation_input_tokens: 32000, cost_usd: 0.95 } },
      },
    },
    {
      agent_id: "worker", outcome: "failure" as const,
      status: "failed" as const, received_at: ago(90), next_run_at: future(150),
      duration_secs: 1800, consecutive_failures: 2, run_id: "20260321-121500-codex-xhigh-worker",
      trigger: "scheduled" as const, error: "provider timeout after 1800s",
      token_usage: {
        input_tokens: 890000, output_tokens: 15000,
        cache_read_input_tokens: 600000, cache_creation_input_tokens: null,
        cost_usd: null, num_turns: 1, model_breakdown: null,
      },
    },
    {
      agent_id: "heater", outcome: "success" as const,
      status: "ok" as const, received_at: ago(20), next_run_at: future(260),
      duration_secs: 310, consecutive_failures: 0, run_id: "20260321-144200-claude-sonnet-heater",
      trigger: "mention" as const,
      run_summary: "Verified claim in issue #295: alias-aware checks are now correctly detecting governance pipelines. Confirmed fix is valid.",
      token_usage: {
        input_tokens: 95, output_tokens: 8700,
        cache_read_input_tokens: 980000, cache_creation_input_tokens: 18000,
        cost_usd: 0.62, num_turns: 15,
        model_breakdown: { "claude-sonnet-4-6": { input_tokens: 95, output_tokens: 8700, cache_read_input_tokens: 980000, cache_creation_input_tokens: 18000, cost_usd: 0.62 } },
      },
    },
    {
      agent_id: "builder", outcome: "timeout" as const,
      status: "failed" as const, received_at: ago(180), next_run_at: future(60),
      duration_secs: 1800, consecutive_failures: 3, run_id: "20260321-110000-claude-builder",
      trigger: "scheduled" as const, error: "global slot timeout (300s)",
    },
    {
      agent_id: "scout", outcome: "success" as const,
      status: "ok" as const, received_at: ago(30), next_run_at: future(255),
      duration_secs: 185, consecutive_failures: 0, run_id: "20260321-143500-codex-scout",
      trigger: "scheduled" as const,
      token_usage: {
        input_tokens: 310000, output_tokens: 6200,
        cache_read_input_tokens: 250000, cache_creation_input_tokens: null,
        cost_usd: null, num_turns: 3, model_breakdown: null,
      },
    },
    {
      agent_id: "nurse", outcome: "success" as const,
      status: "late" as const, received_at: ago(400), next_run_at: ago(30),
      duration_secs: 250, consecutive_failures: 0, run_id: "20260321-072000-codex-nurse",
      trigger: "scheduled" as const,
      token_usage: {
        input_tokens: 280000, output_tokens: 3800,
        cache_read_input_tokens: 200000, cache_creation_input_tokens: null,
        cost_usd: null, num_turns: 1, model_breakdown: null,
      },
    },
    {
      agent_id: "drone", outcome: "success" as const,
      status: "ok" as const, received_at: ago(8), next_run_at: future(270),
      duration_secs: 430, consecutive_failures: 0, run_id: "20260321-150200-claude-drone",
      trigger: "mention" as const,
      run_summary: "Reviewed merge readiness for PR #458. CI green, approved.",
      token_usage: {
        input_tokens: 210, output_tokens: 14300,
        cache_read_input_tokens: 1800000, cache_creation_input_tokens: 38000,
        cost_usd: 1.15, num_turns: 34,
        model_breakdown: {
          "claude-sonnet-4-6": { input_tokens: 180, output_tokens: 12000, cache_read_input_tokens: 1600000, cache_creation_input_tokens: 30000, cost_usd: 0.95 },
          "claude-haiku-4-5": { input_tokens: 30, output_tokens: 2300, cache_read_input_tokens: 200000, cache_creation_input_tokens: 8000, cost_usd: 0.20 },
        },
      },
    },
  ];
}

function demoHistory(agentId: string) {
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  return [
    {
      agent_id: agentId, outcome: "success" as const,
      received_at: ago(5), duration_secs: 542, consecutive_failures: 0,
      run_id: `20260321-151241-claude-${agentId}`, trigger: "mention" as const,
      run_summary: "Reviewed PR #420 — all CI checks green. Approved and ready to merge.",
      token_usage: {
        input_tokens: 62, output_tokens: 25749,
        cache_read_input_tokens: 3697965, cache_creation_input_tokens: 82114,
        cost_usd: 1.80, num_turns: 76,
        model_breakdown: { "claude-sonnet-4-6": { input_tokens: 62, output_tokens: 25749, cache_read_input_tokens: 3697965, cache_creation_input_tokens: 82114, cost_usd: 1.80 } },
      },
    },
    {
      agent_id: agentId, outcome: "success" as const,
      received_at: ago(310), duration_secs: 798, consecutive_failures: 0,
      run_id: `20260321-100200-claude-${agentId}`, trigger: "scheduled" as const,
      run_summary: "Periodic sweep. No new issues to address. Verified 2 open PRs still have passing CI.",
      token_usage: {
        input_tokens: 120, output_tokens: 8400,
        cache_read_input_tokens: 1200000, cache_creation_input_tokens: 22000,
        cost_usd: 0.68, num_turns: 18,
        model_breakdown: { "claude-sonnet-4-6": { input_tokens: 120, output_tokens: 8400, cache_read_input_tokens: 1200000, cache_creation_input_tokens: 22000, cost_usd: 0.68 } },
      },
    },
    {
      agent_id: agentId, outcome: "timeout" as const,
      received_at: ago(620), duration_secs: 1800, consecutive_failures: 1,
      run_id: `20260320-220000-claude-${agentId}`, trigger: "scheduled" as const,
      exit_code: 124, error: "global slot timeout (300s)",
    },
    {
      agent_id: agentId, outcome: "success" as const,
      received_at: ago(930), duration_secs: 415, consecutive_failures: 0,
      run_id: `20260320-165500-claude-${agentId}`, trigger: "mention" as const,
      run_summary: "Security review on PR #415. No vulnerabilities found. Approved.",
      token_usage: {
        input_tokens: 85, output_tokens: 11200,
        cache_read_input_tokens: 900000, cache_creation_input_tokens: 15000,
        cost_usd: 0.55, num_turns: 22,
        model_breakdown: { "claude-sonnet-4-6": { input_tokens: 85, output_tokens: 11200, cache_read_input_tokens: 900000, cache_creation_input_tokens: 15000, cost_usd: 0.55 } },
      },
    },
  ];
}

export async function GET(request: NextRequest) {
  // Demo mode for local development — bypasses auth and returns mock data
  if (process.env.DEMO_MODE === "1") {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get("agent_id");

    if (agentId) {
      return NextResponse.json({ agent_id: agentId, history: demoHistory(agentId), runs: demoHistory(agentId) });
    }
    return NextResponse.json({ agents: demoOverview() });
  }

  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const installationId = auth.session.installationId;

  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agent_id");
  const historyFlag = searchParams.get("history");
  const wantsHistory = historyFlag === "true";
  // `repo` is accepted-and-ignored (health is per-agent now).

  // Null-installation sessions have no agents reporting. Return the same
  // empty shape the dashboard already renders gracefully.
  if (installationId === null) {
    if (wantsHistory || agentId) {
      return NextResponse.json({ agent_id: agentId ?? "", history: [], runs: [] });
    }
    return NextResponse.json({ agents: [] });
  }

  if (wantsHistory && !agentId) {
    return agentHealthError(
      AGENT_HEALTH_ERROR.MISSING_FIELDS,
      "history=true requires agent_id",
      400,
    );
  }

  if (agentId) {
    if (agentId.length < 1 || agentId.length > 64 || !AGENT_ID_PATTERN.test(agentId)) {
      return agentHealthError(
        AGENT_HEALTH_ERROR.VALIDATION_FAILED,
        "agent_id must be 1-64 chars and match [a-z0-9_-]",
        400,
      );
    }

    try {
      const history = await getHistory(
        installationId,
        agentId,
        auth.redis,
      );

      return NextResponse.json({
        agent_id: agentId,
        history,
        runs: history,
      });
    } catch (err) {
      console.error("[agent-health] Failed to fetch history", {
        installationId,
        agentId,
        error: err,
      });
      return agentHealthError(
        AGENT_HEALTH_ERROR.SERVER_MISCONFIGURATION,
        "Failed to load agent history",
        500,
      );
    }
  }

  try {
    const overview = await getOverview(installationId, auth.redis);
    return NextResponse.json({ agents: overview });
  } catch (err) {
    console.error("[agent-health] Failed to fetch overview", {
      installationId,
      error: err,
    });
    return agentHealthError(
      AGENT_HEALTH_ERROR.SERVER_MISCONFIGURATION,
      "Failed to load agent health data",
      500,
    );
  }
}
