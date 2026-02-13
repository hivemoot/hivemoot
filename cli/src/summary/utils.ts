import type { GitHubPR } from "../config/types.js";

export const GOVERNANCE_LABEL_ALIASES = {
  DISCUSSION: ["hivemoot:discussion", "phase:discussion"],
  VOTING: ["hivemoot:voting", "phase:voting"],
  EXTENDED_VOTING: ["hivemoot:extended-voting", "phase:extended-voting"],
  READY_TO_IMPLEMENT: ["hivemoot:ready-to-implement", "phase:ready-to-implement"],
  NEEDS_HUMAN: ["hivemoot:needs-human", "needs:human"],
  IMPLEMENTATION: ["hivemoot:candidate", "implementation"],
  REJECTED: ["hivemoot:rejected", "rejected"],
  INCONCLUSIVE: ["hivemoot:inconclusive", "inconclusive"],
  STALE: ["hivemoot:stale", "stale"],
  IMPLEMENTED: ["hivemoot:implemented", "implemented"],
  MERGE_READY: ["hivemoot:merge-ready", "merge-ready"],
} as const;

export type GovernanceLabelKey = keyof typeof GOVERNANCE_LABEL_ALIASES;

export function hasGovernanceLabel(
  labels: Array<{ name: string }>,
  key: GovernanceLabelKey,
): boolean {
  const aliases = GOVERNANCE_LABEL_ALIASES[key];
  return labels.some((label) => aliases.some((alias) => alias === label.name.toLowerCase()));
}

export function hasGovernanceLabelName(
  labelNames: string[],
  key: GovernanceLabelKey,
): boolean {
  const aliases = GOVERNANCE_LABEL_ALIASES[key];
  return labelNames.some((name) => aliases.some((alias) => alias === name.toLowerCase()));
}

// ── Comment context ──────────────────────────────────────────────

export interface CommentContext {
  yourComment: string;
  yourCommentAge: string;
}

/**
 * Compute the current user's latest comment on an issue/PR.
 * Returns null if the user has not commented.
 */
export function commentContext(
  item: { comments: Array<{ createdAt: string; author: { login: string } | null }> },
  currentUser: string,
  now: Date,
): CommentContext | null {
  let latestTime: string | undefined;
  for (const comment of item.comments) {
    if (comment.author?.login === currentUser) {
      if (!latestTime || comment.createdAt > latestTime) {
        latestTime = comment.createdAt;
      }
    }
  }
  if (!latestTime) return null;
  return { yourComment: "commented", yourCommentAge: timeAgo(latestTime, now) };
}

// ── Voting issue detection ───────────────────────────────────────

/**
 * Whether an issue is in a voting phase based on its labels.
 * Matches canonical/legacy voting labels, or the keyword "vote".
 */
export function isVotingIssue(labels: Array<{ name: string }>): boolean {
  return (
    hasGovernanceLabel(labels, "VOTING") ||
    hasGovernanceLabel(labels, "EXTENDED_VOTING") ||
    hasLabel(labels, "vote")
  );
}

export function hasLabel(labels: Array<{ name: string }>, keyword: string): boolean {
  return labels.some((l) =>
    l.name.toLowerCase().split(/[:\-_]/).some((seg) => seg === keyword),
  );
}

export function hasExactLabel(labels: Array<{ name: string }>, labelName: string): boolean {
  return labels.some((l) => l.name.toLowerCase() === labelName.toLowerCase());
}

/** Human-relative time string ("just now", "5 minutes ago", "yesterday", etc.). */
export function timeAgo(dateStr: string, now: Date): string {
  const ms = now.getTime() - new Date(dateStr).getTime();
  if (ms < 0) return "just now"; // future date — clock skew or bad data

  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(ms / 86_400_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) {
    const remainingMinutes = minutes % 60;
    if (remainingMinutes === 0) return `${hours}h ago`;
    return `${hours}h${remainingMinutes}m ago`;
  }
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "1 week ago";
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return "1 month ago";
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  const years = Math.floor(days / 365);
  if (years === 1) return "1 year ago";
  return `${years} years ago`;
}

export function daysSince(dateStr: string, now: Date): number {
  const diff = now.getTime() - new Date(dateStr).getTime();
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}

export function hasCIFailure(pr: GitHubPR): boolean {
  if (!pr.statusCheckRollup) return false;
  return pr.statusCheckRollup.some((check) => {
    const conclusion = check.conclusion?.toUpperCase();
    const state = check.state?.toUpperCase();
    return conclusion === "FAILURE" || state === "FAILURE";
  });
}

/**
 * Summarize all status checks into a single label.
 * Returns null when there are no checks to report.
 */
export function checkStatus(pr: GitHubPR): string | null {
  if (!pr.statusCheckRollup || pr.statusCheckRollup.length === 0) return null;

  const hasFailing = hasCIFailure(pr);
  if (hasFailing) return "checks failing";

  const hasPending = pr.statusCheckRollup.some((c) => {
    const s = c.state?.toUpperCase();
    return s === "PENDING" || s === "QUEUED" || s === "IN_PROGRESS";
  });
  if (hasPending) return "checks pending";

  return "checks passing";
}

/**
 * Return a merge-conflict label, or null if no conflict info.
 */
export function mergeStatus(pr: GitHubPR): string | null {
  if (pr.mergeable === "CONFLICTING") return "has conflicts";
  if (pr.mergeable === "MERGEABLE") return "no conflicts";
  return null;
}

/** Collapse reviews to the latest state per author. */
function latestReviewByAuthor(pr: GitHubPR): Map<string, string> {
  const map = new Map<string, string>();
  for (const review of pr.reviews ?? []) {
    map.set(review.author?.login ?? "ghost", review.state);
  }
  return map;
}

/** Count unique approvals (latest review per author). */
export function approvalCount(pr: GitHubPR): number {
  let count = 0;
  for (const state of latestReviewByAuthor(pr).values()) {
    if (state === "APPROVED") count++;
  }
  return count;
}

/**
 * Count unique changes-requested reviews (latest review per author).
 * If an author requests changes then later approves, they are no longer counted.
 */
export function changesRequestedCount(pr: GitHubPR): number {
  let count = 0;
  for (const state of latestReviewByAuthor(pr).values()) {
    if (state === "CHANGES_REQUESTED") count++;
  }
  return count;
}

// ── Review context ────────────────────────────────────────────────

export interface ReviewContext {
  yourReview: string;
  yourReviewAge: string;
}

/**
 * Compute the current user's review relationship to a PR.
 * Returns null if the user has not reviewed this PR.
 */
export function reviewContext(pr: GitHubPR, currentUser: string, now: Date): ReviewContext | null {
  // Find currentUser's latest review (gh returns chronologically, last wins)
  let latestState: string | undefined;
  let latestTime: string | undefined;
  for (const review of pr.reviews ?? []) {
    if (review.author?.login === currentUser) {
      latestState = review.state;
      latestTime = review.submittedAt;
    }
  }

  if (!latestState) return null;

  const stateMap: Record<string, string> = {
    CHANGES_REQUESTED: "changes-requested",
    APPROVED: "approved",
    COMMENTED: "commented",
    DISMISSED: "dismissed",
  };
  const yourReview = stateMap[latestState] ?? latestState.toLowerCase();
  const yourReviewAge = latestTime ? timeAgo(latestTime, now) : "unknown";

  return { yourReview, yourReviewAge };
}

// ── Temporal helpers ──────────────────────────────────────────────

/** Relative time of the most recent commit, or undefined if no commits. */
export function latestCommitAge(pr: GitHubPR, now: Date): string | undefined {
  const commits = pr.commits ?? [];
  if (commits.length === 0) return undefined;
  let latest = commits[0].committedDate;
  for (let i = 1; i < commits.length; i++) {
    if (commits[i].committedDate > latest) latest = commits[i].committedDate;
  }
  return timeAgo(latest, now);
}

/** Relative time of the most recent comment, or undefined if no comments. */
export function latestCommentAge(item: { comments: Array<{ createdAt: string }> }, now: Date): string | undefined {
  if (item.comments.length === 0) return undefined;
  let latest = item.comments[0].createdAt;
  for (let i = 1; i < item.comments.length; i++) {
    if (item.comments[i].createdAt > latest) latest = item.comments[i].createdAt;
  }
  return timeAgo(latest, now);
}
