import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type Redis } from "@upstash/redis";
import { withRedisLock, LockTimeoutError } from "@hivemoot/war-room/redis-lock";

export const MAX_CONCURRENT_TASKS = 3;
export const DEFAULT_TASK_TIMEOUT_SECONDS = 5 * 60;
export const MAX_TASK_TIMEOUT_SECONDS = 10 * 60;
export const COMPLETED_TASK_TTL_SECONDS = 7 * 24 * 60 * 60;
export const FAILED_TASK_TTL_SECONDS = 24 * 60 * 60;
export const TASK_CREATE_RATE_LIMIT_PER_MINUTE = 10;
const MAX_PROMPT_CHARS = 8000;
const MAX_PROGRESS_CHARS = 400;
const TASK_CLAIM_TOKEN_BYTES = 32;
const TASK_LOCK_PREFIX = "hive:task-lock:";

export const TASK_ID_PATTERN = /^[a-f0-9]{24}$/;

export type TaskStatus = "pending" | "running" | "needs_follow_up" | "completed" | "failed" | "timed_out";

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "timed_out"]);

// Tasks paused for human input — exempt from auto-timeout.
const PAUSED_STATUSES = new Set<TaskStatus>(["needs_follow_up"]);

export interface TaskMessage {
  role: "user" | "agent" | "system";
  content: string;
  created_at: string;
}

const MAX_MESSAGE_CONTENT_CHARS = 128_000;
const MAX_MESSAGES_PER_TASK = 200;

// ---------------------------------------------------------------------------
// Task artifacts (#332) — structured GitHub outputs an agent produced while
// working a task (PRs opened, issues filed, comments posted, commits pushed).
// Surfaced on the dashboard so a reviewer can jump straight to the result
// instead of scrubbing the chat log.
// ---------------------------------------------------------------------------

export type TaskArtifactType =
  | "pull_request"
  | "issue"
  | "issue_comment"
  | "commit";

const TASK_ARTIFACT_TYPES = new Set<TaskArtifactType>([
  "pull_request",
  "issue",
  "issue_comment",
  "commit",
]);

export interface TaskArtifact {
  type: TaskArtifactType;
  url: string;
  /** PR or issue number when the type implies one (absent for commits). */
  number?: number;
  /** Display name, sanitized + capped. */
  title?: string;
  /** Server-stamped when the artifact was first recorded. */
  created_at: string;
}

/** Artifact shape after validation but before the store stamps `created_at`. */
export type NormalizedTaskArtifact = Omit<TaskArtifact, "created_at">;

// 20 is generous for any real task and bounds both storage growth and the
// blast radius of a misbehaving agent spamming the append endpoint.
export const MAX_ARTIFACTS_PER_TASK = 20;
const MAX_ARTIFACT_TITLE_CHARS = 200;

// GitHub owner logins: alphanumeric + single hyphens, ≤39 chars, no leading
// hyphen. Repos: alphanumeric plus `.`, `_`, `-`, ≤100 chars. These mirror
// GitHub's own naming rules closely enough to reject path-traversal and
// obviously-malformed slugs without a network round-trip.
const GITHUB_OWNER_REGEX = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GITHUB_REPO_REGEX = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_COMMIT_SHA_REGEX = /^[0-9a-fA-F]{7,40}$/;

export interface TaskRecord {
  task_id: string;
  status: TaskStatus;
  prompt: string;
  timeout_secs: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  progress?: string;
  artifacts?: TaskArtifact[];
}

export interface ClaimedTask {
  task: TaskRecord;
  claim_token: string;
}

interface StoredTaskRecord {
  task_id: string;
  status: TaskStatus;
  prompt: string;
  timeout_secs: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  // Artifacts ride on the stored record so they carry through finalize/retry
  // (which spread `...stored`) and inherit the record's terminal TTL — no
  // separate key to TTL-manage. See addTaskArtifacts.
  artifacts?: TaskArtifact[];
}

export interface CreateTaskRequest {
  prompt: string;
  timeout_secs: number;
}

export type CreateTaskValidationResult =
  | { ok: true; request: CreateTaskRequest }
  | { ok: false; message: string };

export type CreateTaskResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; reason: "concurrency_limited" };

type TaskMutationFailureReason =
  | "not_found"
  | "invalid_transition"
  | "concurrency_limited"
  | "lock_timeout";
type TaskMutationResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; reason: TaskMutationFailureReason };

export type TaskTransitionResult = TaskMutationResult;
export type AddUserMessageResult = TaskMutationResult;

export type TaskDeleteResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "invalid_transition" };

export type TaskRetryResult = TaskMutationResult;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}


function taskKey(installationId: string, taskId: string): string {
  return `task:${installationId}:${taskId}`;
}

function taskProgressKey(installationId: string, taskId: string): string {
  return `task:${installationId}:${taskId}:progress`;
}

function taskMessagesKey(installationId: string, taskId: string): string {
  return `task:${installationId}:${taskId}:messages`;
}

function taskClaimTokenHashKey(installationId: string, taskId: string): string {
  return `task:${installationId}:${taskId}:claim-token-hash`;
}

function pendingKey(installationId: string): string {
  return `tasks:pending:${installationId}`;
}

function runningKey(installationId: string): string {
  return `tasks:running:${installationId}`;
}

function recentKey(installationId: string): string {
  return `tasks:recent:${installationId}`;
}

function createRateLimitKey(
  installationId: string,
  userId: number,
  minuteBucket: number,
): string {
  return `tasks:create-ratelimit:${installationId}:${userId}:${minuteBucket}`;
}

function taskLockKey(installationId: string): string {
  return `${TASK_LOCK_PREFIX}${installationId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function withTaskInstallationLock<T>(
  installationId: string,
  redis: Redis,
  fn: () => Promise<T>,
): Promise<T> {
  return withRedisLock(taskLockKey(installationId), redis, fn, {
    onReleaseError: (error) =>
      console.error("[tasks] Failed to release task lock", {
        installationId,
        error,
      }),
  });
}

function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function terminalTtl(status: TaskStatus): number {
  return status === "completed"
    ? COMPLETED_TASK_TTL_SECONDS
    : FAILED_TASK_TTL_SECONDS;
}

function sanitizeText(input: string, maxLength: number): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength);
}

// Lenient: drop individual malformed artifacts rather than failing the whole
// task parse (which would trip cleanupMissingTask and delete a live task).
function parseStoredArtifacts(raw: unknown): TaskArtifact[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const out: TaskArtifact[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const o = entry as Record<string, unknown>;
    if (
      typeof o.type !== "string"
      || !TASK_ARTIFACT_TYPES.has(o.type as TaskArtifactType)
      || typeof o.url !== "string"
      || typeof o.created_at !== "string"
    ) {
      continue;
    }

    const artifact: TaskArtifact = {
      type: o.type as TaskArtifactType,
      url: o.url,
      created_at: o.created_at,
    };
    if (typeof o.number === "number" && Number.isInteger(o.number)) {
      artifact.number = o.number;
    }
    if (typeof o.title === "string") {
      artifact.title = o.title;
    }
    out.push(artifact);
  }

  return out.length > 0 ? out : undefined;
}

function parseStoredTask(raw: unknown): StoredTaskRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.task_id !== "string"
    || !TASK_ID_PATTERN.test(obj.task_id)
    || typeof obj.status !== "string"
    || !["pending", "running", "needs_follow_up", "completed", "failed", "timed_out"].includes(obj.status)
    || typeof obj.prompt !== "string"
    || typeof obj.timeout_secs !== "number"
    || !Number.isInteger(obj.timeout_secs)
    || typeof obj.created_by !== "string"
    || typeof obj.created_at !== "string"
    || typeof obj.updated_at !== "string"
  ) {
    return null;
  }

  const parsed: StoredTaskRecord = {
    task_id: obj.task_id,
    status: obj.status as TaskStatus,
    prompt: obj.prompt,
    timeout_secs: obj.timeout_secs,
    created_by: obj.created_by,
    created_at: obj.created_at,
    updated_at: obj.updated_at,
  };

  if (typeof obj.started_at === "string") parsed.started_at = obj.started_at;
  if (typeof obj.finished_at === "string") parsed.finished_at = obj.finished_at;
  if (typeof obj.error === "string") parsed.error = obj.error;

  const artifacts = parseStoredArtifacts(obj.artifacts);
  if (artifacts) parsed.artifacts = artifacts;

  return parsed;
}

function generateTaskId(): string {
  return randomBytes(12).toString("hex");
}

function generateTaskClaimToken(): string {
  return randomBytes(TASK_CLAIM_TOKEN_BYTES).toString("hex");
}

function hashTaskClaimToken(claimToken: string): string {
  return createHash("sha256").update(claimToken).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function parseIsoTimestampMs(value?: string): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function transitionDeadlineMs(task: StoredTaskRecord): number {
  const baseCandidates = task.status === "running"
    ? [task.updated_at, task.started_at, task.created_at]
    : [task.created_at];

  for (const candidate of baseCandidates) {
    const baseTs = parseIsoTimestampMs(candidate);
    if (baseTs !== null) {
      return baseTs + task.timeout_secs * 1000;
    }
  }

  return Date.now() + task.timeout_secs * 1000;
}

function requeueTaskToPending(stored: StoredTaskRecord, timestamp: string): StoredTaskRecord {
  return {
    ...stored,
    status: "pending",
    // Reset lifecycle timestamps so timeout checks use the new attempt window.
    created_at: timestamp,
    updated_at: timestamp,
    started_at: undefined,
    finished_at: undefined,
    error: undefined,
  };
}

async function withTaskTransitionLock(
  installationId: string,
  taskId: string,
  redis: Redis,
  operation: string,
  fn: () => Promise<TaskTransitionResult>,
): Promise<TaskTransitionResult> {
  try {
    return await withTaskInstallationLock(installationId, redis, fn);
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      console.warn(operation, {
        installationId,
        taskId,
      });
      return { ok: false, reason: "lock_timeout" };
    }
    throw error;
  }
}

async function cleanupMissingTask(
  installationId: string,
  taskId: string,
  redis: Redis,
): Promise<void> {
  await redis
    .multi()
    .zrem(pendingKey(installationId), taskId)
    .zrem(runningKey(installationId), taskId)
    .zrem(recentKey(installationId), taskId)
    .del(taskProgressKey(installationId, taskId))
    .del(taskMessagesKey(installationId, taskId))
    .del(taskClaimTokenHashKey(installationId, taskId))
    .exec();
}

async function loadStoredTask(
  installationId: string,
  taskId: string,
  redis: Redis,
): Promise<StoredTaskRecord | null> {
  const raw = await redis.get(taskKey(installationId, taskId));
  const parsed = parseStoredTask(raw);
  if (parsed) return parsed;
  if (raw !== null && raw !== undefined) {
    console.error("[tasks] Invalid task metadata in Redis", {
      installationId,
      taskId,
    });
  }
  await cleanupMissingTask(installationId, taskId, redis);
  return null;
}

async function buildTaskRecord(
  installationId: string,
  stored: StoredTaskRecord,
  redis: Redis,
): Promise<TaskRecord> {
  const progressRaw = await redis.get(taskProgressKey(installationId, stored.task_id));

  const task: TaskRecord = {
    ...stored,
  };

  if (typeof progressRaw === "string") task.progress = progressRaw;

  return task;
}

async function countActiveTasks(installationId: string, redis: Redis): Promise<number> {
  const [pendingCount, runningCount] = await Promise.all([
    redis.zcard(pendingKey(installationId)),
    redis.zcard(runningKey(installationId)),
  ]);

  return pendingCount + runningCount;
}

async function maybeTimeoutTask(
  installationId: string,
  stored: StoredTaskRecord,
  redis: Redis,
): Promise<StoredTaskRecord> {
  if (isTerminal(stored.status) || PAUSED_STATUSES.has(stored.status)) return stored;

  const deadlineMs = transitionDeadlineMs(stored);
  if (Date.now() <= deadlineMs) return stored;

  const errorDetail = `Timed out after ${stored.timeout_secs} seconds`;
  const timestamp = nowIso();
  const timedOut = await finalizeTask(
    installationId,
    stored.task_id,
    "timed_out",
    {
      error: errorDetail,
      progress: errorDetail,
      messages: [
        { role: "system", content: "Task timed out.", created_at: timestamp },
      ],
    },
    redis,
    new Set(["pending", "running"]),
  );

  if (!timedOut.ok) return stored;
  return {
    task_id: timedOut.task.task_id,
    status: timedOut.task.status,
    prompt: timedOut.task.prompt,
    timeout_secs: timedOut.task.timeout_secs,
    created_by: timedOut.task.created_by,
    created_at: timedOut.task.created_at,
    updated_at: timedOut.task.updated_at,
    started_at: timedOut.task.started_at,
    finished_at: timedOut.task.finished_at,
    error: timedOut.task.error,
  };
}

export function validateCreateTaskRequest(body: unknown): CreateTaskValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Body must be a JSON object" };
  }

  const obj = body as Record<string, unknown>;
  const allowedFields = new Set(["prompt", "timeout_secs"]);
  for (const key of Object.keys(obj)) {
    if (!allowedFields.has(key)) {
      return { ok: false, message: `Unknown field: ${key}` };
    }
  }

  if (typeof obj.prompt !== "string") {
    return { ok: false, message: "prompt must be a string" };
  }

  const prompt = sanitizeText(obj.prompt, MAX_PROMPT_CHARS);
  if (prompt.length < 1) {
    return { ok: false, message: "prompt must not be empty" };
  }

  let timeoutSecs = DEFAULT_TASK_TIMEOUT_SECONDS;
  if (obj.timeout_secs !== undefined) {
    if (
      typeof obj.timeout_secs !== "number"
      || !Number.isInteger(obj.timeout_secs)
      || obj.timeout_secs < 1
      || obj.timeout_secs > MAX_TASK_TIMEOUT_SECONDS
    ) {
      return {
        ok: false,
        message: `timeout_secs must be an integer between 1 and ${MAX_TASK_TIMEOUT_SECONDS}`,
      };
    }
    timeoutSecs = obj.timeout_secs;
  }

  return {
    ok: true,
    request: {
      prompt,
      timeout_secs: timeoutSecs,
    },
  };
}

export async function checkTaskCreateRateLimit(
  installationId: string,
  userId: number,
  redis: Redis,
): Promise<RateLimitResult> {
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const key = createRateLimitKey(installationId, userId, minuteBucket);

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 60);
  }

  if (count > TASK_CREATE_RATE_LIMIT_PER_MINUTE) {
    return { allowed: false, retryAfterSeconds: 60 };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

export async function createTask(
  installationId: string,
  createdBy: string,
  request: CreateTaskRequest,
  redis: Redis,
): Promise<CreateTaskResult> {
  try {
    return await withTaskInstallationLock(installationId, redis, async () => {
      const activeTaskCount = await countActiveTasks(installationId, redis);
      if (activeTaskCount >= MAX_CONCURRENT_TASKS) {
        return { ok: false, reason: "concurrency_limited" };
      }

      const taskId = generateTaskId();
      const ts = Date.now();
      const timestamp = new Date(ts).toISOString();

      const stored: StoredTaskRecord = {
        task_id: taskId,
        status: "pending",
        prompt: request.prompt,
        timeout_secs: request.timeout_secs,
        created_by: createdBy,
        created_at: timestamp,
        updated_at: timestamp,
      };

      await redis
        .multi()
        .set(taskKey(installationId, taskId), stored)
        .set(taskProgressKey(installationId, taskId), "Queued")
        .zadd(pendingKey(installationId), { score: ts, member: taskId })
        .zadd(recentKey(installationId), { score: ts, member: taskId })
        .exec();

      // Append initial user prompt as the first message in the timeline.
      // Best-effort: the task is already committed so a Redis failure here
      // must not cause a 500 — the prompt is recoverable from the task record.
      try {
        const initialMessage: TaskMessage = {
          role: "user",
          content: request.prompt,
          created_at: timestamp,
        };
        await appendTaskMessageRaw(installationId, taskId, initialMessage, redis);
      } catch (error) {
        console.error("[tasks] Failed to append initial message (task created successfully)", {
          installationId,
          taskId,
          error,
        });
      }

      return {
        ok: true,
        task: {
          ...stored,
          progress: "Queued",
        },
      };
    });
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      console.warn("[tasks] Task create lock timeout", {
        installationId,
      });
      return { ok: false, reason: "concurrency_limited" };
    }
    throw error;
  }
}

async function finalizeTask(
  installationId: string,
  taskId: string,
  status: Extract<TaskStatus, "completed" | "failed" | "timed_out">,
  options: {
    error?: string;
    progress?: string;
    messages?: TaskMessage[];
  },
  redis: Redis,
  allowedFrom: Set<TaskStatus>,
): Promise<TaskTransitionResult> {
  return withTaskTransitionLock(
    installationId,
    taskId,
    redis,
    "[tasks] Task finalize lock timeout",
    async () => {
      const stored = await loadStoredTask(installationId, taskId, redis);
      if (!stored) return { ok: false, reason: "not_found" };

      if (!allowedFrom.has(stored.status)) {
        return { ok: false, reason: "invalid_transition" };
      }

      // Append timeline messages before the status change so they are
      // visible when consumers see the terminal status.
      if (options.messages && options.messages.length > 0) {
        for (const msg of options.messages) {
          await appendTaskMessageRaw(installationId, taskId, msg, redis);
        }
      }

      const timestamp = nowIso();
      const nextStored: StoredTaskRecord = {
        ...stored,
        status,
        updated_at: timestamp,
        finished_at: timestamp,
        error: options.error ? sanitizeText(options.error, MAX_PROGRESS_CHARS) : stored.error,
      };

      const ttl = terminalTtl(status);
      const progress = options.progress
        ? sanitizeText(options.progress, MAX_PROGRESS_CHARS)
        : status === "completed"
          ? "Completed"
          : status === "timed_out"
            ? "Timed out"
            : "Failed";

      await redis
        .multi()
        .set(taskKey(installationId, taskId), nextStored, { ex: ttl })
        .set(taskProgressKey(installationId, taskId), progress, { ex: ttl })
        .zrem(pendingKey(installationId), taskId)
        .zrem(runningKey(installationId), taskId)
        .del(taskClaimTokenHashKey(installationId, taskId))
        .zadd(recentKey(installationId), { score: Date.now(), member: taskId })
        .exec();

      // Best-effort: expire the messages list alongside the task data.
      // The task has already been finalized so a failure here must not propagate.
      try {
        await redis.expire(taskMessagesKey(installationId, taskId), ttl);
      } catch (error) {
        console.error("[tasks] Failed to expire messages key (task finalized)", {
          installationId,
          taskId,
          error,
        });
      }

      return {
        ok: true,
        task: {
          ...nextStored,
          progress,
        },
      };
    },
  );
}

async function markTaskRunningUnlocked(
  installationId: string,
  taskId: string,
  redis: Redis,
  claimTokenHash?: string,
): Promise<TaskTransitionResult> {
  const stored = await loadStoredTask(installationId, taskId, redis);
  if (!stored) return { ok: false, reason: "not_found" };

  if (stored.status !== "pending") {
    return { ok: false, reason: "invalid_transition" };
  }

  const runningCount = await redis.zcard(runningKey(installationId));
  if (runningCount >= MAX_CONCURRENT_TASKS) {
    return { ok: false, reason: "concurrency_limited" };
  }

  const timestamp = nowIso();
  const nextStored: StoredTaskRecord = {
    ...stored,
    status: "running",
    started_at: stored.started_at ?? timestamp,
    updated_at: timestamp,
  };

  const multi = redis
    .multi()
    .set(taskKey(installationId, taskId), nextStored)
    .set(taskProgressKey(installationId, taskId), "Running")
    .zrem(pendingKey(installationId), taskId)
    .zadd(runningKey(installationId), { score: Date.now(), member: taskId })
    .zadd(recentKey(installationId), { score: Date.now(), member: taskId });

  if (typeof claimTokenHash === "string") {
    multi.set(taskClaimTokenHashKey(installationId, taskId), claimTokenHash);
  } else {
    multi.del(taskClaimTokenHashKey(installationId, taskId));
  }

  await multi.exec();

  return {
    ok: true,
    task: {
      ...nextStored,
      progress: "Running",
    },
  };
}

export async function markTaskRunning(
  installationId: string,
  taskId: string,
  redis: Redis,
): Promise<TaskTransitionResult> {
  try {
    return await withTaskInstallationLock(
      installationId,
      redis,
      () => markTaskRunningUnlocked(installationId, taskId, redis),
    );
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      console.warn("[tasks] Task start lock timeout", {
        installationId,
        taskId,
      });
      return { ok: false, reason: "concurrency_limited" };
    }
    throw error;
  }
}

export async function setTaskProgress(
  installationId: string,
  taskId: string,
  progress: string,
  redis: Redis,
): Promise<TaskTransitionResult> {
  return withTaskTransitionLock(
    installationId,
    taskId,
    redis,
    "[tasks] Task progress lock timeout",
    async () => {
      const stored = await loadStoredTask(installationId, taskId, redis);
      if (!stored) return { ok: false, reason: "not_found" };

      if (isTerminal(stored.status)) {
        return { ok: false, reason: "invalid_transition" };
      }

      const nextStored: StoredTaskRecord = {
        ...stored,
        updated_at: nowIso(),
      };

      const normalized = sanitizeText(progress, MAX_PROGRESS_CHARS);

      await redis
        .multi()
        .set(taskKey(installationId, taskId), nextStored)
        .set(taskProgressKey(installationId, taskId), normalized)
        .zadd(recentKey(installationId), { score: Date.now(), member: taskId })
        .exec();

      return {
        ok: true,
        task: {
          ...nextStored,
          progress: normalized,
        },
      };
    },
  );
}

export async function heartbeatTask(
  installationId: string,
  taskId: string,
  redis: Redis,
): Promise<TaskTransitionResult> {
  return withTaskTransitionLock(
    installationId,
    taskId,
    redis,
    "[tasks] Task heartbeat lock timeout",
    async () => {
      const stored = await loadStoredTask(installationId, taskId, redis);
      if (!stored) return { ok: false, reason: "not_found" };

      if (stored.status !== "running") {
        return { ok: false, reason: "invalid_transition" };
      }

      const nextStored: StoredTaskRecord = {
        ...stored,
        updated_at: nowIso(),
      };

      await redis
        .multi()
        .set(taskKey(installationId, taskId), nextStored)
        .zadd(runningKey(installationId), { score: Date.now(), member: taskId })
        .zadd(recentKey(installationId), { score: Date.now(), member: taskId })
        .exec();

      return {
        ok: true,
        task: await buildTaskRecord(installationId, nextStored, redis),
      };
    },
  );
}

export async function completeTask(
  installationId: string,
  taskId: string,
  result: string,
  redis: Redis,
): Promise<TaskTransitionResult> {
  const timestamp = nowIso();
  const sanitizedResult = sanitizeText(result, MAX_MESSAGE_CONTENT_CHARS);

  return finalizeTask(
    installationId,
    taskId,
    "completed",
    {
      progress: "Completed",
      messages: [
        { role: "agent", content: sanitizedResult, created_at: timestamp },
        { role: "system", content: "Task completed.", created_at: timestamp },
      ],
    },
    redis,
    new Set(["pending", "running"]),
  );
}

export async function failTask(
  installationId: string,
  taskId: string,
  error: string,
  redis: Redis,
): Promise<TaskTransitionResult> {
  const timestamp = nowIso();

  return finalizeTask(
    installationId,
    taskId,
    "failed",
    {
      error,
      progress: error,
      messages: [
        { role: "system", content: `Task failed: ${sanitizeText(error, MAX_MESSAGE_CONTENT_CHARS)}`, created_at: timestamp },
      ],
    },
    redis,
    new Set(["pending", "running"]),
  );
}

export async function timeoutTask(
  installationId: string,
  taskId: string,
  redis: Redis,
): Promise<TaskTransitionResult> {
  const timestamp = nowIso();

  return finalizeTask(
    installationId,
    taskId,
    "timed_out",
    {
      error: "Timed out",
      progress: "Timed out",
      messages: [
        { role: "system", content: "Task timed out.", created_at: timestamp },
      ],
    },
    redis,
    new Set(["pending", "running"]),
  );
}

export async function getTask(
  installationId: string,
  taskId: string,
  redis: Redis,
): Promise<TaskRecord | null> {
  const stored = await loadStoredTask(installationId, taskId, redis);
  if (!stored) return null;

  const maybeTimedOut = await maybeTimeoutTask(installationId, stored, redis);
  return buildTaskRecord(installationId, maybeTimedOut, redis);
}

export async function listRecentTasks(
  installationId: string,
  limit: number,
  redis: Redis,
): Promise<TaskRecord[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 50));
  const members = await redis.zrange(recentKey(installationId), 0, boundedLimit - 1, { rev: true });
  const taskIds = members.filter((member): member is string => typeof member === "string");

  if (!taskIds || taskIds.length === 0) return [];

  const tasks = await Promise.all(taskIds.map((taskId) => getTask(installationId, taskId, redis)));

  const validTasks: TaskRecord[] = [];
  const missingTaskIds: string[] = [];

  for (let i = 0; i < taskIds.length; i += 1) {
    const task = tasks[i];
    if (task) {
      validTasks.push(task);
    } else {
      missingTaskIds.push(taskIds[i]);
    }
  }

  if (missingTaskIds.length > 0) {
    await redis.zrem(recentKey(installationId), ...missingTaskIds);
  }

  return validTasks;
}

export async function claimNextPendingTask(
  installationId: string,
  redis: Redis,
): Promise<ClaimedTask | null> {
  try {
    return await withTaskInstallationLock(installationId, redis, async () => {
      const candidates = await redis.zrange(pendingKey(installationId), 0, 9);
      const taskIds = candidates.filter((candidate): candidate is string => typeof candidate === "string");

      for (const taskId of taskIds) {
        const claimToken = generateTaskClaimToken();
        const claimTokenHash = hashTaskClaimToken(claimToken);
        const transitioned = await markTaskRunningUnlocked(
          installationId,
          taskId,
          redis,
          claimTokenHash,
        );
        if (transitioned.ok) {
          return {
            task: transitioned.task,
            claim_token: claimToken,
          };
        }

        if (transitioned.reason === "not_found" || transitioned.reason === "invalid_transition") {
          await redis.zrem(pendingKey(installationId), taskId);
          continue;
        }

        if (transitioned.reason === "concurrency_limited") {
          return null;
        }
      }

      return null;
    });
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      console.warn("[tasks] Task claim lock timeout", {
        installationId,
      });
      return null;
    }
    throw error;
  }
}

export async function verifyTaskClaimToken(
  installationId: string,
  taskId: string,
  claimToken: string,
  redis: Redis,
): Promise<boolean> {
  if (!claimToken) return false;

  const storedHash = await redis.get(taskClaimTokenHashKey(installationId, taskId));
  if (typeof storedHash !== "string" || storedHash.length === 0) {
    return false;
  }

  const providedHash = hashTaskClaimToken(claimToken);
  return constantTimeEqual(storedHash, providedHash);
}

// ---------------------------------------------------------------------------
// Delete & retry
// ---------------------------------------------------------------------------

const DELETABLE_STATUSES = new Set<TaskStatus>([
  "pending",
  "completed",
  "failed",
  "timed_out",
]);

const MESSAGE_ALLOWED_STATUSES = new Set<TaskStatus>([
  "pending",
  "completed",
  "failed",
  "timed_out",
]);

export async function deleteTask(
  installationId: string,
  taskId: string,
  redis: Redis,
): Promise<TaskDeleteResult> {
  return await withTaskInstallationLock(installationId, redis, async () => {
    const stored = await loadStoredTask(installationId, taskId, redis);
    if (!stored) return { ok: false, reason: "not_found" };

    if (!DELETABLE_STATUSES.has(stored.status)) {
      return { ok: false, reason: "invalid_transition" };
    }

    await redis
      .multi()
      .del(taskKey(installationId, taskId))
      .del(taskProgressKey(installationId, taskId))
      .del(taskMessagesKey(installationId, taskId))
      .zrem(pendingKey(installationId), taskId)
      .zrem(runningKey(installationId), taskId)
      .zrem(recentKey(installationId), taskId)
      .exec();

    return { ok: true };
  });
}

const RETRYABLE_STATUSES = new Set<TaskStatus>(["failed", "timed_out"]);

export async function retryTask(
  installationId: string,
  taskId: string,
  redis: Redis,
): Promise<TaskRetryResult> {
  try {
    return await withTaskInstallationLock(installationId, redis, async () => {
      const stored = await loadStoredTask(installationId, taskId, redis);
      if (!stored) return { ok: false, reason: "not_found" };

      if (!RETRYABLE_STATUSES.has(stored.status)) {
        return { ok: false, reason: "invalid_transition" };
      }

      const activeTaskCount = await countActiveTasks(installationId, redis);
      if (activeTaskCount >= MAX_CONCURRENT_TASKS) {
        return { ok: false, reason: "concurrency_limited" };
      }

      const timestamp = nowIso();
      const nextStored = requeueTaskToPending(stored, timestamp);
      const progress = "Re-queued via retry";

      await redis
        .multi()
        .persist(taskKey(installationId, taskId))
        .persist(taskProgressKey(installationId, taskId))
        .persist(taskMessagesKey(installationId, taskId))
        .set(taskKey(installationId, taskId), nextStored)
        .set(taskProgressKey(installationId, taskId), progress)
        .zrem(runningKey(installationId), taskId)
        .zadd(pendingKey(installationId), { score: Date.now(), member: taskId })
        .zadd(recentKey(installationId), { score: Date.now(), member: taskId })
        .del(taskClaimTokenHashKey(installationId, taskId))
        .exec();

      try {
        await appendTaskMessage(
          installationId,
          taskId,
          "system",
          "Task retried - re-queued.",
          redis,
        );
      } catch (error) {
        console.error("[tasks] Failed to append retry system message", {
          installationId,
          taskId,
          error,
        });
      }

      return {
        ok: true,
        task: {
          ...nextStored,
          progress,
        },
      };
    });
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      console.warn("[tasks] Task retry lock timeout", {
        installationId,
        taskId,
      });
      return { ok: false, reason: "concurrency_limited" };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Task messages
// ---------------------------------------------------------------------------

async function appendTaskMessageRaw(
  installationId: string,
  taskId: string,
  message: TaskMessage,
  redis: Redis,
): Promise<void> {
  const key = taskMessagesKey(installationId, taskId);
  await redis.rpush(key, JSON.stringify(message));
  await redis.ltrim(key, -MAX_MESSAGES_PER_TASK, -1);
}

export async function appendTaskMessage(
  installationId: string,
  taskId: string,
  role: TaskMessage["role"],
  content: string,
  redis: Redis,
): Promise<void> {
  const message: TaskMessage = {
    role,
    content: sanitizeText(content, MAX_MESSAGE_CONTENT_CHARS),
    created_at: nowIso(),
  };
  await appendTaskMessageRaw(installationId, taskId, message, redis);
}

export async function getTaskMessages(
  installationId: string,
  taskId: string,
  redis: Redis,
): Promise<TaskMessage[]> {
  const raw = await redis.lrange(taskMessagesKey(installationId, taskId), 0, -1);
  if (!raw || raw.length === 0) return [];

  const messages: TaskMessage[] = [];
  for (const entry of raw) {
    try {
      const str = typeof entry === "string" ? entry : JSON.stringify(entry);
      const parsed = JSON.parse(str) as Record<string, unknown>;
      if (
        typeof parsed.role === "string"
        && typeof parsed.content === "string"
        && typeof parsed.created_at === "string"
      ) {
        messages.push({
          role: parsed.role as TaskMessage["role"],
          content: parsed.content,
          created_at: parsed.created_at,
        });
      }
    } catch (error) {
      console.warn("[tasks] Dropped malformed task message entry", {
        installationId,
        taskId,
        error,
      });
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Follow-up transitions
// ---------------------------------------------------------------------------

export async function requestFollowUp(
  installationId: string,
  taskId: string,
  message: string,
  redis: Redis,
): Promise<TaskTransitionResult> {
  const transitioned = await withTaskTransitionLock(
    installationId,
    taskId,
    redis,
    "[tasks] Task follow-up lock timeout",
    async () => {
      const stored = await loadStoredTask(installationId, taskId, redis);
      if (!stored) return { ok: false, reason: "not_found" };

      if (stored.status !== "running") {
        return { ok: false, reason: "invalid_transition" };
      }

      const timestamp = nowIso();
      const nextStored: StoredTaskRecord = {
        ...stored,
        status: "needs_follow_up",
        updated_at: timestamp,
      };

      const progress = sanitizeText(message, MAX_PROGRESS_CHARS);

      await redis
        .multi()
        .set(taskKey(installationId, taskId), nextStored)
        .set(taskProgressKey(installationId, taskId), progress)
        .zrem(runningKey(installationId), taskId)
        .del(taskClaimTokenHashKey(installationId, taskId))
        .zadd(recentKey(installationId), { score: Date.now(), member: taskId })
        .exec();

      return {
        ok: true,
        task: {
          ...nextStored,
          progress,
        },
      };
    },
  );
  if (!transitioned.ok) return transitioned;

  // Best-effort: append timeline messages after the transition is committed.
  // A Redis failure here must not cause a 500 — the state change is durable.
  try {
    await appendTaskMessage(installationId, taskId, "agent", message, redis);
    await appendTaskMessage(
      installationId,
      taskId,
      "system",
      "Task paused — waiting for follow-up from user.",
      redis,
    );
  } catch (error) {
    console.error("[tasks] Failed to append follow-up messages (transition committed)", {
      installationId,
      taskId,
      error,
    });
  }

  return transitioned;
}

export async function resumeTaskWithFollowUp(
  installationId: string,
  taskId: string,
  followUpMessage: string,
  redis: Redis,
): Promise<TaskTransitionResult> {
  try {
    return await withTaskInstallationLock(installationId, redis, async () => {
      const stored = await loadStoredTask(installationId, taskId, redis);
      if (!stored) return { ok: false, reason: "not_found" };

      if (stored.status !== "needs_follow_up") {
        return { ok: false, reason: "invalid_transition" };
      }

      const activeTaskCount = await countActiveTasks(installationId, redis);
      if (activeTaskCount >= MAX_CONCURRENT_TASKS) {
        return { ok: false, reason: "concurrency_limited" };
      }

      const timestamp = nowIso();
      const nextStored = requeueTaskToPending(stored, timestamp);

      await redis
        .multi()
        .set(taskKey(installationId, taskId), nextStored)
        .set(taskProgressKey(installationId, taskId), "Re-queued after follow-up")
        .del(taskClaimTokenHashKey(installationId, taskId))
        .zadd(pendingKey(installationId), { score: Date.now(), member: taskId })
        .zadd(recentKey(installationId), { score: Date.now(), member: taskId })
        .exec();

      // Best-effort: record the user's follow-up in the timeline.
      // The transition is committed so a Redis failure must not propagate.
      try {
        await appendTaskMessage(
          installationId,
          taskId,
          "user",
          followUpMessage,
          redis,
        );
        await appendTaskMessage(
          installationId,
          taskId,
          "system",
          "Follow-up received — task re-queued.",
          redis,
        );
      } catch (error) {
        console.error("[tasks] Failed to append follow-up timeline messages (transition committed)", {
          installationId,
          taskId,
          error,
        });
      }

      return {
        ok: true,
        task: {
          ...nextStored,
          progress: "Re-queued after follow-up",
        },
      };
    });
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      console.warn("[tasks] Task follow-up lock timeout", {
        installationId,
        taskId,
      });
      return { ok: false, reason: "concurrency_limited" };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// User messages (chat-like interface)
// ---------------------------------------------------------------------------

export async function addUserMessage(
  installationId: string,
  taskId: string,
  message: string,
  redis: Redis,
): Promise<AddUserMessageResult> {
  try {
    return await withTaskInstallationLock(installationId, redis, async () => {
      const stored = await loadStoredTask(installationId, taskId, redis);
      if (!stored) return { ok: false, reason: "not_found" };

      if (!MESSAGE_ALLOWED_STATUSES.has(stored.status)) {
        return { ok: false, reason: "invalid_transition" };
      }

      const timestamp = nowIso();
      const sanitizedMessage = sanitizeText(message, MAX_MESSAGE_CONTENT_CHARS);

      // --- Pending: just append the message, no state change ---
      if (stored.status === "pending") {
        const nextStored: StoredTaskRecord = {
          ...stored,
          updated_at: timestamp,
        };

        await appendTaskMessage(installationId, taskId, "user", sanitizedMessage, redis);

        await redis
          .multi()
          .set(taskKey(installationId, taskId), nextStored)
          .zadd(recentKey(installationId), { score: Date.now(), member: taskId })
          .exec();

        return {
          ok: true,
          task: await buildTaskRecord(installationId, nextStored, redis),
        };
      }

      // --- Terminal (completed/failed/timed_out): revive to pending ---
      const activeTaskCount = await countActiveTasks(installationId, redis);
      if (activeTaskCount >= MAX_CONCURRENT_TASKS) {
        return { ok: false, reason: "concurrency_limited" };
      }

      const nextStored: StoredTaskRecord = {
        ...requeueTaskToPending(stored, timestamp),
      };

      await appendTaskMessage(installationId, taskId, "user", sanitizedMessage, redis);

      // Clear terminal TTLs in the same transaction as the state transition so
      // success guarantees the revived task will not expire mid-run.
      await redis
        .multi()
        .persist(taskKey(installationId, taskId))
        .persist(taskProgressKey(installationId, taskId))
        .persist(taskMessagesKey(installationId, taskId))
        .set(taskKey(installationId, taskId), nextStored)
        .set(taskProgressKey(installationId, taskId), "Re-queued with new message")
        .zadd(pendingKey(installationId), { score: Date.now(), member: taskId })
        .zadd(recentKey(installationId), { score: Date.now(), member: taskId })
        .del(taskClaimTokenHashKey(installationId, taskId))
        .exec();

      try {
        await appendTaskMessage(
          installationId,
          taskId,
          "system",
          "New message received \u2014 task re-queued.",
          redis,
        );
      } catch (error) {
        console.error("[tasks] Failed to append revival system message", {
          installationId,
          taskId,
          error,
        });
      }

      return {
        ok: true,
        task: {
          ...nextStored,
          progress: "Re-queued with new message",
        },
      };
    });
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      console.warn("[tasks] Add user message lock timeout", {
        installationId,
        taskId,
      });
      return { ok: false, reason: "concurrency_limited" };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Task artifacts (#332)
// ---------------------------------------------------------------------------

const ARTIFACT_ALLOWED_KEYS = new Set(["type", "url", "number", "title"]);

export type ValidateTaskArtifactsResult =
  | { ok: true; artifacts: NormalizedTaskArtifact[] }
  | { ok: false; message: string };

function sanitizeArtifactTitle(value: string): string {
  // Replace control characters (the value is rendered in the dashboard)
  // with spaces, collapse whitespace runs, then cap length. The \u escapes
  // keep the source pure-ASCII (no literal control bytes in the regex).
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, MAX_ARTIFACT_TITLE_CHARS);
}

function parsePositiveInt(segment: string): number | null {
  if (!/^\d{1,9}$/.test(segment)) return null;
  const n = Number.parseInt(segment, 10);
  return n > 0 ? n : null;
}

type ParsedArtifactUrl =
  | { ok: true; owner: string; repo: string; number?: number }
  | { ok: false; message: string };

// Strict, network-free validation: the URL must be an https github.com link
// whose path shape matches the declared artifact type. This is the primary
// defense against an agent attaching unrelated/external/`javascript:` URLs.
function parseGitHubArtifactUrl(
  rawUrl: string,
  type: TaskArtifactType,
): ParsedArtifactUrl {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, message: "url must be a valid absolute URL" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, message: "url must use https" };
  }
  // Exact host match — blocks gist.github.com, look-alikes, and
  // `github.com.attacker.example` style suffixes.
  if (parsed.hostname.toLowerCase() !== "github.com") {
    return { ok: false, message: "url must be on github.com" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: "url must not embed credentials" };
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 4) {
    return { ok: false, message: "url must point to a specific GitHub resource" };
  }

  const [owner, repo, kind, id] = segments;
  if (!GITHUB_OWNER_REGEX.test(owner)) {
    return { ok: false, message: "url has an invalid repository owner" };
  }
  if (!GITHUB_REPO_REGEX.test(repo) || repo === "." || repo === "..") {
    return { ok: false, message: "url has an invalid repository name" };
  }

  switch (type) {
    case "pull_request": {
      if (kind !== "pull") {
        return { ok: false, message: "pull_request url must look like /{owner}/{repo}/pull/{number}" };
      }
      const number = parsePositiveInt(id);
      if (number === null) {
        return { ok: false, message: "pull_request url must end in a positive PR number" };
      }
      return { ok: true, owner, repo, number };
    }
    case "issue": {
      if (kind !== "issues") {
        return { ok: false, message: "issue url must look like /{owner}/{repo}/issues/{number}" };
      }
      const number = parsePositiveInt(id);
      if (number === null) {
        return { ok: false, message: "issue url must end in a positive issue number" };
      }
      return { ok: true, owner, repo, number };
    }
    case "issue_comment": {
      // Comments live under issues/ or pull/; the comment id is in the
      // fragment (e.g. #issuecomment-123), so require a non-empty hash.
      if (kind !== "issues" && kind !== "pull") {
        return { ok: false, message: "issue_comment url must reference an issue or pull request" };
      }
      const number = parsePositiveInt(id);
      if (number === null) {
        return { ok: false, message: "issue_comment url must include the issue or PR number" };
      }
      if (parsed.hash.length <= 1) {
        return { ok: false, message: "issue_comment url must include a comment anchor (e.g. #issuecomment-123)" };
      }
      return { ok: true, owner, repo, number };
    }
    case "commit": {
      if (kind !== "commit") {
        return { ok: false, message: "commit url must look like /{owner}/{repo}/commit/{sha}" };
      }
      if (!GITHUB_COMMIT_SHA_REGEX.test(id)) {
        return { ok: false, message: "commit url must end in a valid commit sha" };
      }
      return { ok: true, owner, repo };
    }
  }
}

function validateSingleArtifact(
  entry: unknown,
  allowedRepos: Set<string> | null,
): { ok: true; artifact: NormalizedTaskArtifact } | { ok: false; message: string } {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, message: "must be an object" };
  }
  const o = entry as Record<string, unknown>;

  for (const key of Object.keys(o)) {
    if (!ARTIFACT_ALLOWED_KEYS.has(key)) {
      return { ok: false, message: `unknown field: ${key}` };
    }
  }

  if (typeof o.type !== "string" || !TASK_ARTIFACT_TYPES.has(o.type as TaskArtifactType)) {
    return {
      ok: false,
      message: "type must be one of: pull_request, issue, issue_comment, commit",
    };
  }
  const type = o.type as TaskArtifactType;

  if (typeof o.url !== "string" || o.url.trim().length === 0) {
    return { ok: false, message: "url is required" };
  }

  const parsedUrl = parseGitHubArtifactUrl(o.url.trim(), type);
  if (!parsedUrl.ok) {
    return { ok: false, message: parsedUrl.message };
  }

  // Additive repo scoping: when the agent token declares allowed_repos,
  // the artifact must point at one of them. Tokens without a repo policy
  // fall back to the installation boundary already enforced by the caller.
  if (allowedRepos) {
    const slug = `${parsedUrl.owner}/${parsedUrl.repo}`.toLowerCase();
    if (!allowedRepos.has(slug)) {
      return {
        ok: false,
        message: `url repository ${parsedUrl.owner}/${parsedUrl.repo} is outside this token's allowed repositories`,
      };
    }
  }

  const artifact: NormalizedTaskArtifact = {
    type,
    url: o.url.trim(),
  };

  // Number: derive from the URL as the source of truth. If the caller also
  // supplied one, it must agree (catches copy-paste/format drift); commits
  // carry no number so any supplied value is rejected.
  if (parsedUrl.number !== undefined) {
    if (o.number !== undefined) {
      if (typeof o.number !== "number" || !Number.isInteger(o.number)) {
        return { ok: false, message: "number must be an integer" };
      }
      if (o.number !== parsedUrl.number) {
        return {
          ok: false,
          message: `number ${o.number} does not match the number in the url (${parsedUrl.number})`,
        };
      }
    }
    artifact.number = parsedUrl.number;
  } else if (o.number !== undefined) {
    return { ok: false, message: "commit artifacts must not include a number" };
  }

  if (o.title !== undefined) {
    if (typeof o.title !== "string") {
      return { ok: false, message: "title must be a string" };
    }
    const title = sanitizeArtifactTitle(o.title);
    if (title.length > 0) artifact.title = title;
  }

  return { ok: true, artifact };
}

/**
 * Validate + normalize a batch of artifact inputs from an agent.
 *
 * Pure (no Redis) so it is exhaustively unit-testable. `allowedRepos` is the
 * agent token's `policy.allowed_repos` (optional); when present and non-empty
 * it bounds artifacts to those repositories.
 */
export function validateTaskArtifacts(
  input: unknown,
  options: { allowedRepos?: readonly string[] } = {},
): ValidateTaskArtifactsResult {
  if (!Array.isArray(input)) {
    return { ok: false, message: "artifacts must be an array" };
  }
  if (input.length === 0) {
    return { ok: false, message: "artifacts must contain at least one entry" };
  }
  if (input.length > MAX_ARTIFACTS_PER_TASK) {
    return {
      ok: false,
      message: `artifacts must not exceed ${MAX_ARTIFACTS_PER_TASK} entries per request`,
    };
  }

  const allowedRepos = normalizeAllowedRepos(options.allowedRepos);
  const artifacts: NormalizedTaskArtifact[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const result = validateSingleArtifact(input[i], allowedRepos);
    if (!result.ok) {
      return { ok: false, message: `artifacts[${i}]: ${result.message}` };
    }
    artifacts.push(result.artifact);
  }

  return { ok: true, artifacts };
}

function normalizeAllowedRepos(
  allowedRepos: readonly string[] | undefined,
): Set<string> | null {
  if (!allowedRepos || allowedRepos.length === 0) return null;
  const set = new Set<string>();
  for (const repo of allowedRepos) {
    if (typeof repo === "string" && repo.includes("/")) {
      set.add(repo.toLowerCase());
    }
  }
  return set.size > 0 ? set : null;
}

export type AddTaskArtifactsResult =
  | { ok: true; task: TaskRecord; added: number }
  | {
      ok: false;
      reason: "not_found" | "invalid_transition" | "limit_exceeded" | "lock_timeout";
    };

/**
 * Append artifacts to a running task (append-only, deduped by URL).
 *
 * Only valid while the task is `running` — that is the exact window the
 * per-task claim token is live (it is deleted on finalize/follow-up), so the
 * caller's claim-token check already gates this to the agent currently
 * working the task. Re-reporting the same URL is a no-op (idempotent retries),
 * and the write doubles as a liveness signal like a heartbeat.
 */
export async function addTaskArtifacts(
  installationId: string,
  taskId: string,
  artifacts: NormalizedTaskArtifact[],
  redis: Redis,
): Promise<AddTaskArtifactsResult> {
  try {
    return await withTaskInstallationLock(installationId, redis, async () => {
      const stored = await loadStoredTask(installationId, taskId, redis);
      if (!stored) return { ok: false, reason: "not_found" };

      if (stored.status !== "running") {
        return { ok: false, reason: "invalid_transition" };
      }

      const existing = stored.artifacts ?? [];
      const seen = new Set(existing.map((a) => a.url.toLowerCase()));
      const timestamp = nowIso();

      const additions: TaskArtifact[] = [];
      for (const candidate of artifacts) {
        const key = candidate.url.toLowerCase();
        if (seen.has(key)) continue; // dedup vs existing + within-batch
        seen.add(key);
        additions.push({ ...candidate, created_at: timestamp });
      }

      const merged = [...existing, ...additions];
      if (merged.length > MAX_ARTIFACTS_PER_TASK) {
        return { ok: false, reason: "limit_exceeded" };
      }

      const nextStored: StoredTaskRecord = {
        ...stored,
        artifacts: merged,
        updated_at: timestamp,
      };

      await redis
        .multi()
        .set(taskKey(installationId, taskId), nextStored)
        .zadd(runningKey(installationId), { score: Date.now(), member: taskId })
        .zadd(recentKey(installationId), { score: Date.now(), member: taskId })
        .exec();

      return {
        ok: true,
        task: await buildTaskRecord(installationId, nextStored, redis),
        added: additions.length,
      };
    });
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      console.warn("[tasks] Task artifacts lock timeout", {
        installationId,
        taskId,
      });
      return { ok: false, reason: "lock_timeout" };
    }
    throw error;
  }
}
