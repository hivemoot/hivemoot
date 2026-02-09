import type { RepoRef } from "../config/types.js";
import { gh } from "./client.js";

export interface NotificationInfo {
  reason: string;     // "comment" | "mention" | "author" | "ci_activity" | ...
  updatedAt: string;  // ISO timestamp
}

export type NotificationMap = Map<number, NotificationInfo>;

interface RawNotification {
  unread: boolean;
  reason: string;
  updated_at: string;
  subject: {
    url: string;
    type: string;
  };
}

/** Extract issue/PR number from a GitHub API subject URL (last path segment). */
export function parseSubjectNumber(url: string): number | undefined {
  const match = url.match(/\/(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Fetch unread notifications for a repository.
 * Returns a map from issue/PR number to notification info.
 * When multiple notifications exist for the same item, keeps the most recent.
 */
export async function fetchNotifications(repo: RepoRef): Promise<NotificationMap> {
  const raw = await gh([
    "api",
    `/repos/${repo.owner}/${repo.repo}/notifications`,
  ]);

  const notifications: RawNotification[] = JSON.parse(raw);
  const map: NotificationMap = new Map();

  for (const n of notifications) {
    if (!n.unread) continue;
    if (n.subject.type !== "Issue" && n.subject.type !== "PullRequest") continue;

    const num = parseSubjectNumber(n.subject.url);
    if (num === undefined) continue;

    const existing = map.get(num);
    // Keep the most recent notification per item
    if (!existing || n.updated_at > existing.updatedAt) {
      map.set(num, { reason: n.reason, updatedAt: n.updated_at });
    }
  }

  return map;
}
