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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthReport {
  agent_id: string;
  repo: string;
  status: "idle" | "working" | "error";
  current_issue?: number;
  summary?: string;
  error_message?: string;
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

const VALID_STATUSES = new Set(["idle", "working", "error"]);

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

  if (typeof obj.agent_id !== "string" || obj.agent_id.length === 0) {
    return { ok: false, message: "agent_id is required and must be a non-empty string" };
  }
  if (typeof obj.repo !== "string" || obj.repo.length === 0) {
    return { ok: false, message: "repo is required and must be a non-empty string" };
  }
  if (typeof obj.status !== "string" || !VALID_STATUSES.has(obj.status)) {
    return { ok: false, message: "status must be one of: idle, working, error" };
  }

  if (obj.current_issue !== undefined && typeof obj.current_issue !== "number") {
    return { ok: false, message: "current_issue must be a number if provided" };
  }
  if (obj.summary !== undefined && typeof obj.summary !== "string") {
    return { ok: false, message: "summary must be a string if provided" };
  }
  if (obj.error_message !== undefined && typeof obj.error_message !== "string") {
    return { ok: false, message: "error_message must be a string if provided" };
  }

  const report: HealthReport = {
    agent_id: obj.agent_id,
    repo: obj.repo,
    status: obj.status as HealthReport["status"],
    received_at: new Date().toISOString(),
  };

  if (typeof obj.current_issue === "number") report.current_issue = obj.current_issue;
  if (typeof obj.summary === "string") report.summary = obj.summary;
  if (typeof obj.error_message === "string") report.error_message = obj.error_message;

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

  // SET latest with TTL
  await redis.set(
    latestKey(installId, agent_id, repo),
    report,
    { ex: LATEST_TTL_SECONDS },
  );

  // ZADD to sorted set (score = epoch ms)
  await redis.zadd(
    runsKey(installId, agent_id, repo),
    { score, member: JSON.stringify(report) },
  );

  // SADD to index
  await redis.sadd(indexKey(installId), `${agent_id}:${repo}`);

  // Trim runs older than 24 hours
  const cutoff = score - HISTORY_RETENTION_MS;
  await redis.zremrangebyscore(
    runsKey(installId, agent_id, repo),
    "-inf",
    cutoff,
  );
}
