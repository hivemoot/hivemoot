import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for close-discussions script logic
 *
 * Tests the phase transition orchestration functions.
 * The script's main() function is tested indirectly through
 * the processIssuePhase and processRepository functions.
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

// Suppress unhandled rejection from module-level main().catch() calling process.exit(1).
// Vitest intercepts process.exit and throws — this catches that error.
process.on("unhandledRejection", () => {});

// Mock API lib — provides mocks for notifyPendingPRs dependencies
// and prevents main() from doing real work
const mockComment = vi.fn().mockResolvedValue(undefined);
const mockFindPRsWithLabel = vi.fn().mockResolvedValue([]);
const mockHasNotificationComment = vi.fn().mockResolvedValue(false);

vi.mock("../api/lib/index.js", () => ({
  createIssueOperations: vi.fn(),
  createPROperations: vi.fn(() => ({
    comment: mockComment,
    findPRsWithLabel: mockFindPRsWithLabel,
    hasNotificationComment: mockHasNotificationComment,
  })),
  createGovernanceService: vi.fn(),
  getOpenPRsForIssue: vi.fn().mockResolvedValue([]),
  isAutoDiscussionExit: (exit: { type?: string }) => exit.type === "auto",
  isAutoVotingExit: (exit: { type?: string }) => exit.type === "auto",
  loadRepositoryConfig: vi.fn(),
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

// Import after all mocks are in place
import {
  notifyPendingPRs,
  isRetryableError,
  withRetry,
  makeEarlyDecisionCheck,
  makeDiscussionEarlyCheck,
  processIssuePhase,
  hasAutoExits,
  hasAutomaticGovernancePhases,
  processRepository,
  reconcileMissingVotingComments,
  reconcileUnlabeledIssues,
} from "./close-discussions.js";
import type { EarlyDecisionDeps, DiscussionEarlyCheckDeps } from "./close-discussions.js";
import { getOpenPRsForIssue, logger, loadRepositoryConfig, createIssueOperations, createGovernanceService } from "../api/lib/index.js";
import { PR_MESSAGES } from "../api/config.js";
import type {
  VotingOutcome,
  IssueRef,
  ValidatedVoteResult,
  DiscussionAutoExit,
  VotingAutoExit,
} from "../api/lib/index.js";

const mockGetOpenPRsForIssue = vi.mocked(getOpenPRsForIssue);
const mockLoadRepositoryConfig = vi.mocked(loadRepositoryConfig);
const mockCreateIssueOperations = vi.mocked(createIssueOperations);
const mockCreateGovernanceService = vi.mocked(createGovernanceService);

function buildIterator<T>(pages: T[][]): AsyncIterable<{ data: T[] }> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const page of pages) {
        yield { data: page };
      }
    },
  };
}

describe("close-discussions script", () => {
  function makeRepoConfig(mode: "manual" | "auto") {
    const discussionExits =
      mode === "auto"
        ? [{ type: "auto", afterMs: 60_000, minReady: 0, requiredReady: { minCount: 0, users: [] } }]
        : [{ type: "manual" }];
    const votingExits =
      mode === "auto"
        ? [{ type: "auto", afterMs: 60_000, requires: "majority", minVoters: 0, requiredVoters: { minCount: 0, voters: [] } }]
        : [{ type: "manual" }];

    return {
      version: 1,
      governance: {
        proposals: {
          discussion: {
            durationMs: mode === "auto" ? 60_000 : 0,
            exits: discussionExits,
          },
          voting: {
            durationMs: mode === "auto" ? 60_000 : 0,
            exits: votingExits,
          },
          extendedVoting: {
            durationMs: mode === "auto" ? 60_000 : 0,
            exits: votingExits,
          },
        },
        pr: {
          staleDays: 3,
          maxPRsPerIssue: 3,
          trustedReviewers: [],
          intake: [{ method: "update" }],
          mergeReady: null,
        },
      },
      standup: { enabled: false, category: "" },
    } as any;
  }

  describe("hasAutoExits", () => {
    it("should return true when at least one auto exit exists", () => {
      expect(hasAutoExits([{ type: "manual" }, { type: "auto" }])).toBe(true);
    });

    it("should return false when all exits are manual", () => {
      expect(hasAutoExits([{ type: "manual" }])).toBe(false);
    });
  });

  describe("hasAutomaticGovernancePhases", () => {
    it("should return false when all phases are manual", () => {
      expect(hasAutomaticGovernancePhases(makeRepoConfig("manual"))).toBe(false);
    });

    it("should return true when any phase has auto exits", () => {
      expect(hasAutomaticGovernancePhases(makeRepoConfig("auto"))).toBe(true);
    });
  });

  describe("reconcileMissingVotingComments", () => {
    const owner = "test-org";
    const repoName = "test-repo";

    it("should post voting comment for issues missing it", async () => {
      const mockGovernance = {
        postVotingComment: vi.fn().mockResolvedValue("posted"),
      } as any;

      const fakeOctokit = {
        rest: { issues: { listForRepo: vi.fn() } },
        paginate: {
          iterator: vi.fn().mockReturnValue(
            buildIterator([[{ number: 10 }, { number: 20 }]])
          ),
        },
      } as any;

      const count = await reconcileMissingVotingComments(fakeOctokit, owner, repoName, mockGovernance);

      expect(count).toBe(2);
      expect(mockGovernance.postVotingComment).toHaveBeenCalledTimes(2);
      expect(mockGovernance.postVotingComment).toHaveBeenCalledWith({ owner, repo: repoName, issueNumber: 10 });
      expect(mockGovernance.postVotingComment).toHaveBeenCalledWith({ owner, repo: repoName, issueNumber: 20 });
    });

    it("should skip issues where voting comment already exists", async () => {
      const mockGovernance = {
        postVotingComment: vi.fn().mockResolvedValue("skipped"),
      } as any;

      const fakeOctokit = {
        rest: { issues: { listForRepo: vi.fn() } },
        paginate: {
          iterator: vi.fn().mockReturnValue(
            buildIterator([[{ number: 10 }]])
          ),
        },
      } as any;

      const count = await reconcileMissingVotingComments(fakeOctokit, owner, repoName, mockGovernance);

      expect(count).toBe(0);
      expect(mockGovernance.postVotingComment).toHaveBeenCalledTimes(1);
    });

    it("should skip pull requests", async () => {
      const mockGovernance = {
        postVotingComment: vi.fn().mockResolvedValue("posted"),
      } as any;

      const fakeOctokit = {
        rest: { issues: { listForRepo: vi.fn() } },
        paginate: {
          iterator: vi.fn().mockReturnValue(
            buildIterator([[
              { number: 10 },
              { number: 11, pull_request: {} },
              { number: 20 },
            ]])
          ),
        },
      } as any;

      const count = await reconcileMissingVotingComments(fakeOctokit, owner, repoName, mockGovernance);

      expect(count).toBe(2);
      expect(mockGovernance.postVotingComment).toHaveBeenCalledTimes(2);
    });

    it("should survive per-issue errors and continue processing", async () => {
      const mockGovernance = {
        postVotingComment: vi.fn()
          .mockRejectedValueOnce(new Error("API error"))
          .mockResolvedValueOnce("posted"),
      } as any;

      const fakeOctokit = {
        rest: { issues: { listForRepo: vi.fn() } },
        paginate: {
          iterator: vi.fn().mockReturnValue(
            buildIterator([[{ number: 10 }, { number: 20 }]])
          ),
        },
      } as any;

      const count = await reconcileMissingVotingComments(fakeOctokit, owner, repoName, mockGovernance);

      expect(count).toBe(1); // Only #20 succeeded
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to reconcile #10"),
      );
    });

    it("should return 0 when there are no voting issues", async () => {
      const mockGovernance = { postVotingComment: vi.fn() } as any;

      const fakeOctokit = {
        rest: { issues: { listForRepo: vi.fn() } },
        paginate: {
          iterator: vi.fn().mockReturnValue(
            buildIterator([[]])
          ),
        },
      } as any;

      const count = await reconcileMissingVotingComments(fakeOctokit, owner, repoName, mockGovernance);

      expect(count).toBe(0);
      expect(mockGovernance.postVotingComment).not.toHaveBeenCalled();
    });

    it("should include installationId when provided", async () => {
      const mockGovernance = {
        postVotingComment: vi.fn().mockResolvedValue("posted"),
      } as any;

      const fakeOctokit = {
        rest: { issues: { listForRepo: vi.fn() } },
        paginate: {
          iterator: vi.fn().mockReturnValue(
            buildIterator([[{ number: 10 }]])
          ),
        },
      } as any;

      await reconcileMissingVotingComments(fakeOctokit, owner, repoName, mockGovernance, 999);

      expect(mockGovernance.postVotingComment).toHaveBeenCalledWith({
        owner,
        repo: repoName,
        issueNumber: 10,
        installationId: 999,
      });
    });
  });

  describe("reconcileUnlabeledIssues", () => {
    const owner = "test-org";
    const repoName = "test-repo";

    it("should call startDiscussion for issues with no hivemoot:* labels", async () => {
      const mockGovernance = {
        startDiscussion: vi.fn().mockResolvedValue(undefined),
      } as any;

      const fakeOctokit = {
        rest: { issues: { listForRepo: vi.fn() } },
        paginate: {
          iterator: vi.fn().mockReturnValue(
            buildIterator([[
              { number: 10, labels: [] },
              { number: 20, labels: [] },
            ]])
          ),
        },
      } as any;

      const count = await reconcileUnlabeledIssues(fakeOctokit, owner, repoName, mockGovernance);

      expect(count).toBe(2);
      expect(mockGovernance.startDiscussion).toHaveBeenCalledTimes(2);
      expect(mockGovernance.startDiscussion).toHaveBeenCalledWith({ owner, repo: repoName, issueNumber: 10 });
      expect(mockGovernance.startDiscussion).toHaveBeenCalledWith({ owner, repo: repoName, issueNumber: 20 });
    });

    it("should skip issues that already have any hivemoot:* label", async () => {
      const mockGovernance = {
        startDiscussion: vi.fn().mockResolvedValue(undefined),
      } as any;

      const fakeOctokit = {
        rest: { issues: { listForRepo: vi.fn() } },
        paginate: {
          iterator: vi.fn().mockReturnValue(
            buildIterator([[
              { number: 10, labels: [{ name: "hivemoot:discussion" }] },
              { number: 20, labels: [{ name: "hivemoot:voting" }] },
              { number: 30, labels: [] },
            ]])
          ),
        },
      } as any;

      const count = await reconcileUnlabeledIssues(fakeOctokit, owner, repoName, mockGovernance);

      expect(count).toBe(1);
      expect(mockGovernance.startDiscussion).toHaveBeenCalledTimes(1);
      expect(mockGovernance.startDiscussion).toHaveBeenCalledWith({ owner, repo: repoName, issueNumber: 30 });
    });

    it("should skip pull requests", async () => {
      const mockGovernance = {
        startDiscussion: vi.fn().mockResolvedValue(undefined),
      } as any;

      const fakeOctokit = {
        rest: { issues: { listForRepo: vi.fn() } },
        paginate: {
          iterator: vi.fn().mockReturnValue(
            buildIterator([[
              { number: 10, labels: [] },
              { number: 11, labels: [], pull_request: {} },
              { number: 20, labels: [] },
            ]])
          ),
        },
      } as any;

      const count = await reconcileUnlabeledIssues(fakeOctokit, owner, repoName, mockGovernance);

      expect(count).toBe(2);
      expect(mockGovernance.startDiscussion).toHaveBeenCalledTimes(2);
      expect(mockGovernance.startDiscussion).not.toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 11 })
      );
    });

    it("should survive per-issue errors and continue processing", async () => {
      const mockGovernance = {
        startDiscussion: vi.fn()
          .mockRejectedValueOnce(new Error("API error"))
          .mockResolvedValueOnce(undefined),
      } as any;

      const fakeOctokit = {
        rest: { issues: { listForRepo: vi.fn() } },
        paginate: {
          iterator: vi.fn().mockReturnValue(
            buildIterator([[{ number: 10, labels: [] }, { number: 20, labels: [] }]])
          ),
        },
      } as any;

      const count = await reconcileUnlabeledIssues(fakeOctokit, owner, repoName, mockGovernance);

      expect(count).toBe(1); // Only #20 succeeded
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to reconcile unlabeled issue #10"),
      );
    });

    it("should return 0 when there are no unlabeled issues", async () => {
      const mockGovernance = { startDiscussion: vi.fn() } as any;

      const fakeOctokit = {
        rest: { issues: { listForRepo: vi.fn() } },
        paginate: {
          iterator: vi.fn().mockReturnValue(
            buildIterator([[{ number: 10, labels: [{ name: "hivemoot:ready-to-implement" }] }]])
          ),
        },
      } as any;

      const count = await reconcileUnlabeledIssues(fakeOctokit, owner, repoName, mockGovernance);

      expect(count).toBe(0);
      expect(mockGovernance.startDiscussion).not.toHaveBeenCalled();
    });

    it("should return 0 for an empty repository", async () => {
      const mockGovernance = { startDiscussion: vi.fn() } as any;

      const fakeOctokit = {
        rest: { issues: { listForRepo: vi.fn() } },
        paginate: {
          iterator: vi.fn().mockReturnValue(buildIterator([[]])),
        },
      } as any;

      const count = await reconcileUnlabeledIssues(fakeOctokit, owner, repoName, mockGovernance);

      expect(count).toBe(0);
      expect(mockGovernance.startDiscussion).not.toHaveBeenCalled();
    });

    it("should include installationId when provided", async () => {
      const mockGovernance = {
        startDiscussion: vi.fn().mockResolvedValue(undefined),
      } as any;

      const fakeOctokit = {
        rest: { issues: { listForRepo: vi.fn() } },
        paginate: {
          iterator: vi.fn().mockReturnValue(
            buildIterator([[{ number: 10, labels: [] }]])
          ),
        },
      } as any;

      await reconcileUnlabeledIssues(fakeOctokit, owner, repoName, mockGovernance, 999);

      expect(mockGovernance.startDiscussion).toHaveBeenCalledWith({
        owner,
        repo: repoName,
        issueNumber: 10,
        installationId: 999,
      });
    });

    it("should skip issues with non-hivemoot labels but no hivemoot:* label", async () => {
      const mockGovernance = {
        startDiscussion: vi.fn().mockResolvedValue(undefined),
      } as any;

      const fakeOctokit = {
        rest: { issues: { listForRepo: vi.fn() } },
        paginate: {
          iterator: vi.fn().mockReturnValue(
            buildIterator([[
              { number: 10, labels: [{ name: "bug" }, { name: "help wanted" }] },
              { number: 20, labels: [{ name: "hivemoot:discussion" }] },
            ]])
          ),
        },
      } as any;

      const count = await reconcileUnlabeledIssues(fakeOctokit, owner, repoName, mockGovernance);

      // #10 has no hivemoot:* label so it is reconciled; #20 already has one
      expect(count).toBe(1);
      expect(mockGovernance.startDiscussion).toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 10 })
      );
      expect(mockGovernance.startDiscussion).not.toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 20 })
      );
    });
  });

  describe("processRepository gating", () => {
    const repo = {
      owner: { login: "test-org" },
      name: "test-repo",
      full_name: "test-org/test-repo",
    } as any;
    const appId = 123;
    const emptyIterator = async function* () {
      // No issues in any phase
    };

    it("should run reconciliation even when all exits are manual, then skip transitions", async () => {
      const mockGovernance = { postVotingComment: vi.fn() } as any;
      mockCreateGovernanceService.mockReturnValue(mockGovernance);

      const fakeOctokit = {
        rest: {
          issues: {
            listForRepo: vi.fn(),
          },
        },
        paginate: {
          iterator: vi.fn().mockReturnValue(emptyIterator()),
        },
      } as any;
      mockLoadRepositoryConfig.mockResolvedValue(makeRepoConfig("manual"));

      const result = await processRepository(fakeOctokit, repo, appId);

      expect(result).toEqual({ skippedIssues: [], accessIssues: [] });
      // Services ARE created now (for reconciliation)
      expect(mockCreateIssueOperations).toHaveBeenCalled();
      expect(mockCreateGovernanceService).toHaveBeenCalled();
      // But scheduled transitions are still skipped
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("all proposal exits are manual")
      );
    });

    it("should continue processing when at least one phase is auto", async () => {
      const mockGovernance = { postVotingComment: vi.fn() } as any;
      mockCreateGovernanceService.mockReturnValue(mockGovernance);

      const fakeOctokit = {
        rest: {
          issues: {
            listForRepo: vi.fn(),
          },
        },
        paginate: {
          iterator: vi.fn().mockReturnValue(emptyIterator()),
        },
      } as any;
      mockLoadRepositoryConfig.mockResolvedValue(makeRepoConfig("auto"));

      await processRepository(fakeOctokit, repo, appId);

      expect(mockCreateIssueOperations).toHaveBeenCalled();
    });

    it("should continue with phase transitions when reconciliation fails", async () => {
      const mockGovernance = { postVotingComment: vi.fn() } as any;
      mockCreateGovernanceService.mockReturnValue(mockGovernance);

      // First call (reconciliation) throws; subsequent calls (phase iteration) succeed
      const mockIterator = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("Paginator exploded");
        })
        .mockReturnValue(emptyIterator());

      const fakeOctokit = {
        rest: {
          issues: {
            listForRepo: vi.fn(),
          },
        },
        paginate: {
          iterator: mockIterator,
        },
      } as any;
      mockLoadRepositoryConfig.mockResolvedValue(makeRepoConfig("auto"));

      const result = await processRepository(fakeOctokit, repo, appId);

      // Reconciliation failure was caught and logged
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Reconciliation failed"),
      );
      // Phase transitions still ran (paginate.iterator called for phase issues)
      expect(mockIterator.mock.calls.length).toBeGreaterThan(1);
      // No skipped or access issues from the empty iterator
      expect(result).toEqual({ skippedIssues: [], accessIssues: [] });
    });

    it("should thread installationId through reconciliation and transitions", async () => {
      const mockGovernance = {
        postVotingComment: vi.fn().mockResolvedValue("posted"),
        transitionToVoting: vi.fn().mockResolvedValue(undefined),
        startDiscussion: vi.fn().mockResolvedValue(undefined),
      } as any;
      mockCreateGovernanceService.mockReturnValue(mockGovernance);

      const discussionOnlyAutoConfig = makeRepoConfig("manual");
      discussionOnlyAutoConfig.governance.proposals.discussion.exits = [
        { type: "auto", afterMs: 60_000, minReady: 0, requiredReady: { minCount: 0, users: [] } },
      ];

      const mockIssues = {
        getLabelAddedTime: vi.fn().mockResolvedValue(new Date(Date.now() - 120_000)),
        getDiscussionReadiness: vi.fn().mockResolvedValue(new Set<string>()),
      } as any;
      mockCreateIssueOperations.mockReturnValue(mockIssues);

      const fakeOctokit = {
        rest: {
          issues: {
            listForRepo: vi.fn(),
          },
        },
        // Issue has hivemoot:discussion label so reconcileUnlabeledIssues skips it;
        // reconcileMissingVotingComments and phase transitions still process it.
        paginate: {
          iterator: vi.fn().mockReturnValue(buildIterator([[{ number: 42, labels: [{ name: "hivemoot:discussion" }] }]])),
        },
      } as any;
      mockLoadRepositoryConfig.mockResolvedValue(discussionOnlyAutoConfig);

      await processRepository(fakeOctokit, repo, appId, { installationId: 321 });

      expect(mockGovernance.postVotingComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issueNumber: 42,
        installationId: 321,
      });
      expect(mockGovernance.transitionToVoting).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issueNumber: 42,
        installationId: 321,
      });
    });
  });

  describe("processIssuePhase", () => {
    const ref: IssueRef = { owner: "test-org", repo: "test-repo", issueNumber: 42 };
    const labelName = "governance:discussion";
    const phaseName = "discussion";
    const durationMs = 5 * 60 * 1000; // 5 minutes

    let mockGetLabelAddedTime: ReturnType<typeof vi.fn>;
    let mockIssues: { getLabelAddedTime: ReturnType<typeof vi.fn> };
    let transitionFn: ReturnType<typeof vi.fn>;
    let onAccessIssue: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
      vi.clearAllMocks();

      mockGetLabelAddedTime = vi.fn();
      mockIssues = { getLabelAddedTime: mockGetLabelAddedTime };
      transitionFn = vi.fn().mockResolvedValue(undefined);
      onAccessIssue = vi.fn();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should call transitionFn when elapsed time exceeds duration", async () => {
      mockGetLabelAddedTime.mockResolvedValue(new Date(Date.now() - 10 * 60 * 1000));

      await processIssuePhase(
        mockIssues as any, {} as any, ref, labelName, durationMs, phaseName, transitionFn
      );

      expect(transitionFn).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Transitioning #42")
      );
    });

    it("should not transition when elapsed time is less than duration", async () => {
      mockGetLabelAddedTime.mockResolvedValue(new Date(Date.now() - 2 * 60 * 1000));

      await processIssuePhase(
        mockIssues as any, {} as any, ref, labelName, durationMs, phaseName, transitionFn
      );

      expect(transitionFn).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("remaining in discussion")
      );
    });

    it("should log remaining time in minutes and seconds", async () => {
      // 2 minutes elapsed → 3m 0s remaining
      mockGetLabelAddedTime.mockResolvedValue(new Date(Date.now() - 2 * 60 * 1000));

      await processIssuePhase(
        mockIssues as any, {} as any, ref, labelName, durationMs, phaseName, transitionFn
      );

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringMatching(/3m 0s remaining/)
      );
    });

    it("should return early when label time cannot be determined", async () => {
      mockGetLabelAddedTime.mockResolvedValue(null);

      await processIssuePhase(
        mockIssues as any, {} as any, ref, labelName, durationMs, phaseName, transitionFn
      );

      expect(transitionFn).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Could not determine")
      );
    });

    it("should run earlyCheck when provided and elapsed < duration", async () => {
      mockGetLabelAddedTime.mockResolvedValue(new Date(Date.now() - 2 * 60 * 1000));
      const earlyCheck = vi.fn().mockResolvedValue(true);

      await processIssuePhase(
        mockIssues as any, {} as any, ref, labelName, durationMs, phaseName,
        transitionFn, onAccessIssue, earlyCheck
      );

      expect(earlyCheck).toHaveBeenCalledWith(ref, expect.any(Number));
      expect(transitionFn).not.toHaveBeenCalled();
    });

    it("should skip earlyCheck when elapsed >= duration", async () => {
      mockGetLabelAddedTime.mockResolvedValue(new Date(Date.now() - 10 * 60 * 1000));
      const earlyCheck = vi.fn().mockResolvedValue(true);

      await processIssuePhase(
        mockIssues as any, {} as any, ref, labelName, durationMs, phaseName,
        transitionFn, onAccessIssue, earlyCheck
      );

      expect(earlyCheck).not.toHaveBeenCalled();
      expect(transitionFn).toHaveBeenCalledTimes(1);
    });

    it("should fall through to timer when earlyCheck returns false", async () => {
      mockGetLabelAddedTime.mockResolvedValue(new Date(Date.now() - 2 * 60 * 1000));
      const earlyCheck = vi.fn().mockResolvedValue(false);

      await processIssuePhase(
        mockIssues as any, {} as any, ref, labelName, durationMs, phaseName,
        transitionFn, onAccessIssue, earlyCheck
      );

      expect(earlyCheck).toHaveBeenCalled();
      expect(transitionFn).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("remaining in discussion")
      );
    });

    it("should handle 404 errors gracefully (deleted issue)", async () => {
      mockGetLabelAddedTime.mockRejectedValue(
        Object.assign(new Error("Not Found"), { status: 404 })
      );

      await processIssuePhase(
        mockIssues as any, {} as any, ref, labelName, durationMs, phaseName, transitionFn
      );

      expect(transitionFn).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("not found")
      );
    });

    it("should handle 410 errors gracefully (gone issue)", async () => {
      mockGetLabelAddedTime.mockRejectedValue(
        Object.assign(new Error("Gone"), { status: 410 })
      );

      await processIssuePhase(
        mockIssues as any, {} as any, ref, labelName, durationMs, phaseName, transitionFn
      );

      expect(transitionFn).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("not found")
      );
    });

    it("should report rate-limited issues via onAccessIssue", async () => {
      // Bare 429 is not retryable by withRetry, but caught by processIssuePhase
      mockGetLabelAddedTime.mockRejectedValue(
        Object.assign(new Error("Too Many Requests"), { status: 429 })
      );

      await processIssuePhase(
        mockIssues as any, {} as any, ref, labelName, durationMs, phaseName,
        transitionFn, onAccessIssue
      );

      expect(onAccessIssue).toHaveBeenCalledWith(ref, 429, "rate_limit");
      expect(transitionFn).not.toHaveBeenCalled();
    });

    it("should report forbidden issues via onAccessIssue", async () => {
      // Bare 403 without rate-limit indicators → classified as forbidden
      mockGetLabelAddedTime.mockRejectedValue(
        Object.assign(new Error("Forbidden"), { status: 403 })
      );

      await processIssuePhase(
        mockIssues as any, {} as any, ref, labelName, durationMs, phaseName,
        transitionFn, onAccessIssue
      );

      expect(onAccessIssue).toHaveBeenCalledWith(ref, 403, "forbidden");
      expect(transitionFn).not.toHaveBeenCalled();
    });

    it("should not call onAccessIssue when it is not provided", async () => {
      mockGetLabelAddedTime.mockRejectedValue(
        Object.assign(new Error("Forbidden"), { status: 403 })
      );

      // Should not throw even without onAccessIssue callback
      await processIssuePhase(
        mockIssues as any, {} as any, ref, labelName, durationMs, phaseName, transitionFn
      );

      expect(transitionFn).not.toHaveBeenCalled();
    });

    it("should rethrow unexpected errors", async () => {
      mockGetLabelAddedTime.mockRejectedValue(
        Object.assign(new Error("Internal Server Error"), { status: 500 })
      );

      await expect(
        processIssuePhase(
          mockIssues as any, {} as any, ref, labelName, durationMs, phaseName, transitionFn
        )
      ).rejects.toThrow("Internal Server Error");
    });
  });

  describe("notifyPendingPRs", () => {
    const fakeOctokit = {} as any;
    const appId = 12345;
    const owner = "test-org";
    const repo = "test-repo";
    const issueNumber = 42;

    beforeEach(() => {
      // Freeze time so metadata timestamps in issueReadyToImplement are deterministic
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
      vi.clearAllMocks();
      mockFindPRsWithLabel.mockResolvedValue([]);
      mockHasNotificationComment.mockResolvedValue(false);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should post notification to linked PRs with author mention", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "Fix stuff", state: "OPEN", author: { login: "agent-alice" } },
        { number: 20, title: "Another fix", state: "OPEN", author: { login: "agent-bob" } },
      ]);

      await notifyPendingPRs(fakeOctokit, appId, owner, repo, issueNumber);

      expect(mockComment).toHaveBeenCalledTimes(2);
      expect(mockComment).toHaveBeenCalledWith(
        { owner, repo, prNumber: 10 },
        PR_MESSAGES.issueReadyToImplement(issueNumber, "agent-alice")
      );
      expect(mockComment).toHaveBeenCalledWith(
        { owner, repo, prNumber: 20 },
        PR_MESSAGES.issueReadyToImplement(issueNumber, "agent-bob")
      );
    });

    it("should skip PRs that already have implementation label", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "Already tracked", state: "OPEN", author: { login: "agent-alice" } },
        { number: 20, title: "New PR", state: "OPEN", author: { login: "agent-bob" } },
      ]);
      mockFindPRsWithLabel.mockResolvedValue([
        { number: 10, createdAt: new Date(), updatedAt: new Date(), labels: [{ name: "hivemoot:candidate" }] },
      ]);

      await notifyPendingPRs(fakeOctokit, appId, owner, repo, issueNumber);

      expect(mockComment).toHaveBeenCalledTimes(1);
      expect(mockComment).toHaveBeenCalledWith(
        { owner, repo, prNumber: 20 },
        PR_MESSAGES.issueReadyToImplement(issueNumber, "agent-bob")
      );
    });

    it("should handle issues with no linked PRs", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([]);

      await notifyPendingPRs(fakeOctokit, appId, owner, repo, issueNumber);

      expect(mockComment).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining(`#${issueNumber}`)
      );
    });

    it("should handle API errors gracefully without throwing", async () => {
      mockGetOpenPRsForIssue.mockRejectedValue(new Error("API rate limit"));

      // Should not throw
      await notifyPendingPRs(fakeOctokit, appId, owner, repo, issueNumber);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("API rate limit")
      );
    });

    it("should skip PRs that already have a notification comment", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "Already notified", state: "OPEN", author: { login: "agent-alice" } },
        { number: 20, title: "New PR", state: "OPEN", author: { login: "agent-bob" } },
      ]);
      // PR #10 already has a notification, PR #20 does not
      mockHasNotificationComment
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      await notifyPendingPRs(fakeOctokit, appId, owner, repo, issueNumber);

      expect(mockComment).toHaveBeenCalledTimes(1);
      expect(mockComment).toHaveBeenCalledWith(
        { owner, repo, prNumber: 20 },
        PR_MESSAGES.issueReadyToImplement(issueNumber, "agent-bob")
      );
    });

    it("should use issueReadyToImplement message, not issueReadyNeedsUpdate", async () => {
      mockGetOpenPRsForIssue.mockResolvedValue([
        { number: 10, title: "My PR", state: "OPEN", author: { login: "agent-alice" } },
      ]);

      await notifyPendingPRs(fakeOctokit, appId, owner, repo, issueNumber);

      const commentBody = mockComment.mock.calls[0][1] as string;
      // issueReadyToImplement includes "is ready for implementation"
      expect(commentBody).toContain("is ready for implementation");
      // issueReadyNeedsUpdate includes "opened before approval" — should NOT appear
      expect(commentBody).not.toContain("opened before approval");
    });
  });

  describe("isRetryableError", () => {
    it("should return true for 502 Bad Gateway", () => {
      expect(isRetryableError({ status: 502 })).toBe(true);
    });

    it("should return true for 503 Service Unavailable", () => {
      expect(isRetryableError({ status: 503 })).toBe(true);
    });

    it("should return true for 504 Gateway Timeout", () => {
      expect(isRetryableError({ status: 504 })).toBe(true);
    });

    it("should return true for ETIMEDOUT network errors", () => {
      expect(isRetryableError({ code: "ETIMEDOUT" })).toBe(true);
    });

    it("should return true for ECONNRESET network errors", () => {
      expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
    });

    it("should return true for ECONNREFUSED network errors", () => {
      expect(isRetryableError({ code: "ECONNREFUSED" })).toBe(true);
    });

    it("should return true for ENOTFOUND network errors", () => {
      expect(isRetryableError({ code: "ENOTFOUND" })).toBe(true);
    });

    it("should return true for EAI_AGAIN network errors", () => {
      expect(isRetryableError({ code: "EAI_AGAIN" })).toBe(true);
    });

    it("should return true for EPIPE network errors", () => {
      expect(isRetryableError({ code: "EPIPE" })).toBe(true);
    });

    it("should return true for 429 with retry-after header", () => {
      expect(isRetryableError({
        status: 429,
        response: { headers: { "retry-after": "60" } },
      })).toBe(true);
    });

    it("should return true for 403 with x-ratelimit-remaining: 0", () => {
      expect(isRetryableError({
        status: 403,
        response: { headers: { "x-ratelimit-remaining": "0" } },
      })).toBe(true);
    });

    it("should return true for 403 with rate limit in message", () => {
      expect(isRetryableError({
        status: 403,
        message: "API rate limit exceeded",
      })).toBe(true);
    });

    it("should return false for 404 Not Found", () => {
      expect(isRetryableError({ status: 404 })).toBe(false);
    });

    it("should return false for 401 Unauthorized", () => {
      expect(isRetryableError({ status: 401 })).toBe(false);
    });

    it("should return false for 400 Bad Request", () => {
      expect(isRetryableError({ status: 400 })).toBe(false);
    });

    it("should return false for 403 without rate limit indicators", () => {
      expect(isRetryableError({ status: 403 })).toBe(false);
    });

    it("should return false for plain Error without status or code", () => {
      expect(isRetryableError(new Error("Something broke"))).toBe(false);
    });
  });

  describe("withRetry", () => {
    // Use minimal baseDelayMs to keep tests fast
    const baseDelay = 1;

    beforeEach(() => {
      vi.spyOn(Math, "random").mockReturnValue(0);
    });

    afterEach(() => {
      vi.mocked(Math.random).mockRestore();
    });

    it("should return result on first successful attempt", async () => {
      const fn = vi.fn().mockResolvedValue("success");

      const result = await withRetry(fn, 3, baseDelay);

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should retry on retryable errors and succeed on later attempt", async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("Bad Gateway"), { status: 502 }))
        .mockResolvedValueOnce("recovered");

      const result = await withRetry(fn, 3, baseDelay);

      expect(result).toBe("recovered");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should throw immediately for non-retryable errors", async () => {
      const error = Object.assign(new Error("Not Found"), { status: 404 });
      const fn = vi.fn().mockRejectedValue(error);

      await expect(withRetry(fn, 3, baseDelay)).rejects.toThrow("Not Found");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should throw after exhausting all attempts on retryable errors", async () => {
      const error = Object.assign(new Error("Service Unavailable"), { status: 503 });
      const fn = vi.fn().mockRejectedValue(error);

      await expect(withRetry(fn, 3, baseDelay)).rejects.toThrow("Service Unavailable");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should respect custom maxAttempts", async () => {
      const error = Object.assign(new Error("Bad Gateway"), { status: 502 });
      const fn = vi.fn().mockRejectedValue(error);

      await expect(withRetry(fn, 2, baseDelay)).rejects.toThrow("Bad Gateway");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should log warnings between retry attempts", async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("Timeout"), { status: 504 }))
        .mockResolvedValueOnce("ok");

      await withRetry(fn, 3, baseDelay);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/Attempt 1 failed, retrying in \d+ms: Timeout/)
      );
    });
  });

  describe("makeEarlyDecisionCheck", () => {
    const testRef: IssueRef = { owner: "test-org", repo: "test-repo", issueNumber: 42 };

    const createMockDeps = (overrides: Partial<EarlyDecisionDeps> = {}): EarlyDecisionDeps => ({
      earlyExits: [
        {
          type: "auto",
          afterMs: 15 * 60 * 1000, // 15 minutes
          minVoters: 2,
          requiredVoters: { minCount: 2, voters: ["agent-a", "agent-b"] },
          requires: "majority",
        },
      ],
      findVotingCommentId: vi.fn().mockResolvedValue(123),
      getValidatedVoteCounts: vi.fn().mockResolvedValue({
        votes: { thumbsUp: 2, thumbsDown: 0, confused: 0, eyes: 0 },
        voters: ["agent-a", "agent-b"],
        participants: ["agent-a", "agent-b"],
      } as ValidatedVoteResult),
      votingEndOptions: { votingConfig: { minVoters: 1, requiredVoters: { minCount: 0, voters: [] } } },
      trackOutcome: vi.fn(),
      notifyPRs: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    });

    it("should return undefined when no early exits configured", () => {
      const deps = createMockDeps({ earlyExits: [] });
      const resolveFn = vi.fn();

      const check = makeEarlyDecisionCheck(resolveFn, deps);

      expect(check).toBeUndefined();
    });

    it("should return false when elapsed time has not reached any exit gate", async () => {
      const deps = createMockDeps();
      const resolveFn = vi.fn();

      const check = makeEarlyDecisionCheck(resolveFn, deps);
      const result = await check!(testRef, 5 * 60 * 1000); // 5 minutes (before 15 min gate)

      expect(result).toBe(false);
      expect(resolveFn).not.toHaveBeenCalled();
    });

    it("should return false when voting comment not found", async () => {
      const deps = createMockDeps({
        findVotingCommentId: vi.fn().mockResolvedValue(null),
      });
      const resolveFn = vi.fn();

      const check = makeEarlyDecisionCheck(resolveFn, deps);
      const result = await check!(testRef, 20 * 60 * 1000); // 20 minutes (after 15 min gate)

      expect(result).toBe(false);
      expect(resolveFn).not.toHaveBeenCalled();
    });

    it("should call the provided resolution function when exit conditions are met", async () => {
      const deps = createMockDeps();
      const resolveFn = vi.fn().mockResolvedValue("ready-to-implement" as VotingOutcome);

      const check = makeEarlyDecisionCheck(resolveFn, deps);
      const result = await check!(testRef, 20 * 60 * 1000); // 20 minutes

      expect(result).toBe(true);
      expect(resolveFn).toHaveBeenCalledWith(testRef, expect.objectContaining({
        earlyDecision: true,
        votingConfig: {
          minVoters: 2,
          requiredVoters: { minCount: 2, voters: ["agent-a", "agent-b"] },
        },
      }));
    });

    it("should call trackOutcome with the resolution result", async () => {
      const trackOutcome = vi.fn();
      const deps = createMockDeps({ trackOutcome });
      const resolveFn = vi.fn().mockResolvedValue("ready-to-implement" as VotingOutcome);

      const check = makeEarlyDecisionCheck(resolveFn, deps);
      await check!(testRef, 20 * 60 * 1000);

      expect(trackOutcome).toHaveBeenCalledWith("ready-to-implement", 42);
    });

    it("should call notifyPRs when outcome is ready-to-implement", async () => {
      const notifyPRs = vi.fn().mockResolvedValue(undefined);
      const deps = createMockDeps({ notifyPRs });
      const resolveFn = vi.fn().mockResolvedValue("ready-to-implement" as VotingOutcome);

      const check = makeEarlyDecisionCheck(resolveFn, deps);
      await check!(testRef, 20 * 60 * 1000);

      expect(notifyPRs).toHaveBeenCalledWith(42);
    });

    it("should not call notifyPRs when outcome is not ready-to-implement", async () => {
      const notifyPRs = vi.fn().mockResolvedValue(undefined);
      const deps = createMockDeps({ notifyPRs });
      const resolveFn = vi.fn().mockResolvedValue("inconclusive" as VotingOutcome);

      const check = makeEarlyDecisionCheck(resolveFn, deps);
      await check!(testRef, 20 * 60 * 1000);

      expect(notifyPRs).not.toHaveBeenCalled();
    });

    it("should use the correct resolution function for each phase", async () => {
      // This test verifies the key fix: different phases can use different resolution functions
      const endVotingFn = vi.fn().mockResolvedValue("ready-to-implement" as VotingOutcome);
      const resolveInconclusiveFn = vi.fn().mockResolvedValue("ready-to-implement" as VotingOutcome);

      const votingDeps = createMockDeps();
      const inconclusiveDeps = createMockDeps();

      // Simulate voting phase using endVoting
      const votingCheck = makeEarlyDecisionCheck(endVotingFn, votingDeps);
      await votingCheck!(testRef, 20 * 60 * 1000);

      // Simulate inconclusive phase using resolveInconclusive
      const inconclusiveCheck = makeEarlyDecisionCheck(resolveInconclusiveFn, inconclusiveDeps);
      await inconclusiveCheck!(testRef, 20 * 60 * 1000);

      // Each should have been called with its own resolution function
      expect(endVotingFn).toHaveBeenCalledTimes(1);
      expect(resolveInconclusiveFn).toHaveBeenCalledTimes(1);
    });

    it("should return false and log warning on eligibility check error", async () => {
      const deps = createMockDeps({
        getValidatedVoteCounts: vi.fn().mockRejectedValue(new Error("API failure")),
      });
      const resolveFn = vi.fn();

      const check = makeEarlyDecisionCheck(resolveFn, deps);
      const result = await check!(testRef, 20 * 60 * 1000);

      expect(result).toBe(false);
      expect(resolveFn).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Early decision check failed")
      );
    });

    it("should propagate resolveFn error instead of swallowing it", async () => {
      vi.mocked(logger.warn).mockClear();
      const deps = createMockDeps();
      const resolveFn = vi.fn().mockRejectedValue(new Error("Transition failed"));

      const check = makeEarlyDecisionCheck(resolveFn, deps);

      await expect(check!(testRef, 20 * 60 * 1000)).rejects.toThrow("Transition failed");
      // Transition errors must not be caught by the early decision check
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("Early decision check failed")
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // makeDiscussionEarlyCheck
  // ─────────────────────────────────────────────────────────────────────────────

  describe("makeDiscussionEarlyCheck", () => {
    const testRef: IssueRef = { owner: "test-org", repo: "test-repo", issueNumber: 42 };
    const MS = 60 * 1000;

    function createDiscussionDeps(overrides?: Partial<DiscussionEarlyCheckDeps>): DiscussionEarlyCheckDeps {
      return {
        earlyExits: [
          { type: "auto", afterMs: 30 * MS, minReady: 3, requiredReady: { minCount: 2, users: ["alice", "bob"] } },
        ],
        getDiscussionReadiness: vi.fn().mockResolvedValue(new Set(["alice", "bob", "charlie"])),
        ...overrides,
      };
    }

    it("should return undefined when no early exits", () => {
      const deps = createDiscussionDeps({ earlyExits: [] });
      const transitionFn = vi.fn();

      const check = makeDiscussionEarlyCheck(transitionFn, deps);
      expect(check).toBeUndefined();
    });

    it("should return false when elapsed < afterMs for all exits", async () => {
      const deps = createDiscussionDeps();
      const transitionFn = vi.fn();

      const check = makeDiscussionEarlyCheck(transitionFn, deps);
      const result = await check!(testRef, 10 * MS); // only 10 min elapsed, need 30

      expect(result).toBe(false);
      expect(transitionFn).not.toHaveBeenCalled();
    });

    it("should return true and call transition when exit matches", async () => {
      const deps = createDiscussionDeps();
      const transitionFn = vi.fn().mockResolvedValue(undefined);

      const check = makeDiscussionEarlyCheck(transitionFn, deps);
      const result = await check!(testRef, 35 * MS); // 35 min elapsed, need 30

      expect(result).toBe(true);
      expect(transitionFn).toHaveBeenCalledWith(testRef);
    });

    it("should return false when required users haven't reacted", async () => {
      const deps = createDiscussionDeps({
        getDiscussionReadiness: vi.fn().mockResolvedValue(new Set(["alice", "charlie"])), // missing bob
      });
      const transitionFn = vi.fn();

      const check = makeDiscussionEarlyCheck(transitionFn, deps);
      const result = await check!(testRef, 35 * MS);

      expect(result).toBe(false);
      expect(transitionFn).not.toHaveBeenCalled();
    });

    it("should return false when minReady not met", async () => {
      const deps = createDiscussionDeps({
        getDiscussionReadiness: vi.fn().mockResolvedValue(new Set(["alice", "bob"])), // only 2, need 3
      });
      const transitionFn = vi.fn();

      const check = makeDiscussionEarlyCheck(transitionFn, deps);
      const result = await check!(testRef, 35 * MS);

      expect(result).toBe(false);
    });

    it("should evaluate first-match-wins across multiple exits", async () => {
      const deps = createDiscussionDeps({
        earlyExits: [
          // First exit: strict requirements (will fail)
          { type: "auto", afterMs: 15 * MS, minReady: 5, requiredReady: { minCount: 0, users: [] } },
          // Second exit: relaxed requirements (will pass)
          { type: "auto", afterMs: 30 * MS, minReady: 2, requiredReady: { minCount: 0, users: [] } },
        ],
        getDiscussionReadiness: vi.fn().mockResolvedValue(new Set(["alice", "bob", "charlie"])),
      });
      const transitionFn = vi.fn().mockResolvedValue(undefined);

      const check = makeDiscussionEarlyCheck(transitionFn, deps);
      const result = await check!(testRef, 35 * MS);

      expect(result).toBe(true);
      expect(transitionFn).toHaveBeenCalledWith(testRef);
    });

    it("should work with minCount: 1 for requiredReady", async () => {
      const deps = createDiscussionDeps({
        earlyExits: [
          { type: "auto", afterMs: 30 * MS, minReady: 0, requiredReady: { minCount: 1, users: ["alice", "bob"] } },
        ],
        getDiscussionReadiness: vi.fn().mockResolvedValue(new Set(["bob"])),
      });
      const transitionFn = vi.fn().mockResolvedValue(undefined);

      const check = makeDiscussionEarlyCheck(transitionFn, deps);
      const result = await check!(testRef, 35 * MS);

      expect(result).toBe(true);
    });

    it("should return false and log warning on readiness check error", async () => {
      const deps = createDiscussionDeps({
        getDiscussionReadiness: vi.fn().mockRejectedValue(new Error("API error")),
      });
      const transitionFn = vi.fn();

      const check = makeDiscussionEarlyCheck(transitionFn, deps);
      const result = await check!(testRef, 35 * MS);

      expect(result).toBe(false);
      expect(transitionFn).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Discussion early check failed")
      );
    });

    it("should propagate transitionFn error instead of swallowing it", async () => {
      vi.mocked(logger.warn).mockClear();
      const deps = createDiscussionDeps();
      const transitionFn = vi.fn().mockRejectedValue(new Error("Transition failed"));

      const check = makeDiscussionEarlyCheck(transitionFn, deps);

      await expect(check!(testRef, 35 * MS)).rejects.toThrow("Transition failed");
      // Transition errors must not be caught by the discussion early check
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("Discussion early check failed")
      );
    });
  });

  describe("processRepository — no config file", () => {
    const repo = {
      owner: { login: "test-org" },
      name: "test-repo",
      full_name: "test-org/test-repo",
    } as any;
    const appId = 123;

    it("should skip all automation when config is null (no .github/hivemoot.yml)", async () => {
      vi.clearAllMocks();
      mockLoadRepositoryConfig.mockResolvedValue(null);

      const fakeOctokit = {} as any;
      const result = await processRepository(fakeOctokit, repo, appId);

      expect(result).toEqual({ skippedIssues: [], accessIssues: [] });
      expect(mockCreateIssueOperations).not.toHaveBeenCalled();
      expect(mockCreateGovernanceService).not.toHaveBeenCalled();
    });
  });
});
