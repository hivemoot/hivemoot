import { access, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { CliError } from "../config/types.js";

const MAX_PROCESSED_IDS = 200;

export interface NotificationsPollState {
  /** Last-Modified header value from the most recent successful fetch, used as If-Modified-Since. */
  lastModified?: string;
  /** X-Poll-Interval from the most recent response (seconds). Overrides the configured interval when larger. */
  pollInterval?: number;
}

export interface WatchState {
  lastChecked: string;           // ISO 8601 timestamp
  processedThreadIds: string[];  // rolling window of thread IDs already handled
  /**
   * Latest emitted review-request identity per notification thread, stored as
   * `${threadId}:${requestId}`. The request ID comes from GitHub's GraphQL
   * ReviewRequest object, so watch can suppress plain PR activity while still
   * re-emitting later real re-requests on the same thread.
   */
  reviewRequestIds?: string[];
  /** Per-repo conditional request state, keyed by "owner/repo". */
  notificationsPollState?: Record<string, NotificationsPollState>;
}

export interface LoadStateResult {
  state: WatchState;
  degraded: boolean;
  reason?: string;
}

async function assertNoSymlinkTraversal(filePath: string): Promise<void> {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  const root = parse(absolutePath).root;
  const segments = absolutePath.slice(root.length).split(sep).filter(Boolean);

  let currentPath = root;
  for (const segment of segments) {
    currentPath = join(currentPath, segment);
    try {
      const stats = await lstat(currentPath);
      if (stats.isSymbolicLink()) {
        throw new CliError(`State file path may not traverse symbolic links: ${currentPath}`, "GH_ERROR");
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") continue;
      throw err;
    }
  }
}

async function resolveStateFilePath(filePath: string): Promise<string> {
  const resolvedPath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  await assertNoSymlinkTraversal(resolvedPath);
  return resolvedPath;
}

async function ensureWritableParentDirectory(filePath: string): Promise<void> {
  const parentDir = dirname(filePath);
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  await assertNoSymlinkTraversal(parentDir);

  const parentStats = await lstat(parentDir);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new CliError(`State file parent path is not a directory: ${parentDir}`, "GH_ERROR");
  }

  try {
    await access(parentDir, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : "";
    throw new CliError(`State file parent directory is not readable/writable: ${parentDir}${detail}`, "GH_ERROR");
  }
}

/** Load state from disk, or return a default initial state (since = 1 hour ago). */
export async function loadState(filePath: string): Promise<WatchState> {
  const result = await loadStateWithStatus(filePath);
  return result.state;
}

/** Load state with degradation signal for callers that need explicit warnings. */
export async function loadStateWithStatus(filePath: string): Promise<LoadStateResult> {
  const resolvedPath = await resolveStateFilePath(filePath);

  if (!existsSync(resolvedPath)) {
    return { state: defaultState(), degraded: false };
  }

  try {
    const raw = await readFile(resolvedPath, "utf-8");
    let parsed: Partial<WatchState>;

    try {
      parsed = JSON.parse(raw) as Partial<WatchState>;
    } catch {
      return {
        state: defaultState(),
        degraded: true,
        reason: "invalid JSON",
      };
    }

    if (typeof parsed.lastChecked !== "string" || !parsed.lastChecked) {
      return {
        state: defaultState(),
        degraded: true,
        reason: "missing required fields",
      };
    }

    if (!Array.isArray(parsed.processedThreadIds)) {
      return {
        state: defaultState(),
        degraded: true,
        reason: "missing required fields",
      };
    }

    const processedThreadIds = parsed.processedThreadIds.filter((id): id is string => typeof id === "string");
    const reviewRequestIds = Array.isArray(parsed.reviewRequestIds)
      ? parsed.reviewRequestIds.filter((id): id is string => typeof id === "string")
      : undefined;

    // notificationsPollState is optional and backward-compatible — load it when present and valid
    const notificationsPollState = parseNotificationsPollState(parsed.notificationsPollState);
    return {
      state: {
        lastChecked: parsed.lastChecked,
        processedThreadIds,
        ...(reviewRequestIds && reviewRequestIds.length > 0
          ? { reviewRequestIds }
          : {}),
        ...(notificationsPollState !== undefined ? { notificationsPollState } : {}),
      },
      degraded: false,
    };
  } catch {
    return {
      state: defaultState(),
      degraded: true,
      reason: "read error",
    };
  }
}

/**
 * Parse the notificationsPollState field from persisted JSON.
 * Returns undefined if the value is absent or not a plain object.
 * Invalid per-repo entries are silently skipped; the field is optional.
 */
function parseNotificationsPollState(
  raw: unknown,
): Record<string, NotificationsPollState> | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const result: Record<string, NotificationsPollState> = Object.create(null);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== "string" || typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    const pollState: NotificationsPollState = Object.create(null);
    if (typeof entry.lastModified === "string" && entry.lastModified) {
      pollState.lastModified = entry.lastModified;
    }
    if (typeof entry.pollInterval === "number" && entry.pollInterval > 0 && Number.isFinite(entry.pollInterval)) {
      pollState.pollInterval = entry.pollInterval;
    }
    result[key] = pollState;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Atomically save state to disk (write to temp, then rename). */
export async function saveState(filePath: string, state: WatchState): Promise<void> {
  const resolvedPath = await resolveStateFilePath(filePath);
  await ensureWritableParentDirectory(resolvedPath);

  const dir = dirname(resolvedPath);
  const tmpPath = join(dir, `.${Date.now()}.tmp`);

  const trimmed: WatchState = {
    lastChecked: state.lastChecked,
    processedThreadIds: state.processedThreadIds.slice(-MAX_PROCESSED_IDS),
    ...(state.reviewRequestIds && state.reviewRequestIds.length > 0
      ? { reviewRequestIds: state.reviewRequestIds.slice(-MAX_PROCESSED_IDS) }
      : {}),
    ...(state.notificationsPollState ? { notificationsPollState: state.notificationsPollState } : {}),
  };

  try {
    await writeFile(tmpPath, JSON.stringify(trimmed, null, 2) + "\n", "utf-8");
    await rename(tmpPath, resolvedPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // Best effort cleanup of partial temp files.
    }
    throw err;
  }
}

/** Mark a thread ID as processed, maintaining the rolling window. */
export function addProcessedId(state: WatchState, threadId: string): WatchState {
  const ids = state.processedThreadIds.includes(threadId)
    ? state.processedThreadIds
    : [...state.processedThreadIds, threadId].slice(-MAX_PROCESSED_IDS);

  return { ...state, processedThreadIds: ids };
}

/** Record the latest emitted review-request identity for a thread. */
export function addReviewRequestId(
  state: WatchState,
  threadId: string,
  requestId: string,
): WatchState {
  const key = `${threadId}:${requestId}`;
  const existing = state.reviewRequestIds ?? [];
  if (existing.includes(key)) return state;

  const next = [
    ...existing.filter((entry) => !entry.startsWith(`${threadId}:`)),
    key,
  ].slice(-MAX_PROCESSED_IDS);

  return {
    ...state,
    reviewRequestIds: next,
  };
}

function defaultState(): WatchState {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  return {
    lastChecked: oneHourAgo.toISOString(),
    processedThreadIds: [],
  };
}

function parseIsoMillis(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Build a map of threadId → latest updatedAt from processedThreadIds.
 * Keys in processedThreadIds have the composite format `threadId:updatedAt`.
 * Used to skip already-processed notifications in both watch and notifications pull.
 */
export function buildLatestProcessedByThread(processedKeys: string[]): Map<string, string> {
  const byThread = new Map<string, string>();

  for (const key of processedKeys) {
    const separatorIndex = key.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === key.length - 1) continue;

    const threadId = key.slice(0, separatorIndex);
    const updatedAt = key.slice(separatorIndex + 1);
    if (parseIsoMillis(updatedAt) === null) continue;

    const existing = byThread.get(threadId);
    if (!existing || updatedAt > existing) {
      byThread.set(threadId, updatedAt);
    }
  }

  return byThread;
}

/**
 * Build a map of threadId → latest emitted review-request ID.
 * Keys in reviewRequestIds have the composite format `threadId:requestId`.
 */
export function buildLatestReviewRequestByThread(reviewRequestIds: string[]): Map<string, string> {
  const byThread = new Map<string, string>();

  for (const key of reviewRequestIds) {
    const separatorIndex = key.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === key.length - 1) continue;

    const threadId = key.slice(0, separatorIndex);
    const requestId = key.slice(separatorIndex + 1);
    byThread.set(threadId, requestId);
  }

  return byThread;
}

/**
 * Atomically consume the ack journal file and merge its keys into state.
 *
 * Pattern: rename journal → read → merge → delete temp file.
 * Rename is atomic on POSIX, so concurrent appends by `appendAck` won't
 * lose data — they'll create a new journal file after the rename.
 */
export async function mergeAckJournal(stateFilePath: string, state: WatchState): Promise<WatchState> {
  const resolvedPath = await resolveStateFilePath(stateFilePath);
  const journalPath = `${resolvedPath}.acks`;
  const processingPath = `${resolvedPath}.acks.processing`;

  try {
    await rename(journalPath, processingPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      // No journal file — nothing to merge
      return state;
    }
    throw err;
  }

  try {
    const raw = await readFile(processingPath, "utf-8");
    const keys = raw.split("\n").filter((line) => line.length > 0);

    let merged = state;
    for (const key of keys) {
      merged = addProcessedId(merged, key);
    }

    return merged;
  } finally {
    // Always clean up the processing file.
    try {
      await unlink(processingPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") throw err;
    }
  }
}

/**
 * Append a key to the ack journal file.
 * Uses O_APPEND for safe concurrent writes from multiple ack invocations.
 */
export async function appendAck(stateFilePath: string, key: string): Promise<void> {
  const resolvedPath = await resolveStateFilePath(stateFilePath);
  await ensureWritableParentDirectory(resolvedPath);

  const journalPath = `${resolvedPath}.acks`;
  const fh = await open(journalPath, "a");
  try {
    await fh.write(`${key}\n`);
  } finally {
    await fh.close();
  }
}
