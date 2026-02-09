import type {
  GitHubIssue,
  GitHubPR,
  RepoRef,
  RepoSummary,
  SummaryItem,
} from "../config/types.js";
import type { VoteMap } from "../github/votes.js";
import type { NotificationMap } from "../github/notifications.js";
import { hasLabel, hasExactLabel, hasCIFailure, checkStatus, mergeStatus, approvalCount, changesRequestedCount, timeAgo, reviewContext, latestCommitAge, latestCommentAge, commentContext } from "./utils.js";

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
  currentUser: string,
  now: Date,
): { bucket: "voteOn" | "discuss" | "implement" | "needsHuman"; item: SummaryItem } {
  const age = timeAgo(issue.createdAt, now);
  const assigned =
    issue.assignees.length > 0
      ? issue.assignees.map((a) => a.login).join(", ")
      : undefined;

  const tags = issue.labels.map((l) => l.name);
  const author = issue.author?.login ?? "ghost";
  const comments = issue.comments.length;

  const base: SummaryItem = {
    number: issue.number,
    title: issue.title,
    tags,
    author,
    comments,
    age,
    lastComment: latestCommentAge(issue, now),
    updated: timeAgo(issue.updatedAt, now),
  };

  // Populate comment context for the current user
  if (currentUser) {
    const ctx = commentContext(issue, currentUser, now);
    if (ctx) {
      base.yourComment = ctx.yourComment;
      base.yourCommentAge = ctx.yourCommentAge;
    }
  }

  // Issues needing human attention are excluded from all actionable buckets
  if (hasExactLabel(issue.labels, "needs:human")) {
    return {
      bucket: "needsHuman",
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
  const author = pr.author?.login ?? "ghost";
  const comments = pr.comments.length;
  const ciFailing = hasCIFailure(pr);
  const checks = compactChecks(checkStatus(pr));
  const merge = compactMergeable(mergeStatus(pr));
  const review = {
    approvals: approvalCount(pr),
    changesRequested: changesRequestedCount(pr),
  };

  if (pr.isDraft || ciFailing || pr.reviewDecision === "CHANGES_REQUESTED" || changesRequestedCount(pr) > 0) {
    let status: string;
    if (pr.isDraft) status = "draft";
    else if (pr.reviewDecision === "CHANGES_REQUESTED" || changesRequestedCount(pr) > 0) status = "changes-requested";
    else status = "pending";

    return {
      bucket: "addressFeedback",
      item: { number: pr.number, title: pr.title, tags, author, comments, age, status, checks, mergeable: merge, review },
    };
  }

  const status = pr.reviewDecision === "APPROVED" ? "approved" : "pending";

  return {
    bucket: "reviewPRs",
    item: { number: pr.number, title: pr.title, tags, author, comments, age, status, checks, mergeable: merge, review },
  };
}

function buildCompetitionMap(prs: GitHubPR[], currentUser: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const pr of prs) {
    if (!hasLabel(pr.labels, "implementation")) continue;
    if (pr.author?.login === currentUser) continue;
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
  votes: VoteMap = new Map(),
  notifications: NotificationMap = new Map(),
): RepoSummary {
  const needsHuman: SummaryItem[] = [];
  const voteOn: SummaryItem[] = [];
  const discuss: SummaryItem[] = [];
  const implement: SummaryItem[] = [];
  const reviewPRs: SummaryItem[] = [];
  const addressFeedback: SummaryItem[] = [];

  for (const issue of issues) {
    const { bucket, item } = classifyIssue(issue, currentUser, now);
    if (bucket === "needsHuman") needsHuman.push(item);
    else if (bucket === "voteOn") voteOn.push(item);
    else if (bucket === "discuss") discuss.push(item);
    else if (bucket === "implement") implement.push(item);
  }

  // Annotate voting items with vote reactions from the votes map
  for (const item of voteOn) {
    const vote = votes.get(item.number);
    if (vote) {
      item.yourVote = vote.reaction;
      item.yourVoteAge = timeAgo(vote.createdAt, now);
    }
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
    const ctx = reviewContext(pr, currentUser, now);
    if (ctx) {
      item.yourReview = ctx.yourReview;
      item.yourReviewAge = ctx.yourReviewAge;
    }
    item.lastCommit = latestCommitAge(pr, now);
    item.lastComment = latestCommentAge(pr, now);
    item.updated = timeAgo(pr.updatedAt, now);
    if (bucket === "reviewPRs") reviewPRs.push(item);
    else addressFeedback.push(item);
  }

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

  // Annotate all items with unread notification status
  const allItems = [
    ...needsHuman,
    ...driveDiscussion,
    ...driveImplementation,
    ...filteredVoteOn,
    ...filteredDiscuss,
    ...implement,
    ...filteredReviewPRs,
    ...filteredAddressFeedback,
  ];
  for (const item of allItems) {
    const n = notifications.get(item.number);
    if (n) {
      item.unread = true;
      item.unreadReason = n.reason;
      item.unreadAge = timeAgo(n.updatedAt, now);
    }
  }

  return {
    repo,
    currentUser,
    needsHuman,
    driveDiscussion,
    driveImplementation,
    voteOn: filteredVoteOn,
    discuss: filteredDiscuss,
    implement,
    reviewPRs: filteredReviewPRs,
    addressFeedback: filteredAddressFeedback,
    notes: [],
  };
}
