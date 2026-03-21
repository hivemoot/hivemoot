/**
 * Automerge PR Classification
 *
 * Evaluates whether a PR qualifies for automatic merging based on:
 * 1. PR state: not a draft and no merge conflicts
 * 2. File paths pass allowlist/denylist filtering
 * 3. File count within maxFiles threshold
 * 4. Total changed lines within maxChangedLines threshold
 * 5. Minimum approvals from trusted reviewers
 * 6. CI checks passing (when requireChecks is true)
 *
 * All conditions must pass before the `hivemoot:automerge` label is applied.
 * Phase 1 (dryRun: true) = label only, no merge action.
 *
 * Short-circuit order optimized by API cost:
 * config → draft/mergeable gates (zero cost from webhook payload) → files → approvals (1 call) → CI (2 calls)
 */

import { minimatch } from "minimatch";
import { LABELS, isLabelMatch } from "../config.js";
import type { PRRef } from "./types.js";
import type { PROperations } from "./pr-operations.js";
import type { AutomergeConfig } from "./repo-config.js";
import { isCIPassing } from "./merge-readiness.js";
import { logger } from "./logger.js";
import type { GraphQLClient } from "./graphql-queries.js";
import {
  enablePullRequestAutoMerge,
  disablePullRequestAutoMerge,
} from "./graphql-queries.js";
import { isAutoMergeNotEnabledError } from "./transient-error.js";

// ───────────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────────

export interface ClassifyResult {
  eligible: boolean;
  reason: string;
}

export type AutomergeResult =
  | { action: "skipped"; reason: string }
  | { action: "labeled" }
  | { action: "unlabeled"; reason: string }
  | { action: "noop"; labeled: boolean };

export interface AutomergeParams {
  prs: PROperations;
  ref: PRRef;
  config: AutomergeConfig | null;
  trustedReviewers: string[];
  /** HEAD SHA for CI check. Fetched from PR if not provided. */
  headSha?: string;
  /** PR node ID for Phase 2 GraphQL mutations. Fetched from PR if not provided. */
  nodeId?: string;
  /** Pre-fetched labels from webhook payload to avoid extra API call. */
  currentLabels?: string[];
  /** Draft state from webhook payload. True → skip classification. */
  draft?: boolean;
  /** Mergeable state from webhook payload. False → skip; null = unknown (GitHub still computing). */
  mergeable?: boolean | null;
  log?: { info: (msg: string) => void; warn?: (msg: string) => void };
  /**
   * GraphQL client for Phase 2 (dryRun: false).
   * Required when config.dryRun is false — used to call
   * enablePullRequestAutoMerge / disablePullRequestAutoMerge mutations.
   */
  graphql?: GraphQLClient;
}

/** Shape of a file entry from PROperations.listFiles */
interface PRFile {
  filename: string;
  additions: number;
  deletions: number;
  changes: number;
  status: string;
  /** Source path for renamed files. Must also pass path checks. */
  previous_filename?: string;
}

// ───────────────────────────────────────────────────────────────────────────────
// Pure Classification Functions (no side effects)
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a single file is allowed by the automerge path rules.
 * Deny patterns are checked first — a denied file is never allowed.
 * Then the file must match at least one allowedPaths pattern.
 */
export function isFileAllowed(
  filename: string,
  allowedPaths: string[],
  denyPaths: string[]
): boolean {
  // Deny-first: if any deny pattern matches, file is rejected
  for (const pattern of denyPaths) {
    if (minimatch(filename, pattern, { dot: true })) {
      return false;
    }
  }

  // Must match at least one allow pattern
  for (const pattern of allowedPaths) {
    if (minimatch(filename, pattern, { dot: true })) {
      return true;
    }
  }

  return false;
}

/**
 * Classify whether a set of PR files qualifies for automerge.
 * Checks file count, total changed lines, and path rules.
 *
 * Returns { eligible: true } when all file-level conditions pass,
 * or { eligible: false, reason } explaining the first failure.
 */
export function classifyFiles(
  files: PRFile[],
  config: AutomergeConfig
): ClassifyResult {
  // Empty PRs don't qualify — nothing to merge
  if (files.length === 0) {
    return { eligible: false, reason: "no files changed" };
  }

  // File count check
  if (files.length > config.maxFiles) {
    return {
      eligible: false,
      reason: `too many files: ${files.length} > ${config.maxFiles}`,
    };
  }

  // Total changed lines check
  let totalChangedLines = 0;
  for (const file of files) {
    totalChangedLines += file.additions + file.deletions;
  }
  if (totalChangedLines > config.maxChangedLines) {
    return {
      eligible: false,
      reason: `too many changed lines: ${totalChangedLines} > ${config.maxChangedLines}`,
    };
  }

  // Path rules check — every file must be allowed.
  // For renames, both source and destination paths must pass.
  for (const file of files) {
    if (!isFileAllowed(file.filename, config.allowedPaths, config.denyPaths)) {
      return {
        eligible: false,
        reason: `file not allowed: ${file.filename}`,
      };
    }

    if (file.previous_filename && !isFileAllowed(file.previous_filename, config.allowedPaths, config.denyPaths)) {
      return {
        eligible: false,
        reason: `file not allowed: ${file.previous_filename} (renamed to ${file.filename})`,
      };
    }
  }

  return { eligible: true, reason: "all file checks passed" };
}

// ───────────────────────────────────────────────────────────────────────────────
// Label Evaluator (side effects, follows merge-readiness pattern)
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate whether a PR qualifies for automerge and add/remove the label.
 *
 * Orchestrates all checks in short-circuit order:
 * 1. Config null → skip
 * 2. PR state gates: draft → remove; merge conflicts → remove
 * 3. Fetch files → classify (file count, changed lines, path rules)
 * 4. Count trusted approvals → check ≥ minApprovals
 * 5. If requireChecks → check CI via isCIPassing()
 * 6. All pass → add label; any fail → remove label if present
 *
 * Idempotent: safe to call multiple times for the same PR.
 */
export async function evaluateAutomerge(
  params: AutomergeParams
): Promise<AutomergeResult> {
  const { prs, ref, config, trustedReviewers, log } = params;

  // 1. Feature disabled → skip
  if (!config) {
    return { action: "skipped", reason: "feature disabled" };
  }

  // Resolve current labels (use pre-fetched or fetch)
  const labels = params.currentLabels ?? await prs.getLabels(ref);
  const hasAutomerge = labels.some(l => isLabelMatch(l, LABELS.AUTOMERGE));

  // Track nodeId and headSha across steps to avoid redundant prs.get() calls.
  // Seeded from pre-fetched webhook payload values when available.
  let capturedNodeId: string | undefined = params.nodeId;
  let capturedHeadSha: string | undefined = params.headSha;

  // Helper: remove label and, when Phase 2 is active, disable native auto-merge.
  // Phase 2 disable runs BEFORE label removal: if the GraphQL call fails unexpectedly,
  // the label is preserved so future reconciliations can retry the disable.
  const removeIfLabeled = async (reason: string): Promise<AutomergeResult> => {
    if (hasAutomerge) {
      // Phase 2: disable GitHub native auto-merge BEFORE removing the label
      if (!config.dryRun && params.graphql) {
        if (!capturedNodeId) {
          try {
            capturedNodeId = (await prs.get(ref)).nodeId;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const warnMsg = `[PR #${ref.prNumber}] Failed to fetch PR node ID for auto-merge disable: ${msg}`;
            if (log?.warn) { log.warn(warnMsg); } else { logger.warn(warnMsg); }
            // Cannot disable native auto-merge without nodeId — keep the label so
            // future reconciliations can retry once the REST API is available again.
            return { action: "noop", labeled: true };
          }
        }
        if (capturedNodeId) {
          try {
            await disablePullRequestAutoMerge(params.graphql, capturedNodeId);
            log?.info(`[PR #${ref.prNumber}] Disabled GitHub native auto-merge`);
          } catch (err) {
            if (isAutoMergeNotEnabledError(err)) {
              // auto-merge was never activated (e.g., enable failed earlier or dryRun mode).
              // Treat as a no-op and proceed with label removal.
            } else {
              // Unexpected failure — keep the label so future reconciliations can retry.
              const msg = err instanceof Error ? err.message : String(err);
              const warnMsg = `[PR #${ref.prNumber}] Failed to disable GitHub auto-merge, retaining label for retry: ${msg}`;
              if (log?.warn) { log.warn(warnMsg); } else { logger.warn(warnMsg); }
              return { action: "noop", labeled: true };
            }
          }
        }
      }

      await prs.removeLabel(ref, LABELS.AUTOMERGE);
      log?.info(`[PR #${ref.prNumber}] Removed automerge: ${reason}`);
      return { action: "unlabeled", reason };
    }
    return { action: "noop", labeled: false };
  };

  // 2. PR state gates — cheaper than file/approval/CI API calls
  if (params.draft === true) {
    return removeIfLabeled("PR is a draft");
  }
  if (params.mergeable === false) {
    return removeIfLabeled("PR has merge conflicts");
  }

  // 3. Fetch files and classify
  const files = await prs.listFiles(ref, { earlyExitThreshold: config.maxFiles });
  const classification = classifyFiles(files, config);

  if (!classification.eligible) {
    return removeIfLabeled(classification.reason);
  }

  // 4. Check trusted approvals
  const approvers = await prs.getApproverLogins(ref);
  const trustedApprovalCount = trustedReviewers.filter(r => approvers.has(r)).length;

  if (trustedApprovalCount < config.minApprovals) {
    return removeIfLabeled(
      `insufficient approvals: ${trustedApprovalCount}/${config.minApprovals}`
    );
  }

  // 5. Check CI if required
  if (config.requireChecks) {
    let headSha = params.headSha;
    if (!headSha) {
      const pr = await prs.get(ref);
      headSha = pr.headSha;
      // Capture nodeId and headSha while we have the PR — avoids a second prs.get() in Phase 2
      capturedNodeId ??= pr.nodeId;
      capturedHeadSha ??= pr.headSha;
    } else {
      capturedHeadSha ??= headSha;
    }

    const ciPassing = await isCIPassing(prs, ref, headSha);
    if (!ciPassing) {
      return removeIfLabeled("CI not passing");
    }
  }

  // 6. All conditions met → add label if not present
  if (!hasAutomerge) {
    await prs.addLabels(ref, [LABELS.AUTOMERGE]);
    log?.info(`[PR #${ref.prNumber}] Added automerge label`);
  }

  // Phase 2: reconcile GitHub native auto-merge state for any eligible PR.
  // Runs on both label-add and label-already-present paths so that:
  // - PRs labeled during dryRun mode enter the native queue when dryRun flips to false
  // - config changes (mergeMethod, commitHeadline, commitBody) are applied to existing PRs
  // Skip when mergeable is null: GitHub is still computing the merge state.
  // The next check_suite or push event will re-evaluate once the state is known.
  if (!config.dryRun && params.graphql && params.mergeable != null) {
    // Fetch nodeId and headSha if either is missing.
    // headSha must be captured even when nodeId is pre-seeded: without it,
    // expectedHeadOid is undefined and the TOCTOU guard is silently dropped.
    if (!capturedNodeId || !capturedHeadSha) {
      try {
        const pr = await prs.get(ref);
        capturedNodeId ??= pr.nodeId;
        capturedHeadSha ??= pr.headSha;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const warnMsg = `[PR #${ref.prNumber}] Failed to fetch PR node ID for auto-merge: ${msg}`;
        if (log?.warn) { log.warn(warnMsg); } else { logger.warn(warnMsg); }
      }
    }

    if (capturedNodeId && capturedHeadSha) {
      try {
        await enablePullRequestAutoMerge(params.graphql, capturedNodeId, config.mergeMethod, {
          commitHeadline: config.commitHeadline,
          commitBody: config.commitBody,
          // expectedHeadOid prevents arming auto-merge on a head that wasn't classified.
          // GitHub rejects the mutation if a push occurred between classification and here.
          // The next check_suite/synchronize event will re-evaluate the new head.
          expectedHeadOid: capturedHeadSha,
        });
        log?.info(`[PR #${ref.prNumber}] Enabled GitHub native auto-merge (${config.mergeMethod})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const hint = msg.includes("PullRequestAutoMergeNotAllowed")
          ? " Verify the repository has branch protection rules configured."
          : "";
        const warnMsg = `[PR #${ref.prNumber}] Failed to enable GitHub auto-merge: ${msg}.${hint}`;
        if (log?.warn) { log.warn(warnMsg); } else { logger.warn(warnMsg); }
      }
    }
  }

  return hasAutomerge ? { action: "noop", labeled: true } : { action: "labeled" };
}
