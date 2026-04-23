/**
 * Merge-Readiness & Preflight Evaluation
 *
 * Shared checklist evaluation used by both:
 * - The merge-ready label automation (webhook-driven)
 * - The /preflight command (on-demand readiness report)
 *
 * Conditions (hard gates — block merge-ready label):
 * 1. PR is open and not merged
 * 2. PR is not draft
 * 3. At least minApprovals approvals from trustedReviewers
 * 4. PR is not conflicting (`mergeable !== false`; `null` = not yet computed, allowed)
 * 5. All check runs on HEAD are completed with success/neutral/skipped
 * 6. All commit statuses on HEAD are success (legacy Status API)
 *
 * Advisory checks (informational — do not block):
 * - PR has `implementation` label
 * - PR has `merge-ready` label
 *
 * Short-circuit order in evaluateMergeReadiness optimized by API cost:
 * config → labels → draft (if pre-fetched) → approvals (1 call)
 * → PR fetch (for missing headSha and/or missing draft)
 * → mergeable → CI (2 calls)
 */

import { LABELS, isLabelMatch } from "../config.js";
import type { PRRef } from "./types.js";
import type { PROperations } from "./pr-operations.js";
import type { MergeReadyConfig } from "./repo-config.js";

// ───────────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────────

export interface MergeReadinessParams {
  prs: PROperations;
  ref: PRRef;
  config: MergeReadyConfig | null;
  trustedReviewers: string[];
  /** Pre-fetched labels to avoid extra API call (from webhook payload). */
  currentLabels?: string[];
  /** Draft state from webhook payload (optional; fetched from PR when absent). */
  draft?: boolean;
  /** HEAD SHA to check CI against. Fetched from PR if not provided. */
  headSha?: string;
  log?: { info: (msg: string) => void; debug?: (msg: string) => void };
}

export type MergeReadinessResult =
  | { action: "skipped"; reason: string }
  | { action: "added" }
  | { action: "removed" }
  | { action: "noop"; labeled: boolean };

// ───────────────────────────────────────────────────────────────────────────────
// Preflight Check Types (shared between merge-ready label and /preflight command)
// ───────────────────────────────────────────────────────────────────────────────

export type PreflightSeverity = "hard" | "advisory";

export interface PreflightCheckItem {
  name: string;
  passed: boolean;
  severity: PreflightSeverity;
  detail: string;
  pendingTargets?: string[];
}

export interface PreflightResult {
  checks: PreflightCheckItem[];
  /** Whether all hard checks passed */
  allHardChecksPassed: boolean;
}

export interface PreflightParams {
  prs: PROperations;
  ref: PRRef;
  config: MergeReadyConfig | null;
  trustedReviewers: string[];
  /** Pre-fetched labels to avoid extra API call. */
  currentLabels?: string[];
  /** HEAD SHA to check CI against. Fetched from PR if not provided. */
  headSha?: string;
}

// ───────────────────────────────────────────────────────────────────────────────
// Preflight Evaluation (shared core)
// ───────────────────────────────────────────────────────────────────────────────

/** Check run conclusions that count as passing. */
const PASSING_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * Evaluate all preflight checks for a PR without short-circuiting.
 * Returns individual check results so callers can render a full report
 * or use the results for label management.
 *
 * This is the shared core used by both:
 * - `evaluateMergeReadiness()` — for label automation
 * - `handlePreflight()` — for the /preflight command report
 */
export async function evaluatePreflightChecks(
  params: PreflightParams
): Promise<PreflightResult> {
  const { prs, ref, config, trustedReviewers } = params;
  const checks: PreflightCheckItem[] = [];

  // Fetch PR data upfront when not pre-provided (needed for state, mergeable, headSha)
  let headSha: string;
  let mergeable: boolean | null;
  let prState: string | null = null;
  let prMerged: boolean | null = null;
  if (params.headSha) {
    // Webhook path: headSha pre-fetched, PR is guaranteed open by webhook context
    headSha = params.headSha;
    mergeable = null;
  } else {
    const pr = await prs.get(ref);
    headSha = pr.headSha;
    mergeable = pr.mergeable;
    prState = pr.state;
    prMerged = pr.merged;
  }

  // 1. PR is open (hard gate)
  // When headSha is pre-provided (webhook path), we skip this check because
  // webhooks only fire on open PRs. For /preflight (on-demand), this prevents
  // reporting "ready for merge" on closed or already-merged PRs.
  if (prState !== null) {
    const isOpen = prState === "open" && !prMerged;
    checks.push({
      name: "PR is open",
      passed: isOpen,
      severity: "hard",
      detail: prMerged
        ? "PR is already merged"
        : prState !== "open"
          ? `PR is ${prState}`
          : "PR is open",
    });
  }

  // 2. Approvals (hard gate)
  const approvers = await prs.getApproverLogins(ref);
  const trustedApprovers = trustedReviewers.filter((r) => approvers.has(r));
  const minApprovals = config?.minApprovals ?? 1;

  checks.push({
    name: "Approved by trusted reviewers",
    passed: trustedApprovers.length >= minApprovals,
    severity: "hard",
    detail: trustedApprovers.length >= minApprovals
      ? `${trustedApprovers.length}/${minApprovals} trusted approvals (${trustedApprovers.join(", ")})`
      : `${trustedApprovers.length}/${minApprovals} trusted approvals`,
  });

  // 3. Mergeable state (hard gate)
  // mergeable === null means GitHub hasn't computed yet — treat as passing
  checks.push({
    name: "No merge conflicts",
    passed: mergeable !== false,
    severity: "hard",
    detail: mergeable === false
      ? "PR has merge conflicts"
      : mergeable === null
        ? "Mergeable (pending GitHub computation)"
        : "Branch is mergeable",
  });

  // 4. CI status (hard gate, 2 API calls in parallel)
  const ciResult = await evaluateCI(prs, ref, headSha);
  checks.push(ciResult);

  // 5. Implementation label (advisory)
  const labels = params.currentLabels ?? await prs.getLabels(ref);
  const hasImplementation = labels.some(l => isLabelMatch(l, LABELS.IMPLEMENTATION));
  checks.push({
    name: "Implementation label",
    passed: hasImplementation,
    severity: "advisory",
    detail: hasImplementation
      ? "Has `hivemoot:candidate` label"
      : "Missing `hivemoot:candidate` label",
  });

  // 6. Merge-ready label (advisory)
  const hasMergeReady = labels.some(l => isLabelMatch(l, LABELS.MERGE_READY));
  checks.push({
    name: "Merge-ready label",
    passed: hasMergeReady,
    severity: "advisory",
    detail: hasMergeReady
      ? "Has `hivemoot:merge-ready` label"
      : "Missing `hivemoot:merge-ready` label",
  });

  const allHardChecksPassed = checks
    .filter(c => c.severity === "hard")
    .every(c => c.passed);

  return { checks, allHardChecksPassed };
}

/**
 * Evaluate CI status and return a PreflightCheckItem.
 */
async function evaluateCI(
  prs: PROperations,
  ref: PRRef,
  sha: string
): Promise<PreflightCheckItem> {
  const [checksResult, statusResult] = await Promise.all([
    prs.getCheckRunsForRef(ref.owner, ref.repo, sha),
    prs.getCombinedStatus(ref.owner, ref.repo, sha),
  ]);

  // Fail-closed if check runs were truncated (>100)
  if (checksResult.totalCount > checksResult.checkRuns.length) {
    return {
      name: "CI checks passing",
      passed: false,
      severity: "hard",
      detail: `Too many check runs (${checksResult.totalCount}) to verify — fail-closed`,
    };
  }

  // Check Runs: all must be completed with a passing conclusion
  const failingChecks: string[] = [];
  const pendingChecks: string[] = [];
  for (const checkRun of checksResult.checkRuns) {
    if (checkRun.status !== "completed") {
      pendingChecks.push(checkRun.name ?? `check #${checkRun.id}`);
    } else if (!checkRun.conclusion || !PASSING_CHECK_CONCLUSIONS.has(checkRun.conclusion)) {
      failingChecks.push(`${checkRun.name ?? `check #${checkRun.id}`}: ${checkRun.conclusion ?? "no conclusion"}`);
    }
  }

  if (pendingChecks.length > 0) {
    return {
      name: "CI checks passing",
      passed: false,
      severity: "hard",
      detail: `Still running: ${pendingChecks.join(", ")}`,
      pendingTargets: pendingChecks,
    };
  }

  if (failingChecks.length > 0) {
    return {
      name: "CI checks passing",
      passed: false,
      severity: "hard",
      detail: `Failing: ${failingChecks.join(", ")}`,
    };
  }

  const pendingStatuses = (statusResult.statuses ?? [])
    .filter((status) => status.state === "pending")
    .map((status) => status.context)
    .filter((context) => context.length > 0);

  if (pendingStatuses.length > 0) {
    return {
      name: "CI checks passing",
      passed: false,
      severity: "hard",
      detail: `Still running: ${pendingStatuses.join(", ")}`,
      pendingTargets: pendingStatuses,
    };
  }

  // Legacy Status API
  if (statusResult.totalCount > 0 && statusResult.state !== "success") {
    return {
      name: "CI checks passing",
      passed: false,
      severity: "hard",
      detail: statusResult.state === "pending"
        ? "Still running: legacy status checks"
        : `Legacy status: ${statusResult.state}`,
      pendingTargets: statusResult.state === "pending" ? ["legacy status checks"] : undefined,
    };
  }

  const totalChecks = checksResult.checkRuns.length + statusResult.totalCount;
  return {
    name: "CI checks passing",
    passed: true,
    severity: "hard",
    detail: totalChecks > 0
      ? `All ${totalChecks} check(s) passed`
      : "No CI configured",
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Merge-Readiness Label Management (consumes preflight checks)
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate whether a PR meets all merge-readiness conditions and
 * add or remove the `merge-ready` label accordingly.
 *
 * Idempotent: safe to call multiple times for the same PR.
 *
 * This function preserves the original short-circuit behavior for performance
 * in webhook handlers, while sharing the same check logic as preflight.
 */
export async function evaluateMergeReadiness(
  params: MergeReadinessParams
): Promise<MergeReadinessResult> {
  const { prs, ref, config, trustedReviewers, log } = params;

  // 1. Feature disabled → skip
  if (!config) {
    return { action: "skipped", reason: "feature disabled" };
  }

  // 2. Check implementation label (use pre-fetched labels or fetch)
  const labels = params.currentLabels ?? await prs.getLabels(ref);
  const hasImplementation = labels.some(l => isLabelMatch(l, LABELS.IMPLEMENTATION));
  const hasMergeReady = labels.some(l => isLabelMatch(l, LABELS.MERGE_READY));

  // Draft PRs are never merge-ready.
  if (params.draft === true) {
    if (hasMergeReady) {
      await prs.removeLabel(ref, LABELS.MERGE_READY);
      log?.info(`[PR #${ref.prNumber}] Removed merge-ready: PR is draft`);
      return { action: "removed" };
    }
    return { action: "skipped", reason: "PR is draft" };
  }

  if (!hasImplementation) {
    if (hasMergeReady) {
      await prs.removeLabel(ref, LABELS.MERGE_READY);
      log?.info(`[PR #${ref.prNumber}] Removed merge-ready: no implementation label`);
      return { action: "removed" };
    }
    return { action: "skipped", reason: "no implementation label" };
  }

  // 3. Check trusted approvals (1 API call)
  const approvers = await prs.getApproverLogins(ref);
  const trustedApprovalCount = trustedReviewers.filter((reviewer) =>
    approvers.has(reviewer)
  ).length;

  if (trustedApprovalCount < config.minApprovals) {
    if (hasMergeReady) {
      await prs.removeLabel(ref, LABELS.MERGE_READY);
      log?.info(
        `[PR #${ref.prNumber}] Removed merge-ready: ${trustedApprovalCount}/${config.minApprovals} trusted approvals`
      );
      return { action: "removed" };
    }
    return {
      action: "skipped",
      reason: `insufficient approvals (${trustedApprovalCount}/${config.minApprovals})`,
    };
  }

  // 4. Resolve HEAD SHA + mergeable state and ensure draft is known.
  // When draft is not pre-fetched, we fetch PR state even if headSha is provided,
  // so SHA-only webhooks (check_run/check_suite/status) still enforce draft gating.
  let draft: boolean | undefined = params.draft;
  let headSha: string;
  let mergeable: boolean | null;
  if (params.headSha && draft !== undefined) {
    headSha = params.headSha;
    // When headSha is pre-fetched (webhook payload), we don't have mergeable — treat as unknown
    mergeable = null;
  } else {
    const pr = await prs.get(ref);
    headSha = params.headSha ?? pr.headSha;
    // With pre-fetched SHA we still treat mergeable as unknown for this path.
    mergeable = params.headSha ? null : pr.mergeable;
    if (draft === undefined) {
      draft = pr.draft;
    }
  }

  if (draft === true) {
    if (hasMergeReady) {
      await prs.removeLabel(ref, LABELS.MERGE_READY);
      log?.info(`[PR #${ref.prNumber}] Removed merge-ready: PR is draft`);
      return { action: "removed" };
    }
    return { action: "skipped", reason: "PR is draft" };
  }

  // 5. Check mergeable state (null = not yet computed by GitHub, allow through)
  if (mergeable === false) {
    if (hasMergeReady) {
      await prs.removeLabel(ref, LABELS.MERGE_READY);
      log?.info(`[PR #${ref.prNumber}] Removed merge-ready: has merge conflicts`);
      return { action: "removed" };
    }
    return { action: "skipped", reason: "has merge conflicts" };
  }

  // 6. Check CI status (2 API calls in parallel)
  const ciPassing = await isCIPassing(prs, ref, headSha);

  if (!ciPassing) {
    if (hasMergeReady) {
      await prs.removeLabel(ref, LABELS.MERGE_READY);
      log?.info(`[PR #${ref.prNumber}] Removed merge-ready: CI not passing`);
      return { action: "removed" };
    }
    return { action: "skipped", reason: "CI not passing" };
  }

  // All conditions met → add label if not present
  if (!hasMergeReady) {
    await prs.addLabels(ref, [LABELS.MERGE_READY]);
    log?.info(`[PR #${ref.prNumber}] Added merge-ready label`);
    return { action: "added" };
  }

  return { action: "noop", labeled: true };
}

/**
 * Check that all CI signals are passing for the given SHA.
 *
 * Queries both the Checks API (GitHub Actions) and the legacy Status API
 * (external CI like Jenkins) in parallel. Both must pass.
 *
 * Zero checks/statuses = treated as passing (repo has no CI configured).
 */
export async function isCIPassing(
  prs: PROperations,
  ref: PRRef,
  sha: string
): Promise<boolean> {
  const [checksResult, statusResult] = await Promise.all([
    prs.getCheckRunsForRef(ref.owner, ref.repo, sha),
    prs.getCombinedStatus(ref.owner, ref.repo, sha),
  ]);

  // Fail-closed if check runs were truncated (>100) — we can't verify unseen checks
  if (checksResult.totalCount > checksResult.checkRuns.length) {
    return false;
  }

  // Check Runs: all must be completed with a passing conclusion
  for (const checkRun of checksResult.checkRuns) {
    if (checkRun.status !== "completed") {
      return false;
    }
    if (!checkRun.conclusion || !PASSING_CHECK_CONCLUSIONS.has(checkRun.conclusion)) {
      return false;
    }
  }

  // Legacy Status API: combined state must be "success" or no statuses at all
  if (statusResult.totalCount > 0 && statusResult.state !== "success") {
    return false;
  }

  return true;
}
