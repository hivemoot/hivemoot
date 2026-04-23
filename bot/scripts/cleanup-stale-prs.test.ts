import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getDaysSinceActivity, processPR, processRepository } from "./cleanup-stale-prs.js";
import type { PROperations } from "../api/lib/pr-operations.js";
import type { PRRef } from "../api/lib/index.js";
import { LABELS, CONFIG_BOUNDS, PR_MESSAGES } from "../api/config.js";

// Use the default stale days from CONFIG_BOUNDS for tests
const PR_STALE_THRESHOLD_DAYS = CONFIG_BOUNDS.prStaleDays.default;

/**
 * Tests for Stale PR Cleanup Script
 *
 * These tests verify the staleness detection and handling logic:
 * - Day calculation from timestamps
 * - Warning threshold behavior
 * - Close threshold behavior
 * - Recovery when activity resumes
 */

describe("getDaysSinceActivity", () => {
  beforeEach(() => {
    // Mock Date.now() for consistent testing
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should return 0 for today", () => {
    const today = new Date("2024-01-20T08:00:00Z");
    expect(getDaysSinceActivity(today)).toBe(0);
  });

  it("should return correct day count for past dates", () => {
    const fiveDaysAgo = new Date("2024-01-15T12:00:00Z");
    expect(getDaysSinceActivity(fiveDaysAgo)).toBe(5);
  });

  it("should handle boundary condition - 23h59m is still 0 days", () => {
    // Just under 24 hours ago
    const almostOneDay = new Date("2024-01-19T12:01:00Z");
    expect(getDaysSinceActivity(almostOneDay)).toBe(0);
  });

  it("should handle boundary condition - exactly 24h is 1 day", () => {
    const exactlyOneDay = new Date("2024-01-19T12:00:00Z");
    expect(getDaysSinceActivity(exactlyOneDay)).toBe(1);
  });

  it("should handle timestamps from different parts of the day", () => {
    // Early morning 5 days ago should still be 5 days
    const earlyMorning = new Date("2024-01-15T06:00:00Z");
    expect(getDaysSinceActivity(earlyMorning)).toBe(5);

    // Late evening 5 days ago should still be 5 days
    const lateEvening = new Date("2024-01-15T23:00:00Z");
    expect(getDaysSinceActivity(lateEvening)).toBe(4);
  });
});

describe("processPR", () => {
  let mockPRs: PROperations;
  const testRef: PRRef = { owner: "test-org", repo: "test-repo", prNumber: 42 };
  const threshold = PR_STALE_THRESHOLD_DAYS; // e.g., 3 days
  const closeThreshold = threshold * 2; // e.g., 6 days

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00Z"));

    mockPRs = {
      comment: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
      removeGovernanceLabels: vi.fn().mockResolvedValue(undefined),
      hasLabel: vi.fn().mockReturnValue(false),
    } as unknown as PROperations;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper to create lastActivityDate from days inactive
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  describe("Close scenario", () => {
    it("should close PR when daysSinceActivity >= closeThreshold", async () => {
      // PR inactive for closeThreshold days (e.g., 6+ days)
      const daysInactive = closeThreshold;
      const pr = {
        number: 42,
        labels: [{ name: LABELS.IMPLEMENTATION }, { name: LABELS.STALE }],
      };

      await processPR(mockPRs, testRef, pr, threshold, daysAgo(daysInactive));

      expect(mockPRs.comment).toHaveBeenCalledWith(
        testRef,
        PR_MESSAGES.prStaleClosed(daysInactive)
      );
      expect(mockPRs.close).toHaveBeenCalledWith(testRef);
    });

    it("should remove governance labels and stale label when closing", async () => {
      const daysInactive = closeThreshold + 1;
      const pr = {
        number: 42,
        labels: [{ name: LABELS.IMPLEMENTATION }, { name: LABELS.STALE }],
      };

      await processPR(mockPRs, testRef, pr, threshold, daysAgo(daysInactive));

      expect(mockPRs.removeGovernanceLabels).toHaveBeenCalledWith(testRef);
      expect(mockPRs.removeLabel).toHaveBeenCalledWith(testRef, LABELS.STALE);
    });

    it("should close PRs significantly past the threshold", async () => {
      const daysInactive = closeThreshold + 10; // Well past threshold
      const pr = {
        number: 42,
        labels: [{ name: LABELS.IMPLEMENTATION }],
      };

      await processPR(mockPRs, testRef, pr, threshold, daysAgo(daysInactive));

      expect(mockPRs.close).toHaveBeenCalled();
    });
  });

  describe("Warning scenario", () => {
    it("should add stale label when daysSinceActivity >= threshold but < closeThreshold", async () => {
      const daysInactive = threshold; // Exactly at threshold
      const pr = {
        number: 42,
        labels: [{ name: LABELS.IMPLEMENTATION }],
      };
      vi.mocked(mockPRs.hasLabel).mockReturnValue(false);

      await processPR(mockPRs, testRef, pr, threshold, daysAgo(daysInactive));

      expect(mockPRs.addLabels).toHaveBeenCalledWith(testRef, [LABELS.STALE]);
    });

    it("should post warning comment with days until close", async () => {
      const daysInactive = threshold;
      const daysUntilClose = closeThreshold - daysInactive;
      const pr = {
        number: 42,
        labels: [{ name: LABELS.IMPLEMENTATION }],
      };
      vi.mocked(mockPRs.hasLabel).mockReturnValue(false);

      await processPR(mockPRs, testRef, pr, threshold, daysAgo(daysInactive));

      expect(mockPRs.comment).toHaveBeenCalledWith(
        testRef,
        PR_MESSAGES.prStaleWarning(daysInactive, daysUntilClose)
      );
    });

    it("should skip warning if stale label already present", async () => {
      const daysInactive = threshold;
      const pr = {
        number: 42,
        labels: [{ name: LABELS.IMPLEMENTATION }, { name: LABELS.STALE }],
      };
      vi.mocked(mockPRs.hasLabel).mockImplementation((_pr, label) => label === LABELS.STALE);

      await processPR(mockPRs, testRef, pr, threshold, daysAgo(daysInactive));

      expect(mockPRs.addLabels).not.toHaveBeenCalled();
      expect(mockPRs.comment).not.toHaveBeenCalled();
    });
  });

  describe("Recovery scenario", () => {
    it("should remove stale label when activity resumes", async () => {
      // PR has recent activity (below threshold)
      const daysInactive = threshold - 1;
      const pr = {
        number: 42,
        labels: [{ name: LABELS.IMPLEMENTATION }, { name: LABELS.STALE }],
      };
      vi.mocked(mockPRs.hasLabel).mockImplementation((_pr, label) => label === LABELS.STALE);

      await processPR(mockPRs, testRef, pr, threshold, daysAgo(daysInactive));

      expect(mockPRs.removeLabel).toHaveBeenCalledWith(testRef, LABELS.STALE);
    });

    it("should do nothing if stale label not present and activity is recent", async () => {
      const daysInactive = 1; // Recent activity
      const pr = {
        number: 42,
        labels: [{ name: LABELS.IMPLEMENTATION }],
      };
      vi.mocked(mockPRs.hasLabel).mockReturnValue(false);

      await processPR(mockPRs, testRef, pr, threshold, daysAgo(daysInactive));

      expect(mockPRs.removeLabel).not.toHaveBeenCalled();
      expect(mockPRs.addLabels).not.toHaveBeenCalled();
      expect(mockPRs.comment).not.toHaveBeenCalled();
      expect(mockPRs.close).not.toHaveBeenCalled();
    });
  });

  describe("Edge cases", () => {
    it("should handle PR with 0 days inactive", async () => {
      const pr = {
        number: 42,
        labels: [{ name: LABELS.IMPLEMENTATION }],
      };

      await processPR(mockPRs, testRef, pr, threshold, new Date()); // Just now

      expect(mockPRs.close).not.toHaveBeenCalled();
      expect(mockPRs.addLabels).not.toHaveBeenCalled();
    });

    it("should handle PR at exactly closeThreshold - 1 day", async () => {
      const daysInactive = closeThreshold - 1;
      const pr = {
        number: 42,
        labels: [{ name: LABELS.IMPLEMENTATION }],
      };
      vi.mocked(mockPRs.hasLabel).mockReturnValue(false);

      await processPR(mockPRs, testRef, pr, threshold, daysAgo(daysInactive));

      // Should warn but not close
      expect(mockPRs.addLabels).toHaveBeenCalled();
      expect(mockPRs.close).not.toHaveBeenCalled();
    });

    it("should use provided lastActivityDate, not pr.updatedAt", async () => {
      // This test verifies the fix for the feedback loop bug:
      // Even if updatedAt is recent (due to bot comment), we use lastActivityDate
      const daysInactive = closeThreshold; // 6 days since last human activity
      const pr = {
        number: 42,
        labels: [{ name: LABELS.IMPLEMENTATION }, { name: LABELS.STALE }],
      };

      // lastActivityDate is 6 days ago (should trigger close)
      await processPR(mockPRs, testRef, pr, threshold, daysAgo(daysInactive));

      // PR should be closed based on lastActivityDate, not updatedAt
      expect(mockPRs.close).toHaveBeenCalledWith(testRef);
    });
  });
});

describe("processRepository", () => {
  const testAppId = 12345;

  // Mock the createPROperations and loadRepositoryConfig imports
  // Note: Can't reference CONFIG_BOUNDS in the mock factory as it's hoisted before imports
  // Use literal values that match the defaults: 24h (1440 min), 3 days stale, 3 max PRs
  vi.mock("../api/lib/index.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../api/lib/index.js")>();
    return {
      ...original,
      createPROperations: vi.fn().mockReturnValue({
        findPRsWithLabel: vi.fn().mockResolvedValue([]),
        getLatestActivityDate: vi.fn().mockResolvedValue(new Date()),
        hasLabel: vi.fn().mockReturnValue(false),
        comment: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        addLabels: vi.fn().mockResolvedValue(undefined),
        removeLabel: vi.fn().mockResolvedValue(undefined),
        removeGovernanceLabels: vi.fn().mockResolvedValue(undefined),
      }),
      loadRepositoryConfig: vi.fn().mockResolvedValue({
        version: 1,
        governance: {
          proposals: {
            discussion: { durationMs: 24 * 60 * 60 * 1000 },
            voting: {
              durationMs: 24 * 60 * 60 * 1000,
              exits: [{
                afterMs: 24 * 60 * 60 * 1000,
                requires: "majority",
                minVoters: 3,
                requiredVoters: { mode: "all", voters: [] },
              }],
            },
          },
          pr: {
            staleDays: 3,
            maxPRsPerIssue: 3,
          },
        },
      }),
      logger: {
        group: vi.fn(),
        groupEnd: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
    };
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  // Default config to use in tests
  const defaultMockConfig = {
    version: 1,
    governance: {
      proposals: {
        discussion: { durationMs: 24 * 60 * 60 * 1000 },
        voting: {
          durationMs: 24 * 60 * 60 * 1000,
          exits: [{
            afterMs: 24 * 60 * 60 * 1000,
            requires: "majority" as const,
            minVoters: 3,
            requiredVoters: { mode: "all" as const, voters: [] as string[] },
          }],
        },
      },
      pr: {
        staleDays: 3,
        maxPRsPerIssue: 3,
      },
    },
  };

  it("should skip processing when PR workflows are disabled (pr: null)", async () => {
    const { createPROperations, loadRepositoryConfig } = await import("../api/lib/index.js");
    vi.mocked(loadRepositoryConfig).mockResolvedValue({
      ...defaultMockConfig,
      governance: { ...defaultMockConfig.governance, pr: null },
    });

    const mockOctokit = {} as Parameters<typeof processRepository>[0];
    const repo = { owner: { login: "test-org" }, name: "test-repo", full_name: "test-org/test-repo" };

    await processRepository(mockOctokit, repo, testAppId);

    expect(createPROperations).not.toHaveBeenCalled();
  });

  it("should skip processing when stale cleanup is not explicitly enabled", async () => {
    const { createPROperations, loadRepositoryConfig } = await import("../api/lib/index.js");
    vi.mocked(loadRepositoryConfig).mockResolvedValue({
      ...defaultMockConfig,
      governance: {
        ...defaultMockConfig.governance,
        pr: { ...defaultMockConfig.governance.pr, staleDays: null },
      },
    });

    const mockOctokit = {} as Parameters<typeof processRepository>[0];
    const repo = { owner: { login: "test-org" }, name: "test-repo", full_name: "test-org/test-repo" };

    await processRepository(mockOctokit, repo, testAppId);

    expect(createPROperations).not.toHaveBeenCalled();
  });

  it("should handle empty repository (no implementation PRs)", async () => {
    const { createPROperations, loadRepositoryConfig } = await import("../api/lib/index.js");
    const mockPRs = {
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
      getLatestActivityDate: vi.fn(),
      hasLabel: vi.fn(),
      comment: vi.fn(),
      close: vi.fn(),
      addLabels: vi.fn(),
      removeLabel: vi.fn(),
    };
    vi.mocked(createPROperations).mockReturnValue(mockPRs as unknown as ReturnType<typeof createPROperations>);
    vi.mocked(loadRepositoryConfig).mockResolvedValue(defaultMockConfig);

    const mockOctokit = {} as Parameters<typeof processRepository>[0];
    const repo = { owner: { login: "test-org" }, name: "test-repo", full_name: "test-org/test-repo" };

    await processRepository(mockOctokit, repo, testAppId);

    expect(createPROperations).toHaveBeenCalledWith(mockOctokit, { appId: testAppId });
    expect(mockPRs.findPRsWithLabel).toHaveBeenCalledWith("test-org", "test-repo", LABELS.IMPLEMENTATION);
    // No PRs to process
    expect(mockPRs.comment).not.toHaveBeenCalled();
    expect(mockPRs.close).not.toHaveBeenCalled();
  });

  it("should call getLatestActivityDate for each PR", async () => {
    const { createPROperations, loadRepositoryConfig } = await import("../api/lib/index.js");
    const prCreatedAt1 = new Date("2024-01-05T12:00:00Z");
    const prCreatedAt2 = new Date("2024-01-08T12:00:00Z");
    const mockPRs = {
      findPRsWithLabel: vi.fn().mockResolvedValue([
        { number: 1, createdAt: prCreatedAt1, updatedAt: new Date("2024-01-19T12:00:00Z"), labels: [{ name: LABELS.IMPLEMENTATION }] },
        { number: 2, createdAt: prCreatedAt2, updatedAt: new Date("2024-01-19T12:00:00Z"), labels: [{ name: LABELS.IMPLEMENTATION }] },
      ]),
      getLatestActivityDate: vi.fn().mockResolvedValue(new Date("2024-01-19T12:00:00Z")),
      hasLabel: vi.fn().mockReturnValue(false),
      comment: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
      removeGovernanceLabels: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createPROperations).mockReturnValue(mockPRs as unknown as ReturnType<typeof createPROperations>);
    vi.mocked(loadRepositoryConfig).mockResolvedValue(defaultMockConfig);

    const mockOctokit = {} as Parameters<typeof processRepository>[0];
    const repo = { owner: { login: "test-org" }, name: "test-repo", full_name: "test-org/test-repo" };

    await processRepository(mockOctokit, repo, testAppId);

    // Should call getLatestActivityDate for each PR with correct createdAt fallback
    expect(mockPRs.getLatestActivityDate).toHaveBeenCalledTimes(2);
    expect(mockPRs.getLatestActivityDate).toHaveBeenCalledWith(
      { owner: "test-org", repo: "test-repo", prNumber: 1 },
      prCreatedAt1
    );
    expect(mockPRs.getLatestActivityDate).toHaveBeenCalledWith(
      { owner: "test-org", repo: "test-repo", prNumber: 2 },
      prCreatedAt2
    );
  });

  it("should use non-bot activity date for staleness calculation (bot comments do not reset timer)", async () => {
    const { createPROperations, loadRepositoryConfig } = await import("../api/lib/index.js");
    const prCreatedAt = new Date("2024-01-05T12:00:00Z");
    // updatedAt is recent (bot commented today), but last non-bot activity was 10 days ago
    const mockPRs = {
      findPRsWithLabel: vi.fn().mockResolvedValue([
        {
          number: 1,
          createdAt: prCreatedAt,
          updatedAt: new Date("2024-01-20T10:00:00Z"), // Today - bot commented
          labels: [{ name: LABELS.IMPLEMENTATION }, { name: LABELS.STALE }],
        },
      ]),
      // Last non-bot activity was 10 days ago
      getLatestActivityDate: vi.fn().mockResolvedValue(new Date("2024-01-10T12:00:00Z")),
      hasLabel: vi.fn().mockImplementation((_pr, label) => label === LABELS.STALE),
      comment: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
      removeGovernanceLabels: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createPROperations).mockReturnValue(mockPRs as unknown as ReturnType<typeof createPROperations>);
    vi.mocked(loadRepositoryConfig).mockResolvedValue(defaultMockConfig);

    const mockOctokit = {} as Parameters<typeof processRepository>[0];
    const repo = { owner: { login: "test-org" }, name: "test-repo", full_name: "test-org/test-repo" };

    await processRepository(mockOctokit, repo, testAppId);

    // PR should be closed because last non-bot activity was 10 days ago (> 6 day close threshold)
    // Even though updatedAt is today (due to bot comment)
    expect(mockPRs.close).toHaveBeenCalled();
  });

  it("should continue processing remaining PRs when one fails, then throw aggregate error", async () => {
    const { createPROperations, loadRepositoryConfig, logger } = await import("../api/lib/index.js");
    const mockPRs = {
      findPRsWithLabel: vi.fn().mockResolvedValue([
        { number: 1, createdAt: new Date("2024-01-05T12:00:00Z"), updatedAt: new Date("2024-01-19T12:00:00Z"), labels: [{ name: LABELS.IMPLEMENTATION }] },
        { number: 2, createdAt: new Date("2024-01-06T12:00:00Z"), updatedAt: new Date("2024-01-19T12:00:00Z"), labels: [{ name: LABELS.IMPLEMENTATION }] },
        { number: 3, createdAt: new Date("2024-01-07T12:00:00Z"), updatedAt: new Date("2024-01-19T12:00:00Z"), labels: [{ name: LABELS.IMPLEMENTATION }] },
      ]),
      getLatestActivityDate: vi.fn()
        .mockResolvedValueOnce(new Date("2024-01-19T12:00:00Z")) // PR #1 succeeds
        .mockRejectedValueOnce(new Error("API rate limit")) // PR #2 fails
        .mockResolvedValueOnce(new Date("2024-01-19T12:00:00Z")), // PR #3 succeeds
      hasLabel: vi.fn().mockReturnValue(false),
      comment: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
      removeGovernanceLabels: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createPROperations).mockReturnValue(mockPRs as unknown as ReturnType<typeof createPROperations>);
    vi.mocked(loadRepositoryConfig).mockResolvedValue(defaultMockConfig);

    const mockOctokit = {} as Parameters<typeof processRepository>[0];
    const repo = { owner: { login: "test-org" }, name: "test-repo", full_name: "test-org/test-repo" };

    // Should throw aggregate error
    await expect(processRepository(mockOctokit, repo, testAppId)).rejects.toThrow(
      "Failed to process 1 PR(s): #2"
    );

    // All three PRs should have been attempted (not halted after PR #2)
    expect(mockPRs.getLatestActivityDate).toHaveBeenCalledTimes(3);
    // Error should be logged for PR #2
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to process PR #2",
      expect.any(Error)
    );
  });

  it("should skip processing when no config file exists (null config)", async () => {
    const { createPROperations, loadRepositoryConfig } = await import("../api/lib/index.js");
    const mockPRs = {
      findPRsWithLabel: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(createPROperations).mockReturnValue(mockPRs as unknown as ReturnType<typeof createPROperations>);
    vi.mocked(loadRepositoryConfig).mockResolvedValue(null);

    const mockOctokit = {} as Parameters<typeof processRepository>[0];
    const repo = { owner: { login: "test-org" }, name: "test-repo", full_name: "test-org/test-repo" };

    await processRepository(mockOctokit, repo, testAppId);

    expect(mockPRs.findPRsWithLabel).not.toHaveBeenCalled();
  });
});
