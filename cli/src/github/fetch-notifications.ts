import { ghPaginatedList } from "./client.js";
import { parseSubjectNumber } from "./notifications.js";
import { buildLatestProcessedByThread, loadState } from "../watch/state.js";

export interface NotificationItem {
  threadId: string;
  reason: string;
  updatedAt: string;
  title: string;
  url: string | null;
  itemType: "Issue" | "PullRequest" | null;
  number: number | null;
}

export interface NotificationsPullResult {
  schemaVersion: 1;
  kind: "notifications_pull";
  generatedAt: string;
  repo: string;
  reasons: string[];
  notifications: NotificationItem[];
}

interface RawNotification {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  subject: {
    url: string;
    type: string;
    title: string;
  };
  repository: {
    full_name: string;
  };
}

function subjectHtmlUrl(repo: string, subjectType: string, number: number): string {
  if (subjectType === "PullRequest") {
    return `https://github.com/${repo}/pull/${number}`;
  }
  return `https://github.com/${repo}/issues/${number}`;
}

/**
 * Fetch unread notifications for a repo with cursor-based deduplication.
 *
 * Uses `--paginate --slurp` for correct multi-page handling.
 * Applies reason filter client-side (GitHub API does not support server-side reason filtering).
 * Skips notifications already processed according to the watch state cursor.
 */
export async function fetchNotificationsPull(
  repo: string,
  reasons: string[],
  stateFilePath?: string,
): Promise<NotificationsPullResult> {
  const generatedAt = new Date().toISOString();

  // Load cursor state to skip already-processed notifications.
  let latestByThread = new Map<string, string>();
  if (stateFilePath) {
    try {
      const state = await loadState(stateFilePath);
      latestByThread = buildLatestProcessedByThread(state.processedThreadIds);
    } catch {
      // State file missing or unreadable — proceed without cursor filtering.
    }
  }

  const allNotifications = await ghPaginatedList<RawNotification>(
    `/repos/${repo}/notifications?all=false`,
  );
  const filterByReason = reasons.length > 0 && !reasons.includes("*");

  const items: NotificationItem[] = [];

  for (const n of allNotifications) {
    if (!n.unread) continue;
    if (n.subject.type !== "Issue" && n.subject.type !== "PullRequest") continue;
    if (filterByReason && !reasons.includes(n.reason)) continue;

    // Skip if this notification was already processed at this updatedAt or newer.
    const processedAt = latestByThread.get(n.id);
    if (processedAt && n.updated_at <= processedAt) continue;

    const number = parseSubjectNumber(n.subject.url) ?? null;
    const itemType = n.subject.type as "Issue" | "PullRequest";
    const url = number !== null ? subjectHtmlUrl(repo, itemType, number) : null;

    items.push({
      threadId: n.id,
      reason: n.reason,
      updatedAt: n.updated_at,
      title: n.subject.title,
      url,
      itemType,
      number,
    });
  }

  return {
    schemaVersion: 1,
    kind: "notifications_pull",
    generatedAt,
    repo,
    reasons: filterByReason ? reasons : ["*"],
    notifications: items,
  };
}
