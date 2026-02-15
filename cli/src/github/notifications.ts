import type { RepoRef, MentionEvent } from "../config/types.js";
import { gh } from "./client.js";

export interface NotificationInfo {
  threadId: string;   // GitHub notification thread ID — needed for ack
  reason: string;     // "comment" | "mention" | "author" | "ci_activity" | ...
  updatedAt: string;  // ISO timestamp
  title: string;      // Subject title — always present for Issue/PR notifications
  url?: string;       // HTML URL for the issue/PR, when derivable
  itemType?: "Issue" | "PullRequest";
}

export type NotificationMap = Map<number, NotificationInfo>;

export interface RawNotification {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  subject: {
    url: string;
    type: string;
    title: string;
    latest_comment_url: string | null;
  };
  repository: {
    full_name: string;
  };
}

export interface CommentDetail {
  body: string;
  author: string;
  htmlUrl: string;
}

/** Extract issue/PR number from a GitHub API subject URL (last path segment). */
export function parseSubjectNumber(url: string): number | undefined {
  const match = url.match(/\/(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

function subjectHtmlUrl(
  repo: RepoRef,
  subjectType: "Issue" | "PullRequest",
  number: number,
): string {
  if (subjectType === "Issue") {
    return `https://github.com/${repo.owner}/${repo.repo}/issues/${number}`;
  }
  return `https://github.com/${repo.owner}/${repo.repo}/pull/${number}`;
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
      const subjectType = n.subject.type as "Issue" | "PullRequest";
      const info: NotificationInfo = {
        threadId: n.id,
        reason: n.reason,
        updatedAt: n.updated_at,
        title: n.subject.title,
        url: subjectHtmlUrl(repo, subjectType, num),
        itemType: subjectType,
      };
      map.set(num, info);
    }
  }

  return map;
}

/**
 * Fetch unread mention notifications for a repo, filtered by reason.
 * When `since` is provided, only returns notifications updated after that time.
 * When omitted, returns all unread notifications (relying on GitHub's unread filter).
 */
export async function fetchMentionNotifications(
  repo: string,
  reasons: string[],
  since?: string,
): Promise<RawNotification[]> {
  const params = new URLSearchParams({ all: "false" });
  if (since) {
    params.set("since", since);
  }

  const args = [
    "api",
    "--paginate",
    `/repos/${repo}/notifications?${params}`,
  ];

  const raw = await gh(args);

  const notifications: RawNotification[] = JSON.parse(raw);

  return notifications.filter((n) => {
    if (!n.unread) return false;
    if (!reasons.includes(n.reason)) return false;
    if (n.subject.type !== "Issue" && n.subject.type !== "PullRequest") return false;
    return true;
  });
}

/** Mark a single notification thread as read. */
export async function markNotificationRead(threadId: string): Promise<void> {
  await gh([
    "api",
    "--method", "PATCH",
    `/notifications/threads/${threadId}`,
  ]);
}

/**
 * Fetch the comment body and author from a comment API URL.
 * Returns null if the URL is missing or the fetch fails.
 */
export async function fetchCommentBody(commentUrl: string): Promise<CommentDetail | null> {
  if (!commentUrl) return null;

  try {
    const raw = await gh([
      "api",
      commentUrl,
      "--jq", '{ body: .body, author: (.user.login // .author.login // "unknown"), htmlUrl: .html_url }',
    ]);
    const parsed = JSON.parse(raw) as { body: string; author: string; htmlUrl: string };
    return {
      body: parsed.body,
      author: parsed.author,
      htmlUrl: parsed.htmlUrl,
    };
  } catch {
    return null;
  }
}

/**
 * Check if the comment body contains an @mention of the given GitHub login.
 * Case-insensitive, boundary-safe on both sides:
 *   Left:  rejects email local-parts (foo@agent)
 *   Right: rejects suffix usernames (@agent-extra)
 */
export function isAgentMentioned(body: string, agent: string): boolean {
  const escaped = agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-zA-Z0-9._+-])@${escaped}(?![a-zA-Z0-9-])`, "i").test(body);
}

/**
 * Build a MentionEvent from a raw notification and its associated comment.
 * Returns null if the notification can't be mapped to a valid event.
 */
export function buildMentionEvent(
  notification: RawNotification,
  comment: CommentDetail | null,
  agent: string,
): MentionEvent | null {
  const number = parseSubjectNumber(notification.subject.url);
  if (number === undefined) return null;

  return {
    agent,
    repo: notification.repository.full_name,
    number,
    type: notification.subject.type,
    title: notification.subject.title,
    author: comment?.author ?? "unknown",
    body: comment?.body ?? "",
    url: comment?.htmlUrl ?? "",
    threadId: notification.id,
    timestamp: notification.updated_at,
  };
}
