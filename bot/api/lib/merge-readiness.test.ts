import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluateMergeReadiness } from "./merge-readiness.js";
import type { MergeReadinessParams, MergeReadinessResult } from "./merge-readiness.js";
import type { PROperations } from "./pr-operations.js";

/**
 * Tests for merge-readiness evaluation.
 *
 * Verifies the evaluateMergeReadiness function:
 * - Feature disabled → skipped
 * - Missing implementation label → skipped / removed
 * - Insufficient trusted approvals → skipped / removed
 * - Pending/failed CI → skipped / removed
 * - All conditions met → label added
 * - Already labeled + conditions met → noop
 * - Label present + condition fails → removed
 * - Zero checks/statuses → treated as passing
 */

function createMockPrs(overrides: Partial<Record<keyof PROperations, unknown>> = {}): PROperations {
  return {
    getLabels: vi.fn().mockResolvedValue(["hivemoot:candidate"]),
    getApproverLogins: vi.fn().mockResolvedValue(new Set<string>()),
    get: vi.fn().mockResolvedValue({ headSha: "abc123", mergeable: true, draft: false }),
    getCheckRunsForRef: vi.fn().mockResolvedValue({ totalCount: 0, checkRuns: [] }),
    getCombinedStatus: vi.fn().mockResolvedValue({ state: "pending", totalCount: 0 }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PROperations;
}

const defaultRef = { owner: "test-org", repo: "test-repo", prNumber: 42 };
const defaultConfig = { minApprovals: 1 };
const defaultReviewers = ["alice", "bob"];

function buildParams(overrides: Partial<MergeReadinessParams> = {}): MergeReadinessParams {
  return {
    prs: createMockPrs(),
    ref: defaultRef,
    config: defaultConfig,
    trustedReviewers: defaultReviewers,
    ...overrides,
  };
}

describe("evaluateMergeReadiness", () => {
  describe("feature disabled", () => {
    it("should skip when config is null", async () => {
      const params = buildParams({ config: null });
      const result = await evaluateMergeReadiness(params);

      expect(result).toEqual({ action: "skipped", reason: "feature disabled" });
      expect(params.prs.getLabels).not.toHaveBeenCalled();
    });
  });

  describe("implementation label check", () => {
    it("should skip when PR has no implementation label", async () => {
      const prs = createMockPrs({
        getLabels: vi.fn().mockResolvedValue(["bug"]),
      });
      const result = await evaluateMergeReadiness(buildParams({ prs }));

      expect(result).toEqual({ action: "skipped", reason: "no implementation label" });
    });

    it("should remove merge-ready if implementation label is missing but merge-ready is present", async () => {
      const prs = createMockPrs({
        getLabels: vi.fn().mockResolvedValue(["hivemoot:merge-ready"]),
      });
      const result = await evaluateMergeReadiness(buildParams({ prs }));

      expect(result).toEqual({ action: "removed" });
      expect(prs.removeLabel).toHaveBeenCalledWith(defaultRef, "hivemoot:merge-ready");
    });

    it("should use pre-fetched labels when provided", async () => {
      const prs = createMockPrs();
      const result = await evaluateMergeReadiness(
        buildParams({ prs, currentLabels: ["bug"] })
      );

      expect(result).toEqual({ action: "skipped", reason: "no implementation label" });
      expect(prs.getLabels).not.toHaveBeenCalled();
    });
  });

  describe("draft check", () => {
    it("should skip when draft is pre-fetched as true", async () => {
      const prs = createMockPrs();
      const result = await evaluateMergeReadiness(buildParams({ prs, draft: true }));

      expect(result).toEqual({ action: "skipped", reason: "PR is draft" });
      expect(prs.getApproverLogins).not.toHaveBeenCalled();
      expect(prs.getCheckRunsForRef).not.toHaveBeenCalled();
    });

    it("should remove merge-ready when draft is pre-fetched as true and label is present", async () => {
      const prs = createMockPrs({
        getLabels: vi.fn().mockResolvedValue(["hivemoot:candidate", "hivemoot:merge-ready"]),
      });
      const result = await evaluateMergeReadiness(buildParams({ prs, draft: true }));

      expect(result).toEqual({ action: "removed" });
      expect(prs.removeLabel).toHaveBeenCalledWith(defaultRef, "hivemoot:merge-ready");
    });

    it("should remove merge-ready when draft is discovered via prs.get()", async () => {
      const prs = createMockPrs({
        getLabels: vi.fn().mockResolvedValue(["hivemoot:candidate", "hivemoot:merge-ready"]),
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
        get: vi.fn().mockResolvedValue({ headSha: "abc123", mergeable: true, draft: true }),
      });
      const result = await evaluateMergeReadiness(buildParams({ prs }));

      expect(result).toEqual({ action: "removed" });
      expect(prs.removeLabel).toHaveBeenCalledWith(defaultRef, "hivemoot:merge-ready");
      expect(prs.getCheckRunsForRef).not.toHaveBeenCalled();
    });

    it("should skip when draft is discovered via prs.get() and merge-ready is absent", async () => {
      const prs = createMockPrs({
        getLabels: vi.fn().mockResolvedValue(["hivemoot:candidate"]),
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
        get: vi.fn().mockResolvedValue({ headSha: "abc123", mergeable: true, draft: true }),
      });
      const result = await evaluateMergeReadiness(buildParams({ prs }));

      expect(result).toEqual({ action: "skipped", reason: "PR is draft" });
      expect(prs.removeLabel).not.toHaveBeenCalled();
      expect(prs.getCheckRunsForRef).not.toHaveBeenCalled();
    });

    it("should fetch PR draft when headSha is pre-fetched and draft is missing", async () => {
      const prs = createMockPrs({
        getLabels: vi.fn().mockResolvedValue(["hivemoot:candidate"]),
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
        get: vi.fn().mockResolvedValue({ headSha: "abc123", mergeable: true, draft: true }),
      });
      const result = await evaluateMergeReadiness(
        buildParams({ prs, headSha: "precomputed-sha" })
      );

      expect(result).toEqual({ action: "skipped", reason: "PR is draft" });
      expect(prs.get).toHaveBeenCalledWith(defaultRef);
      expect(prs.getCheckRunsForRef).not.toHaveBeenCalled();
    });

    it("should skip PR fetch when both headSha and draft are pre-fetched", async () => {
      const prs = createMockPrs({
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
        getCheckRunsForRef: vi.fn().mockResolvedValue({ totalCount: 0, checkRuns: [] }),
        getCombinedStatus: vi.fn().mockResolvedValue({ state: "pending", totalCount: 0 }),
      });
      const result = await evaluateMergeReadiness(
        buildParams({ prs, headSha: "precomputed-sha", draft: false })
      );

      expect(result.action).toBe("added");
      expect(prs.get).not.toHaveBeenCalled();
    });
  });

  describe("approval check", () => {
    it("should skip when no trusted approvals", async () => {
      const prs = createMockPrs({
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["random-user"])),
      });
      const result = await evaluateMergeReadiness(buildParams({ prs }));

      expect(result).toEqual({
        action: "skipped",
        reason: "insufficient approvals (0/1)",
      });
    });

    it("should skip when fewer trusted approvals than minApprovals", async () => {
      const prs = createMockPrs({
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
      });
      const result = await evaluateMergeReadiness(
        buildParams({ prs, config: { minApprovals: 2 } })
      );

      expect(result).toEqual({
        action: "skipped",
        reason: "insufficient approvals (1/2)",
      });
    });

    it("should remove merge-ready when approvals drop below threshold", async () => {
      const prs = createMockPrs({
        getLabels: vi.fn().mockResolvedValue(["hivemoot:candidate", "hivemoot:merge-ready"]),
        getApproverLogins: vi.fn().mockResolvedValue(new Set<string>()),
      });
      const result = await evaluateMergeReadiness(buildParams({ prs }));

      expect(result).toEqual({ action: "removed" });
      expect(prs.removeLabel).toHaveBeenCalledWith(defaultRef, "hivemoot:merge-ready");
    });

    it("should count only trusted reviewers from the approvers set", async () => {
      const prs = createMockPrs({
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "random-user", "another-random"])),
        getCheckRunsForRef: vi.fn().mockResolvedValue({ totalCount: 0, checkRuns: [] }),
        getCombinedStatus: vi.fn().mockResolvedValue({ state: "pending", totalCount: 0 }),
      });

      const result = await evaluateMergeReadiness(buildParams({ prs }));

      // alice is trusted → 1 approval meets minApprovals: 1
      expect(result.action).toBe("added");
    });
  });

  describe("mergeable check", () => {
    it("should skip when PR has merge conflicts (mergeable: false)", async () => {
      const prs = createMockPrs({
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
        get: vi.fn().mockResolvedValue({ headSha: "abc123", mergeable: false }),
      });
      const result = await evaluateMergeReadiness(buildParams({ prs }));

      expect(result).toEqual({ action: "skipped", reason: "has merge conflicts" });
      expect(prs.getCheckRunsForRef).not.toHaveBeenCalled();
    });

    it("should remove merge-ready when PR has conflicts and label is present", async () => {
      const prs = createMockPrs({
        getLabels: vi.fn().mockResolvedValue(["hivemoot:candidate", "hivemoot:merge-ready"]),
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
        get: vi.fn().mockResolvedValue({ headSha: "abc123", mergeable: false }),
      });
      const result = await evaluateMergeReadiness(buildParams({ prs }));

      expect(result).toEqual({ action: "removed" });
      expect(prs.removeLabel).toHaveBeenCalledWith(defaultRef, "hivemoot:merge-ready");
    });

    it("should pass through when mergeable is null (not yet computed)", async () => {
      const prs = createMockPrs({
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
        get: vi.fn().mockResolvedValue({ headSha: "abc123", mergeable: null }),
        getCheckRunsForRef: vi.fn().mockResolvedValue({ totalCount: 0, checkRuns: [] }),
        getCombinedStatus: vi.fn().mockResolvedValue({ state: "pending", totalCount: 0 }),
      });
      const result = await evaluateMergeReadiness(buildParams({ prs }));

      expect(result.action).toBe("added");
    });

    it("should pass through when mergeable is true", async () => {
      const prs = createMockPrs({
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
        get: vi.fn().mockResolvedValue({ headSha: "abc123", mergeable: true }),
        getCheckRunsForRef: vi.fn().mockResolvedValue({ totalCount: 0, checkRuns: [] }),
        getCombinedStatus: vi.fn().mockResolvedValue({ state: "pending", totalCount: 0 }),
      });
      const result = await evaluateMergeReadiness(buildParams({ prs }));

      expect(result.action).toBe("added");
    });

    it("should skip mergeable check when headSha and draft are pre-fetched (webhook path)", async () => {
      const prs = createMockPrs({
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
        getCheckRunsForRef: vi.fn().mockResolvedValue({ totalCount: 0, checkRuns: [] }),
        getCombinedStatus: vi.fn().mockResolvedValue({ state: "pending", totalCount: 0 }),
      });
      const result = await evaluateMergeReadiness(
        buildParams({ prs, headSha: "precomputed-sha", draft: false })
      );

      expect(result.action).toBe("added");
      expect(prs.get).not.toHaveBeenCalled();
    });
  });

  describe("CI status check", () => {
    function buildCIParams(
      checkRuns: Array<{ id: number; status: string; conclusion: string | null }>,
      statusState: string,
      statusCount: number,
      extraOverrides: Partial<MergeReadinessParams> = {}
    ): MergeReadinessParams {
      const prs = createMockPrs({
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
        getCheckRunsForRef: vi.fn().mockResolvedValue({
          totalCount: checkRuns.length,
          checkRuns,
        }),
        getCombinedStatus: vi.fn().mockResolvedValue({
          state: statusState,
          totalCount: statusCount,
        }),
      });
      return buildParams({ prs, ...extraOverrides });
    }

    it("should fail-closed when check runs are truncated (totalCount > returned)", async () => {
      const prs = createMockPrs({
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
        getCheckRunsForRef: vi.fn().mockResolvedValue({
          totalCount: 150,
          checkRuns: [{ id: 1, status: "completed", conclusion: "success" }],
        }),
        getCombinedStatus: vi.fn().mockResolvedValue({ state: "pending", totalCount: 0 }),
      });
      const result = await evaluateMergeReadiness(buildParams({ prs }));

      expect(result).toEqual({ action: "skipped", reason: "CI not passing" });
    });

    it("should skip when check runs are pending", async () => {
      const result = await evaluateMergeReadiness(
        buildCIParams(
          [{ id: 1, status: "in_progress", conclusion: null }],
          "pending",
          0
        )
      );

      expect(result).toEqual({ action: "skipped", reason: "CI not passing" });
    });

    it("should skip when check runs have failed conclusion", async () => {
      const result = await evaluateMergeReadiness(
        buildCIParams(
          [{ id: 1, status: "completed", conclusion: "failure" }],
          "pending",
          0
        )
      );

      expect(result).toEqual({ action: "skipped", reason: "CI not passing" });
    });

    it("should skip when check runs have cancelled conclusion", async () => {
      const result = await evaluateMergeReadiness(
        buildCIParams(
          [{ id: 1, status: "completed", conclusion: "cancelled" }],
          "pending",
          0
        )
      );

      expect(result).toEqual({ action: "skipped", reason: "CI not passing" });
    });

    it("should skip when completed check run has null conclusion", async () => {
      const result = await evaluateMergeReadiness(
        buildCIParams(
          [{ id: 1, status: "completed", conclusion: null }],
          "pending",
          0
        )
      );

      expect(result).toEqual({ action: "skipped", reason: "CI not passing" });
    });

    it("should fail when any check run in a mixed set fails", async () => {
      const result = await evaluateMergeReadiness(
        buildCIParams(
          [
            { id: 1, status: "completed", conclusion: "success" },
            { id: 2, status: "completed", conclusion: "neutral" },
            { id: 3, status: "completed", conclusion: "failure" },
          ],
          "pending",
          0
        )
      );

      expect(result).toEqual({ action: "skipped", reason: "CI not passing" });
    });

    it("should pass with success conclusion", async () => {
      const result = await evaluateMergeReadiness(
        buildCIParams(
          [{ id: 1, status: "completed", conclusion: "success" }],
          "pending",
          0
        )
      );

      expect(result.action).toBe("added");
    });

    it("should pass with neutral conclusion", async () => {
      const result = await evaluateMergeReadiness(
        buildCIParams(
          [{ id: 1, status: "completed", conclusion: "neutral" }],
          "pending",
          0
        )
      );

      expect(result.action).toBe("added");
    });

    it("should pass with skipped conclusion", async () => {
      const result = await evaluateMergeReadiness(
        buildCIParams(
          [{ id: 1, status: "completed", conclusion: "skipped" }],
          "pending",
          0
        )
      );

      expect(result.action).toBe("added");
    });

    it("should pass when zero checks exist (no CI configured)", async () => {
      const result = await evaluateMergeReadiness(
        buildCIParams([], "pending", 0)
      );

      expect(result.action).toBe("added");
    });

    it("should fail when legacy status API reports failure", async () => {
      const result = await evaluateMergeReadiness(
        buildCIParams([], "failure", 1)
      );

      expect(result).toEqual({ action: "skipped", reason: "CI not passing" });
    });

    it("should pass when legacy status API reports success", async () => {
      const result = await evaluateMergeReadiness(
        buildCIParams([], "success", 1)
      );

      expect(result.action).toBe("added");
    });

    it("should fail when checks pass but legacy status fails", async () => {
      const result = await evaluateMergeReadiness(
        buildCIParams(
          [{ id: 1, status: "completed", conclusion: "success" }],
          "failure",
          1
        )
      );

      expect(result).toEqual({ action: "skipped", reason: "CI not passing" });
    });

    it("should remove merge-ready label when CI fails and label is present", async () => {
      const params = buildCIParams(
        [{ id: 1, status: "completed", conclusion: "failure" }],
        "pending",
        0,
        { currentLabels: ["hivemoot:candidate", "hivemoot:merge-ready"] }
      );
      const result = await evaluateMergeReadiness(params);

      expect(result).toEqual({ action: "removed" });
      expect(params.prs.removeLabel).toHaveBeenCalledWith(defaultRef, "hivemoot:merge-ready");
    });

    it("should use pre-fetched headSha for CI even when draft requires PR fetch", async () => {
      const prs = createMockPrs({
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
        get: vi.fn().mockResolvedValue({ headSha: "different-sha", mergeable: true, draft: false }),
        getCheckRunsForRef: vi.fn().mockResolvedValue({ totalCount: 0, checkRuns: [] }),
        getCombinedStatus: vi.fn().mockResolvedValue({ state: "pending", totalCount: 0 }),
      });
      const result = await evaluateMergeReadiness(
        buildParams({ prs, headSha: "precomputed-sha" })
      );

      expect(result.action).toBe("added");
      expect(prs.get).toHaveBeenCalledWith(defaultRef);
      expect(prs.getCheckRunsForRef).toHaveBeenCalledWith(
        "test-org",
        "test-repo",
        "precomputed-sha"
      );
    });
  });

  describe("label management", () => {
    function buildAllPassingParams(
      labelOverrides: string[] = ["hivemoot:candidate"]
    ): MergeReadinessParams {
      const prs = createMockPrs({
        getLabels: vi.fn().mockResolvedValue(labelOverrides),
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
        getCheckRunsForRef: vi.fn().mockResolvedValue({
          totalCount: 1,
          checkRuns: [{ id: 1, status: "completed", conclusion: "success" }],
        }),
        getCombinedStatus: vi.fn().mockResolvedValue({ state: "success", totalCount: 1 }),
      });
      return buildParams({ prs });
    }

    it("should add merge-ready label when all conditions met", async () => {
      const params = buildAllPassingParams();
      const result = await evaluateMergeReadiness(params);

      expect(result).toEqual({ action: "added" });
      expect(params.prs.addLabels).toHaveBeenCalledWith(defaultRef, ["hivemoot:merge-ready"]);
    });

    it("should noop when label already present and conditions still met", async () => {
      const params = buildAllPassingParams(["hivemoot:candidate", "hivemoot:merge-ready"]);
      const result = await evaluateMergeReadiness(params);

      expect(result).toEqual({ action: "noop", labeled: true });
      expect(params.prs.addLabels).not.toHaveBeenCalled();
      expect(params.prs.removeLabel).not.toHaveBeenCalled();
    });
  });
});
