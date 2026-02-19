import type { WatchOptions } from "../config/types.js";
import { CliError } from "../config/types.js";
import { fetchCurrentUser } from "../github/user.js";
import type { CommentDetail } from "../github/notifications.js";
import {
  fetchMentionNotifications,
  fetchCommentBody,
  fetchRecentSubjectComments,
  fetchSubjectBodyResult,
  buildMentionEvent,
  isAgentMentioned,
} from "../github/notifications.js";
import { loadState, saveState, mergeAckJournal, addProcessedId } from "../watch/state.js";

function log(message: string): void {
  process.stderr.write(`[watch ${new Date().toISOString()}] ${message}\n`);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseIsoMillis(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function buildLatestProcessedByThread(processedKeys: string[]): Map<string, string> {
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

function isCommentAtOrBeforeNotification(
  comment: CommentDetail,
  notificationUpdatedAt: string,
): boolean {
  const notificationMs = parseIsoMillis(notificationUpdatedAt);
  if (notificationMs === null) {
    return true;
  }

  const commentMs = parseIsoMillis(comment.updatedAt) ?? parseIsoMillis(comment.createdAt);
  if (commentMs === null) {
    return true;
  }

  return commentMs <= notificationMs;
}

/** Result of scanning thread comments for an @-mention of the agent. */
type ThreadScanResult =
  | { match: CommentDetail }
  | { match: null; fetchFailed: true; permanentFailure: boolean }
  | { match: null; fetchFailed: false };

/**
 * Scan recent thread comments for one that mentions the agent.
 * Shared by both the "latest_comment_url present" and "null" code paths
 * to avoid logic divergence.
 */
async function scanThreadForMention(
  subjectUrl: string,
  subjectType: string,
  notificationUpdatedAt: string,
  agent: string,
  since?: string,
): Promise<ThreadScanResult> {
  const recent = await fetchRecentSubjectComments(subjectUrl, subjectType, since);

  if (recent.comments === null) {
    return { match: null, fetchFailed: true, permanentFailure: recent.permanentFailure };
  }

  const match = recent.comments.find(
    (c) => isCommentAtOrBeforeNotification(c, notificationUpdatedAt)
      && isAgentMentioned(c.body, agent),
  ) ?? null;

  return match
    ? { match }
    : { match: null, fetchFailed: false };
}

export async function watchCommand(options: WatchOptions): Promise<void> {
  const repo = options.repo;
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new CliError(
      "Invalid or missing --repo. Expected format: owner/repo",
      "GH_ERROR",
      1,
    );
  }

  const intervalMs = (options.interval ?? 300) * 1000;
  const stateFile = options.stateFile ?? ".hivemoot-watch.json";
  const reasons = (options.reasons ?? "mention").split(",").map((r) => r.trim());

  // Resolve authenticated user login (used as agent name in events)
  let agent: string;
  try {
    agent = await fetchCurrentUser();
  } catch {
    throw new CliError(
      "Could not determine GitHub user. Ensure token is valid.",
      "GH_NOT_AUTHENTICATED",
      2,
    );
  }

  log(`Starting watch: repo=${repo} agent=${agent} interval=${options.interval ?? 300}s reasons=${reasons.join(",")}`);

  const abortController = new AbortController();
  let shutdownRequested = false;

  const shutdown = () => {
    if (!shutdownRequested) {
      shutdownRequested = true;
      log("Shutdown signal received");
      abortController.abort();
    }
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    await runPollLoop(repo, agent, stateFile, reasons, intervalMs, options.once ?? false, abortController.signal);
  } finally {
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
  }
}

async function runPollLoop(
  repo: string,
  agent: string,
  stateFile: string,
  reasons: string[],
  intervalMs: number,
  once: boolean,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    let state = await loadState(stateFile);

    // Merge keys acked since last poll into processedThreadIds
    state = await mergeAckJournal(stateFile, state);
    const latestProcessedByThread = buildLatestProcessedByThread(state.processedThreadIds);

    try {
      // Capture time before fetch (informational — no longer used as fetch cursor)
      const fetchTime = new Date().toISOString();
      const notifications = await fetchMentionNotifications(repo, reasons);

      for (const notification of notifications) {
        if (signal.aborted) break;

        // Key on threadId + updated_at so new activity on the same thread
        // is recognized as a distinct event (thread IDs are reused by GitHub)
        const processedKey = `${notification.id}:${notification.updated_at}`;
        const previousProcessedAt = latestProcessedByThread.get(notification.id);
        if (state.processedThreadIds.includes(processedKey)) continue;

        // Fetch the comment that triggered this notification
        const comment = notification.subject.latest_comment_url
          ? await fetchCommentBody(notification.subject.latest_comment_url)
          : null;

        // -- Null-comment gate: transient API failure --
        // URL existed but fetch returned null → skip and retry next poll.
        // No URL at all (e.g. issue-body mention) → fall through to
        // buildMentionEvent which handles null comments gracefully.
        if (comment === null && notification.subject.latest_comment_url) {
          log(`Skipping ${notification.id}: comment fetch failed, will retry`);
          continue;
        }

        let eventSource = comment;

        // -- Mention verification (strict for reason="mention") --
        // Only emit events when we can prove the authenticated agent is
        // explicitly mentioned in either:
        //  1) the latest comment (when latest_comment_url is present),
        //  2) recent thread comments (fallback scan), or
        //  3) the issue/PR body.
        // This prevents stale thread notifications from triggering other agents.
        if (notification.reason === "mention") {
          if (comment !== null) {
            if (isAgentMentioned(comment.body, agent)) {
              eventSource = comment;
            } else {
              const scan = await scanThreadForMention(
                notification.subject.url,
                notification.subject.type,
                notification.updated_at,
                agent,
                previousProcessedAt,
              );

              if (scan.match) {
                eventSource = scan.match;
              } else if (scan.fetchFailed) {
                if (scan.permanentFailure) {
                  log(`Skipping ${notification.id}: cannot fetch thread comments (permanent), marking processed`);
                  state = addProcessedId(state, processedKey);
                  latestProcessedByThread.set(notification.id, notification.updated_at);
                } else {
                  log(`Skipping ${notification.id}: thread comment scan failed, will retry`);
                }
                continue;
              } else {
                log(`Skipping ${notification.id}: agent not mentioned in recent thread comments (stale thread)`);
                state = addProcessedId(state, processedKey);
                latestProcessedByThread.set(notification.id, notification.updated_at);
                continue;
              }
            }
          } else {
            // latest_comment_url is absent — check subject body first,
            // then scan recent thread comments as fallback (GitHub sometimes
            // omits latest_comment_url even when the mention is in a comment).
            const subject = await fetchSubjectBodyResult(notification.subject.url);
            if (subject.detail !== null && isAgentMentioned(subject.detail.body, agent)) {
              eventSource = subject.detail;
            } else {
              const scan = await scanThreadForMention(
                notification.subject.url,
                notification.subject.type,
                notification.updated_at,
                agent,
                previousProcessedAt,
              );

              if (scan.match) {
                eventSource = scan.match;
              } else if (scan.fetchFailed) {
                if (scan.permanentFailure) {
                  log(`Skipping ${notification.id}: cannot fetch thread comments (permanent), marking processed`);
                  state = addProcessedId(state, processedKey);
                  latestProcessedByThread.set(notification.id, notification.updated_at);
                } else {
                  log(`Skipping ${notification.id}: comment scan failed (no latest_comment_url), will retry`);
                }
                continue;
              } else if (subject.detail === null) {
                // Both subject body fetch and comment scan found nothing
                if (subject.permanentFailure) {
                  log(`Skipping ${notification.id}: subject fetch failed permanently and no matching comments, marking processed`);
                  state = addProcessedId(state, processedKey);
                  latestProcessedByThread.set(notification.id, notification.updated_at);
                } else {
                  log(`Skipping ${notification.id}: subject fetch failed and no matching comments, will retry`);
                }
                continue;
              } else {
                log(`Skipping ${notification.id}: agent not mentioned in subject body or recent comments (stale thread)`);
                state = addProcessedId(state, processedKey);
                latestProcessedByThread.set(notification.id, notification.updated_at);
                continue;
              }
            }
          }
        }

        const event = buildMentionEvent(notification, eventSource, agent);
        if (!event) {
          // Can't parse — skip silently. Unparseable events reappear next poll
          // but are harmless since all=false naturally drops them once the
          // thread gets new activity.
          continue;
        }

        // Output the event as JSON line to stdout.
        // Notification is NOT marked read here — the consumer calls `hivemoot ack`
        // after successfully processing the event, which marks it read on GitHub
        // and records the key in the ack journal.
        process.stdout.write(JSON.stringify(event) + "\n");
      }

      state = { ...state, lastChecked: fetchTime };
      await saveState(stateFile, state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Poll error: ${message}`);
      // In --once mode there's no retry — propagate so callers see the failure
      if (once) {
        throw err instanceof CliError
          ? err
          : new CliError(`Poll failed: ${message}`, "GH_ERROR", 1);
      }
      // In continuous mode, keep polling — transient errors will be retried
    }

    if (once) break;

    await sleep(intervalMs, signal);
  }
}
