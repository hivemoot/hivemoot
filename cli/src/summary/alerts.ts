import type { GitHubIssue, GitHubPR, Alert } from "../config/types.js";
import { hasLabel, hasExactLabel, daysSince, hasCIFailure } from "./utils.js";

const STALE_DISCUSSION_DAYS = 3;
const PR_WAITING_REVIEW_DAYS = 2;

function lastCommentDate(issue: GitHubIssue): string | null {
  if (issue.comments.length === 0) return null;
  return issue.comments.reduce((latest, c) =>
    c.createdAt > latest.createdAt ? c : latest,
  ).createdAt;
}

export function generateAlerts(
  issues: GitHubIssue[],
  prs: GitHubPR[],
  now: Date = new Date(),
): Alert[] {
  const alerts: Alert[] = [];

  // Stale discussions: discuss-labeled issues with no recent comments
  for (const issue of issues) {
    if (!hasLabel(issue.labels, "discuss") && !hasExactLabel(issue.labels, "phase:discussion")) continue;
    const lastComment = lastCommentDate(issue);
    const referenceDate = lastComment ?? issue.createdAt;
    const days = daysSince(referenceDate, now);
    if (days >= STALE_DISCUSSION_DAYS) {
      alerts.push({
        icon: "\u26a0\ufe0f",
        message: `#${issue.number} in discussion ${days} days, no recent comments`,
      });
    }
  }

  // Issues needing human attention
  for (const issue of issues) {
    if (hasExactLabel(issue.labels, "needs:human")) {
      alerts.push({
        icon: "\ud83d\uded1",
        message: `#${issue.number} needs human attention`,
      });
    }
  }

  // Only PRs in the governance intake (with "implementation" label) generate attention items
  const intakePRs = prs.filter((pr) => hasExactLabel(pr.labels, "implementation"));

  // PRs waiting on review too long (skip approved/changes-requested/drafts)
  for (const pr of intakePRs) {
    if (pr.isDraft) continue;
    if (pr.reviewDecision === "APPROVED" || pr.reviewDecision === "CHANGES_REQUESTED") continue;
    const days = daysSince(pr.createdAt, now);
    if (days >= PR_WAITING_REVIEW_DAYS) {
      alerts.push({
        icon: "\u26a0\ufe0f",
        message: `PR #${pr.number} waiting on review ${days} days`,
      });
    }
  }

  // CI failures on non-draft PRs
  for (const pr of intakePRs) {
    if (pr.isDraft) continue;
    if (hasCIFailure(pr)) {
      alerts.push({
        icon: "\u26a0\ufe0f",
        message: `PR #${pr.number} has CI failures`,
      });
    }
  }

  return alerts;
}
