/**
 * Agent health report storage.
 *
 * Redis layout per agent:
 *
 *   agent-health:latest:{installId}:{agentId}:{repo}
 *     → HealthReport JSON, TTL 30 min (online indicator)
 *
 *   agent-health:runs:{installId}:{agentId}:{repo}
 *     → Sorted set, score = received_at epoch ms, member = JSON report
 *     → Trimmed to last 24 hours on each write
 *
 *   agent-health:index:{installId}
 *     → Set of "{agentId}:{repo}" combos for enumeration
 *
 *   agent-health:ratelimit:{installId}:{agentId}:{repo}
 *     → NX/EX guard — one report per agent per repo per 60 seconds
 */

import { type Redis } from "@upstash/redis";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LATEST_TTL_SECONDS = 30 * 60; // 30 minutes
const RATE_LIMIT_SECONDS = 60;
const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const AGENT_ID_PATTERN = /^[a-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthReport {
  agent_id: string;
  repo: string;
  run_id: string;
  outcome: "success" | "failure" | "timeout";
  duration_secs: number;
  consecutive_failures: number;
  error?: string;
  exit_code?: number;
  received_at: string; // ISO 8601, server-assigned
}

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

function latestKey(installId: string, agentId: string, repo: string): string {
  return `agent-health:latest:${installId}:${agentId}:${repo}`;
}

function runsKey(installId: string, agentId: string, repo: string): string {
  return `agent-health:runs:${installId}:${agentId}:${repo}`;
}

function indexKey(installId: string): string {
  return `agent-health:index:${installId}`;
}

function rateLimitKey(installId: string, agentId: string, repo: string): string {
  return `agent-health:ratelimit:${installId}:${agentId}:${repo}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_OUTCOMES = new Set(["success", "failure", "timeout"]);
const ALLOWED_FIELDS = new Set([
  "agent_id",
  "repo",
  "run_id",
  "outcome",
  "duration_secs",
  "consecutive_failures",
  "error",
  "exit_code",
]);

export type ValidationResult = {
  ok: true;
  report: HealthReport;
} | {
  ok: false;
  message: string;
};

export function validateReport(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "Body must be a JSON object" };
  }

  const obj = body as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return { ok: false, message: `Unknown field: ${key}` };
    }
  }

  if (
    typeof obj.agent_id !== "string"
    || obj.agent_id.length < 1
    || obj.agent_id.length > 64
    || !AGENT_ID_PATTERN.test(obj.agent_id)
  ) {
    return {
      ok: false,
      message: "agent_id must be 1-64 chars and match [a-z0-9_-]",
    };
  }

  if (
    typeof obj.repo !== "string"
    || obj.repo.length < 1
    || obj.repo.length > 200
    || !obj.repo.includes("/")
  ) {
    return {
      ok: false,
      message: "repo must be 1-200 chars in owner/name format",
    };
  }

  if (
    typeof obj.run_id !== "string"
    || obj.run_id.length < 1
    || obj.run_id.length > 128
  ) {
    return {
      ok: false,
      message: "run_id must be a string (1-128 chars)",
    };
  }

  if (typeof obj.outcome !== "string" || !VALID_OUTCOMES.has(obj.outcome)) {
    return { ok: false, message: "outcome must be one of: success, failure, timeout" };
  }

  if (
    typeof obj.duration_secs !== "number"
    || !Number.isInteger(obj.duration_secs)
    || obj.duration_secs < 0
    || obj.duration_secs > 86400
  ) {
    return { ok: false, message: "duration_secs must be an integer between 0 and 86400" };
  }

  if (
    typeof obj.consecutive_failures !== "number"
    || !Number.isInteger(obj.consecutive_failures)
    || obj.consecutive_failures < 0
  ) {
    return { ok: false, message: "consecutive_failures must be an integer >= 0" };
  }

  if (
    obj.error !== undefined
    && (typeof obj.error !== "string" || obj.error.length < 1 || obj.error.length > 256)
  ) {
    return { ok: false, message: "error must be a string (1-256 chars) if provided" };
  }

  if (
    obj.exit_code !== undefined
    && (typeof obj.exit_code !== "number" || !Number.isInteger(obj.exit_code))
  ) {
    return { ok: false, message: "exit_code must be an integer if provided" };
  }

  const report: HealthReport = {
    agent_id: obj.agent_id,
    repo: obj.repo,
    run_id: obj.run_id,
    outcome: obj.outcome as HealthReport["outcome"],
    duration_secs: obj.duration_secs,
    consecutive_failures: obj.consecutive_failures,
    received_at: new Date().toISOString(),
  };

  if (typeof obj.error === "string") report.error = obj.error;
  if (typeof obj.exit_code === "number") report.exit_code = obj.exit_code;

  return { ok: true, report };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Returns true if the request is allowed, false if rate-limited.
 * Uses SET NX EX for atomic check-and-set with automatic expiry.
 */
export async function checkRateLimit(
  installId: string,
  agentId: string,
  repo: string,
  redis: Redis,
): Promise<boolean> {
  const result = await redis.set(
    rateLimitKey(installId, agentId, repo),
    "1",
    { nx: true, ex: RATE_LIMIT_SECONDS },
  );
  // Upstash returns "OK" on success, null if key already exists
  return result === "OK";
}

// ---------------------------------------------------------------------------
// Write pipeline
// ---------------------------------------------------------------------------

/**
 * Records a validated health report in Redis.
 * Pipeline: SET latest (30min TTL) + ZADD runs + SADD index + trim old runs.
 */
export async function recordHealthReport(
  installId: string,
  report: HealthReport,
  redis: Redis,
): Promise<void> {
  const { agent_id, repo, received_at } = report;
  const score = new Date(received_at).getTime();
  const cutoff = score - HISTORY_RETENTION_MS;

  await redis
    .multi()
    .set(
      latestKey(installId, agent_id, repo),
      report,
      { ex: LATEST_TTL_SECONDS },
    )
    .zadd(
      runsKey(installId, agent_id, repo),
      { score, member: JSON.stringify(report) },
    )
    .sadd(indexKey(installId), `${agent_id}:${repo}`)
    .zremrangebyscore(
      runsKey(installId, agent_id, repo),
      "-inf",
      cutoff,
    )
    .exec();
}
