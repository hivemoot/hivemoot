import { describe, it, expect } from "vitest";
import { buildSummary } from "./builder.js";
import type { GitHubIssue, GitHubPR, RepoRef } from "../config/types.js";

const repo: RepoRef = { owner: "hivemoot", repo: "colony" };
const now = new Date("2025-06-15T12:00:00Z");

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 1,
    title: "Test issue",
    labels: [],
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
    ...overrides,
  };
}

describe("buildSummary()", () => {
  it("classifies vote-labeled issues into voteOn bucket", () => {
    const issue = makeIssue({
      number: 50,
      title: "Auth redesign",
      labels: [{ name: "vote" }],
      comments: [{ createdAt: "2025-06-13T00:00:00Z" }, { createdAt: "2025-06-14T00:00:00Z" }],
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
      comments: [{ createdAt: "2025-06-13T00:00:00Z" }],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.discuss).toHaveLength(1);
    expect(summary.discuss[0].number).toBe(52);
    expect(summary.discuss[0].comments).toBe(1);
  });

  it("classifies unlabeled issues into implement bucket with empty tags", () => {
    const issue = makeIssue({
      number: 45,
      title: "User Dashboard",
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.implement).toHaveLength(1);
    expect(summary.implement[0].number).toBe(45);
    expect(summary.implement[0].assigned).toBeUndefined();
    expect(summary.implement[0].age).toBe("3 days ago");
    expect(summary.implement[0].tags).toEqual([]);
  });

  it("shows assignee names in implement item", () => {
    const issue = makeIssue({
      assignees: [{ login: "alice" }],
    });

    const summary = buildSummary(repo, [issue], [], "testuser", now);
    expect(summary.implement[0].assigned).toBe("alice");
  });

  it("classifies normal PRs into reviewPRs bucket", () => {
    const pr = makePR({ number: 49, title: "Search" });

    const summary = buildSummary(repo, [], [pr], "testuser", now);
    expect(summary.reviewPRs).toHaveLength(1);
    expect(summary.reviewPRs[0].number).toBe(49);
    expect(summary.reviewPRs[0].status).toBe("waiting");
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
    expect(summary.implement[0].age).toBe("6 hours ago");
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
});
