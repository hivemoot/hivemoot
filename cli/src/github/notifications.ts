import type { RepoRef, MentionEvent } from "../config/types.js";
import { CliError } from "../config/types.js";
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
  createdAt?: string;
  updatedAt?: string;
}

export interface FetchDetailResult {
  detail: CommentDetail | null;
  permanentFailure: boolean;
}

export interface FetchCommentsResult {
  comments: CommentDetail[] | null;
  permanentFailure: boolean;
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

interface SubjectApiRef {
  owner: string;
  repo: string;
  number: string;
}

function parseSubjectApiRef(subjectUrl: string): SubjectApiRef | null {
  if (!subjectUrl) return null;

  let path = subjectUrl;
  try {
    path = new URL(subjectUrl).pathname;
  } catch {
    // Keep raw value; we support absolute URLs and /repos/... paths.
  }

  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 5 || parts[0] !== "repos") return null;
  if (parts[3] !== "issues" && parts[3] !== "pulls") return null;
  if (!/^\d+$/.test(parts[4])) return null;

  return {
    owner: parts[1],
    repo: parts[2],
    number: parts[4],
  };
}

function isPermanentFetchError(err: unknown): boolean {
  if (err instanceof CliError || err instanceof Error) {
    return /\bHTTP (403|404)\b/i.test(err.message);
  }
  return false;
}

async function fetchCommentsList(apiPath: string): Promise<CommentDetail[]> {
  const raw = await gh([
    "api",
    apiPath,
    "--jq", 'map({ body: (.body // ""), author: (.user.login // .author.login // "unknown"), htmlUrl: (.html_url // ""), createdAt: (.created_at // ""), updatedAt: (.updated_at // "") })',
  ]);
  const parsed = JSON.parse(raw) as Array<{
    body: string;
    author: string;
    htmlUrl: string;
    createdAt?: string;
    updatedAt?: string;
  }>;

  return parsed.map((comment) => {
    const detail: CommentDetail = {
      body: comment.body,
      author: comment.author,
      htmlUrl: comment.htmlUrl,
    };
    if (comment.createdAt) {
      detail.createdAt = comment.createdAt;
    }
    if (comment.updatedAt) {
      detail.updatedAt = comment.updatedAt;
    }
    return detail;
  });
}

function parseIsoMillis(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function commentTimestamp(comment: CommentDetail): number | null {
  return parseIsoMillis(comment.updatedAt) ?? parseIsoMillis(comment.createdAt);
}

function filterCommentsSince(
  comments: CommentDetail[],
  since?: string,
): CommentDetail[] {
  const sinceMs = parseIsoMillis(since);
  if (sinceMs === null) {
    return comments;
  }

  return comments.filter((comment) => {
    const timestamp = commentTimestamp(comment);
    return timestamp !== null && timestamp > sinceMs;
  });
}

function buildCommentsPath(
  path: string,
  sort: "created" | "updated",
  since?: string,
): string {
  const params = new URLSearchParams({
    per_page: "100",
    sort,
    direction: "desc",
  });
  if (since) {
    params.set("since", since);
  }
  return `${path}?${params.toString()}`;
}

/**
 * Fetch recent issue/PR comments for mention routing.
 * For PR subjects, merges issue comments and review comments.
 */
export async function fetchRecentSubjectComments(
  subjectUrl: string,
  subjectType: string,
  since?: string,
): Promise<FetchCommentsResult> {
  const ref = parseSubjectApiRef(subjectUrl);
  if (!ref) {
    return { comments: null, permanentFailure: true };
  }

  try {
    const issueCommentsPath = buildCommentsPath(
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`,
      "updated",
      since,
    );
    const issueComments = await fetchCommentsList(issueCommentsPath);

    if (subjectType !== "PullRequest") {
      return {
        comments: filterCommentsSince(issueComments, since),
        permanentFailure: false,
      };
    }

    const reviewCommentsPath = buildCommentsPath(
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`,
      "created",
      since,
    );
    const reviewComments = await fetchCommentsList(reviewCommentsPath);

    // De-duplicate by URL when the same comment appears in overlapping payloads.
    const seen = new Set<string>();
    const merged: CommentDetail[] = [];
    for (const comment of [...issueComments, ...reviewComments]) {
      const key = comment.htmlUrl || `${comment.author}:${comment.body}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(comment);
    }
    return {
      comments: filterCommentsSince(merged, since),
      permanentFailure: false,
    };
  } catch (err) {
    return { comments: null, permanentFailure: isPermanentFetchError(err) };
  }
}

/**
 * Fetch the issue/PR body and author from a subject API URL.
 * Returns null if the URL is missing or the fetch fails.
 */
export async function fetchSubjectBody(subjectUrl: string): Promise<CommentDetail | null> {
  const result = await fetchSubjectBodyResult(subjectUrl);
  return result.detail;
}

/**
 * Fetch the issue/PR body and author and classify failures for retry strategy.
 */
export async function fetchSubjectBodyResult(subjectUrl: string): Promise<FetchDetailResult> {
  if (!subjectUrl) {
    return { detail: null, permanentFailure: true };
  }

  try {
    const raw = await gh([
      "api",
      subjectUrl,
      "--jq", '{ body: (.body // ""), author: (.user.login // .author.login // "unknown"), htmlUrl: (.html_url // "") }',
    ]);
    const parsed = JSON.parse(raw) as { body: string; author: string; htmlUrl: string };
    return {
      detail: {
        body: parsed.body,
        author: parsed.author,
        htmlUrl: parsed.htmlUrl,
      },
      permanentFailure: false,
    };
  } catch (err) {
    return { detail: null, permanentFailure: isPermanentFetchError(err) };
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
