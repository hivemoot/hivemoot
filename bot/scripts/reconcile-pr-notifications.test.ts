import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for reconcile-pr-notifications script
 *
 * Tests the reconciliation functions:
 * - hasReadyToImplementNotification: duplicate detection (metadata + fallback)
 * - reconcileIssue: notification logic, skipping, error handling, intake reconciliation
 * - processRepository: filtering, issue iteration, config loading
 */

// Mock the external dependencies before importing
vi.mock("octokit", () => ({
  App: vi.fn(),
  Octokit: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  setFailed: vi.fn(),
  warning: vi.fn(),
}));

// Suppress unhandled rejection from module-level main().catch() calling process.exit(1)
process.on("unhandledRejection", () => {});

// Mock API lib
const mockComment = vi.fn().mockResolvedValue(undefined);
const mockFindPRsWithLabel = vi.fn().mockResolvedValue([]);
const mockHasNotificationCommentInComments = vi.fn().mockReturnValue(false);
const mockListCommentsWithBody = vi.fn().mockResolvedValue([]);

const mockIssueOperations = {
  hasNotificationComment: vi.fn().mockResolvedValue(false),
  comment: vi.fn().mockResolvedValue(undefined),
  getLabelAddedTime: vi.fn().mockResolvedValue(new Date("2024-01-01T00:00:00Z")),
};

vi.mock("../api/lib/index.js", () => ({
  createPROperations: vi.fn(() => ({
    comment: mockComment,
    findPRsWithLabel: mockFindPRsWithLabel,
    hasNotificationCommentInComments: mockHasNotificationCommentInComments,
    listCommentsWithBody: mockListCommentsWithBody,
  })),
  createIssueOperations: vi.fn(() => mockIssueOperations),
  getOpenPRsForIssue: vi.fn().mockResolvedValue([]),
  getLinkedIssues: vi.fn().mockResolvedValue([]),
  getPRBodyLastEditedAt: vi.fn().mockResolvedValue(null),
  loadRepositoryConfig: vi.fn().mockResolvedValue({
    governance: { pr: { maxPRsPerIssue: 3 } },
  }),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    group: vi.fn(),
    groupEnd: vi.fn(),
  },
}));

vi.mock("../api/lib/env-validation.js", () => ({
  getAppConfig: vi.fn(() => {
    throw new Error("test: no env");
  }),
}));

// Mock processImplementationIntake from implementation-intake module
const mockProcessImplementationIntake = vi.fn().mockResolvedValue(undefined);
vi.mock("../api/lib/implementation-intake.js", () => ({
  processImplementationIntake: (...args: unknown[]) => mockProcessImplementationIntake(...args),
}));

// Import after all mocks are in place
import {
  hasReadyToImplementNotification,
  reconcileIssue,
  processRepository,
} from "./reconcile-pr-notifications.js";
import {
  getOpenPRsForIssue,
  createPROperations,
  getLinkedIssues,
  getPRBodyLastEditedAt,
  loadRepositoryConfig,
  logger,
} from "../api/lib/index.js";
import { PR_MESSAGES, LABELS } from "../api/config.js";
import { NOTIFICATION_TYPES } from "../api/lib/bot-comments.js";
import type { PROperations } from "../api/lib/pr-operations.js";
import type { IssueOperations } from "../api/lib/github-client.js";
import type { PRRef } from "../api/lib/index.js";

const mockGetOpenPRsForIssue = vi.mocked(getOpenPRsForIssue);
const mockGetLinkedIssues = vi.mocked(getLinkedIssues);
const mockGetPRBodyLastEditedAt = vi.mocked(getPRBodyLastEditedAt);
const mockLoadRepositoryConfig = vi.mocked(loadRepositoryConfig);

describe("reconcile-pr-notifications", () => {
  const appId = 12345;
  const owner = "test-org";
  const repo = "test-repo";
  const fakeOctokit = {} as any;
  const fakeIssues = mockIssueOperations as unknown as IssueOperations;
  const defaultMaxPRs = 3;

  beforeEach(() => {
    // Freeze time so metadata timestamps in issueReadyToImplement are deterministic
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
    vi.clearAllMocks();
    mockFindPRsWithLabel.mockResolvedValue([]);
    mockHasNotificationCommentInComments.mockReturnValue(false);
    mockListCommentsWithBody.mockResolvedValue([]);
    mockGetLinkedIssues.mockResolvedValue([]);
    mockGetPRBodyLastEditedAt.mockResolvedValue(null);
    mockProcessImplementationIntake.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("hasReadyToImplementNotification", () => {
    const ref: PRRef = { owner, repo, prNumber: 10 };
    const mockPRs = {
      hasNotificationCommentInComments: mockHasNotificationCommentInComments,
      listCommentsWithBody: mockListCommentsWithBody,
    } as unknown as PROperations;

    it("should return true when metadata-tagged notification exists", async () => {
      const comments = [
        { id: 1, body: "metadata comment", performed_via_github_app: { id: appId } },
      ];
      mockListCommentsWithBody.mockResolvedValue(comments);
      mockHasNotificationCommentInComments.mockReturnValue(true);

      const result = await hasReadyToImplementNotification(mockPRs, ref, 42);

      expect(result).toBe(true);
      expect(mockListCommentsWithBody).toHaveBeenCalledWith(ref);
      expect(mockHasNotificationCommentInComments).toHaveBeenCalledWith(
        comments,
        NOTIFICATION_TYPES.VOTING_PASSED,
        42
      );
    });

    it("should return true when pre-metadata comment matches (fallback)", async () => {
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([
        {
          id: 1,
          body: "# 🐝 Issue #42 Ready to Implement ✅\n\nGood news @agent — Issue #42 passed voting and is ready for implementation!",
        },
      ]);

      const result = await hasReadyToImplementNotification(mockPRs, ref, 42);

      expect(result).toBe(true);
    });

    it("should return true when ready-to-implement wording matches (fallback)", async () => {
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([
        {
          id: 1,
          body: "# 🐝 Issue #42 Ready to Implement ✅\n\nGood news @agent — Issue #42 is ready for implementation!\n\nPush a new commit or add a comment to activate it for implementation tracking.",
        },
      ]);

      const result = await hasReadyToImplementNotification(mockPRs, ref, 42);

      expect(result).toBe(true);
    });

    it("should return false when no matching comments exist", async () => {
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([]);

      const result = await hasReadyToImplementNotification(mockPRs, ref, 42);

      expect(result).toBe(false);
    });

    it("should return false when fallback comment is for different issue", async () => {
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([
        {
          id: 1,
          body: "# 🐝 Issue #99 Ready to Implement ✅\n\nIssue #99 passed voting and is ready for implementation!",
        },
      ]);

      const result = await hasReadyToImplementNotification(mockPRs, ref, 42);

      expect(result).toBe(false);
    });

    it("should not false-positive on issue-number prefixes in fallback comments", async () => {
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([
        {
          id: 1,
          body: "# 🐝 Issue #10 Ready to Implement ✅\n\nIssue #10 passed voting and is ready for implementation!",
        },
      ]);

      const result = await hasReadyToImplementNotification(mockPRs, ref, 1);

      expect(result).toBe(false);
    });

    it("should match exact issue number in fallback comments with multiple issue tokens", async () => {
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([
        {
          id: 1,
          body: "Issue #10 passed voting and is ready for implementation. Duplicate mention: Issue #1.",
        },
      ]);

      const result = await hasReadyToImplementNotification(mockPRs, ref, 1);

      expect(result).toBe(true);
    });

    it("should not match fallback tokens with leading zeros", async () => {
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([
        {
          id: 1,
          body: "Issue #01 passed voting and is ready for implementation!",
        },
      ]);

      const result = await hasReadyToImplementNotification(mockPRs, ref, 1);

      expect(result).toBe(false);
    });

    it("should return false when comment body is unrelated", async () => {
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([
        { id: 1, body: "Great work on this PR!" },
        { id: 2, body: "LGTM" },
      ]);

      const result = await hasReadyToImplementNotification(mockPRs, ref, 42);

      expect(result).toBe(false);
    });
  });

  describe("reconcileIssue", () => {
    it("should post notification to un-notified PRs", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "Fix stuff", state: "OPEN", author: { login: "agent-alice" } },
        { number: 20, title: "Another fix", state: "OPEN", author: { login: "agent-bob" } },
      ]);
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([]);

      const prs = createPROperations(fakeOctokit, { appId }) as unknown as PROperations;
      const result = await reconcileIssue(fakeOctokit, prs, fakeIssues, owner, repo, 42, defaultMaxPRs);

      expect(result).toEqual({ notified: 2, skipped: 0 });
      expect(mockComment).toHaveBeenCalledTimes(2);
      expect(mockComment).toHaveBeenCalledWith(
        { owner, repo, prNumber: 10 },
        PR_MESSAGES.issueReadyToImplement(42, "agent-alice")
      );
      expect(mockComment).toHaveBeenCalledWith(
        { owner, repo, prNumber: 20 },
        PR_MESSAGES.issueReadyToImplement(42, "agent-bob")
      );
    });

    it("should skip PRs with implementation label", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "Already tracked", state: "OPEN", author: { login: "agent-alice" } },
        { number: 20, title: "New PR", state: "OPEN", author: { login: "agent-bob" } },
      ]);
      mockFindPRsWithLabel.mockResolvedValue([
        { number: 10, createdAt: new Date(), updatedAt: new Date(), labels: [{ name: LABELS.IMPLEMENTATION }] },
      ]);

      const prs = createPROperations(fakeOctokit, { appId }) as unknown as PROperations;
      const result = await reconcileIssue(fakeOctokit, prs, fakeIssues, owner, repo, 42, defaultMaxPRs);

      expect(result).toEqual({ notified: 1, skipped: 1 });
      expect(mockComment).toHaveBeenCalledTimes(1);
      expect(mockComment).toHaveBeenCalledWith(
        { owner, repo, prNumber: 20 },
        PR_MESSAGES.issueReadyToImplement(42, "agent-bob")
      );
    });

    it("should skip notification but attempt intake for already-notified PRs", async () => {
      const linkedIssues = [{ number: 42, title: "Issue", state: "OPEN" as const, labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] } }];
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "PR", state: "OPEN", author: { login: "agent-alice" } },
      ]);
      mockHasNotificationCommentInComments.mockReturnValue(true);
      mockGetLinkedIssues.mockResolvedValue(linkedIssues);

      const prs = createPROperations(fakeOctokit, { appId }) as unknown as PROperations;
      const result = await reconcileIssue(fakeOctokit, prs, fakeIssues, owner, repo, 42, defaultMaxPRs);

      expect(result).toEqual({ notified: 0, skipped: 1 });
      expect(mockComment).not.toHaveBeenCalled();
      expect(mockGetLinkedIssues).toHaveBeenCalledWith(fakeOctokit, owner, repo, 10);
      expect(mockProcessImplementationIntake).toHaveBeenCalledWith(
        expect.objectContaining({ prNumber: 10, trigger: "updated" })
      );
    });

    it("should handle no linked PRs", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([]);

      const prs = createPROperations(fakeOctokit, { appId }) as unknown as PROperations;
      const result = await reconcileIssue(fakeOctokit, prs, fakeIssues, owner, repo, 42, defaultMaxPRs);

      expect(result).toEqual({ notified: 0, skipped: 0 });
      expect(mockComment).not.toHaveBeenCalled();
    });

    it("should call processImplementationIntake for notified PRs", async () => {
      const linkedIssues = [{ number: 42, title: "Issue", state: "OPEN" as const, labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] } }];
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "PR", state: "OPEN", author: { login: "agent-alice" } },
      ]);
      mockGetLinkedIssues.mockResolvedValue(linkedIssues);
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([]);

      const prs = createPROperations(fakeOctokit, { appId }) as unknown as PROperations;
      await reconcileIssue(fakeOctokit, prs, fakeIssues, owner, repo, 42, defaultMaxPRs);

      expect(mockProcessImplementationIntake).toHaveBeenCalledWith({
        octokit: fakeOctokit,
        issues: fakeIssues,
        prs,
        log: logger,
        owner,
        repo,
        prNumber: 10,
        linkedIssues,
        trigger: "updated",
        maxPRsPerIssue: defaultMaxPRs,
        trustedReviewers: [],
        intake: [{ method: "update" }],
        editedAt: undefined,
      });
    });

    it("should pass non-null bodyLastEditedAt as editedAt to processImplementationIntake", async () => {
      const linkedIssues = [{ number: 42, title: "Issue", state: "OPEN" as const, labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] } }];
      const editDate = new Date("2026-02-10T00:00:00Z");
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "PR", state: "OPEN", author: { login: "agent-alice" } },
      ]);
      mockGetLinkedIssues.mockResolvedValue(linkedIssues);
      mockGetPRBodyLastEditedAt.mockResolvedValue(editDate);
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([]);

      const prs = createPROperations(fakeOctokit, { appId }) as unknown as PROperations;
      await reconcileIssue(fakeOctokit, prs, fakeIssues, owner, repo, 42, defaultMaxPRs);

      expect(mockProcessImplementationIntake).toHaveBeenCalledWith({
        octokit: fakeOctokit,
        issues: fakeIssues,
        prs,
        log: logger,
        owner,
        repo,
        prNumber: 10,
        linkedIssues,
        trigger: "updated",
        maxPRsPerIssue: defaultMaxPRs,
        trustedReviewers: [],
        intake: [{ method: "update" }],
        editedAt: editDate,
      });
    });

    it("should proceed with intake when getPRBodyLastEditedAt fails", async () => {
      const linkedIssues = [{ number: 42, title: "Issue", state: "OPEN" as const, labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] } }];
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "PR", state: "OPEN", author: { login: "agent-alice" } },
      ]);
      mockGetLinkedIssues.mockResolvedValue(linkedIssues);
      mockGetPRBodyLastEditedAt.mockRejectedValue(new Error("GraphQL 502"));
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([]);

      const prs = createPROperations(fakeOctokit, { appId }) as unknown as PROperations;
      const result = await reconcileIssue(fakeOctokit, prs, fakeIssues, owner, repo, 42, defaultMaxPRs);

      // Should still process intake with editedAt: undefined
      expect(mockProcessImplementationIntake).toHaveBeenCalledWith(
        expect.objectContaining({ editedAt: undefined })
      );
      // Should warn about the failure
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("PR #10")
      );
      // Notification should still be counted
      expect(result).toEqual({ notified: 1, skipped: 0 });
    });

    it("should not call processImplementationIntake for already-labeled PRs", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "Already tracked", state: "OPEN", author: { login: "agent-alice" } },
      ]);
      mockFindPRsWithLabel.mockResolvedValue([
        { number: 10, createdAt: new Date(), updatedAt: new Date(), labels: [{ name: LABELS.IMPLEMENTATION }] },
      ]);

      const prs = createPROperations(fakeOctokit, { appId }) as unknown as PROperations;
      await reconcileIssue(fakeOctokit, prs, fakeIssues, owner, repo, 42, defaultMaxPRs);

      expect(mockProcessImplementationIntake).not.toHaveBeenCalled();
    });

    it("should still count notification when processImplementationIntake throws", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "PR", state: "OPEN", author: { login: "agent-alice" } },
      ]);
      mockHasNotificationCommentInComments.mockReturnValue(false);
      mockListCommentsWithBody.mockResolvedValue([]);
      mockGetLinkedIssues.mockResolvedValue([]);
      mockProcessImplementationIntake.mockRejectedValueOnce(new Error("Transient API error"));

      const prs = createPROperations(fakeOctokit, { appId }) as unknown as PROperations;
      const result = await reconcileIssue(fakeOctokit, prs, fakeIssues, owner, repo, 42, defaultMaxPRs);

      // Notification was posted (before the intake call), so notified should be 1
      expect(result).toEqual({ notified: 1, skipped: 0 });
      // Error should be logged, not thrown
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("PR #10"),
        expect.any(Error)
      );
    });

    it("should attempt intake for already-notified but unlabeled PRs", async () => {
      const linkedIssues = [{ number: 42, title: "Issue", state: "OPEN" as const, labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] } }];
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "PR", state: "OPEN", author: { login: "agent-alice" } },
      ]);
      mockHasNotificationCommentInComments.mockReturnValue(true);
      mockGetLinkedIssues.mockResolvedValue(linkedIssues);

      const prs = createPROperations(fakeOctokit, { appId }) as unknown as PROperations;
      await reconcileIssue(fakeOctokit, prs, fakeIssues, owner, repo, 42, defaultMaxPRs);

      expect(mockProcessImplementationIntake).toHaveBeenCalledWith({
        octokit: fakeOctokit,
        issues: fakeIssues,
        prs,
        log: logger,
        owner,
        repo,
        prNumber: 10,
        linkedIssues,
        trigger: "updated",
        maxPRsPerIssue: defaultMaxPRs,
        trustedReviewers: [],
        intake: [{ method: "update" }],
        editedAt: undefined,
      });
    });

    it("should handle intake failure for already-notified PR gracefully", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "PR", state: "OPEN", author: { login: "agent-alice" } },
      ]);
      mockHasNotificationCommentInComments.mockReturnValue(true);
      mockGetLinkedIssues.mockResolvedValue([]);
      mockProcessImplementationIntake.mockRejectedValueOnce(new Error("Transient API error"));

      const prs = createPROperations(fakeOctokit, { appId }) as unknown as PROperations;
      const result = await reconcileIssue(fakeOctokit, prs, fakeIssues, owner, repo, 42, defaultMaxPRs);

      // Notification was already posted (skipped), so skipped should be 1
      expect(result).toEqual({ notified: 0, skipped: 1 });
      expect(mockComment).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("PR #10"),
        expect.any(Error)
      );
    });

    it("should not attempt intake for already-labeled PRs (even if notified)", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "Already tracked", state: "OPEN", author: { login: "agent-alice" } },
      ]);
      mockFindPRsWithLabel.mockResolvedValue([
        { number: 10, createdAt: new Date(), updatedAt: new Date(), labels: [{ name: LABELS.IMPLEMENTATION }] },
      ]);
      // Even though it has notification, it should short-circuit before checking
      mockHasNotificationCommentInComments.mockReturnValue(true);

      const prs = createPROperations(fakeOctokit, { appId }) as unknown as PROperations;
      await reconcileIssue(fakeOctokit, prs, fakeIssues, owner, repo, 42, defaultMaxPRs);

      expect(mockProcessImplementationIntake).not.toHaveBeenCalled();
      expect(mockListCommentsWithBody).not.toHaveBeenCalled();
    });
  });

  describe("processRepository", () => {
    /** Create a mock octokit with paginate.iterator returning one page of items */
    function createMockOctokit(items: any[]) {
      const mockListForRepo = vi.fn();
      return {
        octokit: {
          paginate: {
            iterator: vi.fn().mockImplementation(() =>
              (async function* () {
                yield { data: items };
              })()
            ),
          },
          rest: {
            issues: { listForRepo: mockListForRepo },
          },
        } as any,
        mockListForRepo,
      };
    }

    it("should skip processing when PR workflows are disabled (pr: null)", async () => {
      mockLoadRepositoryConfig.mockResolvedValueOnce({
        governance: { pr: null },
      } as any);

      const { octokit: mockOctokit } = createMockOctokit([]);
      const repoObj = { owner: { login: owner }, name: repo, full_name: `${owner}/${repo}` };
      await processRepository(mockOctokit, repoObj, appId);

      expect(mockOctokit.paginate.iterator).not.toHaveBeenCalled();
    });

    it("should process ready-to-implement issues", async () => {
      const { octokit: mockOctokit } = createMockOctokit([
        { number: 42, labels: [{ name: LABELS.READY_TO_IMPLEMENT }] },
        { number: 43, labels: [{ name: LABELS.READY_TO_IMPLEMENT }] },
      ]);

      mockGetOpenPRsForIssue.mockResolvedValue([]);

      const repoObj = { owner: { login: owner }, name: repo, full_name: `${owner}/${repo}` };
      await processRepository(mockOctokit, repoObj, appId);

      expect(mockOctokit.paginate.iterator).toHaveBeenCalledWith(
        mockOctokit.rest.issues.listForRepo,
        {
          owner,
          repo,
          state: "open",
          labels: LABELS.READY_TO_IMPLEMENT,
          per_page: 100,
        }
      );
    });

    it("should skip items with pull_request property (PRs, not issues)", async () => {
      const { octokit: mockOctokit } = createMockOctokit([
        { number: 42, labels: [{ name: LABELS.READY_TO_IMPLEMENT }] },
        { number: 43, labels: [{ name: LABELS.READY_TO_IMPLEMENT }], pull_request: { url: "..." } },
      ]);

      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "PR", state: "OPEN", author: { login: "agent" } },
      ]);

      const repoObj = { owner: { login: owner }, name: repo, full_name: `${owner}/${repo}` };
      await processRepository(mockOctokit, repoObj, appId);

      // getOpenPRsForIssue should only be called for issue #42 (not #43 which is a PR)
      expect(mockGetOpenPRsForIssue).toHaveBeenCalledTimes(1);
      expect(mockGetOpenPRsForIssue).toHaveBeenCalledWith(mockOctokit, owner, repo, 42);
    });

    it("should handle empty repository (no ready issues)", async () => {
      const { octokit: mockOctokit } = createMockOctokit([]);

      const repoObj = { owner: { login: owner }, name: repo, full_name: `${owner}/${repo}` };
      await processRepository(mockOctokit, repoObj, appId);

      expect(mockGetOpenPRsForIssue).not.toHaveBeenCalled();
    });

    it("should continue after per-issue errors, then throw aggregate error", async () => {
      const { octokit: mockOctokit } = createMockOctokit([
        { number: 42, labels: [{ name: LABELS.READY_TO_IMPLEMENT }] },
        { number: 43, labels: [{ name: LABELS.READY_TO_IMPLEMENT }] },
      ]);

      // First issue fails, second succeeds
      mockGetOpenPRsForIssue
        .mockRejectedValueOnce(new Error("API error"))
        .mockResolvedValueOnce([]);

      const repoObj = { owner: { login: owner }, name: repo, full_name: `${owner}/${repo}` };

      // Should throw aggregate error after processing all issues
      await expect(processRepository(mockOctokit, repoObj, appId)).rejects.toThrow(
        "Failed to reconcile 1 issue(s): #42"
      );

      // Should log error for first issue but still process second
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("#42"),
        expect.any(Error)
      );
      expect(mockGetOpenPRsForIssue).toHaveBeenCalledTimes(2);
    });

    it("should throw when loadRepositoryConfig fails (no issues reconciled)", async () => {
      mockLoadRepositoryConfig.mockRejectedValueOnce(new Error("Config file parse error"));

      const { octokit: mockOctokit } = createMockOctokit([
        { number: 42, labels: [{ name: LABELS.READY_TO_IMPLEMENT }] },
      ]);

      const repoObj = { owner: { login: owner }, name: repo, full_name: `${owner}/${repo}` };

      await expect(processRepository(mockOctokit, repoObj, appId)).rejects.toThrow(
        "Config file parse error"
      );

      // No issues should be reconciled because config loading happens first
      expect(mockGetOpenPRsForIssue).not.toHaveBeenCalled();
    });

    it("should load repository config and pass maxPRsPerIssue", async () => {
      mockLoadRepositoryConfig.mockResolvedValue({
        governance: { pr: { maxPRsPerIssue: 5 } },
      } as any);

      const { octokit: mockOctokit } = createMockOctokit([
        { number: 42, labels: [{ name: LABELS.READY_TO_IMPLEMENT }] },
      ]);

      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "PR", state: "OPEN", author: { login: "agent" } },
      ]);
      mockGetLinkedIssues.mockResolvedValue([]);

      const repoObj = { owner: { login: owner }, name: repo, full_name: `${owner}/${repo}` };
      await processRepository(mockOctokit, repoObj, appId);

      expect(mockLoadRepositoryConfig).toHaveBeenCalledWith(mockOctokit, owner, repo);
      // processImplementationIntake should receive maxPRsPerIssue from config
      expect(mockProcessImplementationIntake).toHaveBeenCalledWith(
        expect.objectContaining({ maxPRsPerIssue: 5 })
      );
    });
  });
});
