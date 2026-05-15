/**
 * Pure D1-invariant evaluator + subject_ref parser for the local-queen
 * `resolve-action` endpoint (RFC PR 3c slice 2c).
 *
 * Per RFC D1, the resolve-action endpoint computes a `permittedAction`
 * given the queen's submitted verdict + the PR's current GitHub state.
 * The invariants (all must hold for `squash-merge`):
 *
 *   1. Clamped verdict (post-`applyDowngradeOnlyFloor`) == APPROVE
 *   2. `hivemoot:automerge` label present
 *   3. `hivemoot:hold` label absent
 *   4. CI green (Check Runs + legacy Status both passing)
 *   5. Head SHA stable (reviewed_head_sha matches current GitHub head)
 *   6. No prior post-close drift recorded on the room
 *      (`last_post_close_drift_at` unset — set by a different flow
 *      after a confirmed merge sees post-close events arrive,
 *      indicating the room shouldn't be re-merged)
 *
 * Failing ANY invariant returns `permittedAction: "comment"` with a
 * typed `downgradeReason`. The endpoint emits a G2
 * `queen.action_downgrade` audit event using this reason (whenever
 * the queen's recommendation differs from the permitted action).
 *
 * This module is pure: no Redis, no GitHub, no audit. It takes the
 * inputs the endpoint has already loaded and returns the decision.
 * The endpoint (slice 2c) is responsible for:
 *   - Loading the room core (for `last_post_close_drift_at`)
 *   - Loading contributions + computing the clamped verdict via
 *     `applyDowngradeOnlyFloor`
 *   - Calling `getPullRequestState` (slice 2a)
 *   - Emitting audit events
 *   - Returning the response envelope
 *
 * Splitting the policy out makes the invariant logic testable in
 * isolation and visibly co-located with the RFC spec.
 */

import type { WorkerVerdict } from "@hivemoot/war-room";
import type { PullRequestState } from "./github-pr-state";

/**
 * Why `permittedAction` was forced to `"comment"` instead of the
 * queen's recommended `"squash-merge"`. One reason per failed
 * invariant, evaluated in the order below — the FIRST failure wins
 * (so e.g. `verdict_not_approve` shadows downstream checks rather
 * than the queen guessing which to fix first).
 *
 * Audit events emit this reason verbatim as the `downgrade_reason`
 * field of `queen.action_downgrade`.
 */
export type DowngradeReason =
  /** Clamped verdict (post-floor) was not APPROVE. */
  | "verdict_not_approve"
  /** `hivemoot:automerge` label not present on the PR. */
  | "label_missing"
  /** `hivemoot:hold` label present on the PR. */
  | "hold_label_present"
  /** GitHub returned `total_count > 100` check-runs — unseen checks
   * could be failing, so fail closed. */
  | "ci_truncated"
  /** Any check-run conclusion is failing OR legacy combined-status
   * is `failure`. */
  | "ci_failure"
  /** Check-runs queued/in-progress OR legacy combined-status is
   * `pending` (no failures yet, but not green either). */
  | "ci_pending"
  /** Current GitHub head SHA differs from the queen's submitted
   * `reviewed_head_sha` (PR was pushed during synthesis). */
  | "head_sha_drift"
  /** Room has `last_post_close_drift_at` set — a prior merge attempt
   * saw post-close events, marking it ineligible for re-merge. */
  | "post_close_drift";

export interface PolicyDecision {
  permittedAction: "comment" | "squash-merge";
  /**
   * Set when `permittedAction === "comment"` and at least one D1
   * invariant failed. `null` when `permittedAction === "squash-merge"`
   * (all invariants passed). The pair is mutually constrained — a
   * "comment" with no downgrade reason would be a logic bug.
   */
  downgradeReason: DowngradeReason | null;
}

/**
 * Evaluate the D1 invariants. Pure function: no I/O, no side effects.
 *
 * Evaluation order is significant — the first failed invariant wins
 * (see `DowngradeReason` doc). Order:
 *   1. verdict_not_approve
 *   2. ci_truncated (defense before label — truncated means we can't
 *      verify any CI signal, so we want to surface this distinctly
 *      from a label-only failure)
 *   3. label_missing
 *   4. hold_label_present
 *   5. ci_failure
 *   6. ci_pending
 *   7. head_sha_drift
 *   8. post_close_drift
 *
 * All-pass returns `{ permittedAction: "squash-merge", downgradeReason: null }`.
 */
export function evaluateResolveActionPolicy(args: {
  clampedVerdict: WorkerVerdict;
  prState: PullRequestState;
  /** From the queen's request body. Compared to `prState.headSha`. */
  reviewedHeadSha: string;
  /** From the room core. ISO 8601 or null. */
  lastPostCloseDriftAt: string | null;
}): PolicyDecision {
  if (args.clampedVerdict !== "APPROVE") {
    return {
      permittedAction: "comment",
      downgradeReason: "verdict_not_approve",
    };
  }
  if (args.prState.ciState === "truncated") {
    return { permittedAction: "comment", downgradeReason: "ci_truncated" };
  }
  if (!args.prState.labels.includes("hivemoot:automerge")) {
    return { permittedAction: "comment", downgradeReason: "label_missing" };
  }
  if (args.prState.labels.includes("hivemoot:hold")) {
    return {
      permittedAction: "comment",
      downgradeReason: "hold_label_present",
    };
  }
  if (args.prState.ciState === "failure") {
    return { permittedAction: "comment", downgradeReason: "ci_failure" };
  }
  if (args.prState.ciState === "pending") {
    return { permittedAction: "comment", downgradeReason: "ci_pending" };
  }
  if (args.prState.headSha !== args.reviewedHeadSha) {
    return { permittedAction: "comment", downgradeReason: "head_sha_drift" };
  }
  if (args.lastPostCloseDriftAt !== null) {
    return { permittedAction: "comment", downgradeReason: "post_close_drift" };
  }
  return { permittedAction: "squash-merge", downgradeReason: null };
}

// ---------------------------------------------------------------------------
// subject_ref parsing
// ---------------------------------------------------------------------------

/**
 * Room `subject_ref` shape for `subject_type: "pr_review"` is
 * `<owner>/<repo>#<number>` per the war-room storage convention.
 * The resolve-action endpoint needs to split this into the three
 * parts to pass to `getPullRequestState`.
 *
 * Strict parser — returns `{ ok: false }` on:
 *   - missing `#` separator
 *   - non-numeric PR number
 *   - empty owner or repo
 *   - extra path segments (we expect exactly one `/`)
 *
 * Owner + repo names are NOT case-normalized — GitHub is
 * case-insensitive on owner/repo but the canonical casing on the
 * API call should match what the webhook delivered (preserved on
 * the room core).
 */
export interface ParsedPullRequestSubjectRef {
  owner: string;
  repo: string;
  prNumber: number;
}

const PR_SUBJECT_REF_REGEX = /^([^/]+)\/([^/#]+)#(\d+)$/;

export function parsePullRequestSubjectRef(
  subjectRef: string,
):
  | { ok: true; ref: ParsedPullRequestSubjectRef }
  | { ok: false; reason: string } {
  const match = subjectRef.match(PR_SUBJECT_REF_REGEX);
  if (!match) {
    return {
      ok: false,
      reason: `subject_ref ${JSON.stringify(subjectRef)} does not match the canonical pr_review shape \`<owner>/<repo>#<number>\``,
    };
  }
  const [, owner, repo, prNumberStr] = match;
  if (owner.length === 0 || repo.length === 0) {
    return { ok: false, reason: "owner and repo must both be non-empty" };
  }
  const prNumber = Number.parseInt(prNumberStr, 10);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    return {
      ok: false,
      reason: `PR number ${JSON.stringify(prNumberStr)} is not a positive integer`,
    };
  }
  return { ok: true, ref: { owner, repo, prNumber } };
}
