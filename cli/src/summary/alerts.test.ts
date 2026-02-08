import { describe, it, expect } from "vitest";
import { generateAlerts } from "./alerts.js";
import type { GitHubIssue, GitHubPR } from "../config/types.js";

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
    url: "https://github.com/test/repo/issues/1",
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
    url: "https://github.com/test/repo/pull/10",
    isDraft: false,
    reviewDecision: "",
    mergeable: "MERGEABLE",
    statusCheckRollup: [],
    closingIssuesReferences: [],
    ...overrides,
  };
}

describe("generateAlerts()", () => {
  it("returns no alerts for empty inputs", () => {
    expect(generateAlerts([], [], now)).toEqual([]);
  });

  it("alerts on stale discussions (no comments for 3+ days)", () => {
    const issue = makeIssue({
      number: 52,
      labels: [{ name: "discuss" }],
      createdAt: "2025-06-10T12:00:00Z",
      comments: [],
    });

    const alerts = generateAlerts([issue], [], now);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toContain("#52");
    expect(alerts[0].message).toContain("discussion");
    expect(alerts[0].message).toContain("5 days");
  });

  it("does not alert on fresh discussions", () => {
    const issue = makeIssue({
      labels: [{ name: "discuss" }],
      createdAt: "2025-06-14T12:00:00Z",
      comments: [{ createdAt: "2025-06-15T10:00:00Z" }],
    });

    const alerts = generateAlerts([issue], [], now);
    expect(alerts).toHaveLength(0);
  });

  it("uses latest comment date for staleness check", () => {
    const issue = makeIssue({
      number: 7,
      labels: [{ name: "discuss" }],
      createdAt: "2025-06-01T12:00:00Z",
      comments: [
        { createdAt: "2025-06-05T12:00:00Z" },
        { createdAt: "2025-06-14T12:00:00Z" },
      ],
    });

    const alerts = generateAlerts([issue], [], now);
    // Latest comment is 1 day old — not stale
    expect(alerts).toHaveLength(0);
  });

  it("alerts on PRs waiting on review for 2+ days", () => {
    const pr = makePR({
      number: 49,
      labels: [{ name: "implementation" }],
      createdAt: "2025-06-12T12:00:00Z",
      reviewDecision: "",
    });

    const alerts = generateAlerts([], [pr], now);
    const reviewAlert = alerts.find((a) => a.message.includes("#49"));
    expect(reviewAlert).toBeDefined();
    expect(reviewAlert!.message).toContain("waiting on review");
    expect(reviewAlert!.message).toContain("3 days");
  });

  it("does not alert on PRs with review decisions", () => {
    const pr = makePR({
      labels: [{ name: "implementation" }],
      reviewDecision: "APPROVED",
      createdAt: "2025-06-10T12:00:00Z",
    });

    const alerts = generateAlerts([], [pr], now);
    const reviewAlerts = alerts.filter((a) => a.message.includes("waiting on review"));
    expect(reviewAlerts).toHaveLength(0);
  });

  it("does not alert on draft PRs for review waiting", () => {
    const pr = makePR({
      labels: [{ name: "implementation" }],
      isDraft: true,
      createdAt: "2025-06-10T12:00:00Z",
      reviewDecision: "",
    });

    const alerts = generateAlerts([], [pr], now);
    const reviewAlerts = alerts.filter((a) => a.message.includes("waiting on review"));
    expect(reviewAlerts).toHaveLength(0);
  });

  it("alerts on CI failures", () => {
    const pr = makePR({
      number: 53,
      labels: [{ name: "implementation" }],
      statusCheckRollup: [
        { context: "ci/build", state: "FAILURE", conclusion: "failure" },
      ],
    });

    const alerts = generateAlerts([], [pr], now);
    const ciAlert = alerts.find((a) => a.message.includes("CI failures"));
    expect(ciAlert).toBeDefined();
    expect(ciAlert!.message).toContain("#53");
  });

  it("does not alert on CI failures for draft PRs", () => {
    const pr = makePR({
      labels: [{ name: "implementation" }],
      isDraft: true,
      statusCheckRollup: [
        { context: "ci", state: "FAILURE", conclusion: "failure" },
      ],
    });

    const alerts = generateAlerts([], [pr], now);
    const ciAlerts = alerts.filter((a) => a.message.includes("CI failures"));
    expect(ciAlerts).toHaveLength(0);
  });

  it("does not alert on PRs without implementation label", () => {
    const pr = makePR({
      number: 70,
      labels: [],
      createdAt: "2025-06-12T12:00:00Z",
      reviewDecision: "",
    });

    const alerts = generateAlerts([], [pr], now);
    const reviewAlerts = alerts.filter((a) => a.message.includes("waiting on review"));
    expect(reviewAlerts).toHaveLength(0);
  });

  it("does not alert on issues without discuss label", () => {
    const issue = makeIssue({
      labels: [{ name: "bug" }],
      createdAt: "2025-06-01T12:00:00Z",
    });

    const alerts = generateAlerts([issue], [], now);
    expect(alerts).toHaveLength(0);
  });

  it("handles PRs with null statusCheckRollup without crashing", () => {
    const pr = makePR({
      number: 60,
      statusCheckRollup: null,
    });

    const alerts = generateAlerts([], [pr], now);
    const ciAlerts = alerts.filter((a) => a.message.includes("CI failures"));
    expect(ciAlerts).toHaveLength(0);
  });

  it("alerts on PRs with REVIEW_REQUIRED review decision", () => {
    const pr = makePR({
      number: 61,
      labels: [{ name: "implementation" }],
      reviewDecision: "REVIEW_REQUIRED",
      createdAt: "2025-06-12T12:00:00Z",
    });

    const alerts = generateAlerts([], [pr], now);
    const reviewAlerts = alerts.filter((a) => a.message.includes("waiting on review"));
    expect(reviewAlerts).toHaveLength(1);
    expect(reviewAlerts[0].message).toContain("#61");
  });

  // ── Blocked issue alerts ───────────────────────────────────────────

  it("alerts on blocked issues", () => {
    const issue = makeIssue({
      number: 77,
      labels: [{ name: "blocked:human-help-needed" }],
    });

    const alerts = generateAlerts([issue], [], now);
    const blockedAlerts = alerts.filter((a) => a.message.includes("blocked"));
    expect(blockedAlerts).toHaveLength(1);
    expect(blockedAlerts[0].message).toContain("#77");
  });

  it("alerts on any blocked variant label", () => {
    const issue = makeIssue({
      number: 88,
      labels: [{ name: "blocked:dependency" }],
    });

    const alerts = generateAlerts([issue], [], now);
    const blockedAlerts = alerts.filter((a) => a.message.includes("blocked"));
    expect(blockedAlerts).toHaveLength(1);
    expect(blockedAlerts[0].message).toContain("#88");
  });

  it("does not alert on issues without blocked label", () => {
    const issue = makeIssue({
      number: 90,
      labels: [{ name: "bug" }],
    });

    const alerts = generateAlerts([issue], [], now);
    const blockedAlerts = alerts.filter((a) => a.message.includes("blocked"));
    expect(blockedAlerts).toHaveLength(0);
  });

  // ── phase:discussion stale detection ──────────────────────────────

  it("alerts on stale phase:discussion issues", () => {
    const issue = makeIssue({
      number: 95,
      labels: [{ name: "phase:discussion" }],
      createdAt: "2025-06-10T12:00:00Z",
      comments: [],
    });

    const alerts = generateAlerts([issue], [], now);
    const staleAlerts = alerts.filter((a) => a.message.includes("discussion"));
    expect(staleAlerts).toHaveLength(1);
    expect(staleAlerts[0].message).toContain("#95");
  });

  it("does not alert on fresh phase:discussion issues", () => {
    const issue = makeIssue({
      number: 96,
      labels: [{ name: "phase:discussion" }],
      createdAt: "2025-06-14T12:00:00Z",
      comments: [{ createdAt: "2025-06-15T10:00:00Z" }],
    });

    const alerts = generateAlerts([issue], [], now);
    const staleAlerts = alerts.filter((a) => a.message.includes("discussion"));
    expect(staleAlerts).toHaveLength(0);
  });
});
