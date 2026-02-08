import type { GitHubPR } from "../config/types.js";

export function hasLabel(labels: Array<{ name: string }>, keyword: string): boolean {
  return labels.some((l) =>
    l.name.toLowerCase().split(/[:\-_]/).some((seg) => seg === keyword),
  );
}

export function hasExactLabel(labels: Array<{ name: string }>, labelName: string): boolean {
  return labels.some((l) => l.name.toLowerCase() === labelName.toLowerCase());
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

/**
 * Count unique approvals (latest review per author).
 */
export function approvalCount(pr: GitHubPR): number {
  if (!pr.reviews || pr.reviews.length === 0) return 0;
  const latestByAuthor = new Map<string, string>();
  for (const review of pr.reviews) {
    latestByAuthor.set(review.author.login, review.state);
  }
  let count = 0;
  for (const state of latestByAuthor.values()) {
    if (state === "APPROVED") count++;
  }
  return count;
}
