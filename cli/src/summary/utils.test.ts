import { describe, it, expect } from "vitest";
import { hasLabel, hasExactLabel, timeAgo, daysSince, hasCIFailure, checkStatus, mergeStatus, approvalCount, changesRequestedCount, reviewContext, latestCommitAge, latestCommentAge, commentContext, isVotingIssue } from "./utils.js";
import type { GitHubPR } from "../config/types.js";

function makePR(overrides: Partial<GitHubPR> = {}): GitHubPR {
  return {
    number: 1,
    title: "Test PR",
    state: "OPEN",
    author: { login: "alice" },
    labels: [],
    comments: [],
    reviews: [],
    createdAt: "2025-06-01T00:00:00Z",
    updatedAt: "2025-06-01T00:00:00Z",
    url: "https://github.com/test/repo/pull/1",
    isDraft: false,
    reviewDecision: "",
    mergeable: "MERGEABLE",
    statusCheckRollup: [],
    closingIssuesReferences: [],
    commits: [],
    ...overrides,
  };
}

describe("hasLabel()", () => {
  it("returns true when label contains keyword", () => {
    expect(hasLabel([{ name: "discuss" }], "discuss")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(hasLabel([{ name: "VOTE" }], "vote")).toBe(true);
  });

  it("does not match partial segment keywords", () => {
    expect(hasLabel([{ name: "needs-discussion" }], "discuss")).toBe(false);
    expect(hasLabel([{ name: "voting" }], "vote")).toBe(false);
  });

  it("matches exact segment after splitting on separators", () => {
    expect(hasLabel([{ name: "priority:high" }], "priority")).toBe(true);
    expect(hasLabel([{ name: "discuss:api-versioning" }], "discuss")).toBe(true);
    expect(hasLabel([{ name: "vote:auth" }], "vote")).toBe(true);
  });

  it("returns false when no label matches", () => {
    expect(hasLabel([{ name: "bug" }], "vote")).toBe(false);
  });

  it("returns false for empty labels", () => {
    expect(hasLabel([], "vote")).toBe(false);
  });

  it("does not match 'blocked' in 'unblocked'", () => {
    expect(hasLabel([{ name: "unblocked" }], "blocked")).toBe(false);
  });

  it("does not match 'vote' in 'devote'", () => {
    expect(hasLabel([{ name: "devote" }], "vote")).toBe(false);
  });

  it("does not match 'discuss' in 'undiscussed'", () => {
    expect(hasLabel([{ name: "undiscussed" }], "discuss")).toBe(false);
  });
});

describe("hasExactLabel()", () => {
  it("matches exact label name", () => {
    expect(hasExactLabel([{ name: "phase:discussion" }], "phase:discussion")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(hasExactLabel([{ name: "Phase:Discussion" }], "phase:discussion")).toBe(true);
  });

  it("does not match partial labels", () => {
    expect(hasExactLabel([{ name: "phase:discussion" }], "discussion")).toBe(false);
    expect(hasExactLabel([{ name: "phase:discussion" }], "phase")).toBe(false);
  });

  it("returns false for empty labels", () => {
    expect(hasExactLabel([], "phase:discussion")).toBe(false);
  });

  it("matches all governance labels used by the bot", () => {
    expect(hasExactLabel([{ name: "phase:voting" }], "phase:voting")).toBe(true);
    expect(hasExactLabel([{ name: "phase:extended-voting" }], "phase:extended-voting")).toBe(true);
    expect(hasExactLabel([{ name: "phase:ready-to-implement" }], "phase:ready-to-implement")).toBe(true);
    expect(hasExactLabel([{ name: "implementation" }], "implementation")).toBe(true);
    expect(hasExactLabel([{ name: "merge-ready" }], "merge-ready")).toBe(true);
    expect(hasExactLabel([{ name: "stale" }], "stale")).toBe(true);
  });
});

describe("timeAgo()", () => {
  const now = new Date("2025-06-15T12:00:00Z");

  it('returns "just now" for seconds ago', () => {
    expect(timeAgo("2025-06-15T11:59:30Z", now)).toBe("just now");
  });

  it("returns compact minutes for < 60 minutes", () => {
    expect(timeAgo("2025-06-15T11:59:00Z", now)).toBe("1m ago");
    expect(timeAgo("2025-06-15T11:15:00Z", now)).toBe("45m ago");
  });

  it("returns compact hours for exact hours", () => {
    expect(timeAgo("2025-06-15T11:00:00Z", now)).toBe("1h ago");
    expect(timeAgo("2025-06-15T06:00:00Z", now)).toBe("6h ago");
  });

  it("returns hours+minutes for non-exact hours", () => {
    expect(timeAgo("2025-06-15T10:30:00Z", now)).toBe("1h30m ago");
    expect(timeAgo("2025-06-15T08:48:00Z", now)).toBe("3h12m ago");
    expect(timeAgo("2025-06-14T12:15:00Z", now)).toBe("23h45m ago");
  });

  it('returns "yesterday" for 1 day', () => {
    expect(timeAgo("2025-06-14T12:00:00Z", now)).toBe("yesterday");
  });

  it("returns days for < 7 days", () => {
    expect(timeAgo("2025-06-12T12:00:00Z", now)).toBe("3 days ago");
  });

  it('returns "1 week ago" for 7-13 days', () => {
    expect(timeAgo("2025-06-05T12:00:00Z", now)).toBe("1 week ago");
  });

  it("returns weeks for 14-29 days", () => {
    expect(timeAgo("2025-05-25T12:00:00Z", now)).toBe("3 weeks ago");
  });

  it('returns "1 month ago" for 30-59 days', () => {
    expect(timeAgo("2025-05-10T12:00:00Z", now)).toBe("1 month ago");
  });

  it("returns months for 60-364 days", () => {
    expect(timeAgo("2025-01-15T12:00:00Z", now)).toBe("5 months ago");
  });

  it('returns "1 year ago" for 365-729 days', () => {
    expect(timeAgo("2024-06-15T12:00:00Z", now)).toBe("1 year ago");
  });

  it("returns years for > 729 days", () => {
    expect(timeAgo("2022-06-15T12:00:00Z", now)).toBe("3 years ago");
  });

  it('returns "just now" for future dates (clock skew)', () => {
    expect(timeAgo("2025-06-16T12:00:00Z", now)).toBe("just now");
  });
});

describe("daysSince()", () => {
  const now = new Date("2025-06-15T12:00:00Z");

  it("returns correct number of days", () => {
    expect(daysSince("2025-06-12T12:00:00Z", now)).toBe(3);
  });

  it("returns 0 for same day", () => {
    expect(daysSince("2025-06-15T06:00:00Z", now)).toBe(0);
  });

  it("floors partial days", () => {
    expect(daysSince("2025-06-14T18:00:00Z", now)).toBe(0);
  });

  it("returns 0 for future dates (clock skew)", () => {
    expect(daysSince("2025-06-16T12:00:00Z", now)).toBe(0);
    expect(daysSince("2025-06-15T14:00:00Z", now)).toBe(0);
  });
});

describe("hasCIFailure()", () => {
  it("returns true for lowercase failure conclusion", () => {
    const pr = makePR({
      statusCheckRollup: [
        { context: "ci", state: "completed", conclusion: "failure" },
      ],
    });
    expect(hasCIFailure(pr)).toBe(true);
  });

  it("returns true for uppercase FAILURE state", () => {
    const pr = makePR({
      statusCheckRollup: [
        { context: "ci", state: "FAILURE", conclusion: null },
      ],
    });
    expect(hasCIFailure(pr)).toBe(true);
  });

  it("returns false when all checks pass", () => {
    const pr = makePR({
      statusCheckRollup: [
        { context: "ci", state: "SUCCESS", conclusion: "success" },
      ],
    });
    expect(hasCIFailure(pr)).toBe(false);
  });

  it("returns false for empty statusCheckRollup", () => {
    const pr = makePR({ statusCheckRollup: [] });
    expect(hasCIFailure(pr)).toBe(false);
  });

  it("returns false for null statusCheckRollup", () => {
    const pr = makePR({ statusCheckRollup: null });
    expect(hasCIFailure(pr)).toBe(false);
  });

  it("returns false when state is undefined", () => {
    const pr = makePR({
      statusCheckRollup: [
        { context: "ci", state: undefined as unknown as string, conclusion: "success" },
      ],
    });
    expect(hasCIFailure(pr)).toBe(false);
  });

  it("handles mixed-case conclusion", () => {
    const pr = makePR({
      statusCheckRollup: [
        { context: "ci", state: "completed", conclusion: "Failure" },
      ],
    });
    expect(hasCIFailure(pr)).toBe(true);
  });
});

describe("checkStatus()", () => {
  it("returns null for null statusCheckRollup", () => {
    const pr = makePR({ statusCheckRollup: null });
    expect(checkStatus(pr)).toBeNull();
  });

  it("returns null for empty statusCheckRollup", () => {
    const pr = makePR({ statusCheckRollup: [] });
    expect(checkStatus(pr)).toBeNull();
  });

  it("returns 'checks failing' when any check fails", () => {
    const pr = makePR({
      statusCheckRollup: [
        { context: "ci", state: "FAILURE", conclusion: "failure" },
        { context: "lint", state: "SUCCESS", conclusion: "success" },
      ],
    });
    expect(checkStatus(pr)).toBe("checks failing");
  });

  it("returns 'checks pending' when checks are pending", () => {
    const pr = makePR({
      statusCheckRollup: [
        { context: "ci", state: "PENDING", conclusion: null },
      ],
    });
    expect(checkStatus(pr)).toBe("checks pending");
  });

  it("handles lowercase pending states", () => {
    const pr = makePR({
      statusCheckRollup: [
        { context: "ci", state: "pending", conclusion: null },
      ],
    });
    expect(checkStatus(pr)).toBe("checks pending");
  });

  it("returns 'checks passing' when all succeed", () => {
    const pr = makePR({
      statusCheckRollup: [
        { context: "ci", state: "SUCCESS", conclusion: "success" },
      ],
    });
    expect(checkStatus(pr)).toBe("checks passing");
  });
});

describe("mergeStatus()", () => {
  it("returns 'has conflicts' for CONFLICTING", () => {
    const pr = makePR({ mergeable: "CONFLICTING" });
    expect(mergeStatus(pr)).toBe("has conflicts");
  });

  it("returns 'no conflicts' for MERGEABLE", () => {
    const pr = makePR({ mergeable: "MERGEABLE" });
    expect(mergeStatus(pr)).toBe("no conflicts");
  });

  it("returns null for UNKNOWN", () => {
    const pr = makePR({ mergeable: "UNKNOWN" });
    expect(mergeStatus(pr)).toBeNull();
  });
});

describe("approvalCount()", () => {
  it("returns 0 for no reviews", () => {
    const pr = makePR({ reviews: [] });
    expect(approvalCount(pr)).toBe(0);
  });

  it("counts unique approvals", () => {
    const pr = makePR({
      reviews: [
        { state: "APPROVED", author: { login: "alice" } },
        { state: "APPROVED", author: { login: "bob" } },
      ],
    });
    expect(approvalCount(pr)).toBe(2);
  });

  it("uses latest review per author (re-review scenario)", () => {
    const pr = makePR({
      reviews: [
        { state: "APPROVED", author: { login: "alice" } },
        { state: "CHANGES_REQUESTED", author: { login: "alice" } },
      ],
    });
    expect(approvalCount(pr)).toBe(0);
  });

  it("handles re-approval after changes requested", () => {
    const pr = makePR({
      reviews: [
        { state: "CHANGES_REQUESTED", author: { login: "alice" } },
        { state: "APPROVED", author: { login: "alice" } },
      ],
    });
    expect(approvalCount(pr)).toBe(1);
  });

  it("ignores COMMENTED reviews", () => {
    const pr = makePR({
      reviews: [
        { state: "COMMENTED", author: { login: "alice" } },
      ],
    });
    expect(approvalCount(pr)).toBe(0);
  });

  it("handles null author reviews without crashing", () => {
    const pr = makePR({
      reviews: [
        { state: "APPROVED", author: null },
      ],
    });
    expect(approvalCount(pr)).toBe(1);
  });
});

describe("changesRequestedCount()", () => {
  it("returns 0 for no reviews", () => {
    const pr = makePR({ reviews: [] });
    expect(changesRequestedCount(pr)).toBe(0);
  });

  it("counts latest CHANGES_REQUESTED review", () => {
    const pr = makePR({
      reviews: [
        { state: "CHANGES_REQUESTED", author: { login: "alice" } },
      ],
    });
    expect(changesRequestedCount(pr)).toBe(1);
  });

  it("returns 0 when CHANGES_REQUESTED is followed by APPROVED", () => {
    const pr = makePR({
      reviews: [
        { state: "CHANGES_REQUESTED", author: { login: "alice" } },
        { state: "APPROVED", author: { login: "alice" } },
      ],
    });
    expect(changesRequestedCount(pr)).toBe(0);
  });

  it("counts multiple reviewers with outstanding change requests", () => {
    const pr = makePR({
      reviews: [
        { state: "APPROVED", author: { login: "alice" } },
        { state: "CHANGES_REQUESTED", author: { login: "bob" } },
        { state: "CHANGES_REQUESTED", author: { login: "carol" } },
      ],
    });
    expect(changesRequestedCount(pr)).toBe(2);
  });

  it("handles mixed states across multiple reviewers", () => {
    const pr = makePR({
      reviews: [
        { state: "CHANGES_REQUESTED", author: { login: "alice" } },
        { state: "APPROVED", author: { login: "bob" } },
        { state: "APPROVED", author: { login: "alice" } },
        { state: "CHANGES_REQUESTED", author: { login: "bob" } },
      ],
    });
    // alice: CR → APPROVED (latest = APPROVED, not counted)
    // bob: APPROVED → CR (latest = CR, counted)
    expect(changesRequestedCount(pr)).toBe(1);
  });

  it("ignores COMMENTED reviews", () => {
    const pr = makePR({
      reviews: [
        { state: "COMMENTED", author: { login: "alice" } },
      ],
    });
    expect(changesRequestedCount(pr)).toBe(0);
  });

  it("handles null author reviews without crashing", () => {
    const pr = makePR({
      reviews: [
        { state: "CHANGES_REQUESTED", author: null },
      ],
    });
    expect(changesRequestedCount(pr)).toBe(1);
  });
});

// ── reviewContext ────────────────────────────────────────────────────

describe("reviewContext()", () => {
  const now = new Date("2025-06-15T12:00:00Z");

  it("returns null when user has no reviews", () => {
    const pr = makePR({
      reviews: [{ state: "APPROVED", author: { login: "other" }, submittedAt: "2025-06-02T00:00:00Z" }],
    });
    expect(reviewContext(pr, "scout", now)).toBeNull();
  });

  it("returns yourReview and yourReviewAge", () => {
    const pr = makePR({
      reviews: [{ state: "APPROVED", author: { login: "scout" }, submittedAt: "2025-06-14T12:00:00Z" }],
    });
    expect(reviewContext(pr, "scout", now)).toEqual({
      yourReview: "approved",
      yourReviewAge: "yesterday",
    });
  });

  it("returns changes-requested review with age", () => {
    const pr = makePR({
      reviews: [{ state: "CHANGES_REQUESTED", author: { login: "scout" }, submittedAt: "2025-06-12T12:00:00Z" }],
    });
    expect(reviewContext(pr, "scout", now)).toEqual({
      yourReview: "changes-requested",
      yourReviewAge: "3 days ago",
    });
  });

  it("returns 'unknown' age when submittedAt is missing", () => {
    const pr = makePR({
      reviews: [{ state: "APPROVED", author: { login: "scout" } }],
    });
    expect(reviewContext(pr, "scout", now)).toEqual({
      yourReview: "approved",
      yourReviewAge: "unknown",
    });
  });

  it("uses latest review when user has multiple reviews", () => {
    const pr = makePR({
      reviews: [
        { state: "CHANGES_REQUESTED", author: { login: "scout" }, submittedAt: "2025-06-01T00:00:00Z" },
        { state: "APPROVED", author: { login: "scout" }, submittedAt: "2025-06-14T12:00:00Z" },
      ],
    });
    expect(reviewContext(pr, "scout", now)).toEqual({
      yourReview: "approved",
      yourReviewAge: "yesterday",
    });
  });

  it("maps DISMISSED state correctly", () => {
    const pr = makePR({
      reviews: [{ state: "DISMISSED", author: { login: "scout" }, submittedAt: "2025-06-14T12:00:00Z" }],
    });
    expect(reviewContext(pr, "scout", now)).toEqual({
      yourReview: "dismissed",
      yourReviewAge: "yesterday",
    });
  });

  it("maps COMMENTED state correctly", () => {
    const pr = makePR({
      reviews: [{ state: "COMMENTED", author: { login: "scout" }, submittedAt: "2025-06-15T11:00:00Z" }],
    });
    expect(reviewContext(pr, "scout", now)).toEqual({
      yourReview: "commented",
      yourReviewAge: "1h ago",
    });
  });
});

// ── latestCommitAge ──────────────────────────────────────────────────

describe("latestCommitAge()", () => {
  const now = new Date("2025-06-15T12:00:00Z");

  it("returns undefined when no commits", () => {
    const pr = makePR({ commits: [] });
    expect(latestCommitAge(pr, now)).toBeUndefined();
  });

  it("returns age of single commit", () => {
    const pr = makePR({ commits: [{ committedDate: "2025-06-15T10:00:00Z" }] });
    expect(latestCommitAge(pr, now)).toBe("2h ago");
  });

  it("picks the latest commit from multiple", () => {
    const pr = makePR({
      commits: [
        { committedDate: "2025-06-13T00:00:00Z" },
        { committedDate: "2025-06-15T11:00:00Z" },
        { committedDate: "2025-06-14T00:00:00Z" },
      ],
    });
    expect(latestCommitAge(pr, now)).toBe("1h ago");
  });
});

// ── latestCommentAge ──────────────────────────────────────────────────

describe("latestCommentAge()", () => {
  const now = new Date("2025-06-15T12:00:00Z");

  it("returns undefined when no comments", () => {
    const pr = makePR({ comments: [] });
    expect(latestCommentAge(pr, now)).toBeUndefined();
  });

  it("returns age of single comment", () => {
    const pr = makePR({ comments: [{ createdAt: "2025-06-15T07:00:00Z" }] });
    expect(latestCommentAge(pr, now)).toBe("5h ago");
  });

  it("picks the latest comment from multiple", () => {
    const pr = makePR({
      comments: [
        { createdAt: "2025-06-12T00:00:00Z" },
        { createdAt: "2025-06-15T11:30:00Z" },
        { createdAt: "2025-06-14T00:00:00Z" },
      ],
    });
    expect(latestCommentAge(pr, now)).toBe("30m ago");
  });
});

// ── commentContext ──────────────────────────────────────────────────

describe("commentContext()", () => {
  const now = new Date("2025-06-15T12:00:00Z");

  it("returns null when no comments exist", () => {
    const item = { comments: [] as Array<{ createdAt: string; author: { login: string } | null }> };
    expect(commentContext(item, "scout", now)).toBeNull();
  });

  it("returns null when user has not commented", () => {
    const item = {
      comments: [
        { createdAt: "2025-06-14T00:00:00Z", author: { login: "other" } },
      ],
    };
    expect(commentContext(item, "scout", now)).toBeNull();
  });

  it("returns yourComment and yourCommentAge for user's comment", () => {
    const item = {
      comments: [
        { createdAt: "2025-06-15T09:00:00Z", author: { login: "scout" } },
      ],
    };
    expect(commentContext(item, "scout", now)).toEqual({
      yourComment: "commented",
      yourCommentAge: "3h ago",
    });
  });

  it("picks the latest comment when user has multiple", () => {
    const item = {
      comments: [
        { createdAt: "2025-06-13T00:00:00Z", author: { login: "scout" } },
        { createdAt: "2025-06-15T11:00:00Z", author: { login: "scout" } },
        { createdAt: "2025-06-14T00:00:00Z", author: { login: "scout" } },
      ],
    };
    expect(commentContext(item, "scout", now)).toEqual({
      yourComment: "commented",
      yourCommentAge: "1h ago",
    });
  });

  it("handles null author without crashing", () => {
    const item = {
      comments: [
        { createdAt: "2025-06-14T00:00:00Z", author: null },
      ],
    };
    expect(commentContext(item, "scout", now)).toBeNull();
  });

  it("ignores other users' comments", () => {
    const item = {
      comments: [
        { createdAt: "2025-06-15T11:00:00Z", author: { login: "alice" } },
        { createdAt: "2025-06-14T00:00:00Z", author: { login: "scout" } },
        { createdAt: "2025-06-15T11:30:00Z", author: { login: "bob" } },
      ],
    };
    expect(commentContext(item, "scout", now)).toEqual({
      yourComment: "commented",
      yourCommentAge: "yesterday",
    });
  });
});

// ── isVotingIssue ──────────────────────────────────────────────────

describe("isVotingIssue()", () => {
  it("returns true for phase:voting label", () => {
    expect(isVotingIssue([{ name: "phase:voting" }])).toBe(true);
  });

  it("returns true for phase:extended-voting label", () => {
    expect(isVotingIssue([{ name: "phase:extended-voting" }])).toBe(true);
  });

  it("returns true for vote keyword label", () => {
    expect(isVotingIssue([{ name: "vote" }])).toBe(true);
  });

  it("returns true for vote:topic keyword label", () => {
    expect(isVotingIssue([{ name: "vote:auth" }])).toBe(true);
  });

  it("returns false for non-voting labels", () => {
    expect(isVotingIssue([{ name: "discuss" }, { name: "bug" }])).toBe(false);
  });

  it("returns false for empty labels", () => {
    expect(isVotingIssue([])).toBe(false);
  });

  it("returns false for phase:discussion", () => {
    expect(isVotingIssue([{ name: "phase:discussion" }])).toBe(false);
  });
});
