import type { WatchOptions } from "../config/types.js";
import { CliError } from "../config/types.js";
import { fetchCurrentUser } from "../github/user.js";
import {
  fetchMentionNotifications,
  fetchCommentBody,
  fetchRecentSubjectComments,
  fetchSubjectBody,
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

    try {
      // Capture time before fetch (informational — no longer used as fetch cursor)
      const fetchTime = new Date().toISOString();
      const notifications = await fetchMentionNotifications(repo, reasons);

      for (const notification of notifications) {
        if (signal.aborted) break;

        // Key on threadId + updated_at so new activity on the same thread
        // is recognized as a distinct event (thread IDs are reused by GitHub)
        const processedKey = `${notification.id}:${notification.updated_at}`;
        if (state.processedThreadIds.includes(processedKey)) continue;

        let eventSourceComment = notification.subject.latest_comment_url
          ? await fetchCommentBody(notification.subject.latest_comment_url)
          : null;

        if (notification.subject.latest_comment_url && eventSourceComment === null) {
          log(`Skipping ${notification.id}: comment fetch failed, will retry`);
          continue;
        }

        if (notification.reason === "mention") {
          if (eventSourceComment !== null) {
            if (!isAgentMentioned(eventSourceComment.body, agent)) {
              const recentComments = await fetchRecentSubjectComments(notification, state.lastChecked);
              if (recentComments === null) {
                log(`Skipping ${notification.id}: fallback comment scan failed, will retry`);
                continue;
              }

              const matchingComment = recentComments.find((c) => isAgentMentioned(c.body, agent));
              if (!matchingComment) {
                log(`Skipping ${notification.id}: agent not mentioned in notification window`);
                state = addProcessedId(state, processedKey);
                continue;
              }

              eventSourceComment = matchingComment;
            }
          } else {
            // No latest comment URL: verify explicit mention in issue/PR body.
            const subject = await fetchSubjectBody(notification.subject.url);
            if (subject === null) {
              log(`Skipping ${notification.id}: subject fetch failed, will retry`);
              continue;
            }

            if (!isAgentMentioned(subject.body, agent)) {
              log(`Skipping ${notification.id}: agent not mentioned in subject body`);
              state = addProcessedId(state, processedKey);
              continue;
            }

            eventSourceComment = {
              body: subject.body,
              author: subject.author,
              htmlUrl: subject.htmlUrl,
              createdAt: subject.updatedAt,
            };
          }
        }

        const event = buildMentionEvent(notification, eventSourceComment, agent);
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
