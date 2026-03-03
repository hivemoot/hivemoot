import { randomBytes } from "node:crypto";
import { type Redis } from "@upstash/redis";

export const MAX_CONCURRENT_TASKS = 3;
export const DEFAULT_TASK_TIMEOUT_SECONDS = 5 * 60;
export const MAX_TASK_TIMEOUT_SECONDS = 10 * 60;
export const COMPLETED_TASK_TTL_SECONDS = 7 * 24 * 60 * 60;
export const FAILED_TASK_TTL_SECONDS = 24 * 60 * 60;
export const TASK_CREATE_RATE_LIMIT_PER_MINUTE = 10;
const MAX_REPOS_PER_TASK = 10;
const MAX_PROMPT_CHARS = 8000;
const MAX_ENGINE_CHARS = 64;
const MAX_PROGRESS_CHARS = 400;
const MAX_RESULT_CHARS = 128_000;
const TASK_LOCK_PREFIX = "hive:task-lock:";
const TASK_LOCK_TTL_SECONDS = 5;
const TASK_LOCK_MAX_WAIT_MS = 1000;
const TASK_LOCK_RETRY_MIN_MS = 8;
const TASK_LOCK_RETRY_MAX_MS = 20;
const RELEASE_TASK_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

const VALID_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VALID_ENGINE_PATTERN = /^[A-Za-z0-9._:-]+$/;
export const TASK_ID_PATTERN = /^[a-f0-9]{24}$/;

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "timed_out";

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "timed_out"]);

export interface TaskRecord {
  task_id: string;
  status: TaskStatus;
  engine: string;
  prompt: string;
  repos: string[];
  timeout_secs: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  progress?: string;
  result?: string;
}

interface StoredTaskRecord {
  task_id: string;
  status: TaskStatus;
  engine: string;
  prompt: string;
  repos: string[];
  timeout_secs: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
}

export interface CreateTaskRequest {
  engine: string;
  prompt: string;
  repos: string[];
  timeout_secs: number;
}

export type CreateTaskValidationResult =
  | { ok: true; request: CreateTaskRequest }
  | { ok: false; message: string };

export type CreateTaskResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; reason: "concurrency_limited" };

export type TaskTransitionResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; reason: "not_found" | "invalid_transition" | "concurrency_limited" };

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

class TaskLockTimeoutError extends Error {
  constructor(installationId: string) {
    super(`Timed out acquiring task lock for installation ${installationId}`);
    this.name = "TaskLockTimeoutError";
  }
}

function taskKey(installationId: string, taskId: string): string {
  return `task:${installationId}:${taskId}`;
}

function taskResultKey(installationId: string, taskId: string): string {
  return `task:${installationId}:${taskId}:result`;
}

function taskProgressKey(installationId: string, taskId: string): string {
  return `task:${installationId}:${taskId}:progress`;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomTaskLockRetryDelayMs(): number {
  return TASK_LOCK_RETRY_MIN_MS
    + Math.floor(Math.random() * (TASK_LOCK_RETRY_MAX_MS - TASK_LOCK_RETRY_MIN_MS + 1));
}

async function releaseTaskLock(
  lockKey: string,
  lockOwnerToken: string,
  redis: Redis,
): Promise<void> {
  await redis.eval(RELEASE_TASK_LOCK_SCRIPT, [lockKey], [lockOwnerToken]);
}

async function withTaskInstallationLock<T>(
  installationId: string,
  redis: Redis,
  fn: () => Promise<T>,
): Promise<T> {
  const lockKey = taskLockKey(installationId);
  const lockOwnerToken = randomBytes(16).toString("hex");
  const deadline = Date.now() + TASK_LOCK_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    const acquired = await redis.set(lockKey, lockOwnerToken, {
      nx: true,
      ex: TASK_LOCK_TTL_SECONDS,
    });

    if (acquired === "OK") {
      try {
        return await fn();
      } finally {
        try {
          await releaseTaskLock(lockKey, lockOwnerToken, redis);
        } catch (error) {
          // Lock cleanup is best-effort so operation results are preserved.
          console.error("[tasks] Failed to release task lock", {
            installationId,
            error,
          });
        }
      }
    }

    await sleep(randomTaskLockRetryDelayMs());
  }

  throw new TaskLockTimeoutError(installationId);
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

function parseStoredTask(raw: unknown): StoredTaskRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.task_id !== "string"
    || !TASK_ID_PATTERN.test(obj.task_id)
    || typeof obj.status !== "string"
    || !["pending", "running", "completed", "failed", "timed_out"].includes(obj.status)
    || typeof obj.engine !== "string"
    || typeof obj.prompt !== "string"
    || !Array.isArray(obj.repos)
    || obj.repos.some((repo) => typeof repo !== "string")
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
    engine: obj.engine,
    prompt: obj.prompt,
    repos: obj.repos,
    timeout_secs: obj.timeout_secs,
    created_by: obj.created_by,
    created_at: obj.created_at,
    updated_at: obj.updated_at,
  };

  if (typeof obj.started_at === "string") parsed.started_at = obj.started_at;
  if (typeof obj.finished_at === "string") parsed.finished_at = obj.finished_at;
  if (typeof obj.error === "string") parsed.error = obj.error;

  return parsed;
}

function generateTaskId(): string {
  return randomBytes(12).toString("hex");
}

function transitionDeadlineMs(task: StoredTaskRecord): number {
  const baseTs = task.status === "running" && task.started_at
    ? new Date(task.started_at).getTime()
    : new Date(task.created_at).getTime();

  if (!Number.isFinite(baseTs)) {
    return Date.now() + task.timeout_secs * 1000;
  }

  return baseTs + task.timeout_secs * 1000;
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
    .del(taskResultKey(installationId, taskId))
    .del(taskProgressKey(installationId, taskId))
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
  const [resultRaw, progressRaw] = await Promise.all([
    redis.get(taskResultKey(installationId, stored.task_id)),
    redis.get(taskProgressKey(installationId, stored.task_id)),
  ]);

  const task: TaskRecord = {
    ...stored,
  };

  if (typeof resultRaw === "string") task.result = resultRaw;
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
  if (isTerminal(stored.status)) return stored;

  const deadlineMs = transitionDeadlineMs(stored);
  if (Date.now() <= deadlineMs) return stored;

  const timeoutMessage = `Timed out after ${stored.timeout_secs} seconds`;
  const timedOut = await finalizeTask(
    installationId,
    stored.task_id,
    "timed_out",
    {
      error: timeoutMessage,
      progress: timeoutMessage,
    },
    redis,
    new Set(["pending", "running"]),
  );

  if (!timedOut.ok) return stored;
  return {
    task_id: timedOut.task.task_id,
    status: timedOut.task.status,
    engine: timedOut.task.engine,
    prompt: timedOut.task.prompt,
    repos: timedOut.task.repos,
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
  const allowedFields = new Set(["prompt", "repos", "engine", "timeout_secs"]);
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

  if (!Array.isArray(obj.repos)) {
    return { ok: false, message: "repos must be an array" };
  }

  if (obj.repos.length < 1 || obj.repos.length > MAX_REPOS_PER_TASK) {
    return {
      ok: false,
      message: `repos must contain between 1 and ${MAX_REPOS_PER_TASK} entries`,
    };
  }

  const dedupedRepos = new Set<string>();
  for (const repoRaw of obj.repos) {
    if (typeof repoRaw !== "string") {
      return { ok: false, message: "each repo must be a string" };
    }

    const repo = repoRaw.trim();
    if (!VALID_REPO_PATTERN.test(repo)) {
      return { ok: false, message: `invalid repo format: ${repoRaw}` };
    }

    dedupedRepos.add(repo);
  }

  const repos = [...dedupedRepos];

  let engine = "codex";
  if (obj.engine !== undefined) {
    if (
      typeof obj.engine !== "string"
      || obj.engine.trim().length < 1
      || obj.engine.length > MAX_ENGINE_CHARS
      || !VALID_ENGINE_PATTERN.test(obj.engine)
    ) {
      return {
        ok: false,
        message: `engine must be 1-${MAX_ENGINE_CHARS} chars and match [A-Za-z0-9._:-]+`,
      };
    }
    engine = obj.engine.trim();
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
      engine,
      prompt,
      repos,
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
        engine: request.engine,
        prompt: request.prompt,
        repos: request.repos,
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

      return {
        ok: true,
        task: {
          ...stored,
          progress: "Queued",
        },
      };
    });
  } catch (error) {
    if (error instanceof TaskLockTimeoutError) {
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
    result?: string;
    progress?: string;
  },
  redis: Redis,
  allowedFrom: Set<TaskStatus>,
): Promise<TaskTransitionResult> {
  const stored = await loadStoredTask(installationId, taskId, redis);
  if (!stored) return { ok: false, reason: "not_found" };

  if (!allowedFrom.has(stored.status)) {
    return { ok: false, reason: "invalid_transition" };
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

  const multi = redis
    .multi()
    .set(taskKey(installationId, taskId), nextStored, { ex: ttl })
    .set(taskProgressKey(installationId, taskId), progress, { ex: ttl })
    .zrem(pendingKey(installationId), taskId)
    .zrem(runningKey(installationId), taskId)
    .zadd(recentKey(installationId), { score: Date.now(), member: taskId });

  if (typeof options.result === "string") {
    multi.set(
      taskResultKey(installationId, taskId),
      sanitizeText(options.result, MAX_RESULT_CHARS),
      { ex: ttl },
    );
  }

  await multi.exec();

  return {
    ok: true,
    task: {
      ...nextStored,
      progress,
      result: typeof options.result === "string"
        ? sanitizeText(options.result, MAX_RESULT_CHARS)
        : undefined,
    },
  };
}

async function markTaskRunningUnlocked(
  installationId: string,
  taskId: string,
  redis: Redis,
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

  await redis
    .multi()
    .set(taskKey(installationId, taskId), nextStored)
    .set(taskProgressKey(installationId, taskId), "Running")
    .zrem(pendingKey(installationId), taskId)
    .zadd(runningKey(installationId), { score: Date.now(), member: taskId })
    .zadd(recentKey(installationId), { score: Date.now(), member: taskId })
    .exec();

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
    if (error instanceof TaskLockTimeoutError) {
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
}

export async function completeTask(
  installationId: string,
  taskId: string,
  result: string,
  redis: Redis,
): Promise<TaskTransitionResult> {
  return finalizeTask(
    installationId,
    taskId,
    "completed",
    {
      result,
      progress: "Completed",
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
  return finalizeTask(
    installationId,
    taskId,
    "failed",
    {
      error,
      progress: error,
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
  return finalizeTask(
    installationId,
    taskId,
    "timed_out",
    {
      error: "Timed out",
      progress: "Timed out",
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
): Promise<TaskRecord | null> {
  try {
    return await withTaskInstallationLock(installationId, redis, async () => {
      const candidates = await redis.zrange(pendingKey(installationId), 0, 9);
      const taskIds = candidates.filter((candidate): candidate is string => typeof candidate === "string");

      for (const taskId of taskIds) {
        const transitioned = await markTaskRunningUnlocked(installationId, taskId, redis);
        if (transitioned.ok) return transitioned.task;

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
    if (error instanceof TaskLockTimeoutError) {
      console.warn("[tasks] Task claim lock timeout", {
        installationId,
      });
      return null;
    }
    throw error;
  }
}
