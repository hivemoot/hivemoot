import type {
  GitHubIssue,
  GitHubPR,
  RepoRef,
  RepoSummary,
  SummaryItem,
} from "../config/types.js";
import { generateAlerts } from "./alerts.js";
import { hasLabel, hasExactLabel, daysSince, hasCIFailure, checkStatus, mergeStatus, approvalCount } from "./utils.js";

function timeAgo(dateStr: string, now: Date): string {
  const days = daysSince(dateStr, now);
  if (days === 0) return "today";
  if (days === 1) return "1 day old";
  return `${days} days old`;
}

/** Map verbose check labels to compact values for structured output. */
function compactChecks(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw === "checks failing") return "failing";
  if (raw === "checks pending") return "pending";
  if (raw === "checks passing") return "passing";
  return raw;
}

/** Map verbose merge labels to compact values for structured output. */
function compactMergeable(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw === "has conflicts") return "conflicts";
  if (raw === "no conflicts") return "clean";
  return raw;
}

function classifyIssue(
  issue: GitHubIssue,
  now: Date,
): { bucket: "voteOn" | "discuss" | "implement" | "blocked"; item: SummaryItem } {
  const age = timeAgo(issue.createdAt, now);
  const assigned =
    issue.assignees.length > 0
      ? issue.assignees.map((a) => a.login).join(", ")
      : undefined;

  const tags = issue.labels.map((l) => l.name);
  const author = issue.author.login;
  const comments = issue.comments.length;

  const base: SummaryItem = {
    number: issue.number,
    title: issue.title,
    tags,
    author,
    comments,
    age,
  };

  // Blocked issues are excluded from all actionable buckets
  if (hasLabel(issue.labels, "blocked")) {
    return {
      bucket: "blocked",
      item: { ...base, assigned },
    };
  }

  // Bot governance labels (exact match)
  if (hasExactLabel(issue.labels, "phase:voting") || hasExactLabel(issue.labels, "phase:extended-voting")) {
    return { bucket: "voteOn", item: base };
  }
  if (hasExactLabel(issue.labels, "phase:discussion")) {
    return { bucket: "discuss", item: base };
  }
  if (hasExactLabel(issue.labels, "phase:ready-to-implement")) {
    return { bucket: "implement", item: { ...base, assigned } };
  }

  // Keyword fallback (repos without the bot)
  if (hasLabel(issue.labels, "vote")) {
    return { bucket: "voteOn", item: base };
  }
  if (hasLabel(issue.labels, "discuss")) {
    return { bucket: "discuss", item: base };
  }

  return {
    bucket: "implement",
    item: { ...base, assigned },
  };
}

function classifyPR(
  pr: GitHubPR,
  now: Date,
): { bucket: "reviewPRs" | "addressFeedback"; item: SummaryItem } {
  const age = timeAgo(pr.createdAt, now);
  const tags = pr.labels.map((l) => l.name);
  const author = pr.author.login;
  const comments = pr.comments.length;
  const ciFailing = hasCIFailure(pr);
  const checks = compactChecks(checkStatus(pr));
  const merge = compactMergeable(mergeStatus(pr));
  const approvals = approvalCount(pr);

  if (pr.isDraft || ciFailing || pr.reviewDecision === "CHANGES_REQUESTED") {
    let status: string;
    if (pr.isDraft) status = "draft";
    else if (pr.reviewDecision === "CHANGES_REQUESTED") status = "changes-requested";
    else status = "waiting";

    return {
      bucket: "addressFeedback",
      item: { number: pr.number, title: pr.title, tags, author, comments, age, status, checks, mergeable: merge, approvals },
    };
  }

  const status = pr.reviewDecision === "APPROVED" ? "approved" : "waiting";

  return {
    bucket: "reviewPRs",
    item: { number: pr.number, title: pr.title, tags, author, comments, age, status, checks, mergeable: merge, approvals },
  };
}

function buildCompetitionMap(prs: GitHubPR[], currentUser: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const pr of prs) {
    if (!hasLabel(pr.labels, "implementation")) continue;
    if (pr.author.login === currentUser) continue;
    for (const ref of pr.closingIssuesReferences) {
      map.set(ref.number, (map.get(ref.number) ?? 0) + 1);
    }
  }
  return map;
}

export function buildSummary(
  repo: RepoRef,
  issues: GitHubIssue[],
  prs: GitHubPR[],
  currentUser: string,
  now: Date = new Date(),
): RepoSummary {
  const voteOn: SummaryItem[] = [];
  const discuss: SummaryItem[] = [];
  const implement: SummaryItem[] = [];
  const reviewPRs: SummaryItem[] = [];
  const addressFeedback: SummaryItem[] = [];

  for (const issue of issues) {
    const { bucket, item } = classifyIssue(issue, now);
    if (bucket === "voteOn") voteOn.push(item);
    else if (bucket === "discuss") discuss.push(item);
    else if (bucket === "implement") implement.push(item);
    // "blocked" issues intentionally excluded from all buckets
  }

  // Annotate implement items with competing PR counts
  const competitionMap = buildCompetitionMap(prs, currentUser);
  for (const item of implement) {
    const count = competitionMap.get(item.number) ?? 0;
    if (count > 0) {
      item.competingPRs = count;
    }
  }

  for (const pr of prs) {
    const { bucket, item } = classifyPR(pr, now);
    if (bucket === "reviewPRs") reviewPRs.push(item);
    else addressFeedback.push(item);
  }

  const alerts = generateAlerts(issues, prs, now);

  // Extract authored items into "drive" buckets so the agent knows what it owns
  const driveDiscussion: SummaryItem[] = [];
  const driveImplementation: SummaryItem[] = [];

  const filteredDiscuss = discuss.filter((item) => {
    if (item.author === currentUser) { driveDiscussion.push(item); return false; }
    return true;
  });

  const filteredVoteOn = voteOn.filter((item) => {
    if (item.author === currentUser && item.tags.includes("phase:extended-voting")) {
      driveDiscussion.push(item);
      return false;
    }
    return true;
  });

  const filteredReviewPRs = reviewPRs.filter((item) => {
    if (item.author === currentUser) { driveImplementation.push(item); return false; }
    return true;
  });

  const filteredAddressFeedback = addressFeedback.filter((item) => {
    if (item.author === currentUser) { driveImplementation.push(item); return false; }
    return true;
  });

  return {
    repo,
    currentUser,
    driveDiscussion,
    driveImplementation,
    voteOn: filteredVoteOn,
    discuss: filteredDiscuss,
    implement,
    reviewPRs: filteredReviewPRs,
    addressFeedback: filteredAddressFeedback,
    alerts,
  };
}
