import type { WatchOptions } from "../config/types.js";
import { CliError } from "../config/types.js";
import { fetchCurrentUser } from "../github/user.js";
import type { CommentDetail } from "../github/notifications.js";
import {
  fetchMentionNotificationsConditional,
  fetchCommentBody,
  fetchRecentSubjectComments,
  fetchLatestReviewRequestEvent,
  fetchReviewRequestState,
  fetchSubjectBodyResult,
  buildMentionEvent,
  isAgentMentioned,
  parseSubjectNumber,
} from "../github/notifications.js";
import {
  loadState,
  saveState,
  mergeAckJournal,
  addProcessedId,
  addReviewRequestId,
  buildLatestProcessedByThread,
  buildLatestReviewRequestByThread,
  type NotificationsPollState,
} from "../watch/state.js";

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

  log(`Starting watch: repo=${repo} agent=${agent} min-interval=${options.interval ?? 300}s reasons=${reasons.join(",")}`);

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
    const latestReviewRequestByThread = buildLatestReviewRequestByThread(state.reviewRequestIds ?? []);

    // Load per-repo poll state for conditional request headers
    const repoPollState: NotificationsPollState | undefined = state.notificationsPollState?.[repo];

    // Default sleep to the persisted interval (used on error/retry path and as fallback).
    // Overwritten below when a 200 response arrives with a new X-Poll-Interval.
    const persistedPollMs = repoPollState?.pollInterval ? repoPollState.pollInterval * 1000 : 0;
    let effectiveSleepMs = Math.max(intervalMs, persistedPollMs);

    try {
      // Capture time before fetch (informational — no longer used as fetch cursor)
      const fetchTime = new Date().toISOString();
      const conditionalResult = await fetchMentionNotificationsConditional(
        repo,
        reasons,
        repoPollState?.lastModified,
      );

      if (conditionalResult.notModified) {
        log(`304 Not Modified — no new notifications, skipping processing`);
        state = { ...state, lastChecked: fetchTime };
        await saveState(stateFile, state);

        if (once) break;
        // 304: no new X-Poll-Interval from server — effectiveSleepMs already holds persisted interval
        await sleep(effectiveSleepMs, signal);
        continue;
      }

      // Update pollInterval immediately so the new minimum sleep takes effect
      // this cycle. lastModified is held pending until all notifications in this
      // batch are processed — if any have transient failures we keep the old
      // cursor so the next poll fetches a fresh 200 and retries them.
      const newPollInterval = conditionalResult.pollInterval ?? repoPollState?.pollInterval;
      const pendingLastModified = conditionalResult.lastModified ?? repoPollState?.lastModified;

      state = {
        ...state,
        notificationsPollState: {
          ...state.notificationsPollState,
          [repo]: {
            ...(repoPollState?.lastModified ? { lastModified: repoPollState.lastModified } : {}),
            ...(newPollInterval ? { pollInterval: newPollInterval } : {}),
          },
        },
      };

      // 200: recompute sleep from the current response's X-Poll-Interval so the new
      // minimum takes effect immediately (not one cycle late).
      const newPollMs = newPollInterval ? newPollInterval * 1000 : 0;
      effectiveSleepMs = Math.max(intervalMs, newPollMs);

      const notifications = conditionalResult.notifications;

      // Track whether any notification in this batch had a transient fetch failure.
      // If true, we don't advance lastModified so the next poll retries from the
      // same conditional cursor rather than taking the 304 fast path.
      let anyTransientFailure = false;

      for (const notification of notifications) {
        if (signal.aborted) break;

        // Key on threadId + updated_at so new activity on the same thread
        // is recognized as a distinct event (thread IDs are reused by GitHub)
        const processedKey = `${notification.id}:${notification.updated_at}`;
        const previousProcessedAt = latestProcessedByThread.get(notification.id);
        if (state.processedThreadIds.includes(processedKey)) continue;
        if (notification.reason === "review_requested") {
          if (notification.subject.type !== "PullRequest") {
            log(`Skipping ${notification.id}: review_requested on non-PR subject, marking processed`);
            state = addProcessedId(state, processedKey);
            latestProcessedByThread.set(notification.id, notification.updated_at);
            continue;
          }

          const pullNumber = parseSubjectNumber(notification.subject.url);
          if (pullNumber === undefined) {
            log(`Skipping ${notification.id}: cannot parse PR number from subject URL, marking processed`);
            state = addProcessedId(state, processedKey);
            latestProcessedByThread.set(notification.id, notification.updated_at);
            continue;
          }

          const [repoOwner, repoName] = repo.split("/");
          const reviewState = await fetchReviewRequestState(repoOwner, repoName, pullNumber, agent);
          if (reviewState.transientFailure) {
            log(`Skipping ${notification.id}: review request check failed transiently, will retry`);
            anyTransientFailure = true;
            continue;
          }
          if (!reviewState.pending || !reviewState.requestId) {
            if (reviewState.permanentFailure) {
              log(`Skipping ${notification.id}: review request check failed permanently, marking processed`);
            } else {
              log(`Skipping ${notification.id}: agent is not an active requested reviewer, marking processed`);
            }
            state = addProcessedId(state, processedKey);
            latestProcessedByThread.set(notification.id, notification.updated_at);
            continue;
          }

          if (latestReviewRequestByThread.get(notification.id) === reviewState.requestId) {
            log(`Skipping ${notification.id}: review request ${reviewState.requestId} already emitted`);
            state = addProcessedId(state, processedKey);
            latestProcessedByThread.set(notification.id, notification.updated_at);
            continue;
          }

          const latestReviewEvent = await fetchLatestReviewRequestEvent(repoOwner, repoName, pullNumber, agent);
          if (latestReviewEvent.transientFailure) {
            log(`Skipping ${notification.id}: review request event lookup failed transiently, will retry`);
            anyTransientFailure = true;
            continue;
          }
          if (latestReviewEvent.permanentFailure) {
            log(`Continuing ${notification.id}: review request event lookup failed permanently, emitting without requester metadata`);
          } else if (!latestReviewEvent.eventId) {
            log(`Continuing ${notification.id}: no matching review_requested event found, emitting without requester metadata`);
          }

          const reviewEvent = buildMentionEvent(notification, null, agent, {
            trigger: "review_requested",
            reviewer: latestReviewEvent.reviewer ?? agent,
            ...(latestReviewEvent.requester ? { requester: latestReviewEvent.requester } : {}),
          });
          if (!reviewEvent) {
            log(`Skipping ${notification.id}: could not build review_requested event, marking processed`);
            state = addProcessedId(state, processedKey);
            latestProcessedByThread.set(notification.id, notification.updated_at);
            continue;
          }

          process.stdout.write(JSON.stringify(reviewEvent) + "\n");
          state = addReviewRequestId(state, notification.id, reviewState.requestId);
          latestReviewRequestByThread.set(notification.id, reviewState.requestId);
          continue;
        }

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
          anyTransientFailure = true;
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
                  anyTransientFailure = true;
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
                  anyTransientFailure = true;
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
                  anyTransientFailure = true;
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

      // Advance lastModified only when all notifications in this batch were
      // processed or definitively skipped. If any transient failure occurred,
      // keep the old cursor so the next poll retries from the same position —
      // even if GitHub would otherwise serve a 304 Not Modified.
      if (!anyTransientFailure && pendingLastModified) {
        state = {
          ...state,
          notificationsPollState: {
            ...state.notificationsPollState,
            [repo]: {
              ...state.notificationsPollState?.[repo],
              lastModified: pendingLastModified,
            },
          },
        };
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

    await sleep(effectiveSleepMs, signal);
  }
}
