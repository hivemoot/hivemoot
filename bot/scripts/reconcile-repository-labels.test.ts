import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for reconcile-repository-labels script.
 *
 * Verifies:
 * - processRepository: calls ensureRequiredLabels for each repo
 * - Successful runs log created/renamed/updated/skipped counts
 * - Renamed labels are logged individually
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

const mockEnsureRequiredLabels = vi.fn().mockResolvedValue({
  created: 0,
  renamed: 0,
  updated: 0,
  skipped: 0,
  renamedLabels: [],
});

vi.mock("../api/lib/index.js", () => ({
  createRepositoryLabelService: vi.fn(() => ({
    ensureRequiredLabels: mockEnsureRequiredLabels,
  })),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    group: vi.fn(),
    groupEnd: vi.fn(),
  },
}));

vi.mock("./shared/run-installations.js", () => ({
  runForAllRepositories: vi.fn(),
  runIfMain: vi.fn(),
}));

// Import after mocks
import { processRepository } from "./reconcile-repository-labels.js";
import { createRepositoryLabelService, logger } from "../api/lib/index.js";
import type { Repository } from "../api/lib/index.js";

const mockCreateRepositoryLabelService = vi.mocked(createRepositoryLabelService);

const testRepo: Repository = {
  owner: { login: "test-org" },
  name: "test-repo",
  full_name: "test-org/test-repo",
};

describe("reconcile-repository-labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateRepositoryLabelService.mockReturnValue({
      ensureRequiredLabels: mockEnsureRequiredLabels,
    } as ReturnType<typeof createRepositoryLabelService>);
    mockEnsureRequiredLabels.mockResolvedValue({
      created: 0,
      renamed: 0,
      updated: 0,
      skipped: 0,
      renamedLabels: [],
    });
  });

  describe("processRepository", () => {
    it("should call ensureRequiredLabels for a repo", async () => {
      await processRepository({} as never, testRepo, 12345);

      expect(mockCreateRepositoryLabelService).toHaveBeenCalled();
      expect(mockEnsureRequiredLabels).toHaveBeenCalledWith("test-org", "test-repo");
    });

    it("should log reconciliation counts", async () => {
      mockEnsureRequiredLabels.mockResolvedValueOnce({
        created: 3,
        renamed: 1,
        updated: 0,
        skipped: 10,
        renamedLabels: [],
      });

      await processRepository({} as never, testRepo, 12345);

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        expect.stringContaining("created=3 renamed=1 updated=0 skipped=10")
      );
    });

    it("should log each renamed label individually", async () => {
      mockEnsureRequiredLabels.mockResolvedValueOnce({
        created: 0,
        renamed: 2,
        updated: 0,
        skipped: 5,
        renamedLabels: [
          { from: "phase:voting", to: "hivemoot:voting" },
          { from: "phase:discussion", to: "hivemoot:discussion" },
        ],
      });

      await processRepository({} as never, testRepo, 12345);

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        expect.stringContaining("phase:voting → hivemoot:voting")
      );
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        expect.stringContaining("phase:discussion → hivemoot:discussion")
      );
    });

    it("should not log rename details when there are no renames", async () => {
      mockEnsureRequiredLabels.mockResolvedValueOnce({
        created: 2,
        renamed: 0,
        updated: 0,
        skipped: 11,
        renamedLabels: [],
      });

      await processRepository({} as never, testRepo, 12345);

      const infoCalls = vi.mocked(logger.info).mock.calls.map((c) => String(c[0]));
      const renamedCalls = infoCalls.filter((msg) => msg.includes("Renamed label:"));
      expect(renamedCalls).toHaveLength(0);
    });

    it("should always call groupEnd even on error", async () => {
      mockEnsureRequiredLabels.mockRejectedValueOnce(new Error("API failure"));

      await expect(processRepository({} as never, testRepo, 12345)).rejects.toThrow("API failure");

      expect(vi.mocked(logger.groupEnd)).toHaveBeenCalled();
    });
  });
});
