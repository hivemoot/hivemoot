import type { RepoRef, MentionEvent } from "../config/types.js";
import { CliError } from "../config/types.js";
import { gh, ghPaginatedList, ghWithHeaders } from "./client.js";

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

export interface ReviewRequestState {
  pending: boolean;
  requestId?: string;
  permanentFailure: boolean;
  transientFailure: boolean;
}

export interface ReviewRequestEventResult {
  eventId?: string;
  requester?: string;
  reviewer?: string;
  permanentFailure: boolean;
  transientFailure: boolean;
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
  const notifications = await ghPaginatedList<RawNotification>(
    `/repos/${repo.owner}/${repo.repo}/notifications`,
  );
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

  const notifications = await ghPaginatedList<RawNotification>(
    `/repos/${repo}/notifications?${params}`,
  );

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

interface ReviewRequestsGraphqlResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewRequests?: {
          nodes?: Array<{
            id: string;
            databaseId?: number | null;
            requestedReviewer?: {
              __typename: string;
              login?: string;
            } | null;
          }>;
        };
      } | null;
    } | null;
  };
}

interface IssueEventResponseItem {
  id?: number;
  event?: string;
  created_at?: string;
  actor?: {
    login?: string;
  } | null;
  review_requester?: {
    login?: string;
  } | null;
  requested_reviewer?: {
    login?: string;
  } | null;
}

/**
 * Fetch the current active review-request identity for a specific user.
 *
 * We use the GraphQL ReviewRequest object's own identifier instead of
 * notification.updated_at. That lets watch distinguish a real re-request
 * from ordinary PR activity on the same thread.
 */
export async function fetchReviewRequestState(
  owner: string,
  repo: string,
  pullNumber: number,
  reviewer: string,
): Promise<ReviewRequestState> {
  const query = `
    query($owner: String!, $repo: String!, $pullNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pullNumber) {
          reviewRequests(first: 100) {
            nodes {
              id
              databaseId
              requestedReviewer {
                __typename
                ... on User {
                  login
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const raw = await gh([
      "api",
      "graphql",
      "-F", `owner=${owner}`,
      "-F", `repo=${repo}`,
      "-F", `pullNumber=${pullNumber}`,
      "-f", `query=${query}`,
    ]);
    const parsed = JSON.parse(raw) as ReviewRequestsGraphqlResponse;
    const pullRequest = parsed.data?.repository?.pullRequest;
    if (!pullRequest?.reviewRequests?.nodes) {
      return {
        pending: false,
        permanentFailure: true,
        transientFailure: false,
      };
    }

    const match = pullRequest.reviewRequests.nodes.find((request) => (
      request.requestedReviewer?.__typename === "User"
      && request.requestedReviewer.login?.toLowerCase() === reviewer.toLowerCase()
    ));
    if (!match) {
      return {
        pending: false,
        permanentFailure: false,
        transientFailure: false,
      };
    }

    return {
      pending: true,
      requestId: match.databaseId !== null && match.databaseId !== undefined
        ? String(match.databaseId)
        : match.id,
      permanentFailure: false,
      transientFailure: false,
    };
  } catch (err) {
    const permanentFailure = isPermanentFetchError(err);
    return {
      pending: false,
      permanentFailure,
      transientFailure: !permanentFailure,
    };
  }
}

/**
 * Fetch the most recent review_requested issue event for a reviewer on a PR.
 *
 * This gives watch the requester/reviewer metadata required by the event
 * payload without using thread updated_at as the dedupe identity.
 */
export async function fetchLatestReviewRequestEvent(
  owner: string,
  repo: string,
  pullNumber: number,
  reviewer: string,
): Promise<ReviewRequestEventResult> {
  try {
    const raw = await gh([
      "api",
      "--paginate",
      "--slurp",
      `/repos/${owner}/${repo}/issues/${pullNumber}/events?per_page=100`,
    ]);
    const pages = JSON.parse(raw) as IssueEventResponseItem[][];
    const events = pages.flat();

    let latest: IssueEventResponseItem | null = null;
    for (const event of events) {
      if (event.event !== "review_requested") continue;
      if (event.requested_reviewer?.login?.toLowerCase() !== reviewer.toLowerCase()) continue;

      if (!latest) {
        latest = event;
        continue;
      }

      const createdAt = event.created_at ?? "";
      const latestCreatedAt = latest.created_at ?? "";
      const eventId = event.id ?? 0;
      const latestId = latest.id ?? 0;
      if (createdAt > latestCreatedAt || (createdAt === latestCreatedAt && eventId > latestId)) {
        latest = event;
      }
    }

    if (!latest?.id) {
      return {
        permanentFailure: false,
        transientFailure: false,
      };
    }

    return {
      eventId: String(latest.id),
      requester: latest.review_requester?.login ?? latest.actor?.login,
      reviewer: latest.requested_reviewer?.login ?? reviewer,
      permanentFailure: false,
      transientFailure: false,
    };
  } catch (err) {
    const permanentFailure = isPermanentFetchError(err);
    return {
      permanentFailure,
      transientFailure: !permanentFailure,
    };
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

export interface ConditionalFetchResult {
  notModified: boolean;
  notifications: RawNotification[];
  /** Value of the Last-Modified header from the response, to pass as If-Modified-Since on the next request. */
  lastModified?: string;
  /** Value of the X-Poll-Interval header (seconds) from the response. */
  pollInterval?: number;
}

/**
 * Fetch unread mention notifications for a repo using conditional HTTP requests.
 *
 * When `lastModified` is provided it is sent as `If-Modified-Since`. If GitHub
 * responds with HTTP 304 (Nothing changed), this function returns immediately
 * with `notModified: true` — consuming zero rate-limit quota.
 *
 * The `X-Poll-Interval` header value (when present) is returned so callers can
 * adjust their sleep interval to match GitHub's recommended minimum.
 *
 * Uses a two-call design:
 * 1. Conditional probe with `If-Modified-Since` (no pagination) to get 304/200
 *    and extract response metadata (Last-Modified, X-Poll-Interval) from headers.
 *    Using -i here is reliable because we do not need to paginate this probe.
 * 2. If 200: full paginated fetch with `--paginate --slurp` to retrieve all pages,
 *    avoiding silent data loss when >100 unread notifications exist.
 *
 * This approach avoids the `--paginate -i` conflict where Link headers appear
 * only on the first page, making it impossible to read conditional headers from
 * subsequent pages.
 */
export async function fetchMentionNotificationsConditional(
  repo: string,
  reasons: string[],
  lastModified?: string,
): Promise<ConditionalFetchResult> {
  // Step 1: Conditional probe — get 304/200 and extract response metadata.
  const probeArgs = ["api", "-i"];
  if (lastModified) {
    probeArgs.push("-H", `If-Modified-Since: ${lastModified}`);
  }
  probeArgs.push(`/repos/${repo}/notifications?all=false`);

  const probeResult = await ghWithHeaders(probeArgs);

  if (probeResult.notModified) {
    return { notModified: true, notifications: [] };
  }

  const { headers } = probeResult;

  const pollIntervalRaw = headers["x-poll-interval"];
  const pollIntervalSeconds = pollIntervalRaw ? parseInt(pollIntervalRaw, 10) : NaN;
  const pollInterval = Number.isFinite(pollIntervalSeconds) && pollIntervalSeconds > 0
    ? pollIntervalSeconds
    : undefined;

  const newLastModified = headers["last-modified"] ?? undefined;

  // Step 2: Fetch all pages. No If-Modified-Since here — content is known to have
  // changed. --paginate --slurp fetches all Link pages so >100 unread notifications
  // are never silently dropped.
  const raw = await gh([
    "api",
    "--paginate",
    "--slurp",
    `/repos/${repo}/notifications?all=false`,
  ]);

  let notifications: RawNotification[];
  try {
    const pages: unknown = JSON.parse(raw);
    if (!Array.isArray(pages)) {
      throw new CliError(
        `Unexpected notification response shape (expected array, got ${typeof pages})`,
        "GH_ERROR",
        1,
      );
    }
    // --paginate --slurp produces an array of page arrays
    notifications = (pages as RawNotification[][]).flat();
  } catch (err) {
    // Treat parse/shape failures as transient errors — throw so the watch loop
    // does not advance lastModified or lastChecked, ensuring a retry on the
    // next cycle fetches a fresh 200 response with the same notifications.
    if (err instanceof CliError) throw err;
    throw new CliError(
      `Failed to parse notification response body: ${err instanceof Error ? err.message : String(err)}`,
      "GH_ERROR",
      1,
    );
  }

  const filtered = notifications.filter((n) => {
    if (!n.unread) return false;
    if (!reasons.includes(n.reason)) return false;
    if (n.subject.type !== "Issue" && n.subject.type !== "PullRequest") return false;
    return true;
  });

  return {
    notModified: false,
    notifications: filtered,
    lastModified: newLastModified,
    pollInterval,
  };
}

/**
 * Build a MentionEvent from a raw notification and its associated comment.
 * Returns null if the notification can't be mapped to a valid event.
 */
export function buildMentionEvent(
  notification: RawNotification,
  comment: CommentDetail | null,
  agent: string,
  extras?: Pick<MentionEvent, "trigger" | "requester" | "reviewer">,
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
    ...(extras?.trigger ? { trigger: extras.trigger } : {}),
    ...(extras?.requester ? { requester: extras.requester } : {}),
    ...(extras?.reviewer ? { reviewer: extras.reviewer } : {}),
  };
}
