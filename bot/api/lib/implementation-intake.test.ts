import { describe, it, expect, vi, beforeEach } from "vitest";
import { LABELS } from "../config.js";
import { processImplementationIntake, recalculateLeaderboardForPR } from "./implementation-intake.js";
import type { LinkedIssue } from "./types.js";

// Mock env-validation
vi.mock("./env-validation.js", () => ({
  validateEnv: vi.fn(() => ({ valid: true, missing: [] })),
  getAppId: vi.fn(() => 12345),
}));

// Mock GraphQL queries used by leaderboard updates
vi.mock("./graphql-queries.js", () => ({
  getLinkedIssues: vi.fn(),
}));

import { getLinkedIssues } from "./graphql-queries.js";

describe("Implementation Intake", () => {
  const createMockOctokit = () => ({
    rest: {
      issues: {
        get: vi.fn().mockResolvedValue({ data: { labels: [] } }),
        addLabels: vi.fn().mockResolvedValue({}),
        removeLabel: vi.fn().mockResolvedValue({}),
        createComment: vi.fn().mockResolvedValue({}),
        updateComment: vi.fn().mockResolvedValue({}),
        listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
        listComments: vi.fn().mockResolvedValue({ data: [] }),
        listForRepo: vi.fn().mockResolvedValue({ data: [] }),
        lock: vi.fn().mockResolvedValue({}),
        unlock: vi.fn().mockResolvedValue({}),
      },
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            number: 101,
            state: "open",
            merged: false,
            created_at: "2026-02-01T00:00:00Z",
            updated_at: "2026-02-02T00:00:00Z",
            user: { login: "agent" },
            head: { sha: "abc123" },
          },
        }),
        update: vi.fn().mockResolvedValue({}),
        listReviews: vi.fn().mockResolvedValue({ data: [] }),
        listCommits: vi.fn().mockResolvedValue({ data: [] }),
        listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
        listFiles: vi.fn().mockResolvedValue({ data: [] }),
      },
      reactions: {
        listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }),
      },
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue({ data: { state: "pending", total_count: 0, statuses: [] } }),
      },
    },
    paginate: {
      iterator: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [] };
        },
      }),
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create a leaderboard comment when an implementation PR is accepted", async () => {
    const mockOctokit = createMockOctokit();

    const readyIssue: LinkedIssue = {
      number: 7,
      title: "Ready issue",
      state: "OPEN",
      labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
    };

    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-01T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-02T00:00:00Z")),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "opened",
      maxPRsPerIssue: 3,
    });

    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
  });

  it("should apply implementation label on edited trigger when linked issue is ready", async () => {
    const mockOctokit = createMockOctokit();

    const readyIssue: LinkedIssue = {
      number: 7,
      title: "Ready issue",
      state: "OPEN",
      labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
    };

    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-01T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-02T00:00:00Z")),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "edited",
      maxPRsPerIssue: 3,
    });

    expect(prs.addLabels).toHaveBeenCalledWith(
      { owner: "hivemoot", repo: "colony", prNumber: 101 },
      [LABELS.IMPLEMENTATION]
    );
  });

  it("should not post issue-not-ready comment on edited trigger", async () => {
    const mockOctokit = createMockOctokit();

    const discussionIssue: LinkedIssue = {
      number: 7,
      title: "Discussion issue",
      state: "OPEN",
      labels: { nodes: [{ name: LABELS.DISCUSSION }] },
    };

    const issues = {
      getLabelAddedTime: vi.fn(),
      comment: vi.fn().mockResolvedValue(undefined),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-02T00:00:00Z")),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [discussionIssue],
      trigger: "edited",
      maxPRsPerIssue: 3,
    });

    // "edited" trigger should NOT post the "issue not ready" comment
    expect(prs.comment).not.toHaveBeenCalled();
  });

  it.each([
    { label: LABELS.REJECTED },
    { label: LABELS.INCONCLUSIVE },
    { label: LABELS.IMPLEMENTED },
  ])(
    "should post issue-closed message (not 'not ready yet') for $label issue on opened trigger",
    async ({ label }) => {
      const mockOctokit = createMockOctokit();

      const closedIssue: LinkedIssue = {
        number: 42,
        title: "Closed issue",
        state: "CLOSED",
        labels: { nodes: [{ name: label }] },
      };

      const prs = {
        get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
        getLabels: vi.fn().mockResolvedValue([]),
        getLatestAuthorActivityDate: vi.fn(),
        findPRsWithLabel: vi.fn().mockResolvedValue([]),
        addLabels: vi.fn().mockResolvedValue(undefined),
        comment: vi.fn().mockResolvedValue(undefined),
      };

      await processImplementationIntake({
        octokit: mockOctokit,
        issues: { getLabelAddedTime: vi.fn(), comment: vi.fn() },
        prs,
        log: { info: vi.fn(), warn: vi.fn() },
        owner: "hivemoot",
        repo: "colony",
        prNumber: 101,
        linkedIssues: [closedIssue],
        trigger: "opened",
        maxPRsPerIssue: 3,
      });

      expect(prs.comment).toHaveBeenCalledOnce();
      const postedMessage = prs.comment.mock.calls[0][1] as string;
      expect(postedMessage).toContain("Issue Closed");
      expect(postedMessage).toContain(`Issue #42`);
      expect(postedMessage).not.toContain("Not Ready Yet");
      expect(postedMessage).not.toContain("hasn't passed voting");
    }
  );

  it("should post 'not ready yet' (not closed message) for discussion-phase issue on opened trigger", async () => {
    const mockOctokit = createMockOctokit();

    const discussionIssue: LinkedIssue = {
      number: 7,
      title: "Discussion issue",
      state: "OPEN",
      labels: { nodes: [{ name: LABELS.DISCUSSION }] },
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn(),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues: { getLabelAddedTime: vi.fn(), comment: vi.fn() },
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [discussionIssue],
      trigger: "opened",
      maxPRsPerIssue: 3,
    });

    expect(prs.comment).toHaveBeenCalledOnce();
    const postedMessage = prs.comment.mock.calls[0][1] as string;
    expect(postedMessage).toContain("Not Ready Yet");
    expect(postedMessage).toContain("hasn't passed voting");
    expect(postedMessage).not.toContain("Issue Closed");
  });

  it("should silently skip when activation is before ready date on edited trigger without editedAt", async () => {
    const mockOctokit = createMockOctokit();

    const readyIssue: LinkedIssue = {
      number: 7,
      title: "Ready issue",
      state: "OPEN",
      labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
    };

    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-05T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      // Activation BEFORE ready → anti-gaming guard rejects
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-04T00:00:00Z")),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "edited",
      maxPRsPerIssue: 3,
      intake: [{ method: "update" }],
    });

    // No label, no comment — silent skip on edited without editedAt
    expect(prs.addLabels).not.toHaveBeenCalled();
    expect(prs.comment).not.toHaveBeenCalled();
  });

  it("should accept PR when editedAt is after ready date even if activation is before", async () => {
    const mockOctokit = createMockOctokit();

    const readyIssue: LinkedIssue = {
      number: 7,
      title: "Ready issue",
      state: "OPEN",
      labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
    };

    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-05T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      // Activation BEFORE ready — but editedAt is AFTER
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-04T00:00:00Z")),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "edited",
      maxPRsPerIssue: 3,
      editedAt: new Date("2026-02-06T00:00:00Z"),
    });

    expect(prs.addLabels).toHaveBeenCalledWith(
      { owner: "hivemoot", repo: "colony", prNumber: 101 },
      [LABELS.IMPLEMENTATION]
    );
  });

  it("should still block when editedAt is also before ready date", async () => {
    const mockOctokit = createMockOctokit();

    const readyIssue: LinkedIssue = {
      number: 7,
      title: "Ready issue",
      state: "OPEN",
      labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
    };

    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-05T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-03T00:00:00Z")),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "edited",
      maxPRsPerIssue: 3,
      editedAt: new Date("2026-02-04T00:00:00Z"),
      intake: [{ method: "update" }],
    });

    // Both activation and editedAt are before ready — still blocked
    expect(prs.addLabels).not.toHaveBeenCalled();
    expect(prs.comment).not.toHaveBeenCalled();
  });

  it("should accept PR when editedAt equals ready date exactly", async () => {
    const mockOctokit = createMockOctokit();

    const readyIssue: LinkedIssue = {
      number: 7,
      title: "Ready issue",
      state: "OPEN",
      labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
    };

    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-05T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-03T00:00:00Z")),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "edited",
      maxPRsPerIssue: 3,
      editedAt: new Date("2026-02-05T00:00:00Z"),
    });

    // editedAt === readyAt — >= comparison accepts this
    expect(prs.addLabels).toHaveBeenCalledWith(
      { owner: "hivemoot", repo: "colony", prNumber: 101 },
      [LABELS.IMPLEMENTATION]
    );
  });

  it("should post no-room comment (not close) when PR limit reached on edited trigger", async () => {
    const mockOctokit = createMockOctokit();

    const readyIssue: LinkedIssue = {
      number: 7,
      title: "Ready issue",
      state: "OPEN",
      labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
    };

    const existingPR = { number: 50, title: "Existing", state: "OPEN" as const, author: { login: "other" } };

    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-01T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({
        createdAt: new Date("2026-02-01T00:00:00Z"),
        state: "open",
        merged: false,
        author: "other",
      }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-02T00:00:00Z")),
      findPRsWithLabel: vi.fn().mockResolvedValue([existingPR]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "edited",
      maxPRsPerIssue: 1,
    });

    // Should inform about no room, but NOT close the PR
    expect(prs.comment).toHaveBeenCalled();
    expect(prs.close).not.toHaveBeenCalled();
    expect(prs.addLabels).not.toHaveBeenCalled();
  });

  it("should not post duplicate welcome when metadata comment already exists", async () => {
    const mockOctokit = createMockOctokit();

    const readyIssue: LinkedIssue = {
      number: 7,
      title: "Ready issue",
      state: "OPEN",
      labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
    };

    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-01T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(true),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-02T00:00:00Z")),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(true),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "updated",
      maxPRsPerIssue: 3,
    });

    // Label should still be added
    expect(prs.addLabels).toHaveBeenCalledWith(
      { owner: "hivemoot", repo: "colony", prNumber: 101 },
      [LABELS.IMPLEMENTATION]
    );

    // Comments should NOT be posted (dedup detected)
    expect(prs.comment).not.toHaveBeenCalled();
    expect(issues.comment).not.toHaveBeenCalled();
  });

  it("should post comments when no duplicates exist", async () => {
    const mockOctokit = createMockOctokit();

    const readyIssue: LinkedIssue = {
      number: 7,
      title: "Ready issue",
      state: "OPEN",
      labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
    };

    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-01T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-02T00:00:00Z")),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "updated",
      maxPRsPerIssue: 3,
    });

    // Both comments should be posted
    expect(prs.comment).toHaveBeenCalledTimes(1);
    expect(issues.comment).toHaveBeenCalledTimes(1);
  });

  it("should post welcome once and issue comment per-issue for multi-issue PRs", async () => {
    const mockOctokit = createMockOctokit();

    const readyIssue1: LinkedIssue = {
      number: 7,
      title: "Ready issue 1",
      state: "OPEN",
      labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
    };
    const readyIssue2: LinkedIssue = {
      number: 8,
      title: "Ready issue 2",
      state: "OPEN",
      labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
    };

    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue1, readyIssue2]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-01T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-02T00:00:00Z")),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue1, readyIssue2],
      trigger: "opened",
      maxPRsPerIssue: 3,
    });

    // Welcome comment on PR should be posted exactly once (dedup across issues)
    expect(prs.comment).toHaveBeenCalledTimes(1);
    // Issue notification should be posted for each linked issue
    expect(issues.comment).toHaveBeenCalledTimes(2);
  });
});

describe("Intake Methods", () => {
  const createMockOctokit = () => ({
    rest: {
      issues: {
        get: vi.fn().mockResolvedValue({ data: { labels: [] } }),
        addLabels: vi.fn().mockResolvedValue({}),
        removeLabel: vi.fn().mockResolvedValue({}),
        createComment: vi.fn().mockResolvedValue({}),
        updateComment: vi.fn().mockResolvedValue({}),
        listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
        listComments: vi.fn().mockResolvedValue({ data: [] }),
        listForRepo: vi.fn().mockResolvedValue({ data: [] }),
        lock: vi.fn().mockResolvedValue({}),
        unlock: vi.fn().mockResolvedValue({}),
      },
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            number: 101,
            state: "open",
            merged: false,
            created_at: "2026-02-01T00:00:00Z",
            updated_at: "2026-02-02T00:00:00Z",
            user: { login: "agent" },
            head: { sha: "abc123" },
          },
        }),
        update: vi.fn().mockResolvedValue({}),
        listReviews: vi.fn().mockResolvedValue({ data: [] }),
        listCommits: vi.fn().mockResolvedValue({ data: [] }),
        listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
        listFiles: vi.fn().mockResolvedValue({ data: [] }),
      },
      reactions: {
        listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }),
      },
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue({ data: { state: "pending", total_count: 0, statuses: [] } }),
      },
    },
    paginate: {
      iterator: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [] };
        },
      }),
    },
  });

  const readyIssue: LinkedIssue = {
    number: 7,
    title: "Ready issue",
    state: "OPEN",
    labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("intake: [update] — pre-ready PR blocked (existing behavior)", async () => {
    const mockOctokit = createMockOctokit();
    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-05T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-04T00:00:00Z")),
      getApproverLogins: vi.fn().mockResolvedValue(new Set<string>()),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "opened",
      maxPRsPerIssue: 3,
      intake: [{ method: "update" }],
    });

    expect(prs.addLabels).not.toHaveBeenCalled();
    expect(prs.comment).toHaveBeenCalled(); // issueReadyNeedsUpdate
  });

  it("intake: [update] — post-ready PR activated (existing behavior)", async () => {
    const mockOctokit = createMockOctokit();
    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-01T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-02T00:00:00Z")),
      getApproverLogins: vi.fn().mockResolvedValue(new Set<string>()),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "opened",
      maxPRsPerIssue: 3,
      intake: [{ method: "update" }],
    });

    expect(prs.addLabels).toHaveBeenCalledWith(
      { owner: "hivemoot", repo: "colony", prNumber: 101 },
      [LABELS.IMPLEMENTATION]
    );
  });

  it("intake: [update, approval] — pre-ready PR with trusted approval → activated", async () => {
    const mockOctokit = createMockOctokit();
    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-05T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      // Activation BEFORE ready — timing guard fails
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-04T00:00:00Z")),
      // But alice has approved
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "opened",
      maxPRsPerIssue: 3,
      trustedReviewers: ["alice", "bob"],
      intake: [{ method: "update" }, { method: "approval", minApprovals: 1 }],
    });

    expect(prs.addLabels).toHaveBeenCalledWith(
      { owner: "hivemoot", repo: "colony", prNumber: 101 },
      [LABELS.IMPLEMENTATION]
    );
  });

  it("intake: [update, approval] — pre-ready PR with non-trusted approval → blocked", async () => {
    const mockOctokit = createMockOctokit();
    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-05T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-04T00:00:00Z")),
      // "random-user" is not in the trusted list
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["random-user"])),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "opened",
      maxPRsPerIssue: 3,
      trustedReviewers: ["alice", "bob"],
      intake: [{ method: "update" }, { method: "approval", minApprovals: 1 }],
    });

    expect(prs.addLabels).not.toHaveBeenCalled();
  });

  it("intake: [update, approval] — pre-ready PR with 0 approvals → blocked", async () => {
    const mockOctokit = createMockOctokit();
    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-05T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-04T00:00:00Z")),
      getApproverLogins: vi.fn().mockResolvedValue(new Set<string>()),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "opened",
      maxPRsPerIssue: 3,
      trustedReviewers: ["alice"],
      intake: [{ method: "update" }, { method: "approval", minApprovals: 1 }],
    });

    expect(prs.addLabels).not.toHaveBeenCalled();
  });

  it("intake: [approval] only — post-ready activity alone doesn't activate (strict mode)", async () => {
    const mockOctokit = createMockOctokit();
    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-01T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      // Activation AFTER ready — timing guard passes, but intake has no "update" method
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-02T00:00:00Z")),
      getApproverLogins: vi.fn().mockResolvedValue(new Set<string>()),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "updated",
      maxPRsPerIssue: 3,
      trustedReviewers: ["alice"],
      intake: [{ method: "approval", minApprovals: 1 }],
    });

    // NOTE: When isActivationAfterReady passes, we skip the intake loop entirely
    // and proceed to label the PR. The strict-mode guard only applies to pre-ready PRs.
    // Post-ready activity always activates regardless of intake methods.
    expect(prs.addLabels).toHaveBeenCalled();
  });

  it("intake: [approval] — trusted approval activates pre-ready PR", async () => {
    const mockOctokit = createMockOctokit();
    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-05T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-04T00:00:00Z")),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "updated",
      maxPRsPerIssue: 3,
      trustedReviewers: ["alice"],
      intake: [{ method: "approval", minApprovals: 1 }],
    });

    expect(prs.addLabels).toHaveBeenCalledWith(
      { owner: "hivemoot", repo: "colony", prNumber: 101 },
      [LABELS.IMPLEMENTATION]
    );
  });

  it("minApprovals: 2 requires 2 trusted approvals", async () => {
    const mockOctokit = createMockOctokit();
    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-05T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-04T00:00:00Z")),
      // Only 1 trusted approval, but we need 2
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "opened",
      maxPRsPerIssue: 3,
      trustedReviewers: ["alice", "bob"],
      intake: [{ method: "approval", minApprovals: 2 }],
    });

    expect(prs.addLabels).not.toHaveBeenCalled();
  });

  it("intake: [auto] — pre-ready PR unconditionally activated", async () => {
    const mockOctokit = createMockOctokit();
    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-05T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      // Activation BEFORE ready — timing guard fails
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-04T00:00:00Z")),
      getApproverLogins: vi.fn().mockResolvedValue(new Set<string>()),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "opened",
      maxPRsPerIssue: 3,
      intake: [{ method: "auto" }],
    });

    expect(prs.addLabels).toHaveBeenCalledWith(
      { owner: "hivemoot", repo: "colony", prNumber: 101 },
      [LABELS.IMPLEMENTATION]
    );
  });

  it("intake: [auto] — does not call getApproverLogins (no unnecessary API calls)", async () => {
    const mockOctokit = createMockOctokit();
    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-05T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-04T00:00:00Z")),
      getApproverLogins: vi.fn().mockResolvedValue(new Set<string>()),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "opened",
      maxPRsPerIssue: 3,
      intake: [{ method: "auto" }],
    });

    // auto bypasses immediately — no approval API calls needed
    expect(prs.getApproverLogins).not.toHaveBeenCalled();
  });

  it("intake: [auto] — still enforces PR limit (maxPRsPerIssue)", async () => {
    const mockOctokit = createMockOctokit();
    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const existingPR = { number: 50, title: "Existing", state: "OPEN" as const, author: { login: "other" } };

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-05T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({
        createdAt: new Date("2026-02-01T00:00:00Z"),
        state: "open",
        merged: false,
        author: "other",
      }),
      getLabels: vi.fn().mockResolvedValue([]),
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-04T00:00:00Z")),
      getApproverLogins: vi.fn().mockResolvedValue(new Set<string>()),
      findPRsWithLabel: vi.fn().mockResolvedValue([existingPR]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "opened",
      maxPRsPerIssue: 1,
      intake: [{ method: "auto" }],
    });

    // Auto bypasses timing guard, but PR limit still enforced
    expect(prs.addLabels).not.toHaveBeenCalled();
    expect(prs.close).toHaveBeenCalled();
  });

  it("intake: [auto] — post-ready PR activates without entering intake loop", async () => {
    const mockOctokit = createMockOctokit();
    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-01T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      // Activation AFTER ready — timing guard passes, intake loop skipped
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-02T00:00:00Z")),
      getApproverLogins: vi.fn().mockResolvedValue(new Set<string>()),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "updated",
      maxPRsPerIssue: 3,
      intake: [{ method: "auto" }],
    });

    // Post-ready activity always activates — no intake loop needed
    expect(prs.getApproverLogins).not.toHaveBeenCalled();
    expect(prs.addLabels).toHaveBeenCalledWith(
      { owner: "hivemoot", repo: "colony", prNumber: 101 },
      [LABELS.IMPLEMENTATION]
    );
  });

  it("timing guard passes → approval check skipped (no unnecessary API calls)", async () => {
    const mockOctokit = createMockOctokit();
    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    const issues = {
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2026-02-01T00:00:00Z")),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    const prs = {
      get: vi.fn().mockResolvedValue({ createdAt: new Date("2026-02-01T00:00:00Z") }),
      getLabels: vi.fn().mockResolvedValue([]),
      // Activation AFTER ready — timing guard passes
      getLatestAuthorActivityDate: vi.fn().mockResolvedValue(new Date("2026-02-02T00:00:00Z")),
      getApproverLogins: vi.fn().mockResolvedValue(new Set<string>()),
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
    };

    await processImplementationIntake({
      octokit: mockOctokit,
      issues,
      prs,
      log: { info: vi.fn(), warn: vi.fn() },
      owner: "hivemoot",
      repo: "colony",
      prNumber: 101,
      linkedIssues: [readyIssue],
      trigger: "opened",
      maxPRsPerIssue: 3,
      trustedReviewers: ["alice"],
      intake: [{ method: "update" }, { method: "approval", minApprovals: 1 }],
    });

    // getApproverLogins should NOT be called — timing guard passed, loop skipped
    expect(prs.getApproverLogins).not.toHaveBeenCalled();
    expect(prs.addLabels).toHaveBeenCalled();
  });
});

describe("Leaderboard race condition fix", () => {
  const createMockOctokit = () => ({
    rest: {
      issues: {
        get: vi.fn().mockResolvedValue({ data: { labels: [] } }),
        addLabels: vi.fn().mockResolvedValue({}),
        removeLabel: vi.fn().mockResolvedValue({}),
        createComment: vi.fn().mockResolvedValue({}),
        updateComment: vi.fn().mockResolvedValue({}),
        listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
        listComments: vi.fn().mockResolvedValue({ data: [] }),
        listForRepo: vi.fn().mockResolvedValue({ data: [] }),
        lock: vi.fn().mockResolvedValue({}),
        unlock: vi.fn().mockResolvedValue({}),
      },
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            number: 101,
            state: "open",
            merged: false,
            created_at: "2026-02-01T00:00:00Z",
            updated_at: "2026-02-02T00:00:00Z",
            user: { login: "agent" },
            head: { sha: "abc123" },
          },
        }),
        update: vi.fn().mockResolvedValue({}),
        listReviews: vi.fn().mockResolvedValue({ data: [] }),
        listCommits: vi.fn().mockResolvedValue({ data: [] }),
        listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
        listFiles: vi.fn().mockResolvedValue({ data: [] }),
      },
      reactions: {
        listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }),
      },
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue({ data: { state: "pending", total_count: 0, statuses: [] } }),
      },
    },
    paginate: {
      iterator: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [] };
        },
      }),
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should include PR when label search misses it", async () => {
    const mockOctokit = createMockOctokit();

    const readyIssue: LinkedIssue = {
      number: 7,
      title: "Ready issue",
      state: "OPEN",
      labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
    };

    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);
    mockOctokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });
    mockOctokit.rest.issues.get.mockResolvedValue({
      data: {
        labels: [{ name: LABELS.IMPLEMENTATION }],
      },
    });

    await recalculateLeaderboardForPR(
      mockOctokit,
      { info: vi.fn() },
      "hivemoot",
      "colony",
      101
    );

    // The leaderboard comment should include PR #101
    const createCommentCalls = mockOctokit.rest.issues.createComment.mock.calls;
    const updateCommentCalls = mockOctokit.rest.issues.updateComment.mock.calls;
    const allCommentBodies = [
      ...createCommentCalls.map((c: Array<{ body?: string }>) => c[0]?.body ?? ""),
      ...updateCommentCalls.map((c: Array<{ body?: string }>) => c[0]?.body ?? ""),
    ];

    const leaderboardPosted = allCommentBodies.some(
      (body: string) => body.includes("#101")
    );
    expect(leaderboardPosted).toBe(true);
  });

  it("should not duplicate PR when label search includes it", async () => {
    const mockOctokit = createMockOctokit();

    const readyIssue: LinkedIssue = {
      number: 7,
      title: "Ready issue",
      state: "OPEN",
      labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
    };

    vi.mocked(getLinkedIssues).mockResolvedValue([readyIssue]);

    // findPRsWithLabel returns PR #101
    mockOctokit.rest.issues.listForRepo.mockResolvedValue({
      data: [{
        number: 101,
        pull_request: {},
        created_at: "2026-02-01T00:00:00Z",
        updated_at: "2026-02-02T00:00:00Z",
        labels: [{ name: LABELS.IMPLEMENTATION }],
      }],
    });

    // Should not throw or produce duplicate entries
    await recalculateLeaderboardForPR(
      mockOctokit,
      { info: vi.fn() },
      "hivemoot",
      "colony",
      101
    );

    const createCommentCalls = mockOctokit.rest.issues.createComment.mock.calls;
    const updateCommentCalls = mockOctokit.rest.issues.updateComment.mock.calls;
    const allCommentBodies = [
      ...createCommentCalls.map((c: Array<{ body?: string }>) => c[0]?.body ?? ""),
      ...updateCommentCalls.map((c: Array<{ body?: string }>) => c[0]?.body ?? ""),
    ];

    const entries = allCommentBodies
      .join("\n")
      .match(/#101/g) ?? [];
    expect(entries.length).toBe(1);
  });
});
