import { describe, it, expect } from "vitest";
import { buildSummary } from "./builder.js";
import type { GitHubIssue, GitHubPR, RepoRef } from "../config/types.js";

const repo: RepoRef = { owner: "hivemoot", repo: "colony" };
const now = new Date("2025-06-15T12:00:00Z");

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 1,
    title: "Test issue",
    labels: [{ name: "phase:ready-to-implement" }],
    assignees: [],
    author: { login: "alice" },
    comments: [],
    createdAt: "2025-06-12T12:00:00Z",
    updatedAt: "2025-06-12T12:00:00Z",
    url: "https://github.com/hivemoot/colony/issues/1",
    ...overrides,
  };
}

function makePR(overrides: Partial<GitHubPR> = {}): GitHubPR {
  return {
    number: 10,
    title: "Test PR",
    state: "OPEN",
    author: { login: "bob" },
    labels: [],
    comments: [],
    reviews: [],
    createdAt: "2025-06-13T12:00:00Z",
    updatedAt: "2025-06-13T12:00:00Z",
    url: "https://github.com/hivemoot/colony/pull/10",
    isDraft: false,
    reviewDecision: "",
    mergeable: "MERGEABLE",
    statusCheckRollup: [],
    closingIssuesReferences: [],
    commits: [],
    ...overrides,
  };
}

describe("buildSummary()", () => {
  it("classifies vote-labeled issues into voteOn bucket", () => {
    const issue = makeIssue({
      number: 50,
      title: "Auth redesign",
      labels: [{ name: "vote" }],
      comments: [{ createdAt: "2025-06-13T00:00:00Z", author: { login: "bot" } }, { createdAt: "2025-06-14T00:00:00Z", author: { login: "bot" } }],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.voteOn).toHaveLength(1);
    expect(summary.voteOn[0].number).toBe(50);
    expect(summary.voteOn[0].comments).toBe(2);
    expect(summary.voteOn[0].tags).toEqual(["vote"]);
    expect(summary.discuss).toHaveLength(0);
    expect(summary.implement).toHaveLength(0);
  });

  it("classifies discuss-labeled issues into discuss bucket", () => {
    const issue = makeIssue({
      number: 52,
      title: "API versioning",
      labels: [{ name: "discuss" }],
      comments: [{ createdAt: "2025-06-13T00:00:00Z", author: { login: "bot" } }],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.discuss).toHaveLength(1);
    expect(summary.discuss[0].number).toBe(52);
    expect(summary.discuss[0].comments).toBe(1);
  });

  it("classifies unlabeled issues into unclassified bucket with empty tags", () => {
    const issue = makeIssue({
      number: 45,
      title: "User Dashboard",
      labels: [],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.unclassified).toHaveLength(1);
    expect(summary.unclassified![0].number).toBe(45);
    expect(summary.unclassified![0].assigned).toBeUndefined();
    expect(summary.unclassified![0].age).toBe("3 days ago");
    expect(summary.unclassified![0].tags).toEqual([]);
  });

  it("includes canonical URL on issue summary items", () => {
    const issue = makeIssue({ number: 45, url: "https://github.com/hivemoot/colony/issues/45" });
    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.implement[0].url).toBe("https://github.com/hivemoot/colony/issues/45");
  });

  it("shows assignee names in implement item", () => {
    const issue = makeIssue({
      assignees: [{ login: "alice" }],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.implement[0].assigned).toBe("alice");
  });

  it("classifies normal PRs into reviewPRs bucket", () => {
    const pr = makePR({ number: 49, title: "Search", url: "https://github.com/hivemoot/colony/pull/49" });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.reviewPRs).toHaveLength(1);
    expect(summary.reviewPRs[0].number).toBe(49);
    expect(summary.reviewPRs[0].status).toBe("pending");
    expect(summary.reviewPRs[0].url).toBe("https://github.com/hivemoot/colony/pull/49");
  });

  it("classifies approved PRs correctly", () => {
    const pr = makePR({ reviewDecision: "APPROVED" });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.reviewPRs).toHaveLength(1);
    expect(summary.reviewPRs[0].status).toBe("approved");
  });

  it("classifies draft PRs into addressFeedback", () => {
    const pr = makePR({ isDraft: true });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.addressFeedback).toHaveLength(1);
    expect(summary.addressFeedback[0].status).toBe("draft");
  });

  it("classifies PRs with CI failures into addressFeedback", () => {
    const pr = makePR({
      statusCheckRollup: [
        { context: "ci", state: "FAILURE", conclusion: "failure" },
      ],
    });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.addressFeedback).toHaveLength(1);
    expect(summary.addressFeedback[0].checks).toBe("failing");
  });

  it("classifies PRs with changes requested into addressFeedback", () => {
    const pr = makePR({ reviewDecision: "CHANGES_REQUESTED" });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.addressFeedback).toHaveLength(1);
    expect(summary.addressFeedback[0].status).toBe("changes-requested");
  });

  it("classifies PR with individual CHANGES_REQUESTED review but no reviewDecision into addressFeedback", () => {
    const pr = makePR({
      number: 150,
      reviewDecision: "",
      reviews: [
        { state: "APPROVED", author: { login: "reviewer-a" } },
        { state: "CHANGES_REQUESTED", author: { login: "reviewer-b" } },
      ],
    });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.addressFeedback).toHaveLength(1);
    expect(summary.addressFeedback[0].number).toBe(150);
    expect(summary.addressFeedback[0].status).toBe("changes-requested");
    expect(summary.addressFeedback[0].review).toEqual({ approvals: 1, changesRequested: 1 });
    expect(summary.reviewPRs).toHaveLength(0);
  });

  it("includes all labels as tags on issues", () => {
    const issue = makeIssue({
      labels: [{ name: "vote" }, { name: "security" }, { name: "breaking-change" }],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.voteOn[0].tags).toEqual(["vote", "security", "breaking-change"]);
  });

  it("includes all labels as tags on PRs", () => {
    const pr = makePR({
      labels: [{ name: "feature" }, { name: "frontend" }],
    });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.reviewPRs[0].tags).toEqual(["feature", "frontend"]);
  });

  it("returns empty buckets when no issues or PRs", () => {
    const summary = buildSummary(repo, [], [], "testuser", now);
    expect(summary.voteOn).toHaveLength(0);
    expect(summary.discuss).toHaveLength(0);
    expect(summary.implement).toHaveLength(0);
    expect(summary.reviewPRs).toHaveLength(0);
    expect(summary.addressFeedback).toHaveLength(0);
  });

  it("includes repo ref in summary", () => {
    const summary = buildSummary(repo, [], [], "testuser", now);
    expect(summary.repo).toEqual(repo);
  });

  it("shows relative time for issues created today", () => {
    const issue = makeIssue({ createdAt: "2025-06-15T06:00:00Z" });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.implement[0].age).toBe("6h ago");
  });

  it("handles PRs with null statusCheckRollup without crashing", () => {
    const pr = makePR({
      number: 99,
      statusCheckRollup: null,
    });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.reviewPRs).toHaveLength(1);
    expect(summary.reviewPRs[0].number).toBe(99);
  });

  it("classifies PR with null statusCheckRollup and draft into addressFeedback", () => {
    const pr = makePR({
      isDraft: true,
      statusCheckRollup: null,
    });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.addressFeedback).toHaveLength(1);
    expect(summary.addressFeedback[0].status).toBe("draft");
  });

  // ── Bot governance label classification ──────────────────────────

  it("classifies phase:voting issues into voteOn bucket", () => {
    const issue = makeIssue({
      number: 60,
      labels: [{ name: "phase:voting" }],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.voteOn).toHaveLength(1);
    expect(summary.voteOn[0].number).toBe(60);
  });

  it("classifies phase:extended-voting issues into voteOn bucket", () => {
    const issue = makeIssue({
      number: 61,
      labels: [{ name: "phase:extended-voting" }],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.voteOn).toHaveLength(1);
    expect(summary.voteOn[0].number).toBe(61);
  });

  it("classifies phase:discussion issues into discuss bucket", () => {
    const issue = makeIssue({
      number: 62,
      labels: [{ name: "phase:discussion" }],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.discuss).toHaveLength(1);
    expect(summary.discuss[0].number).toBe(62);
  });

  it("classifies phase:ready-to-implement issues into implement bucket", () => {
    const issue = makeIssue({
      number: 63,
      labels: [{ name: "phase:ready-to-implement" }],
      assignees: [{ login: "alice" }],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.implement).toHaveLength(1);
    expect(summary.implement[0].assigned).toBe("alice");
  });

  it("bot labels take priority over keyword fallback", () => {
    const issue = makeIssue({
      number: 64,
      labels: [{ name: "phase:discussion" }, { name: "vote:auth" }],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.discuss).toHaveLength(1);
    expect(summary.voteOn).toHaveLength(0);
  });

  // ── Needs-human issue filtering ────────────────────────────────────

  it("excludes needs:human issues from implement bucket", () => {
    const issue = makeIssue({
      number: 77,
      labels: [{ name: "needs:human" }],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.implement).toHaveLength(0);
    expect(summary.voteOn).toHaveLength(0);
    expect(summary.discuss).toHaveLength(0);
  });

  it("excludes needs:human issues even with other labels present", () => {
    const issue = makeIssue({
      number: 78,
      labels: [{ name: "bug" }, { name: "needs:human" }],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.implement).toHaveLength(0);
  });

  it("excludes needs:human issues from voteOn even with vote label", () => {
    const issue = makeIssue({
      number: 79,
      labels: [{ name: "vote" }, { name: "needs:human" }],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.voteOn).toHaveLength(0);
    expect(summary.implement).toHaveLength(0);
  });

  it("excludes needs:human issues from discuss even with discuss label", () => {
    const issue = makeIssue({
      number: 80,
      labels: [{ name: "discuss" }, { name: "needs:human" }],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.discuss).toHaveLength(0);
    expect(summary.implement).toHaveLength(0);
  });

  // ── PR competition count ───────────────────────────────────────────

  it("sets competingPRs on implement item", () => {
    const issue = makeIssue({ number: 45, title: "User Dashboard" });
    const pr = makePR({
      number: 100,
      labels: [{ name: "implementation" }],
      closingIssuesReferences: [{ number: 45 }],
    });

    const summary = buildSummary(repo, [issue], [pr], "testuser", now);
    expect(summary.implement).toHaveLength(1);
    expect(summary.implement[0].competingPRs).toBe(1);
  });

  it("counts multiple competing PRs for same issue", () => {
    const issue = makeIssue({ number: 45, title: "User Dashboard" });
    const pr1 = makePR({
      number: 100,
      labels: [{ name: "implementation" }],
      closingIssuesReferences: [{ number: 45 }],
    });
    const pr2 = makePR({
      number: 101,
      labels: [{ name: "implementation" }],
      closingIssuesReferences: [{ number: 45 }],
    });

    const summary = buildSummary(repo, [issue], [pr1, pr2], "testuser", now);
    expect(summary.implement[0].competingPRs).toBe(2);
  });

  it("does not set competingPRs when no competing PRs exist", () => {
    const issue = makeIssue({ number: 45, title: "User Dashboard" });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.implement[0].competingPRs).toBeUndefined();
  });

  it("does not count current user's own PRs in competition", () => {
    const issue = makeIssue({ number: 45, title: "User Dashboard" });
    const pr = makePR({
      number: 100,
      author: { login: "testuser" },
      labels: [{ name: "implementation" }],
      closingIssuesReferences: [{ number: 45 }],
    });

    const summary = buildSummary(repo, [issue], [pr], "testuser", now);
    expect(summary.implement[0].competingPRs).toBeUndefined();
  });

  it("does not compute competition when current user is unknown", () => {
    const issue = makeIssue({ number: 45, title: "User Dashboard" });
    const pr = makePR({
      number: 100,
      labels: [{ name: "implementation" }],
      closingIssuesReferences: [{ number: 45 }],
      author: { login: "someone" },
    });

    const summary = buildSummary(repo, [issue], [pr], "", now);
    expect(summary.implement[0].competingPRs).toBeUndefined();
  });

  it("ignores PRs without implementation label for competition count", () => {
    const issue = makeIssue({ number: 45, title: "User Dashboard" });
    const pr = makePR({
      number: 100,
      labels: [{ name: "bugfix" }],
      closingIssuesReferences: [{ number: 45 }],
    });

    const summary = buildSummary(repo, [issue], [pr], "testuser", now);
    expect(summary.implement[0].competingPRs).toBeUndefined();
  });

  it("counts competition independently per issue", () => {
    const issue1 = makeIssue({ number: 45, title: "Dashboard" });
    const issue2 = makeIssue({ number: 46, title: "Notifications" });
    const pr1 = makePR({
      number: 100,
      labels: [{ name: "implementation" }],
      closingIssuesReferences: [{ number: 45 }],
    });
    const pr2 = makePR({
      number: 101,
      labels: [{ name: "implementation" }],
      closingIssuesReferences: [{ number: 45 }, { number: 46 }],
    });

    const summary = buildSummary(repo, [issue1, issue2], [pr1, pr2], "testuser", now);
    expect(summary.implement[0].competingPRs).toBe(2);
    expect(summary.implement[1].competingPRs).toBe(1);
  });

  // ── Structured PR fields ──────────────────────────────────────────

  it("populates compact check/merge/review fields on review PRs", () => {
    const pr = makePR({
      number: 49,
      mergeable: "MERGEABLE",
      statusCheckRollup: [
        { context: "ci", state: "SUCCESS", conclusion: "success" },
      ],
      reviews: [{ state: "APPROVED", author: { login: "reviewer" } }],
      reviewDecision: "APPROVED",
    });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    const item = summary.reviewPRs[0];
    expect(item.status).toBe("approved");
    expect(item.checks).toBe("passing");
    expect(item.mergeable).toBe("clean");
    expect(item.review).toEqual({ approvals: 1, changesRequested: 0 });
  });

  it("populates null checks when no statusCheckRollup", () => {
    const pr = makePR({ statusCheckRollup: null });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.reviewPRs[0].checks).toBeNull();
  });

  it("sets mergeable to conflicts for conflicting PRs", () => {
    const pr = makePR({ mergeable: "CONFLICTING" });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.reviewPRs[0].mergeable).toBe("conflicts");
  });

  // ── DRIVE THE DISCUSSION extraction ─────────────────────────────

  it("moves authored discuss issues to driveDiscussion", () => {
    const issue = makeIssue({
      number: 52,
      labels: [{ name: "discuss" }],
      author: { login: "testuser" },
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.driveDiscussion).toHaveLength(1);
    expect(summary.driveDiscussion[0].number).toBe(52);
    expect(summary.discuss).toHaveLength(0);
  });

  it("keeps non-authored discuss issues in discuss", () => {
    const issue = makeIssue({
      number: 52,
      labels: [{ name: "discuss" }],
      author: { login: "other" },
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.discuss).toHaveLength(1);
    expect(summary.driveDiscussion).toHaveLength(0);
  });

  it("moves authored phase:extended-voting issues to driveDiscussion", () => {
    const issue = makeIssue({
      number: 61,
      labels: [{ name: "phase:extended-voting" }],
      author: { login: "testuser" },
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.driveDiscussion).toHaveLength(1);
    expect(summary.driveDiscussion[0].number).toBe(61);
    expect(summary.voteOn).toHaveLength(0);
  });

  it("keeps authored phase:voting issues in voteOn (only extended moves)", () => {
    const issue = makeIssue({
      number: 60,
      labels: [{ name: "phase:voting" }],
      author: { login: "testuser" },
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.voteOn).toHaveLength(1);
    expect(summary.driveDiscussion).toHaveLength(0);
  });

  // ── DRIVE THE IMPLEMENTATION extraction ─────────────────────────

  it("moves authored PRs from reviewPRs to driveImplementation", () => {
    const pr = makePR({
      number: 49,
      author: { login: "testuser" },
    });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.driveImplementation).toHaveLength(1);
    expect(summary.driveImplementation[0].number).toBe(49);
    expect(summary.reviewPRs).toHaveLength(0);
  });

  it("moves authored PRs from addressFeedback to driveImplementation", () => {
    const pr = makePR({
      number: 53,
      author: { login: "testuser" },
      isDraft: true,
    });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.driveImplementation).toHaveLength(1);
    expect(summary.driveImplementation[0].number).toBe(53);
    expect(summary.addressFeedback).toHaveLength(0);
  });

  it("keeps non-authored PRs in reviewPRs", () => {
    const pr = makePR({
      number: 49,
      author: { login: "other" },
    });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.reviewPRs).toHaveLength(1);
    expect(summary.driveImplementation).toHaveLength(0);
  });

  it("keeps non-authored PRs in addressFeedback", () => {
    const pr = makePR({
      number: 53,
      author: { login: "other" },
      isDraft: true,
    });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.addressFeedback).toHaveLength(1);
    expect(summary.driveImplementation).toHaveLength(0);
  });

  // ── Null author handling ──────────────────────────────────────────

  it("classifyIssue with null author uses 'ghost'", () => {
    const issue = makeIssue({ number: 90, author: null });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.implement).toHaveLength(1);
    expect(summary.implement[0].author).toBe("ghost");
  });

  it("classifyPR with null author uses 'ghost'", () => {
    const pr = makePR({ number: 91, author: null });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.reviewPRs).toHaveLength(1);
    expect(summary.reviewPRs[0].author).toBe("ghost");
  });

  it("buildCompetitionMap with null author PR counts as competition", () => {
    const issue = makeIssue({ number: 45, title: "Dashboard" });
    const pr = makePR({
      number: 100,
      author: null,
      labels: [{ name: "implementation" }],
      closingIssuesReferences: [{ number: 45 }],
    });

    const summary = buildSummary(repo, [issue], [pr], "testuser", now);
    expect(summary.implement[0].competingPRs).toBe(1);
  });

  // ── Notes field ───────────────────────────────────────────────────

  it("initializes notes as empty array", () => {
    const summary = buildSummary(repo, [], [], "testuser", now);
    expect(summary.notes).toEqual([]);
  });

  // ── Review context fields ──────────────────────────────────────────

  it("populates yourReview and yourReviewAge on reviewPRs when currentUser has reviewed", () => {
    const pr = makePR({
      number: 150,
      reviews: [
        { state: "APPROVED", author: { login: "testuser" }, submittedAt: "2025-06-14T00:00:00Z" },
      ],
      commits: [{ committedDate: "2025-06-14T12:00:00Z" }],
      reviewDecision: "APPROVED",
    });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.reviewPRs).toHaveLength(1);
    expect(summary.reviewPRs[0].yourReview).toBe("approved");
    expect(summary.reviewPRs[0].yourReviewAge).toBe("yesterday");
  });

  it("does not set yourReview when currentUser has NOT reviewed the PR", () => {
    const pr = makePR({
      number: 151,
      reviews: [
        { state: "APPROVED", author: { login: "other" }, submittedAt: "2025-06-14T00:00:00Z" },
      ],
    });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.reviewPRs).toHaveLength(1);
    expect(summary.reviewPRs[0].yourReview).toBeUndefined();
    expect(summary.reviewPRs[0].yourReviewAge).toBeUndefined();
  });

  it("populates review context on addressFeedback items too", () => {
    const pr = makePR({
      number: 152,
      reviewDecision: "CHANGES_REQUESTED",
      reviews: [
        { state: "CHANGES_REQUESTED", author: { login: "testuser" }, submittedAt: "2025-06-13T00:00:00Z" },
      ],
      commits: [{ committedDate: "2025-06-14T00:00:00Z" }],
    });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.addressFeedback).toHaveLength(1);
    expect(summary.addressFeedback[0].yourReview).toBe("changes-requested");
    expect(summary.addressFeedback[0].yourReviewAge).toBe("2 days ago");
  });

  // ── Temporal fields on issue items ──────────────────────────────────

  it("populates lastComment and updated on issue items", () => {
    const issue = makeIssue({
      number: 170,
      labels: [{ name: "discuss" }],
      comments: [{ createdAt: "2025-06-15T07:00:00Z", author: { login: "bot" } }],
      updatedAt: "2025-06-15T11:30:00Z",
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.discuss[0].lastComment).toBe("5h ago");
    expect(summary.discuss[0].updated).toBe("30m ago");
  });

  it("sets lastComment to undefined on issues with no comments", () => {
    const issue = makeIssue({ number: 171, comments: [] });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.implement[0].lastComment).toBeUndefined();
    expect(summary.implement[0].updated).toBeDefined();
  });

  it("populates temporal fields on vote issues", () => {
    const issue = makeIssue({
      number: 172,
      labels: [{ name: "phase:voting" }],
      comments: [
        { createdAt: "2025-06-13T00:00:00Z", author: { login: "bot" } },
        { createdAt: "2025-06-15T10:00:00Z", author: { login: "bot" } },
      ],
      updatedAt: "2025-06-15T10:00:00Z",
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.voteOn[0].lastComment).toBe("2h ago");
    expect(summary.voteOn[0].updated).toBe("2h ago");
  });

  it("populates temporal fields on implement issues", () => {
    const issue = makeIssue({
      number: 173,
      comments: [{ createdAt: "2025-06-14T12:00:00Z", author: { login: "bot" } }],
      updatedAt: "2025-06-15T06:00:00Z",
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.implement[0].lastComment).toBe("yesterday");
    expect(summary.implement[0].updated).toBe("6h ago");
  });

  // ── Temporal fields on PR items ────────────────────────────────────

  it("populates lastCommit, lastComment, and updated on all PR items", () => {
    const pr = makePR({
      number: 160,
      commits: [{ committedDate: "2025-06-15T10:00:00Z" }],
      comments: [{ createdAt: "2025-06-15T07:00:00Z" }],
      updatedAt: "2025-06-15T11:30:00Z",
    });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.reviewPRs[0].lastCommit).toBe("2h ago");
    expect(summary.reviewPRs[0].lastComment).toBe("5h ago");
    expect(summary.reviewPRs[0].updated).toBe("30m ago");
  });

  it("sets lastCommit to undefined when PR has no commits", () => {
    const pr = makePR({ number: 161, commits: [] });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.reviewPRs[0].lastCommit).toBeUndefined();
  });

  it("sets lastComment to undefined when PR has no comments", () => {
    const pr = makePR({ number: 162, comments: [] });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.reviewPRs[0].lastComment).toBeUndefined();
  });

  it("populates temporal fields on addressFeedback items", () => {
    const pr = makePR({
      number: 163,
      isDraft: true,
      commits: [{ committedDate: "2025-06-14T12:00:00Z" }],
      comments: [{ createdAt: "2025-06-13T12:00:00Z" }],
      updatedAt: "2025-06-15T06:00:00Z",
    });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.addressFeedback[0].lastCommit).toBe("yesterday");
    expect(summary.addressFeedback[0].lastComment).toBe("2 days ago");
    expect(summary.addressFeedback[0].updated).toBe("6h ago");
  });

  // ── Comment context on issues ──────────────────────────────────────

  it("populates yourComment and yourCommentAge when currentUser has commented on an issue", () => {
    const issue = makeIssue({
      number: 200,
      labels: [{ name: "discuss" }],
      comments: [
        { createdAt: "2025-06-14T00:00:00Z", author: { login: "other" } },
        { createdAt: "2025-06-15T09:00:00Z", author: { login: "testuser" } },
      ],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.discuss[0].yourComment).toBe("commented");
    expect(summary.discuss[0].yourCommentAge).toBe("3h ago");
  });

  it("does not set yourComment when currentUser has not commented", () => {
    const issue = makeIssue({
      number: 201,
      labels: [{ name: "discuss" }],
      comments: [
        { createdAt: "2025-06-14T00:00:00Z", author: { login: "other" } },
      ],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.discuss[0].yourComment).toBeUndefined();
    expect(summary.discuss[0].yourCommentAge).toBeUndefined();
  });

  it("populates yourComment on implement issues", () => {
    const issue = makeIssue({
      number: 202,
      comments: [
        { createdAt: "2025-06-15T11:00:00Z", author: { login: "testuser" } },
      ],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.implement[0].yourComment).toBe("commented");
    expect(summary.implement[0].yourCommentAge).toBe("1h ago");
  });

  // ── Vote annotation on voting items ────────────────────────────────

  it("populates yourVote and yourVoteAge from votes map on voteOn items", () => {
    const issue = makeIssue({
      number: 300,
      labels: [{ name: "phase:voting" }],
    });
    const votes = new Map([[300, { reaction: "👍", createdAt: "2025-06-14T12:00:00Z" }]]);

    const summary = buildSummary(repo, [issue], [], "testuser", now, votes);
    expect(summary.voteOn[0].yourVote).toBe("👍");
    expect(summary.voteOn[0].yourVoteAge).toBe("yesterday");
  });

  it("does not set yourVote when issue is not in votes map", () => {
    const issue = makeIssue({
      number: 301,
      labels: [{ name: "phase:voting" }],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now, new Map());
    expect(summary.voteOn[0].yourVote).toBeUndefined();
    expect(summary.voteOn[0].yourVoteAge).toBeUndefined();
  });

  it("retains vote info on extended-voting items moved to driveDiscussion", () => {
    const issue = makeIssue({
      number: 302,
      labels: [{ name: "phase:extended-voting" }],
      author: { login: "testuser" },
    });
    const votes = new Map([[302, { reaction: "👎", createdAt: "2025-06-13T00:00:00Z" }]]);

    const summary = buildSummary(repo, [issue], [], "testuser", now, votes);
    // Extended-voting authored items move to driveDiscussion
    expect(summary.driveDiscussion).toHaveLength(1);
    expect(summary.driveDiscussion[0].yourVote).toBe("👎");
    expect(summary.driveDiscussion[0].yourVoteAge).toBe("2 days ago");
  });

  // ── Notification annotation ──────────────────────────────────────

  it("annotates voteOn items with unread notification", () => {
    const issue = makeIssue({ number: 50, labels: [{ name: "phase:voting" }] });
    const notifications = new Map([[50, { reason: "mention", updatedAt: "2025-06-15T10:00:00Z" }]]);

    const summary = buildSummary(repo, [issue], [], "testuser", now, new Map(), notifications);
    expect(summary.voteOn[0].unread).toBe(true);
    expect(summary.voteOn[0].unreadReason).toBe("mention");
    expect(summary.voteOn[0].unreadAge).toBe("2h ago");
  });

  it("annotates discuss items with unread notification", () => {
    const issue = makeIssue({ number: 52, labels: [{ name: "discuss" }] });
    const notifications = new Map([[52, { reason: "comment", updatedAt: "2025-06-15T10:00:00Z" }]]);

    const summary = buildSummary(repo, [issue], [], "testuser", now, new Map(), notifications);
    expect(summary.discuss[0].unread).toBe(true);
    expect(summary.discuss[0].unreadReason).toBe("comment");
    expect(summary.discuss[0].unreadAge).toBe("2h ago");
  });

  it("annotates implement items with unread notification", () => {
    const issue = makeIssue({ number: 45 });
    const notifications = new Map([[45, { reason: "author", updatedAt: "2025-06-15T10:00:00Z" }]]);

    const summary = buildSummary(repo, [issue], [], "testuser", now, new Map(), notifications);
    expect(summary.implement[0].unread).toBe(true);
    expect(summary.implement[0].unreadReason).toBe("author");
    expect(summary.implement[0].unreadAge).toBe("2h ago");
  });

  it("annotates needsHuman items with unread notification", () => {
    const issue = makeIssue({ number: 77, labels: [{ name: "needs:human" }] });
    const notifications = new Map([[77, { reason: "ci_activity", updatedAt: "2025-06-15T10:00:00Z" }]]);

    const summary = buildSummary(repo, [issue], [], "testuser", now, new Map(), notifications);
    expect(summary.needsHuman[0].unread).toBe(true);
    expect(summary.needsHuman[0].unreadReason).toBe("ci_activity");
    expect(summary.needsHuman[0].unreadAge).toBe("2h ago");
  });

  it("annotates reviewPRs items with unread notification", () => {
    const pr = makePR({ number: 49 });
    const notifications = new Map([[49, { reason: "review_requested", updatedAt: "2025-06-15T10:00:00Z" }]]);

    const summary = buildSummary(repo, [], [pr], "testuser", now, new Map(), notifications);
    expect(summary.reviewPRs[0].unread).toBe(true);
    expect(summary.reviewPRs[0].unreadReason).toBe("review_requested");
    expect(summary.reviewPRs[0].unreadAge).toBe("2h ago");
  });

  it("annotates driveDiscussion items with unread notification", () => {
    const issue = makeIssue({ number: 52, labels: [{ name: "discuss" }], author: { login: "testuser" } });
    const notifications = new Map([[52, { reason: "comment", updatedAt: "2025-06-15T10:00:00Z" }]]);

    const summary = buildSummary(repo, [issue], [], "testuser", now, new Map(), notifications);
    expect(summary.driveDiscussion[0].unread).toBe(true);
    expect(summary.driveDiscussion[0].unreadReason).toBe("comment");
    expect(summary.driveDiscussion[0].unreadAge).toBe("2h ago");
  });

  it("annotates driveImplementation items with unread notification", () => {
    const pr = makePR({ number: 49, author: { login: "testuser" } });
    const notifications = new Map([[49, { reason: "comment", updatedAt: "2025-06-15T10:00:00Z" }]]);

    const summary = buildSummary(repo, [], [pr], "testuser", now, new Map(), notifications);
    expect(summary.driveImplementation[0].unread).toBe(true);
    expect(summary.driveImplementation[0].unreadReason).toBe("comment");
    expect(summary.driveImplementation[0].unreadAge).toBe("2h ago");
  });

  it("computes unreadAge relative to now", () => {
    const issue = makeIssue({ number: 45 });
    const notifications = new Map([[45, { reason: "comment", updatedAt: "2025-06-14T12:00:00Z" }]]);

    const summary = buildSummary(repo, [issue], [], "testuser", now, new Map(), notifications);
    expect(summary.implement[0].unreadAge).toBe("yesterday");
  });

  it("does not set unread when item is not in notifications map", () => {
    const issue = makeIssue({ number: 45 });

    const summary = buildSummary(repo, [issue], [], "testuser", now, new Map(), new Map());
    expect(summary.implement[0].unread).toBeUndefined();
    expect(summary.implement[0].unreadReason).toBeUndefined();
    expect(summary.implement[0].unreadAge).toBeUndefined();
  });

  it("defaults to empty notification map when not provided", () => {
    const issue = makeIssue({ number: 45 });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.implement[0].unread).toBeUndefined();
  });
});
