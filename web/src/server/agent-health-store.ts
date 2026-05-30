/**
 * Agent health report storage and retrieval.
 *
 * Health is a PER-AGENT signal — there is no `repo` dimension. One row per
 * `agent_id` per installation.
 *
 * Redis layout per agent:
 *
 *   agent-health:latest:{installId}:{agentId}
 *     → HealthReport JSON, dynamic TTL:
 *       max(24h, 2 × secondsUntilNextRun) when next_run_at is provided
 *
 *   agent-health:runs:{installId}:{agentId}
 *     → Sorted set, score = received_at epoch ms, member = JSON report
 *     → Trimmed to last 24 hours on each write
 *
 *   agent-health:index:{installId}
 *     → Set of "{agentId}" members for enumeration. Legacy "{agentId}:{repo}"
 *       members (pre-per-agent) are self-healed away by getOverview.
 *
 *   agent-health:ratelimit:{installId}:{agentId}
 *     → NX/EX guard — one report per agent per 60 seconds
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

export type TriggerType = "scheduled" | "mention" | "manual" | "task";

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

export interface HeartbeatPayload {
  agent_id: string;
  outcome: "heartbeat";
  next_run_at?: string;
  received_at: string; // server-assigned
}

export type AgentStatus = "ok" | "failed" | "late" | "unknown";

export interface HealthOverviewEntry {
  agent_id: string;
  run_id?: string;
  outcome?: HealthReport["outcome"] | "heartbeat";
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

function latestKey(installId: string, agentId: string): string {
  return `agent-health:latest:${installId}:${agentId}`;
}

function runsKey(installId: string, agentId: string): string {
  return `agent-health:runs:${installId}:${agentId}`;
}

function indexKey(installId: string): string {
  return `agent-health:index:${installId}`;
}

function rateLimitKey(installId: string, agentId: string): string {
  return `agent-health:ratelimit:${installId}:${agentId}`;
}

function idempotencyKey(
  installId: string,
  agentId: string,
  runId: string,
): string {
  const digest = createHash("sha256")
    .update(`${agentId}\u0000${runId}`)
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
    idempotencyKey(installId, report.agent_id, report.run_id),
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
const VALID_TRIGGERS = new Set<TriggerType>(["scheduled", "mention", "manual", "task"]);
// `repo` is accepted-and-ignored (NOT validated, NOT stored). Health is now a
// per-agent signal, but a still-running static agent may keep sending `repo`
// during the rollout — tolerate it so those posts don't 400. New repo-less
// agents simply omit it.
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
const HEARTBEAT_ALLOWED_FIELDS = new Set([
  "agent_id",
  "repo",
  "outcome",
  "next_run_at",
]);
// Superset of VALID_OUTCOMES — includes "heartbeat" for stored latest entries.
const DISPLAY_OUTCOMES = new Set(["success", "failure", "timeout", "heartbeat"]);

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

  // `repo` is intentionally not validated — it is accepted and ignored (see
  // ALLOWED_FIELDS) so static agents still mid-rollout don't 400.

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

  let normalizedTokenUsage: TokenUsage | null | undefined;

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
      t.cache_read_input_tokens != null
      && (typeof t.cache_read_input_tokens !== "number" || !Number.isInteger(t.cache_read_input_tokens) || t.cache_read_input_tokens < 0)
    ) {
      return { ok: false, message: "token_usage.cache_read_input_tokens must be a non-negative integer or null" };
    }
    if (
      t.cache_creation_input_tokens != null
      && (typeof t.cache_creation_input_tokens !== "number" || !Number.isInteger(t.cache_creation_input_tokens) || t.cache_creation_input_tokens < 0)
    ) {
      return { ok: false, message: "token_usage.cache_creation_input_tokens must be a non-negative integer or null" };
    }
    if (
      t.cost_usd != null
      && (typeof t.cost_usd !== "number" || t.cost_usd < 0)
    ) {
      return { ok: false, message: "token_usage.cost_usd must be a non-negative number or null" };
    }
    if (typeof t.num_turns !== "number" || !Number.isInteger(t.num_turns) || t.num_turns < 0) {
      return { ok: false, message: "token_usage.num_turns must be a non-negative integer" };
    }
    let normalizedModelBreakdown: Record<string, ModelTokenUsage> | null = null;
    if (t.model_breakdown !== null && t.model_breakdown !== undefined) {
      if (typeof t.model_breakdown !== "object" || Array.isArray(t.model_breakdown)) {
        return { ok: false, message: "token_usage.model_breakdown must be an object or null" };
      }
      const mb = t.model_breakdown as Record<string, unknown>;
      normalizedModelBreakdown = {};
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
          u.cache_read_input_tokens != null
          && (typeof u.cache_read_input_tokens !== "number" || !Number.isInteger(u.cache_read_input_tokens) || u.cache_read_input_tokens < 0)
        ) {
          return { ok: false, message: `token_usage.model_breakdown.${modelId}.cache_read_input_tokens must be a non-negative integer or null` };
        }
        if (
          u.cache_creation_input_tokens != null
          && (typeof u.cache_creation_input_tokens !== "number" || !Number.isInteger(u.cache_creation_input_tokens) || u.cache_creation_input_tokens < 0)
        ) {
          return { ok: false, message: `token_usage.model_breakdown.${modelId}.cache_creation_input_tokens must be a non-negative integer or null` };
        }
        if (
          u.cost_usd != null
          && (typeof u.cost_usd !== "number" || u.cost_usd < 0)
        ) {
          return { ok: false, message: `token_usage.model_breakdown.${modelId}.cost_usd must be a non-negative number or null` };
        }
        normalizedModelBreakdown[modelId] = {
          input_tokens: u.input_tokens,
          output_tokens: u.output_tokens,
          cache_read_input_tokens: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : null,
          cache_creation_input_tokens: typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : null,
          cost_usd: typeof u.cost_usd === "number" ? u.cost_usd : null,
        };
      }
    }
    normalizedTokenUsage = {
      input_tokens: t.input_tokens,
      output_tokens: t.output_tokens,
      cache_read_input_tokens: typeof t.cache_read_input_tokens === "number" ? t.cache_read_input_tokens : null,
      cache_creation_input_tokens: typeof t.cache_creation_input_tokens === "number" ? t.cache_creation_input_tokens : null,
      cost_usd: typeof t.cost_usd === "number" ? t.cost_usd : null,
      num_turns: t.num_turns,
      model_breakdown: normalizedModelBreakdown,
    };
  } else if (obj.token_usage === null) {
    normalizedTokenUsage = null;
  }

  const report: HealthReport = {
    agent_id: obj.agent_id,
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
  if (normalizedTokenUsage !== undefined) report.token_usage = normalizedTokenUsage;

  return { ok: true, report };
}

// ---------------------------------------------------------------------------
// Heartbeat validation
// ---------------------------------------------------------------------------

export type HeartbeatValidationResult = {
  ok: true;
  heartbeat: HeartbeatPayload;
} | {
  ok: false;
  message: string;
};

/**
 * Validates a heartbeat payload — the lightweight liveness signal agents send
 * between runs. Only agent_id, outcome ("heartbeat"), and optional next_run_at
 * are meaningful. `repo` is accepted-and-ignored for rollout tolerance.
 */
export function validateHeartbeat(body: unknown): HeartbeatValidationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "Body must be a JSON object" };
  }

  const obj = body as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!HEARTBEAT_ALLOWED_FIELDS.has(key)) {
      return { ok: false, message: `Unknown field for heartbeat: ${key}` };
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

  // `repo` is intentionally not validated — accepted and ignored (rollout
  // tolerance for static agents still sending it).

  if (obj.outcome !== "heartbeat") {
    return { ok: false, message: "outcome must be 'heartbeat'" };
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

  const heartbeat: HeartbeatPayload = {
    agent_id: obj.agent_id,
    outcome: "heartbeat",
    received_at: new Date().toISOString(),
  };

  if (typeof obj.next_run_at === "string") heartbeat.next_run_at = obj.next_run_at;

  return { ok: true, heartbeat };
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Reserves a run_id for this installation+agent pair.
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

  const key = idempotencyKey(installId, report.agent_id, report.run_id);
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
  const key = idempotencyKey(installId, report.agent_id, report.run_id);
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
  await redis.del(idempotencyKey(installId, report.agent_id, report.run_id));
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
  redis: Redis,
): Promise<boolean> {
  const result = await redis.set(
    rateLimitKey(installId, agentId),
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
function computeLatestTtl(report: { next_run_at?: string }): number {
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
  const { agent_id, received_at } = report;
  const score = new Date(received_at).getTime();
  const cutoff = score - HISTORY_RETENTION_MS;
  const ttl = computeLatestTtl(report);

  await redis
    .multi()
    .set(
      latestKey(installId, agent_id),
      report,
      { ex: ttl },
    )
    .zadd(
      runsKey(installId, agent_id),
      { score, member: JSON.stringify(report) },
    )
    .sadd(indexKey(installId), agent_id)
    .zremrangebyscore(
      runsKey(installId, agent_id),
      "-inf",
      cutoff,
    )
    .exec();
}

/**
 * Records a heartbeat — refreshes the latest key TTL and optionally updates
 * next_run_at without overwriting run history data. If an existing latest
 * report exists, its run fields are preserved. If no prior report exists,
 * a minimal heartbeat entry is stored so the agent appears on the dashboard.
 *
 * Heartbeats are NOT added to the runs sorted set (they aren't runs).
 */
export async function recordHeartbeat(
  installId: string,
  heartbeat: HeartbeatPayload,
  redis: Redis,
): Promise<void> {
  const { agent_id } = heartbeat;
  const key = latestKey(installId, agent_id);

  // Read existing latest report to preserve run data
  const existing = await redis.get(key);

  let dataToStore: Record<string, unknown>;

  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    // Patch existing report: refresh timestamps, keep run data intact
    dataToStore = { ...(existing as Record<string, unknown>) };
    dataToStore.received_at = heartbeat.received_at;
    if (heartbeat.next_run_at) {
      dataToStore.next_run_at = heartbeat.next_run_at;
    }
  } else {
    // No prior report — store minimal heartbeat entry
    dataToStore = { ...heartbeat };
  }

  const ttl = computeLatestTtl(dataToStore as { next_run_at?: string });

  await redis
    .multi()
    .set(key, dataToStore, { ex: ttl })
    .sadd(indexKey(installId), agent_id)
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

  // Runtime data from Redis may contain "heartbeat" — cast for the check.
  const outcome = report.outcome as string;

  if (outcome === "failure" || outcome === "timeout") return "failed";

  // Heartbeat: agent is alive and checking in between runs
  if (outcome === "heartbeat") return "ok";

  if (outcome === "success") {
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
 * Returns an overview of all agents for an installation — one entry per
 * agent_id, with status derived from the latest report.
 *
 * Self-heal: the index now stores plain `{agentId}` members, but a legacy
 * `{agentId}:{repo}` member may linger from the per-repo era. For such a member
 * we best-effort read the per-agent latest key (the part before the first `:`),
 * and if that misses we SREM the stale legacy member. The read is dedup'd by
 * the resolved key so two legacy `agentId:repoA` / `agentId:repoB` members
 * collapse to a single row. Malformed members never crash the read.
 */
export async function getOverview(
  installId: string,
  redis: Redis,
): Promise<HealthOverviewEntry[]> {
  const members = await redis.smembers(indexKey(installId));
  if (!members || members.length === 0) return [];

  // Resolve each raw index member to a per-agent latest key, remembering the
  // original member string so a stale one can be SREM'd. A member containing
  // `:` is legacy (agentId:repo); we take the agentId before the first `:`.
  const resolved: Array<{ rawMember: string; agentId: string; key: string }> = [];
  for (const member of members) {
    if (typeof member !== "string" || member.length === 0) continue;
    const separatorIdx = member.indexOf(":");
    // We resolve a legacy `{agentId}:{repo}` member to the NEW per-agent latest
    // key only. A pre-refactor record's DATA lived at the old repo-suffixed
    // `latest:...:{agentId}:{repo}` key and is intentionally NOT migrated — it
    // TTLs out (24h); a mid-rollout static agent simply re-appears under its new
    // per-agent key on its next heartbeat.
    const agentId = separatorIdx === -1 ? member : member.slice(0, separatorIdx);
    if (agentId.length === 0) {
      // Unparseable member (e.g. leading ":"). Drop it defensively.
      void srembStaleMember(installId, member, redis);
      continue;
    }
    resolved.push({ rawMember: member, agentId, key: latestKey(installId, agentId) });
  }

  if (resolved.length === 0) return [];

  // Dedup reads by latest key so two legacy members for the same agent collapse.
  const uniqueKeys = [...new Set(resolved.map((r) => r.key))];
  const pipeline = redis.pipeline();
  for (const key of uniqueKeys) {
    pipeline.get(key);
  }
  const results = await pipeline.exec();

  const reportByKey = new Map<string, unknown>();
  for (let i = 0; i < uniqueKeys.length; i += 1) {
    reportByKey.set(uniqueKeys[i], results[i] ?? null);
  }

  const entries: HealthOverviewEntry[] = [];
  const seenAgents = new Set<string>();

  for (const { rawMember, agentId, key } of resolved) {
    const reportRaw = reportByKey.get(key) ?? null;

    if (typeof reportRaw === "object" && reportRaw !== null && !Array.isArray(reportRaw)) {
      const report = reportRaw as Partial<HealthReport>;

      if (
        typeof report.agent_id === "string"
        && typeof report.received_at === "string"
      ) {
        // A legacy member resolved to a live per-agent key — it's stale (the
        // canonical member is the plain agentId). Self-heal it away.
        if (rawMember !== agentId) {
          void srembStaleMember(installId, rawMember, redis);
        }

        if (!seenAgents.has(report.agent_id)) {
          seenAgents.add(report.agent_id);
          entries.push({
            agent_id: report.agent_id,
            run_id: typeof report.run_id === "string" ? report.run_id : undefined,
            outcome: DISPLAY_OUTCOMES.has((report.outcome as string) ?? "")
              ? (report.outcome as HealthOverviewEntry["outcome"])
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
        }
        continue;
      }
    }

    // Latest key expired or corrupt — remove the stale index member. A live
    // agent re-registers via SADD on its next POST. (A plain-agentId member is
    // self-healed here too once its latest key expires.)
    void srembStaleMember(installId, rawMember, redis);
  }

  // Sort by received_at descending (most recent first)
  entries.sort((a, b) => b.received_at.localeCompare(a.received_at));

  return entries;
}

/**
 * Best-effort removal of a stale index member. Never throws — a failed cleanup
 * is logged and ignored so a read is never blocked by index hygiene.
 */
function srembStaleMember(installId: string, member: string, redis: Redis): Promise<void> {
  return Promise.resolve(redis.srem(indexKey(installId), member))
    .then(() => undefined)
    .catch((err) => {
      console.warn("[agent-health] Failed to remove stale index entry", {
        member,
        error: err,
      });
    });
}

/**
 * Returns the run history for a specific agent (per-agent — no repo dimension).
 * Results are sorted newest-first, limited to MAX_HISTORY_ENTRIES.
 */
export async function getHistory(
  installId: string,
  agentId: string,
  redis: Redis,
): Promise<HealthReport[]> {
  const key = runsKey(installId, agentId);

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
