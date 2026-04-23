import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for reconcile-merge-ready script.
 *
 * Verifies:
 * - processRepository: skips repos without mergeReady config, processes implementation PRs
 * - Error isolation: one PR failure doesn't block others, AggregateError preserves causes
 */

// Mock external dependencies
vi.mock("octokit", () => ({
  App: vi.fn(),
  Octokit: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  setFailed: vi.fn(),
  warning: vi.fn(),
}));

// Suppress unhandled rejection from module-level main().catch()
process.on("unhandledRejection", () => {});

const mockEvaluateMergeReadiness = vi.fn().mockResolvedValue({ action: "noop", labeled: false });
const mockFindPRsWithLabel = vi.fn().mockResolvedValue([]);

vi.mock("../api/lib/index.js", () => ({
  createPROperations: vi.fn(() => ({
    findPRsWithLabel: mockFindPRsWithLabel,
  })),
  loadRepositoryConfig: vi.fn().mockResolvedValue({
    governance: { pr: { mergeReady: null, trustedReviewers: [] } },
  }),
  evaluateMergeReadiness: (...args: unknown[]) => mockEvaluateMergeReadiness(...args),
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

// Import after mocks
import { processRepository } from "./reconcile-merge-ready.js";
import { loadRepositoryConfig, logger } from "../api/lib/index.js";
import type { Repository } from "../api/lib/index.js";

const mockLoadRepositoryConfig = vi.mocked(loadRepositoryConfig);

const testRepo: Repository = {
  owner: { login: "test-org" },
  name: "test-repo",
  full_name: "test-org/test-repo",
};
const testAppId = 12345;

describe("reconcile-merge-ready", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("processRepository", () => {
    it("should skip repos without mergeReady config", async () => {
      mockLoadRepositoryConfig.mockResolvedValue({
        governance: { pr: { mergeReady: null, trustedReviewers: [] } },
      } as ReturnType<typeof loadRepositoryConfig> extends Promise<infer T> ? T : never);

      await processRepository({} as never, testRepo, testAppId);

      expect(mockFindPRsWithLabel).not.toHaveBeenCalled();
      expect(mockEvaluateMergeReadiness).not.toHaveBeenCalled();
    });

    it("should skip repos with PR workflows disabled (pr: null)", async () => {
      mockLoadRepositoryConfig.mockResolvedValue({
        governance: { pr: null },
      } as ReturnType<typeof loadRepositoryConfig> extends Promise<infer T> ? T : never);

      await processRepository({} as never, testRepo, testAppId);

      expect(mockFindPRsWithLabel).not.toHaveBeenCalled();
      expect(mockEvaluateMergeReadiness).not.toHaveBeenCalled();
    });

    it("should process all implementation PRs", async () => {
      mockLoadRepositoryConfig.mockResolvedValue({
        governance: {
          pr: {
            mergeReady: { minApprovals: 1 },
            trustedReviewers: ["alice"],
          },
        },
      } as ReturnType<typeof loadRepositoryConfig> extends Promise<infer T> ? T : never);

      mockFindPRsWithLabel.mockResolvedValue([
        { number: 1, labels: [{ name: "hivemoot:candidate" }] },
        { number: 2, labels: [{ name: "hivemoot:candidate" }, { name: "hivemoot:merge-ready" }] },
      ]);

      mockEvaluateMergeReadiness.mockResolvedValue({ action: "noop", labeled: false });

      await processRepository({} as never, testRepo, testAppId);

      expect(mockEvaluateMergeReadiness).toHaveBeenCalledTimes(2);
    });

    it("should skip repos with no implementation PRs", async () => {
      mockLoadRepositoryConfig.mockResolvedValue({
        governance: {
          pr: {
            mergeReady: { minApprovals: 1 },
            trustedReviewers: ["alice"],
          },
        },
      } as ReturnType<typeof loadRepositoryConfig> extends Promise<infer T> ? T : never);

      mockFindPRsWithLabel.mockResolvedValue([]);

      await processRepository({} as never, testRepo, testAppId);

      expect(mockEvaluateMergeReadiness).not.toHaveBeenCalled();
    });

    it("should isolate errors per PR", async () => {
      mockLoadRepositoryConfig.mockResolvedValue({
        governance: {
          pr: {
            mergeReady: { minApprovals: 1 },
            trustedReviewers: ["alice"],
          },
        },
      } as ReturnType<typeof loadRepositoryConfig> extends Promise<infer T> ? T : never);

      mockFindPRsWithLabel.mockResolvedValue([
        { number: 1, labels: [{ name: "hivemoot:candidate" }] },
        { number: 2, labels: [{ name: "hivemoot:candidate" }] },
        { number: 3, labels: [{ name: "hivemoot:candidate" }] },
      ]);

      mockEvaluateMergeReadiness
        .mockResolvedValueOnce({ action: "added" })
        .mockRejectedValueOnce(new Error("API error"))
        .mockResolvedValueOnce({ action: "noop", labeled: true });

      // Should throw AggregateError, but all PRs should be processed
      const error = await processRepository({} as never, testRepo, testAppId).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).message).toMatch("1 PR(s) failed reconciliation");
      expect((error as AggregateError).errors).toHaveLength(1);
      expect(((error as AggregateError).errors[0] as Error).message).toBe("API error");

      expect(mockEvaluateMergeReadiness).toHaveBeenCalledTimes(3);
      expect(vi.mocked(logger.error)).toHaveBeenCalled();
    });

    it("should pass currentLabels from pre-fetched PR data", async () => {
      mockLoadRepositoryConfig.mockResolvedValue({
        governance: {
          pr: {
            mergeReady: { minApprovals: 1 },
            trustedReviewers: ["alice"],
          },
        },
      } as ReturnType<typeof loadRepositoryConfig> extends Promise<infer T> ? T : never);

      mockFindPRsWithLabel.mockResolvedValue([
        { number: 1, labels: [{ name: "hivemoot:candidate" }, { name: "bug" }] },
      ]);

      mockEvaluateMergeReadiness.mockResolvedValue({ action: "noop", labeled: false });

      await processRepository({} as never, testRepo, testAppId);

      expect(mockEvaluateMergeReadiness).toHaveBeenCalledWith(
        expect.objectContaining({
          currentLabels: ["hivemoot:candidate", "bug"],
        })
      );
    });
  });
});
