/**
 * Scheduled Discussion/Voting Phase Closer
 *
 * This script runs on a schedule (via GitHub Actions) to automatically
 * transition issues through governance phases:
 *
 * 1. Discussion phase → Voting phase (when a discussion `type: auto` exit is eligible)
 * 2. Voting / Extended voting phase → Outcome (when a voting `type: auto` exit is eligible)
 *
 * It authenticates as a GitHub App and processes all installations.
 */

import { Octokit } from "octokit";
import * as core from "@actions/core";
import { LABELS, PR_MESSAGES, getLabelQueryAliases } from "../api/config.js";
import {
  createIssueOperations,
  createPROperations,
  createGovernanceService,
  getOpenPRsForIssue,
  isAutoDiscussionExit,
  isAutoVotingExit,
  loadRepositoryConfig,
  logger,
} from "../api/lib/index.js";
import { NOTIFICATION_TYPES } from "../api/lib/bot-comments.js";
import { processImplementationIntake } from "../api/lib/implementation-intake.js";
import { getLinkedIssues } from "../api/lib/graphql-queries.js";
import { runForAllRepositories, runIfMain } from "./shared/run-installations.js";
import { isExitEligible, isDiscussionExitEligible } from "../api/lib/governance.js";
import type {
  Repository,
  Issue,
  IssueRef,
  EffectiveConfig,
  VotingOutcome,
  DiscussionAutoExit,
  VotingAutoExit,
  IntakeMethod,
  ExitType,
} from "../api/lib/index.js";
import type { IssueOperations } from "../api/lib/github-client.js";
import type { GovernanceService } from "../api/lib/governance.js";
import type { InstallationContext } from "./shared/run-installations.js";
import { TRANSIENT_NETWORK_CODES } from "../api/lib/transient-error.js";

/**
 * Represents an issue that was skipped due to missing voting comment.
 * The system may have self-healed by posting the voting comment, or
 * flagged it for human intervention.
 */
interface SkippedIssue {
  repo: string;
  issueNumber: number;
}

export type AccessIssueReason = "rate_limit" | "forbidden";

interface AccessIssue {
  repo: string;
  issueNumber: number;
  status?: number;
  reason: AccessIssueReason;
}

function createIssueRef(
  owner: string,
  repoName: string,
  issueNumber: number,
  installationId?: number
): IssueRef {
  return installationId !== undefined
    ? { owner, repo: repoName, issueNumber, installationId }
    : { owner, repo: repoName, issueNumber };
}

/**
 * Whether a phase has automatic exits enabled.
 */
export function hasAutoExits(exits: Array<{ type: ExitType }>): boolean {
  return exits.some((exit) => exit.type === "auto");
}

/**
 * Whether any governance phase has automatic exits enabled.
 */
export function hasAutomaticGovernancePhases(config: EffectiveConfig): boolean {
  const { discussion, voting, extendedVoting } = config.governance.proposals;
  return hasAutoExits(discussion.exits) || hasAutoExits(voting.exits) || hasAutoExits(extendedVoting.exits);
}

// ───────────────────────────────────────────────────────────────────────────────
// Retry Utility
// ───────────────────────────────────────────────────────────────────────────────

interface RetryableError {
  status?: number;
  code?: string;
  message?: string;
  response?: {
    headers?: Record<string, string | number | undefined>;
  };
}

/**
 * Check if an error is retryable (transient network/API issues).
 *
 * Covers: known transient network codes (via shared TRANSIENT_NETWORK_CODES),
 * HTTP 502/503/504, and rate-limited responses.
 *
 * Note: bare HTTP 429 (no rate-limit headers or message) is intentionally
 * excluded — those are caught and handled by the outer processIssuePhase
 * error handler rather than being retried transparently.
 */
export function isRetryableError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as { code?: unknown };
    if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) {
      return true;
    }
  }
  const err = error as RetryableError;
  return err.status === 502 || err.status === 503 || err.status === 504 || isRateLimitError(error);
}

function getHeaderValue(
  headers: Record<string, string | number | undefined> | undefined,
  name: string
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && value !== undefined) {
      return String(value);
    }
  }
  return undefined;
}

function isRateLimitError(error: unknown): boolean {
  const err = error as RetryableError;
  if (err.status !== 403 && err.status !== 429) {
    return false;
  }
  const remaining = getHeaderValue(err.response?.headers, "x-ratelimit-remaining");
  const retryAfter = getHeaderValue(err.response?.headers, "retry-after");
  if (remaining === "0" || retryAfter) {
    return true;
  }
  const message = err.message?.toLowerCase() ?? "";
  return message.includes("rate limit");
}

/**
 * Execute a function with exponential backoff retry for transient errors
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (!isRetryableError(error) || attempt === maxAttempts) {
        throw error;
      }

      // Exponential backoff with jitter
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500;
      logger.warn(
        `Attempt ${attempt} failed, retrying in ${Math.round(delay)}ms: ${lastError.message}`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}

// ───────────────────────────────────────────────────────────────────────────────
// Early Decision Check Factory
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies required by the early decision check.
 */
export interface EarlyDecisionDeps {
  /** Early exits to evaluate (all except deadline) */
  earlyExits: VotingAutoExit[];
  /** Find the voting comment ID for an issue */
  findVotingCommentId: (ref: IssueRef) => Promise<number | null>;
  /** Get validated vote counts from a voting comment */
  getValidatedVoteCounts: (
    ref: IssueRef,
    commentId: number
  ) => Promise<import("../api/lib/types.js").ValidatedVoteResult>;
  /** Base options for ending voting */
  votingEndOptions: import("../api/lib/governance.js").EndVotingOptions;
  /** Callback to track outcome */
  trackOutcome: (outcome: VotingOutcome, issueNumber: number) => void;
  /** Callback to notify PRs on ready-to-implement */
  notifyPRs: (issueNumber: number) => Promise<void>;
}

/**
 * Factory for early decision checks using exit evaluation.
 * Returns a function that checks if voting can close early, or undefined
 * if there are no early exits configured.
 *
 * Exits are evaluated first-match-wins among those whose time gate
 * has elapsed. Each exit is self-contained with its own minVoters,
 * requiredVoters, and requires condition.
 *
 * @param resolveFn - The resolution function to call (endVoting or resolveInconclusive)
 * @param deps - Dependencies for the check
 * @returns Early check function, or undefined if no early exits
 */
export function makeEarlyDecisionCheck(
  resolveFn: (ref: IssueRef, options?: import("../api/lib/governance.js").EndVotingOptions) => Promise<VotingOutcome>,
  deps: EarlyDecisionDeps
): ((ref: IssueRef, elapsed: number) => Promise<boolean>) | undefined {
  const { earlyExits, findVotingCommentId, getValidatedVoteCounts, votingEndOptions, trackOutcome, notifyPRs } = deps;

  if (earlyExits.length === 0) {
    return undefined;
  }

  return async (ref: IssueRef, elapsed: number): Promise<boolean> => {
    let matchedExit: (typeof earlyExits)[number] | null = null;
    let validated: import("../api/lib/types.js").ValidatedVoteResult | null = null;

    try {
      // Find exits whose time gate has elapsed
      const eligible = earlyExits.filter(e => elapsed >= e.afterMs);
      if (eligible.length === 0) return false;

      const commentId = await findVotingCommentId(ref);
      if (!commentId) return false;

      validated = await getValidatedVoteCounts(ref, commentId);

      // Try each eligible exit (first match wins)
      for (const exit of eligible) {
        if (!isExitEligible(exit, validated)) continue;

        // All conditions met — close early
        logger.info(
          `Early decision for #${ref.issueNumber}: exit(after=${exit.afterMs}ms, ` +
          `requires=${exit.requires}), ${validated.voters.length} valid voters`
        );
        matchedExit = exit;
        break;
      }
    } catch (error) {
      // Early decision is an optimization — if the eligibility check fails,
      // the normal timer-based path handles this issue when the voting period
      // expires. Returning false defers to that safer path.
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.constructor.name : typeof error;
      logger.warn(
        `Early decision check failed for #${ref.issueNumber} [${errorName}]: ${errorMessage}. Deferring to normal timer.`
      );
      return false;
    }

    if (!matchedExit || !validated) return false;

    // Resolution errors must propagate — the caller has retry logic.
    // Swallowing here would mask partial transitions.
    const outcome = await resolveFn(ref, {
      ...votingEndOptions,
      earlyDecision: true,
      votingConfig: {
        minVoters: matchedExit.minVoters,
        requiredVoters: matchedExit.requiredVoters,
      },
      validatedVotes: validated,
    });
    trackOutcome(outcome, ref.issueNumber);
    if (outcome === "ready-to-implement") {
      await notifyPRs(ref.issueNumber);
    }
    return true;
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Discussion Early Check Factory
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies required by the discussion early check.
 */
export interface DiscussionEarlyCheckDeps {
  /** Early exits to evaluate (all except deadline) */
  earlyExits: DiscussionAutoExit[];
  /** Get 👍 reactors on the issue itself */
  getDiscussionReadiness: (ref: IssueRef) => Promise<Set<string>>;
}

/**
 * Factory for discussion early checks using exit evaluation.
 * Returns a function that checks if discussion can end early, or undefined
 * if there are no early exits configured.
 *
 * Mirrors makeEarlyDecisionCheck but for discussion readiness signals
 * instead of voting results.
 *
 * @param transitionFn - The function to call when early exit triggers (transitionToVoting)
 * @param deps - Dependencies for the check
 * @returns Early check function, or undefined if no early exits
 */
export function makeDiscussionEarlyCheck(
  transitionFn: (ref: IssueRef) => Promise<unknown>,
  deps: DiscussionEarlyCheckDeps,
): ((ref: IssueRef, elapsed: number) => Promise<boolean>) | undefined {
  const { earlyExits, getDiscussionReadiness } = deps;

  if (earlyExits.length === 0) {
    return undefined;
  }

  return async (ref: IssueRef, elapsed: number): Promise<boolean> => {
    let shouldTransition = false;
    try {
      // Find exits whose time gate has elapsed
      const eligible = earlyExits.filter(e => elapsed >= e.afterMs);
      if (eligible.length === 0) return false;

      const readyUsers = await getDiscussionReadiness(ref);

      // Try each eligible exit (first match wins)
      for (const exit of eligible) {
        if (!isDiscussionExitEligible(exit, readyUsers)) continue;

        logger.info(
          `Early discussion exit for #${ref.issueNumber}: exit(after=${exit.afterMs}ms), ` +
          `${readyUsers.size} ready users`
        );
        shouldTransition = true;
        break;
      }
    } catch (error) {
      // Only readiness-check errors reach here (API flakes, etc).
      // Transition errors propagate to the caller's withRetry handler.
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.constructor.name : typeof error;
      logger.warn(
        `Discussion early check failed for #${ref.issueNumber} [${errorName}]: ${errorMessage}. Deferring to normal timer.`
      );
      return false;
    }

    if (!shouldTransition) return false;

    // Transition errors must propagate — the caller has retry logic.
    // Swallowing here would mask partial transitions.
    await transitionFn(ref);
    return true;
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Issue Processing
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Check if an error indicates the issue was deleted
 */
function isNotFound(error: unknown): boolean {
  const status = (error as RetryableError).status;
  return status === 404 || status === 410;
}

/**
 * Process phase transitions for a single issue.
 *
 * If an `earlyCheck` is provided in the phase config, it runs first — allowing
 * early decision to close voting before the full timer expires.
 */
export async function processIssuePhase(
  issues: IssueOperations,
  governance: GovernanceService,
  ref: IssueRef,
  labelName: string,
  durationMs: number,
  phaseName: string,
  transitionFn: () => Promise<unknown>,
  onAccessIssue?: (ref: IssueRef, status: number | undefined, reason: AccessIssueReason) => void,
  earlyCheck?: (ref: IssueRef, elapsed: number) => Promise<boolean>
): Promise<void> {
  try {
    const labeledAt = await withRetry(() =>
      issues.getLabelAddedTime(ref, labelName)
    );

    if (!labeledAt) {
      logger.warn(
        `Issue #${ref.issueNumber}: Could not determine when '${labelName}' label was added`
      );
      return;
    }

    const elapsed = Date.now() - labeledAt.getTime();

    // Early decision: check if voting can close before the timer expires
    if (earlyCheck && elapsed < durationMs) {
      const handled = await withRetry(() => earlyCheck(ref, elapsed));
      if (handled) {
        return;
      }
    }

    if (elapsed >= durationMs) {
      logger.info(`Transitioning #${ref.issueNumber} out of ${phaseName} phase`);
      await withRetry(transitionFn);
    } else {
      // Use floor for conservative remaining time estimate
      const remainingMs = durationMs - elapsed;
      const remainingMinutes = Math.floor(remainingMs / 60000);
      const remainingSeconds = Math.floor((remainingMs % 60000) / 1000);
      logger.debug(
        `Issue #${ref.issueNumber}: ${remainingMinutes}m ${remainingSeconds}s remaining in ${phaseName}`
      );
    }
  } catch (error) {
    // Handle deleted issues gracefully
    if (isNotFound(error)) {
      logger.warn(
        `Issue #${ref.issueNumber} not found (may have been deleted). Skipping.`
      );
      return;
    }
    const status = (error as RetryableError).status;
    if (isRateLimitError(error) || status === 429) {
      logger.warn(`Issue #${ref.issueNumber} rate limited. Skipping for now.`);
      onAccessIssue?.(ref, status, "rate_limit");
      return;
    }
    if (status === 403) {
      logger.warn(
        `Issue #${ref.issueNumber} forbidden or missing permissions. Skipping.`
      );
      onAccessIssue?.(ref, status, "forbidden");
      return;
    }
    throw error;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// PR Notification
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Notify existing PRs that a linked issue is ready to implement.
 *
 * Intentionally notification-only — does NOT auto-tag PRs with the
 * `implementation` label. PR authors must push a new commit after
 * an issue becomes ready to implement to activate their PR. This prevents gaming where an
 * agent pre-creates an empty PR during discussion/voting to auto-claim
 * an implementation slot when voting passes.
 *
 * The activation date guard (isActivationAfterReady) in the webhook
 * handler enforces this: PR activity must occur after the ready label
 * was added. See processImplementationIntake in api/lib/implementation-intake.ts.
 *
 * This behavior is configurable via the `intake` config. With `method: "auto"`,
 * pre-ready PRs are unconditionally activated (bypassing the timing guard).
 */
export async function notifyPendingPRs(
  octokit: InstanceType<typeof Octokit>,
  appId: number,
  owner: string,
  repo: string,
  issueNumber: number,
  intakeConfig?: {
    maxPRsPerIssue: number;
    trustedReviewers: string[];
    intake: IntakeMethod[];
  }
): Promise<void> {
  try {
    const prs = createPROperations(octokit, { appId });
    const issues = createIssueOperations(octokit, { appId });
    const linkedPRs = await getOpenPRsForIssue(octokit, owner, repo, issueNumber);

    if (linkedPRs.length === 0) {
      logger.debug(`No open PRs linked to issue #${issueNumber}`);
      return;
    }

    // Skip PRs already labeled as implementation
    const implementationPRs = await prs.findPRsWithLabel(owner, repo, LABELS.IMPLEMENTATION);
    const implementationPRNumbers = new Set(implementationPRs.map((pr) => pr.number));

    for (const linkedPR of linkedPRs) {
      if (implementationPRNumbers.has(linkedPR.number)) {
        continue;
      }

      const ref = { owner, repo, prNumber: linkedPR.number };
      const alreadyNotified = await prs.hasNotificationComment(
        ref,
        NOTIFICATION_TYPES.VOTING_PASSED,
        issueNumber
      );
      if (alreadyNotified) {
        logger.debug(`PR #${linkedPR.number} already notified for issue #${issueNumber}`);
        continue;
      }

      await prs.comment(
        ref,
        PR_MESSAGES.issueReadyToImplement(issueNumber, linkedPR.author.login)
      );
      logger.info(`Notified PR #${linkedPR.number} (@${linkedPR.author.login}) that issue #${issueNumber} is ready`);

      // Proactive intake: attempt to activate PRs immediately after notification.
      // This covers the case where a trusted reviewer already approved a pre-voting PR.
      if (intakeConfig) {
        try {
          const linkedIssues = await getLinkedIssues(octokit, owner, repo, linkedPR.number);
          await processImplementationIntake({
            octokit,
            issues,
            prs,
            log: logger,
            owner,
            repo,
            prNumber: linkedPR.number,
            linkedIssues,
            trigger: "updated",
            maxPRsPerIssue: intakeConfig.maxPRsPerIssue,
            trustedReviewers: intakeConfig.trustedReviewers,
            intake: intakeConfig.intake,
          });
        } catch (intakeError) {
          // Best-effort: reconciler catches failures on its next sweep
          logger.warn(
            `Failed to attempt intake for PR #${linkedPR.number} (issue #${issueNumber}): ${(intakeError as Error).message}`
          );
        }
      }
    }
  } catch (error) {
    // Best-effort: don't fail governance transition if notification fails
    logger.warn(
      `Failed to notify PRs for issue #${issueNumber}: ${(error as Error).message}`
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Voting Comment Reconciliation
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Reconcile missing voting comments for hivemoot:voting issues.
 *
 * Iterates all open issues with the hivemoot:voting label and calls
 * governance.postVotingComment() on each. Since postVotingComment is
 * idempotent (skips when a voting comment already exists), this is safe
 * to call on every cron run. Errors on individual issues are logged
 * but do not abort the loop.
 *
 * @returns Number of issues where a voting comment was newly posted
 */
export async function reconcileMissingVotingComments(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repoName: string,
  governance: GovernanceService,
  installationId?: number,
): Promise<number> {
  let reconciledCount = 0;
  const seen = new Set<number>();

  for (const alias of getLabelQueryAliases(LABELS.VOTING)) {
    const iterator = octokit.paginate.iterator(
      octokit.rest.issues.listForRepo,
      { owner, repo: repoName, state: "open", labels: alias, per_page: 100 },
    );

    for await (const { data: page } of iterator) {
      for (const issue of page as Issue[]) {
        if ('pull_request' in issue) continue;
        if (seen.has(issue.number)) continue;
        seen.add(issue.number);
        const ref = createIssueRef(owner, repoName, issue.number, installationId);
        try {
          const result = await governance.postVotingComment(ref);
          if (result === "posted") {
            reconciledCount++;
            logger.info(`[${owner}/${repoName}] Reconciled voting comment for #${issue.number}`);
          }
        } catch (error) {
          logger.warn(
            `[${owner}/${repoName}] Failed to reconcile #${issue.number}: ${(error as Error).message}`,
          );
        }
      }
    }
  }
  return reconciledCount;
}

// ───────────────────────────────────────────────────────────────────────────────
// Unlabeled Issue Reconciliation
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Reconcile open issues that have no hivemoot:* phase label.
 *
 * These issues missed the issues.opened webhook (e.g., during a bot outage)
 * and were never bootstrapped into the discussion phase. This function finds
 * them and calls startDiscussion() to apply hivemoot:discussion and post the
 * welcome comment.
 *
 * Idempotent: once startDiscussion succeeds, the issue gains the
 * hivemoot:discussion label and is skipped on the next run. Errors on
 * individual issues are logged but do not abort the loop.
 *
 * @returns Number of issues that were reconciled
 */
export async function reconcileUnlabeledIssues(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repoName: string,
  governance: GovernanceService,
  installationId?: number,
): Promise<number> {
  let reconciledCount = 0;

  const iterator = octokit.paginate.iterator(
    octokit.rest.issues.listForRepo,
    { owner, repo: repoName, state: "open", per_page: 100 },
  );

  for await (const { data: page } of iterator) {
    for (const issue of page as Issue[]) {
      if ('pull_request' in issue) continue;

      // Skip issues that already have any hivemoot:* label
      if (issue.labels.some((l) => l.name.startsWith('hivemoot:'))) continue;

      const ref = createIssueRef(owner, repoName, issue.number, installationId);
      try {
        await governance.startDiscussion(ref);
        reconciledCount++;
        logger.info(`[${owner}/${repoName}] Reconciled unlabeled issue #${issue.number}`);
      } catch (error) {
        logger.warn(
          `[${owner}/${repoName}] Failed to reconcile unlabeled issue #${issue.number}: ${(error as Error).message}`,
        );
      }
    }
  }
  return reconciledCount;
}

// ───────────────────────────────────────────────────────────────────────────────
// Repository Processing
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for a single governance phase to process.
 * Each phase has a label filter, duration, display name, and transition logic.
 */
interface PhaseConfig {
  label: string;
  durationMs: number;
  phaseName: string;
  transition: (governance: GovernanceService, ref: IssueRef) => Promise<unknown>;
  /** Optional early decision check. Returns true if issue was transitioned early. */
  earlyCheck?: (ref: IssueRef, elapsed: number) => Promise<boolean>;
}

/**
 * Paginate through issues with a given label and process each through
 * the phase transition pipeline. Queries both canonical and legacy label
 * names to catch entities carrying either old or new labels.
 * Skips pull requests (the issues API returns both issues and PRs).
 */
async function processPhaseIssues(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repoName: string,
  installationId: number | undefined,
  issues: IssueOperations,
  governance: GovernanceService,
  phase: PhaseConfig,
  onAccessIssue: (ref: IssueRef, status: number | undefined, reason: AccessIssueReason) => void
): Promise<void> {
  const seen = new Set<number>();

  for (const alias of getLabelQueryAliases(phase.label)) {
    const iterator = octokit.paginate.iterator(
      octokit.rest.issues.listForRepo,
      {
        owner,
        repo: repoName,
        state: "open",
        labels: alias,
        per_page: 100,
      }
    );

    for await (const { data: page } of iterator) {
      for (const issue of page as Issue[]) {
        if ('pull_request' in issue) {
          continue;
        }
        if (seen.has(issue.number)) continue;
        seen.add(issue.number);
        const ref = createIssueRef(owner, repoName, issue.number, installationId);
        await processIssuePhase(
          issues,
          governance,
          ref,
          phase.label,
          phase.durationMs,
          phase.phaseName,
          () => phase.transition(governance, ref),
          onAccessIssue,
          phase.earlyCheck
        );
      }
    }
  }
}

/**
 * Process a single repository - find issues in discussion/voting phase
 * and transition them if the time threshold has passed.
 *
 * Uses pagination to handle repositories with >100 issues per phase.
 * Loads per-repo config from .github/hivemoot.yml if present.
 *
 * @returns Skipped and access issues encountered during processing.
 */
export async function processRepository(
  octokit: InstanceType<typeof Octokit>,
  repo: Repository,
  appId: number,
  installation?: InstallationContext
): Promise<{ skippedIssues: SkippedIssue[]; accessIssues: AccessIssue[] }> {
  const owner = repo.owner.login;
  const repoName = repo.name;
  const installationId = installation?.installationId;
  const skippedIssues: SkippedIssue[] = [];
  const accessIssues: AccessIssue[] = [];

  logger.group(`Processing ${repo.full_name}`);

  try {
    // Load per-repo configuration (returns null when no config file exists)
    const repoConfig = await loadRepositoryConfig(octokit, owner, repoName);
    if (!repoConfig) {
      logger.debug(`[${repo.full_name}] No config file found; skipping automation`);
      return { skippedIssues: [], accessIssues: [] };
    }
    const issues = createIssueOperations(octokit, { appId });
    const governance = createGovernanceService(issues);

    // ── Reconciliation (always runs, even for manual-only repos) ──
    // Best-effort: do not let reconciliation failures block phase transitions.
    try {
      const reconciled = await reconcileMissingVotingComments(
        octokit,
        owner,
        repoName,
        governance,
        installationId
      );
      if (reconciled > 0) {
        logger.info(`[${repo.full_name}] Reconciled ${reconciled} missing voting comment(s)`);
      }
    } catch (error) {
      logger.warn(
        `[${repo.full_name}] Reconciliation failed: ${(error as Error).message}. Continuing with phase transitions.`,
      );
    }

    try {
      const reconciled = await reconcileUnlabeledIssues(
        octokit,
        owner,
        repoName,
        governance,
        installationId
      );
      if (reconciled > 0) {
        logger.info(`[${repo.full_name}] Reconciled ${reconciled} unlabeled issue(s)`);
      }
    } catch (error) {
      logger.warn(
        `[${repo.full_name}] Unlabeled issue reconciliation failed: ${(error as Error).message}. Continuing with phase transitions.`,
      );
    }

    // ── Automatic transitions (only for repos with auto exits) ──
    if (!hasAutomaticGovernancePhases(repoConfig)) {
      logger.info(
        `[${repo.full_name}] all proposal exits are manual; skipping scheduled phase transitions`
      );
      return { skippedIssues, accessIssues };
    }

    const trackOutcome = (outcome: VotingOutcome, issueNumber: number) => {
      if (outcome === "skipped") {
        skippedIssues.push({ repo: repo.full_name, issueNumber });
      }
      logger.info(`Outcome for #${issueNumber}: ${outcome}`);
    };
    const trackAccessIssue = (
      ref: IssueRef,
      status: number | undefined,
      reason: AccessIssueReason
    ) => {
      accessIssues.push({ repo: repo.full_name, issueNumber: ref.issueNumber, status, reason });
    };

    const { discussion, voting, extendedVoting } = repoConfig.governance.proposals;
    const prIntakeConfig = repoConfig.governance.pr
      ? {
          maxPRsPerIssue: repoConfig.governance.pr.maxPRsPerIssue,
          trustedReviewers: repoConfig.governance.pr.trustedReviewers,
          intake: repoConfig.governance.pr.intake,
        }
      : undefined;

    // Voting/inconclusive phases share a transition pattern: end voting, track
    // outcome, and notify pending PRs if the proposal passed.
    // endVoting now fetches validated votes internally (with multi-reaction discard),
    // so no external reactor fetching is needed here.
    const votingTransition = (
      endFn: (ref: IssueRef, options?: import("../api/lib/governance.js").EndVotingOptions) => Promise<VotingOutcome>,
      endOptions: import("../api/lib/governance.js").EndVotingOptions,
    ) => async (_gov: GovernanceService, ref: IssueRef): Promise<void> => {
      const outcome = await endFn(ref, endOptions);
      trackOutcome(outcome, ref.issueNumber);
      if (outcome === "ready-to-implement") {
        await notifyPendingPRs(octokit, appId, owner, repoName, ref.issueNumber, prIntakeConfig);
      }
    };

    const createEndOptions = (
      deadlineExit: VotingAutoExit,
    ): import("../api/lib/governance.js").EndVotingOptions => ({
      votingConfig: {
        minVoters: deadlineExit.minVoters,
        requiredVoters: deadlineExit.requiredVoters,
        requires: deadlineExit.requires,
      },
    });

    const phases: PhaseConfig[] = [];

    const discussionAutoExits = discussion.exits.filter(isAutoDiscussionExit);
    if (discussionAutoExits.length > 0) {
      const deadlineExit = discussionAutoExits[discussionAutoExits.length - 1];
      phases.push({
        label: LABELS.DISCUSSION,
        durationMs: deadlineExit.afterMs,
        phaseName: "discussion",
        transition: (_gov, ref) => governance.transitionToVoting(ref),
        earlyCheck: makeDiscussionEarlyCheck(
          (ref) => governance.transitionToVoting(ref),
          {
            earlyExits: discussionAutoExits.slice(0, -1),
            getDiscussionReadiness: (ref) => issues.getDiscussionReadiness(ref),
          },
        ),
      });
    } else {
      logger.info(`[${repo.full_name}] discussion exits are manual; skipping automatic discussion transitions`);
    }

    const votingAutoExits = voting.exits.filter(isAutoVotingExit);
    if (votingAutoExits.length > 0) {
      const deadlineExit = votingAutoExits[votingAutoExits.length - 1];
      const votingEndOptions = createEndOptions(deadlineExit);
      const votingEarlyDecisionDeps: EarlyDecisionDeps = {
        earlyExits: votingAutoExits.slice(0, -1), // all except deadline
        findVotingCommentId: (ref) => issues.findVotingCommentId(ref),
        getValidatedVoteCounts: (ref, commentId) => issues.getValidatedVoteCounts(ref, commentId),
        votingEndOptions,
        trackOutcome,
        notifyPRs: (issueNumber) => notifyPendingPRs(octokit, appId, owner, repoName, issueNumber, prIntakeConfig),
      };

      phases.push({
        label: LABELS.VOTING,
        durationMs: deadlineExit.afterMs,
        phaseName: "voting",
        transition: votingTransition((ref, opts) => governance.endVoting(ref, opts), votingEndOptions),
        earlyCheck: makeEarlyDecisionCheck((ref, opts) => governance.endVoting(ref, opts), votingEarlyDecisionDeps),
      });
    } else {
      logger.info(`[${repo.full_name}] voting exits are manual; skipping automatic voting transitions`);
    }

    const extendedAutoExits = extendedVoting.exits.filter(isAutoVotingExit);
    if (extendedAutoExits.length > 0) {
      const deadlineExit = extendedAutoExits[extendedAutoExits.length - 1];
      const extendedVotingEndOptions = createEndOptions(deadlineExit);
      const extendedEarlyDecisionDeps: EarlyDecisionDeps = {
        earlyExits: extendedAutoExits.slice(0, -1), // all except deadline
        findVotingCommentId: (ref) => issues.findVotingCommentId(ref),
        getValidatedVoteCounts: (ref, commentId) => issues.getValidatedVoteCounts(ref, commentId),
        votingEndOptions: extendedVotingEndOptions,
        trackOutcome,
        notifyPRs: (issueNumber) => notifyPendingPRs(octokit, appId, owner, repoName, issueNumber, prIntakeConfig),
      };

      phases.push({
        label: LABELS.EXTENDED_VOTING,
        durationMs: deadlineExit.afterMs,
        phaseName: "extended voting",
        transition: votingTransition((ref, opts) => governance.resolveInconclusive(ref, opts), extendedVotingEndOptions),
        earlyCheck: makeEarlyDecisionCheck(
          (ref, opts) => governance.resolveInconclusive(ref, opts),
          extendedEarlyDecisionDeps,
        ),
      });
    } else {
      logger.info(`[${repo.full_name}] extendedVoting exits are manual; skipping automatic extended voting transitions`);
    }

    for (const phase of phases) {
      await processPhaseIssues(
        octokit, owner, repoName, installationId, issues, governance, phase, trackAccessIssue
      );
    }

    return { skippedIssues, accessIssues };
  } finally {
    logger.groupEnd();
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Main entry point - processes all installations and their repositories.
 *
 * Uses the shared runner for installation/repo iteration.
 * The afterAll hook handles aggregate reporting for skipped and access issues.
 */
async function main(): Promise<void> {
  await runForAllRepositories<{ skippedIssues: SkippedIssue[]; accessIssues: AccessIssue[] }>({
    scriptName: "scheduled discussion/voting phase closer",
    startMessage: "Per-repo config loaded from .github/hivemoot.yml (processing phases with auto exits; manual-only phases are skipped)",
    processRepository,
    afterAll: ({ results }) => {
      const allSkippedIssues = results.flatMap((r) => r.result.skippedIssues);
      const allAccessIssues = results.flatMap((r) => r.result.accessIssues);

      if (allSkippedIssues.length > 0) {
        const skippedList = allSkippedIssues
          .map((s) => `${s.repo}#${s.issueNumber}`)
          .join(", ");
        logger.warn(
          `${allSkippedIssues.length} issue(s) skipped due to missing voting comments: ${skippedList}`
        );
        logger.warn("Human intervention requested for these issues (see hivemoot:needs-human label)");
        core.warning(`${allSkippedIssues.length} issue(s) require human intervention`);
      }

      if (allAccessIssues.length > 0) {
        const rateLimited = allAccessIssues.filter((issue) => issue.reason === "rate_limit");
        const forbidden = allAccessIssues.filter((issue) => issue.reason === "forbidden");
        if (rateLimited.length > 0) {
          const list = rateLimited.map((s) => `${s.repo}#${s.issueNumber}`).join(", ");
          logger.warn(`Rate limited on ${rateLimited.length} issue(s): ${list}`);
          core.warning(`Rate limited on ${rateLimited.length} issue(s)`);
        }
        if (forbidden.length > 0) {
          const list = forbidden.map((s) => `${s.repo}#${s.issueNumber}`).join(", ");
          logger.warn(`Forbidden on ${forbidden.length} issue(s): ${list}`);
          core.warning(`Forbidden on ${forbidden.length} issue(s)`);
        }
      }
    },
  });
}

runIfMain(import.meta.url, main);
