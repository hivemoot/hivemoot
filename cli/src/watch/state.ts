import { readFile, writeFile, rename, unlink, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_PROCESSED_IDS = 200;

export interface WatchState {
  lastChecked: string;           // ISO 8601 timestamp
  processedThreadIds: string[];  // rolling window of thread IDs already handled
}

/** Load state from disk, or return a default initial state (since = 1 hour ago). */
export async function loadState(filePath: string): Promise<WatchState> {
  if (!existsSync(filePath)) {
    return defaultState();
  }

  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<WatchState>;

    if (typeof parsed.lastChecked !== "string" || !parsed.lastChecked) {
      return defaultState();
    }

    return {
      lastChecked: parsed.lastChecked,
      processedThreadIds: Array.isArray(parsed.processedThreadIds)
        ? parsed.processedThreadIds.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    // Corrupted file — start fresh
    return defaultState();
  }
}

/** Atomically save state to disk (write to temp, then rename). */
export async function saveState(filePath: string, state: WatchState): Promise<void> {
  const dir = dirname(filePath);
  const tmpPath = join(dir, `.${Date.now()}.tmp`);

  const trimmed: WatchState = {
    lastChecked: state.lastChecked,
    processedThreadIds: state.processedThreadIds.slice(-MAX_PROCESSED_IDS),
  };

  await writeFile(tmpPath, JSON.stringify(trimmed, null, 2) + "\n", "utf-8");
  await rename(tmpPath, filePath);
}

/** Mark a thread ID as processed, maintaining the rolling window. */
export function addProcessedId(state: WatchState, threadId: string): WatchState {
  const ids = state.processedThreadIds.includes(threadId)
    ? state.processedThreadIds
    : [...state.processedThreadIds, threadId].slice(-MAX_PROCESSED_IDS);

  return { ...state, processedThreadIds: ids };
}

function defaultState(): WatchState {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  return {
    lastChecked: oneHourAgo.toISOString(),
    processedThreadIds: [],
  };
}

/**
 * Atomically consume the ack journal file and merge its keys into state.
 *
 * Pattern: rename journal → read → merge → delete temp file.
 * Rename is atomic on POSIX, so concurrent appends by `appendAck` won't
 * lose data — they'll create a new journal file after the rename.
 */
export async function mergeAckJournal(stateFilePath: string, state: WatchState): Promise<WatchState> {
  const journalPath = `${stateFilePath}.acks`;
  const processingPath = `${stateFilePath}.acks.processing`;

  try {
    await rename(journalPath, processingPath);
  } catch {
    // No journal file — nothing to merge
    return state;
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
    // Always clean up the processing file
    try { await unlink(processingPath); } catch { /* ignore */ }
  }
}

/**
 * Append a key to the ack journal file.
 * Uses O_APPEND for safe concurrent writes from multiple ack invocations.
 */
export async function appendAck(stateFilePath: string, key: string): Promise<void> {
  const journalPath = `${stateFilePath}.acks`;
  const fh = await open(journalPath, "a");
  try {
    await fh.write(`${key}\n`);
  } finally {
    await fh.close();
  }
}
