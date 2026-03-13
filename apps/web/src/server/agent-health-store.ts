/**
 * Agent health report storage and retrieval.
 *
 * Redis layout per agent:
 *
 *   agent-health:latest:{installId}:{agentId}:{repo}
 *     → HealthReport JSON, dynamic TTL:
 *       max(24h, 2 × secondsUntilNextRun) when next_run_at is provided
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
 *
 *   agent-health:idempotency:{installId}:{digest}
 *     → Run-id reservation for 24h dedupe/conflict checks, with
 *       pending/committed state to avoid false duplicate acknowledgements
 */

import { createHash } from "node:crypto";
import { type Redis } from "@upstash/redis";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LATEST_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const RATE_LIMIT_SECONDS = 60;
const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_HISTORY_ENTRIES = 1440; // read-side cap; ~24h at 1 report/min
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const MAX_RUN_SUMMARY_CHARS = 4096;
export const AGENT_ID_PATTERN = /^[a-z0-9_-]+$/;
const MODEL_PATTERN = /^[a-zA-Z0-9._:/-]{1,128}$/;
const ANSI_ESCAPE_PATTERN = /[\u001B\u009B](?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriggerType = "scheduled" | "mention" | "manual";

export interface ModelTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cost_usd: number | null;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cost_usd: number | null;
  num_turns: number;
  model_breakdown: Record<string, ModelTokenUsage> | null;
}

export interface HealthReport {
  agent_id: string;
  repo: string;
  run_id: string;
  outcome: "success" | "failure" | "timeout";
  duration_secs: number;
  consecutive_failures: number;
  model?: string;
  error?: string;
  exit_code?: number;
  next_run_at?: string; // ISO 8601, optional — when the next scheduled run is expected
  run_summary?: string;
  trigger?: TriggerType;
  token_usage?: TokenUsage | null;
  received_at: string; // ISO 8601, server-assigned
}

export type AgentStatus = "ok" | "failed" | "late" | "unknown";

export interface HealthOverviewEntry {
  agent_id: string;
  repo: string;
  run_id?: string;
  outcome?: HealthReport["outcome"];
  duration_secs?: number;
  consecutive_failures?: number;
  model?: string;
  error?: string;
  exit_code?: number;
  received_at: string;
  status: AgentStatus;
  next_run_at?: string;
  run_summary?: string;
  trigger?: TriggerType;
  token_usage?: TokenUsage | null;
}

function sanitizeRunSummary(input: string): string {
  const stripped = input.replace(ANSI_ESCAPE_PATTERN, "").trim();
  if (stripped.length <= MAX_RUN_SUMMARY_CHARS) return stripped;
  return stripped.slice(0, MAX_RUN_SUMMARY_CHARS);
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

function idempotencyKey(
  installId: string,
  agentId: string,
  repo: string,
  runId: string,
): string {
  const digest = createHash("sha256")
    .update(`${agentId}\u0000${repo}\u0000${runId}`)
    .digest("hex");
  return `agent-health:idempotency:${installId}:${digest}`;
}

type StoredIdempotencyRecord = {
  payload_hash: string;
  received_at: string;
  state: "pending" | "committed";
};

function idempotencyPayloadHash(report: HealthReport): string {
  return createHash("sha256")
    .update(JSON.stringify({
      agent_id: report.agent_id,
      repo: report.repo,
      run_id: report.run_id,
      outcome: report.outcome,
      duration_secs: report.duration_secs,
      consecutive_failures: report.consecutive_failures,
      error: report.error ?? null,
      exit_code: report.exit_code ?? null,
      next_run_at: report.next_run_at ?? null,
    }))
    .digest("hex");
}

function parseIdempotencyRecord(value: unknown): StoredIdempotencyRecord | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    try {
      return parseIdempotencyRecord(JSON.parse(value));
    } catch (err) {
      console.error("[agent-health] Failed to parse idempotency record from Redis", {
        valueLength: value.length,
        error: err,
      });
      return null;
    }
  }

  if (typeof value !== "object" || Array.isArray(value)) return null;

  const maybe = value as Record<string, unknown>;
  if (typeof maybe.payload_hash !== "string" || typeof maybe.received_at !== "string") {
    return null;
  }

  // Defensive default: if state field is absent (e.g. hand-edited record or
  // future schema change drops it), treat as committed rather than failing.
  let state: StoredIdempotencyRecord["state"] = "committed";
  if (maybe.state !== undefined) {
    if (maybe.state !== "pending" && maybe.state !== "committed") return null;
    state = maybe.state;
  }

  return {
    payload_hash: maybe.payload_hash,
    received_at: maybe.received_at,
    state,
  };
}

async function getIdempotencyRecord(
  installId: string,
  report: HealthReport,
  redis: Redis,
): Promise<StoredIdempotencyRecord | null> {
  const existing = await redis.get(
    idempotencyKey(installId, report.agent_id, report.repo, report.run_id),
  );
  return parseIdempotencyRecord(existing);
}

export type IdempotencyReservation =
  | { kind: "new"; receivedAt: string }
  | { kind: "duplicate"; receivedAt: string }
  | { kind: "pending" }
  | { kind: "conflict" };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_OUTCOMES = new Set(["success", "failure", "timeout"]);
const VALID_TRIGGERS = new Set<TriggerType>(["scheduled", "mention", "manual"]);
const ALLOWED_FIELDS = new Set([
  "agent_id",
  "repo",
  "run_id",
  "outcome",
  "duration_secs",
  "consecutive_failures",
  "model",
  "error",
  "exit_code",
  "next_run_at",
  "run_summary",
  "trigger",
  "token_usage",
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
    obj.model !== undefined
    && (typeof obj.model !== "string" || !MODEL_PATTERN.test(obj.model))
  ) {
    return {
      ok: false,
      message: "model must be 1-128 chars and match [a-zA-Z0-9._:/-]+ if provided",
    };
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

  if (obj.next_run_at !== undefined) {
    if (typeof obj.next_run_at !== "string" || obj.next_run_at.length > 64) {
      return { ok: false, message: "next_run_at must be a string (max 64 chars) if provided" };
    }
    const ts = new Date(obj.next_run_at).getTime();
    if (Number.isNaN(ts)) {
      return { ok: false, message: "next_run_at must be a valid ISO 8601 timestamp" };
    }
    const now = Date.now();
    if (ts < now - 5 * 60 * 1000) {
      return { ok: false, message: "next_run_at must not be more than 5 minutes in the past" };
    }
    if (ts > now + 48 * 60 * 60 * 1000) {
      return { ok: false, message: "next_run_at must not be more than 48 hours in the future" };
    }
  }

  if (obj.run_summary !== undefined) {
    if (typeof obj.run_summary !== "string") {
      return {
        ok: false,
        message: "run_summary must be a non-empty string after ANSI stripping if provided",
      };
    }

    const sanitizedRunSummary = sanitizeRunSummary(obj.run_summary);
    if (sanitizedRunSummary.length < 1) {
      return {
        ok: false,
        message: "run_summary must be a non-empty string after ANSI stripping if provided",
      };
    }
  }

  if (
    obj.trigger !== undefined
    && (typeof obj.trigger !== "string" || !VALID_TRIGGERS.has(obj.trigger as TriggerType))
  ) {
    return { ok: false, message: "trigger must be one of: scheduled, mention, manual" };
  }

  if (obj.token_usage !== undefined && obj.token_usage !== null) {
    const tu = obj.token_usage;
    if (typeof tu !== "object" || Array.isArray(tu)) {
      return { ok: false, message: "token_usage must be an object or null" };
    }
    const t = tu as Record<string, unknown>;

    if (typeof t.input_tokens !== "number" || !Number.isInteger(t.input_tokens) || t.input_tokens < 0) {
      return { ok: false, message: "token_usage.input_tokens must be a non-negative integer" };
    }
    if (typeof t.output_tokens !== "number" || !Number.isInteger(t.output_tokens) || t.output_tokens < 0) {
      return { ok: false, message: "token_usage.output_tokens must be a non-negative integer" };
    }
    if (
      t.cache_read_input_tokens !== null
      && (typeof t.cache_read_input_tokens !== "number" || !Number.isInteger(t.cache_read_input_tokens) || t.cache_read_input_tokens < 0)
    ) {
      return { ok: false, message: "token_usage.cache_read_input_tokens must be a non-negative integer or null" };
    }
    if (
      t.cache_creation_input_tokens !== null
      && (typeof t.cache_creation_input_tokens !== "number" || !Number.isInteger(t.cache_creation_input_tokens) || t.cache_creation_input_tokens < 0)
    ) {
      return { ok: false, message: "token_usage.cache_creation_input_tokens must be a non-negative integer or null" };
    }
    if (
      t.cost_usd !== null
      && (typeof t.cost_usd !== "number" || t.cost_usd < 0)
    ) {
      return { ok: false, message: "token_usage.cost_usd must be a non-negative number or null" };
    }
    if (typeof t.num_turns !== "number" || !Number.isInteger(t.num_turns) || t.num_turns < 0) {
      return { ok: false, message: "token_usage.num_turns must be a non-negative integer" };
    }
    if (t.model_breakdown !== null && t.model_breakdown !== undefined) {
      if (typeof t.model_breakdown !== "object" || Array.isArray(t.model_breakdown)) {
        return { ok: false, message: "token_usage.model_breakdown must be an object or null" };
      }
      const mb = t.model_breakdown as Record<string, unknown>;
      for (const [modelId, usage] of Object.entries(mb)) {
        if (!MODEL_PATTERN.test(modelId)) {
          return { ok: false, message: `token_usage.model_breakdown key must match [a-zA-Z0-9._:/-]+ (got: ${modelId})` };
        }
        if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
          return { ok: false, message: `token_usage.model_breakdown.${modelId} must be an object` };
        }
        const u = usage as Record<string, unknown>;
        if (typeof u.input_tokens !== "number" || !Number.isInteger(u.input_tokens) || u.input_tokens < 0) {
          return { ok: false, message: `token_usage.model_breakdown.${modelId}.input_tokens must be a non-negative integer` };
        }
        if (typeof u.output_tokens !== "number" || !Number.isInteger(u.output_tokens) || u.output_tokens < 0) {
          return { ok: false, message: `token_usage.model_breakdown.${modelId}.output_tokens must be a non-negative integer` };
        }
        if (
          u.cache_read_input_tokens !== null
          && (typeof u.cache_read_input_tokens !== "number" || !Number.isInteger(u.cache_read_input_tokens) || u.cache_read_input_tokens < 0)
        ) {
          return { ok: false, message: `token_usage.model_breakdown.${modelId}.cache_read_input_tokens must be a non-negative integer or null` };
        }
        if (
          u.cache_creation_input_tokens !== null
          && (typeof u.cache_creation_input_tokens !== "number" || !Number.isInteger(u.cache_creation_input_tokens) || u.cache_creation_input_tokens < 0)
        ) {
          return { ok: false, message: `token_usage.model_breakdown.${modelId}.cache_creation_input_tokens must be a non-negative integer or null` };
        }
        if (
          u.cost_usd !== null
          && (typeof u.cost_usd !== "number" || u.cost_usd < 0)
        ) {
          return { ok: false, message: `token_usage.model_breakdown.${modelId}.cost_usd must be a non-negative number or null` };
        }
      }
    }
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
  if (typeof obj.model === "string") report.model = obj.model;
  if (typeof obj.exit_code === "number") report.exit_code = obj.exit_code;
  if (typeof obj.next_run_at === "string") report.next_run_at = obj.next_run_at;
  if (typeof obj.run_summary === "string") report.run_summary = sanitizeRunSummary(obj.run_summary);
  if (typeof obj.trigger === "string") report.trigger = obj.trigger as TriggerType;
  if (obj.token_usage !== undefined) report.token_usage = obj.token_usage as TokenUsage | null;

  return { ok: true, report };
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Reserves a run_id for this installation+agent+repo tuple.
 * - first time: kind "new"
 * - exact retry: kind "duplicate" (same payload hash)
 * - conflicting retry: kind "conflict" (same run_id, different payload)
 */
export async function reserveHealthReportIdempotency(
  installId: string,
  report: HealthReport,
  redis: Redis,
): Promise<IdempotencyReservation> {
  const payloadHash = idempotencyPayloadHash(report);

  const existing = await getIdempotencyRecord(installId, report, redis);
  if (existing) {
    if (existing.payload_hash === payloadHash) {
      if (existing.state === "committed") {
        return { kind: "duplicate", receivedAt: existing.received_at };
      }
      return { kind: "pending" };
    }
    return { kind: "conflict" };
  }

  const record: StoredIdempotencyRecord = {
    payload_hash: payloadHash,
    received_at: report.received_at,
    state: "pending",
  };

  const key = idempotencyKey(installId, report.agent_id, report.repo, report.run_id);
  const reserved = await redis.set(
    key,
    JSON.stringify(record),
    { nx: true, ex: IDEMPOTENCY_TTL_SECONDS },
  );

  if (reserved === "OK") {
    return { kind: "new", receivedAt: report.received_at };
  }

  const raced = await getIdempotencyRecord(installId, report, redis);
  if (!raced) return { kind: "conflict" };

  if (raced.payload_hash === payloadHash) {
    if (raced.state === "committed") {
      return { kind: "duplicate", receivedAt: raced.received_at };
    }
    return { kind: "pending" };
  }

  return { kind: "conflict" };
}

export async function commitHealthReportIdempotency(
  installId: string,
  report: HealthReport,
  redis: Redis,
): Promise<void> {
  const key = idempotencyKey(installId, report.agent_id, report.repo, report.run_id);
  const record: StoredIdempotencyRecord = {
    payload_hash: idempotencyPayloadHash(report),
    received_at: report.received_at,
    state: "committed",
  };
  await redis.set(key, JSON.stringify(record), { ex: IDEMPOTENCY_TTL_SECONDS });
}

export async function releaseHealthReportIdempotency(
  installId: string,
  report: HealthReport,
  redis: Redis,
): Promise<void> {
  await redis.del(idempotencyKey(installId, report.agent_id, report.repo, report.run_id));
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
// TTL computation
// ---------------------------------------------------------------------------

/**
 * Computes the TTL for the latest-report key.
 * Floor is 24 hours so agents on long cycles (e.g. 8h) stay visible on the
 * dashboard even if they miss a cycle. When next_run_at is provided and
 * 2x the gap exceeds 24h, the TTL extends to cover that instead.
 */
function computeLatestTtl(report: HealthReport): number {
  if (typeof report.next_run_at === "string") {
    const nextRunMs = new Date(report.next_run_at).getTime();
    if (!Number.isNaN(nextRunMs)) {
      const secondsUntilNextRun = Math.ceil((nextRunMs - Date.now()) / 1000);
      if (secondsUntilNextRun > 0) {
        return Math.max(DEFAULT_LATEST_TTL_SECONDS, secondsUntilNextRun * 2);
      }
    }
  }
  return DEFAULT_LATEST_TTL_SECONDS;
}

// ---------------------------------------------------------------------------
// Write transaction
// ---------------------------------------------------------------------------

/**
 * Records a validated health report in Redis.
 * Transaction: SET latest (dynamic TTL) + ZADD runs + SADD index + trim old runs.
 */
export async function recordHealthReport(
  installId: string,
  report: HealthReport,
  redis: Redis,
): Promise<void> {
  const { agent_id, repo, received_at } = report;
  const score = new Date(received_at).getTime();
  const cutoff = score - HISTORY_RETENTION_MS;
  const ttl = computeLatestTtl(report);

  await redis
    .multi()
    .set(
      latestKey(installId, agent_id, repo),
      report,
      { ex: ttl },
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

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

/**
 * Derives the 4-state agent status from the latest report.
 * - No valid report → "unknown"
 * - Last outcome failure/timeout → "failed"
 * - Last outcome success + past next_run_at + 50% buffer → "late"
 * - Last outcome success (all other cases) → "ok"
 */
function deriveStatus(report: Partial<HealthReport> | null): AgentStatus {
  if (!report || typeof report.outcome !== "string") return "unknown";

  if (report.outcome === "failure" || report.outcome === "timeout") return "failed";

  if (report.outcome === "success") {
    const nextRunAt = report.next_run_at;
    if (typeof nextRunAt === "string") {
      const nextRunMs = new Date(nextRunAt).getTime();
      if (!Number.isNaN(nextRunMs)) {
        const receivedMs = typeof report.received_at === "string"
          ? new Date(report.received_at).getTime()
          : 0;
        const intervalMs = nextRunMs - receivedMs;
        // 50% buffer beyond next_run_at before marking late
        const bufferMs = intervalMs > 0 ? intervalMs * 0.5 : 0;
        if (Date.now() > nextRunMs + bufferMs) return "late";
      }
    }
    return "ok";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Read functions (used by GET endpoint)
// ---------------------------------------------------------------------------

/**
 * Returns an overview of all agents for an installation.
 * One entry per agent+repo combo, with status derived from latest report.
 */
export async function getOverview(
  installId: string,
  redis: Redis,
): Promise<HealthOverviewEntry[]> {
  const members = await redis.smembers(indexKey(installId));
  if (!members || members.length === 0) return [];

  const indexed = members
    .map((member) => {
      const separatorIdx = member.indexOf(":");
      if (separatorIdx <= 0 || separatorIdx === member.length - 1) return null;

      const agentId = member.slice(0, separatorIdx);
      const repo = member.slice(separatorIdx + 1);
      return {
        agentId,
        repo,
        key: latestKey(installId, agentId, repo),
      };
    })
    .filter((entry): entry is { agentId: string; repo: string; key: string } => entry !== null);

  if (indexed.length === 0) return [];

  const pipeline = redis.pipeline();
  for (const entry of indexed) {
    pipeline.get(entry.key);
  }
  const results = await pipeline.exec();

  const entries: HealthOverviewEntry[] = [];

  for (let i = 0; i < indexed.length; i += 1) {
    const reportRaw = results[i] ?? null;

    if (typeof reportRaw === "object" && reportRaw !== null && !Array.isArray(reportRaw)) {
      const report = reportRaw as Partial<HealthReport>;

      if (
        typeof report.agent_id === "string"
        && typeof report.repo === "string"
        && typeof report.received_at === "string"
      ) {
        entries.push({
          agent_id: report.agent_id,
          repo: report.repo,
          run_id: typeof report.run_id === "string" ? report.run_id : undefined,
          outcome: VALID_OUTCOMES.has(report.outcome ?? "")
            ? (report.outcome as HealthReport["outcome"])
            : undefined,
          duration_secs: typeof report.duration_secs === "number" ? report.duration_secs : undefined,
          consecutive_failures: typeof report.consecutive_failures === "number"
            ? report.consecutive_failures
            : undefined,
          model: typeof report.model === "string" ? report.model : undefined,
          error: typeof report.error === "string" ? report.error : undefined,
          exit_code: typeof report.exit_code === "number" ? report.exit_code : undefined,
          received_at: report.received_at,
          status: deriveStatus(report),
          next_run_at: typeof report.next_run_at === "string" ? report.next_run_at : undefined,
          run_summary: typeof report.run_summary === "string" ? report.run_summary : undefined,
          trigger: typeof report.trigger === "string" && VALID_TRIGGERS.has(report.trigger as TriggerType) ? report.trigger : undefined,
          token_usage: "token_usage" in report ? report.token_usage : undefined,
        });
        continue;
      }
    }

    // Latest key expired or corrupt — remove stale index entry.
    // The agent re-registers via SADD on its next POST.
    redis.srem(indexKey(installId), `${indexed[i].agentId}:${indexed[i].repo}`).catch((err) => {
      console.warn("[agent-health] Failed to remove stale index entry", {
        agentId: indexed[i].agentId,
        repo: indexed[i].repo,
        error: err,
      });
    });
  }

  // Sort by received_at descending (most recent first)
  entries.sort((a, b) => b.received_at.localeCompare(a.received_at));

  return entries;
}

/**
 * Returns the run history for a specific agent+repo combo.
 * Results are sorted newest-first, limited to MAX_HISTORY_ENTRIES.
 */
export async function getHistory(
  installId: string,
  agentId: string,
  repo: string,
  redis: Redis,
): Promise<HealthReport[]> {
  const key = runsKey(installId, agentId, repo);

  // Trim stale entries first
  const now = Date.now();
  const cutoff = now - HISTORY_RETENTION_MS;
  await redis.zremrangebyscore(key, "-inf", cutoff);

  // Fetch newest-first
  const raw = await redis.zrange(key, 0, MAX_HISTORY_ENTRIES - 1, { rev: true });
  if (!raw || raw.length === 0) return [];

  return raw
    .map((entry) => {
      let parsed: unknown;
      if (typeof entry === "string") {
        try {
          parsed = JSON.parse(entry);
        } catch (err) {
          console.warn("[agent-health] Corrupt history entry in Redis, skipping", {
            error: err,
            entryPreview: entry.slice(0, 100),
          });
          return null;
        }
      } else {
        parsed = entry;
      }

      if (
        typeof parsed === "object" && parsed !== null
        && typeof (parsed as Record<string, unknown>).agent_id === "string"
        && typeof (parsed as Record<string, unknown>).received_at === "string"
      ) {
        return parsed as HealthReport;
      }
      console.warn("[agent-health] Malformed history entry in Redis, skipping", {
        entryType: typeof parsed,
      });
      return null;
    })
    .filter((report): report is HealthReport => report !== null);
}
