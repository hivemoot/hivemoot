import type { AckOptions } from "../config/types.js";
import { markNotificationRead } from "../github/notifications.js";
import { appendAck } from "../watch/state.js";

function log(message: string): void {
  process.stderr.write(`[ack ${new Date().toISOString()}] ${message}\n`);
}

export async function ackCommand(key: string, options: AckOptions): Promise<void> {
  const colonIndex = key.indexOf(":");
  if (colonIndex < 1) {
    throw new Error(`Invalid key format: expected "threadId:updatedAt", got "${key}"`);
  }

  const threadId = key.substring(0, colonIndex);

  // Record in journal first — this is the critical path for dedup
  await appendAck(options.stateFile, key);

  // Best-effort mark as read on GitHub — failure is non-fatal since the
  // notification will stay unread but the journal entry prevents re-emission
  try {
    await markNotificationRead(threadId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Warning: could not mark thread ${threadId} as read on GitHub: ${message}`);
  }
}
