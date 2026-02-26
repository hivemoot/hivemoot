/**
 * Agent health report storage and retrieval.
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

const LATEST_TTL_SECONDS = 30 * 60; // 30 minutes
const RATE_LIMIT_SECONDS = 60;
const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_HISTORY_ENTRIES = 1440; // read-side cap; ~24h at 1 report/min
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
export const AGENT_ID_PATTERN = /^[a-z0-9_-]+$/;
const MODEL_PATTERN = /^[a-zA-Z0-9._:/-]{1,128}$/;

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
  model?: string;
  error?: string;
  exit_code?: number;
  received_at: string; // ISO 8601, server-assigned
}

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
  received_at: string | null; // null when latest key is missing/corrupt
  online: boolean; // true if latest key still has TTL remaining
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
// Write transaction
// ---------------------------------------------------------------------------

/**
 * Records a validated health report in Redis.
 * Transaction: SET latest (30min TTL) + ZADD runs + SADD index + trim old runs.
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

// ---------------------------------------------------------------------------
// Read functions (used by GET endpoint)
// ---------------------------------------------------------------------------

/**
 * Returns an overview of all agents for an installation.
 * One entry per agent+repo combo, with online status derived from TTL.
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
    pipeline.ttl(entry.key);
  }
  const results = await pipeline.exec();

  const entries: HealthOverviewEntry[] = [];

  for (let i = 0; i < indexed.length; i += 1) {
    const reportRaw = results[i * 2] ?? null;
    const ttlRaw = results[(i * 2) + 1];
    const ttl = typeof ttlRaw === "number" ? ttlRaw : Number(ttlRaw);
    const online = Number.isFinite(ttl) && ttl > 0;

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
          online,
        });
        continue;
      }
    }

    // Agent existed but latest key is missing/corrupt — show as offline fallback.
    console.warn("[agent-health] Latest report missing or corrupt for indexed agent", {
      agentId: indexed[i].agentId,
      repo: indexed[i].repo,
      reportRawType: typeof reportRaw,
    });
    entries.push({
      agent_id: indexed[i].agentId,
      repo: indexed[i].repo,
      received_at: null,
      online: false,
    });
  }

  // Sort by received_at descending (most recent first); null entries sink to bottom
  entries.sort((a, b) => {
    if (a.received_at === null) return 1;
    if (b.received_at === null) return -1;
    return b.received_at.localeCompare(a.received_at);
  });

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
