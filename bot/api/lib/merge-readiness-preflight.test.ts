import { describe, it, expect, vi } from "vitest";
import { evaluatePreflightChecks } from "./merge-readiness.js";
import type { PreflightParams, PreflightResult } from "./merge-readiness.js";
import type { PROperations } from "./pr-operations.js";

/**
 * Tests for evaluatePreflightChecks — the shared checklist evaluation
 * used by both the merge-ready label automation and the /preflight command.
 *
 * Verifies:
 * - All checks run without short-circuiting (unlike evaluateMergeReadiness)
 * - Hard vs advisory severity is correctly assigned
 * - allHardChecksPassed reflects only hard gates
 * - Individual check details are informative
 */

function createMockPrs(overrides: Partial<Record<keyof PROperations, unknown>> = {}): PROperations {
  return {
    getLabels: vi.fn().mockResolvedValue(["hivemoot:candidate", "hivemoot:merge-ready"]),
    getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
    get: vi.fn().mockResolvedValue({ headSha: "abc123", mergeable: true, state: "open", merged: false }),
    getCheckRunsForRef: vi.fn().mockResolvedValue({ totalCount: 0, checkRuns: [] }),
    getCombinedStatus: vi.fn().mockResolvedValue({ state: "pending", totalCount: 0, statuses: [] }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PROperations;
}

const defaultRef = { owner: "test-org", repo: "test-repo", prNumber: 42 };
const defaultConfig = { minApprovals: 1 };
const defaultReviewers = ["alice", "bob"];

function buildParams(overrides: Partial<PreflightParams> = {}): PreflightParams {
  return {
    prs: createMockPrs(),
    ref: defaultRef,
    config: defaultConfig,
    trustedReviewers: defaultReviewers,
    ...overrides,
  };
}

function findCheck(result: PreflightResult, name: string) {
  return result.checks.find(c => c.name === name);
}

describe("evaluatePreflightChecks", () => {
  describe("does not short-circuit", () => {
    it("should return all checks even when early ones fail", async () => {
      const prs = createMockPrs({
        getApproverLogins: vi.fn().mockResolvedValue(new Set<string>()),
        get: vi.fn().mockResolvedValue({ headSha: "abc123", mergeable: false, state: "open", merged: false }),
        getLabels: vi.fn().mockResolvedValue([]),
      });

      const result = await evaluatePreflightChecks(buildParams({ prs }));

      // All 6 checks should be present (PR open + 3 hard + 2 advisory)
      expect(result.checks).toHaveLength(6);

      const prOpen = findCheck(result, "PR is open");
      expect(prOpen?.passed).toBe(true);

      const approvals = findCheck(result, "Approved by trusted reviewers");
      expect(approvals?.passed).toBe(false);

      const conflicts = findCheck(result, "No merge conflicts");
      expect(conflicts?.passed).toBe(false);

      const ci = findCheck(result, "CI checks passing");
      expect(ci).toBeDefined(); // CI check was still evaluated

      const implLabel = findCheck(result, "Implementation label");
      expect(implLabel?.passed).toBe(false);

      const mergeLabel = findCheck(result, "Merge-ready label");
      expect(mergeLabel?.passed).toBe(false);
    });
  });

  describe("PR state check", () => {
    it("should pass when PR is open", async () => {
      const result = await evaluatePreflightChecks(buildParams());

      const check = findCheck(result, "PR is open");
      expect(check?.passed).toBe(true);
      expect(check?.severity).toBe("hard");
      expect(check?.detail).toBe("PR is open");
    });

    it("should fail when PR is already merged", async () => {
      const prs = createMockPrs({
        get: vi.fn().mockResolvedValue({ headSha: "abc123", mergeable: true, state: "closed", merged: true }),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs }));

      const check = findCheck(result, "PR is open");
      expect(check?.passed).toBe(false);
      expect(check?.detail).toContain("already merged");
    });

    it("should fail when PR is closed but not merged", async () => {
      const prs = createMockPrs({
        get: vi.fn().mockResolvedValue({ headSha: "abc123", mergeable: null, state: "closed", merged: false }),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs }));

      const check = findCheck(result, "PR is open");
      expect(check?.passed).toBe(false);
      expect(check?.detail).toContain("closed");
    });

    it("should cause allHardChecksPassed to be false when PR is merged", async () => {
      const prs = createMockPrs({
        get: vi.fn().mockResolvedValue({ headSha: "abc123", mergeable: true, state: "closed", merged: true }),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs }));

      expect(result.allHardChecksPassed).toBe(false);
    });

    it("should not include PR state check when headSha is pre-provided (webhook path)", async () => {
      const prs = createMockPrs();
      const result = await evaluatePreflightChecks(buildParams({ prs, headSha: "pre-sha" }));

      const check = findCheck(result, "PR is open");
      expect(check).toBeUndefined(); // Not present in webhook path
    });
  });

  describe("approvals check", () => {
    it("should pass when trusted reviewers meet minApprovals", async () => {
      const prs = createMockPrs({
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "bob"])),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs, config: { minApprovals: 2 } }));

      const check = findCheck(result, "Approved by trusted reviewers");
      expect(check?.passed).toBe(true);
      expect(check?.severity).toBe("hard");
      expect(check?.detail).toContain("2/2");
      expect(check?.detail).toContain("alice");
    });

    it("should fail when insufficient trusted approvals", async () => {
      const prs = createMockPrs({
        getApproverLogins: vi.fn().mockResolvedValue(new Set<string>()),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs }));

      const check = findCheck(result, "Approved by trusted reviewers");
      expect(check?.passed).toBe(false);
      expect(check?.detail).toContain("0/1");
    });

    it("should not count non-trusted reviewers", async () => {
      const prs = createMockPrs({
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["random-user"])),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs }));

      const check = findCheck(result, "Approved by trusted reviewers");
      expect(check?.passed).toBe(false);
    });
  });

  describe("mergeable check", () => {
    it("should pass when mergeable is true", async () => {
      const result = await evaluatePreflightChecks(buildParams());

      const check = findCheck(result, "No merge conflicts");
      expect(check?.passed).toBe(true);
      expect(check?.severity).toBe("hard");
    });

    it("should fail when mergeable is false", async () => {
      const prs = createMockPrs({
        get: vi.fn().mockResolvedValue({ headSha: "abc123", mergeable: false, state: "open", merged: false }),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs }));

      const check = findCheck(result, "No merge conflicts");
      expect(check?.passed).toBe(false);
      expect(check?.detail).toContain("merge conflicts");
    });

    it("should pass when mergeable is null (not yet computed)", async () => {
      const prs = createMockPrs({
        get: vi.fn().mockResolvedValue({ headSha: "abc123", mergeable: null, state: "open", merged: false }),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs }));

      const check = findCheck(result, "No merge conflicts");
      expect(check?.passed).toBe(true);
      expect(check?.detail).toContain("pending");
    });

    it("should use pre-fetched headSha and skip prs.get()", async () => {
      const prs = createMockPrs();
      const result = await evaluatePreflightChecks(buildParams({ prs, headSha: "pre-sha" }));

      expect(prs.get).not.toHaveBeenCalled();
      expect(prs.getCheckRunsForRef).toHaveBeenCalledWith("test-org", "test-repo", "pre-sha");
    });
  });

  describe("CI check", () => {
    it("should pass when all checks are green", async () => {
      const prs = createMockPrs({
        getCheckRunsForRef: vi.fn().mockResolvedValue({
          totalCount: 2,
          checkRuns: [
            { id: 1, status: "completed", conclusion: "success" },
            { id: 2, status: "completed", conclusion: "neutral" },
          ],
        }),
        getCombinedStatus: vi.fn().mockResolvedValue({ state: "success", totalCount: 1 }),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs }));

      const check = findCheck(result, "CI checks passing");
      expect(check?.passed).toBe(true);
      expect(check?.detail).toContain("3 check(s) passed");
    });

    it("should fail when check runs are pending", async () => {
      const prs = createMockPrs({
        getCheckRunsForRef: vi.fn().mockResolvedValue({
          totalCount: 1,
          checkRuns: [{ id: 1, name: "CI / build", status: "in_progress", conclusion: null }],
        }),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs }));

      const check = findCheck(result, "CI checks passing");
      expect(check?.passed).toBe(false);
      expect(check?.detail).toContain("Still running: CI / build");
      expect(check?.pendingTargets).toEqual(["CI / build"]);
    });

    it("should fail when legacy status contexts are pending", async () => {
      const prs = createMockPrs({
        getCombinedStatus: vi.fn().mockResolvedValue({
          state: "pending",
          totalCount: 2,
          statuses: [
            { state: "pending", context: "legacy / build" },
            { state: "pending", context: "legacy / test" },
          ],
        }),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs }));

      const check = findCheck(result, "CI checks passing");
      expect(check?.passed).toBe(false);
      expect(check?.detail).toContain("Still running: legacy / build, legacy / test");
      expect(check?.pendingTargets).toEqual(["legacy / build", "legacy / test"]);
    });

    it("should fail when check runs have failed conclusion", async () => {
      const prs = createMockPrs({
        getCheckRunsForRef: vi.fn().mockResolvedValue({
          totalCount: 1,
          checkRuns: [{ id: 1, status: "completed", conclusion: "failure" }],
        }),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs }));

      const check = findCheck(result, "CI checks passing");
      expect(check?.passed).toBe(false);
      expect(check?.detail).toContain("Failing");
    });

    it("should fail-closed when check runs are truncated", async () => {
      const prs = createMockPrs({
        getCheckRunsForRef: vi.fn().mockResolvedValue({
          totalCount: 150,
          checkRuns: [{ id: 1, status: "completed", conclusion: "success" }],
        }),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs }));

      const check = findCheck(result, "CI checks passing");
      expect(check?.passed).toBe(false);
      expect(check?.detail).toContain("fail-closed");
    });

    it("should pass with zero checks (no CI configured)", async () => {
      const result = await evaluatePreflightChecks(buildParams());

      const check = findCheck(result, "CI checks passing");
      expect(check?.passed).toBe(true);
      expect(check?.detail).toContain("No CI configured");
    });

    it("should fail when legacy status API reports failure", async () => {
      const prs = createMockPrs({
        getCombinedStatus: vi.fn().mockResolvedValue({
          state: "failure",
          totalCount: 1,
          statuses: [{ state: "failure", context: "legacy / build" }],
        }),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs }));

      const check = findCheck(result, "CI checks passing");
      expect(check?.passed).toBe(false);
      expect(check?.detail).toContain("Legacy status");
    });
  });

  describe("advisory checks", () => {
    it("should report implementation label as advisory", async () => {
      const result = await evaluatePreflightChecks(buildParams());

      const check = findCheck(result, "Implementation label");
      expect(check?.severity).toBe("advisory");
      expect(check?.passed).toBe(true);
    });

    it("should report missing implementation label", async () => {
      const prs = createMockPrs({
        getLabels: vi.fn().mockResolvedValue(["bug"]),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs }));

      const check = findCheck(result, "Implementation label");
      expect(check?.passed).toBe(false);
      expect(check?.severity).toBe("advisory");
    });

    it("should report merge-ready label as advisory", async () => {
      const result = await evaluatePreflightChecks(buildParams());

      const check = findCheck(result, "Merge-ready label");
      expect(check?.severity).toBe("advisory");
    });

    it("should use pre-fetched labels when provided", async () => {
      const prs = createMockPrs();
      await evaluatePreflightChecks(buildParams({
        prs,
        currentLabels: ["hivemoot:candidate"],
      }));

      expect(prs.getLabels).not.toHaveBeenCalled();
    });
  });

  describe("allHardChecksPassed", () => {
    it("should be true when all hard checks pass (advisory failures don't affect it)", async () => {
      const prs = createMockPrs({
        getLabels: vi.fn().mockResolvedValue([]), // No labels — advisory checks fail
      });
      const result = await evaluatePreflightChecks(buildParams({ prs }));

      // Hard checks pass (approvals + no conflicts + CI), advisory fail (no labels)
      expect(result.allHardChecksPassed).toBe(true);
    });

    it("should be false when any hard check fails", async () => {
      const prs = createMockPrs({
        getApproverLogins: vi.fn().mockResolvedValue(new Set<string>()),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs }));

      expect(result.allHardChecksPassed).toBe(false);
    });

    it("should be false when CI fails even if other hard checks pass", async () => {
      const prs = createMockPrs({
        getCheckRunsForRef: vi.fn().mockResolvedValue({
          totalCount: 1,
          checkRuns: [{ id: 1, status: "completed", conclusion: "failure" }],
        }),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs }));

      expect(result.allHardChecksPassed).toBe(false);
    });
  });

  describe("config handling", () => {
    it("should default to minApprovals=1 when config is null", async () => {
      const prs = createMockPrs({
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
      });
      const result = await evaluatePreflightChecks(buildParams({ prs, config: null }));

      const check = findCheck(result, "Approved by trusted reviewers");
      expect(check?.passed).toBe(true);
      expect(check?.detail).toContain("1/1");
    });
  });
});
