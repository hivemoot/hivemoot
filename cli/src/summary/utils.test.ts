import { describe, it, expect } from "vitest";
import { hasLabel, hasExactLabel, daysSince, hasCIFailure, checkStatus, mergeStatus, approvalCount } from "./utils.js";
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
    expect(hasLabel([{ name: "blocked:human-help-needed" }], "blocked")).toBe(true);
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
});
