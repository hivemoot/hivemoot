/**
 * Governance Operations
 *
 * High-level business logic for issue governance phases:
 * - Discussion → Voting transition
 * - Voting outcome determination
 *
 * This module is agnostic to the GitHub client implementation,
 * making it reusable across webhooks and scheduled scripts.
 */

import { LABELS, MESSAGES, SIGNATURE } from "../config.js";
import {
  buildVotingComment,
  buildDiscussionComment,
  buildHumanHelpComment,
  SIGNATURES,
  ERROR_CODES,
} from "./bot-comments.js";
import type { IssueOperations } from "./github-client.js";
import { createModelFromEnv } from "./llm/provider.js";
import { DiscussionSummarizer, formatVotingMessage } from "./llm/summarizer.js";
import { logger as defaultLogger, type Logger } from "./logger.js";
import type {
  RequiredVotersConfig,
  VotingAutoExit,
  ExitRequires,
  DiscussionAutoExit,
} from "./repo-config.js";
import type {
  IssueRef,
  VoteCounts,
  ValidatedVoteResult,
  VotingOutcome,
  LockReason,
} from "./types.js";
import { getIssuePriority } from "./priority.js";

/**
 * Configuration for GovernanceService
 */
export interface GovernanceServiceConfig {
  logger?: Logger;
}

/**
 * Options for ending a voting phase.
 * Allows the caller to provide voting enforcement rules and early decision context.
 */
export interface EndVotingOptions {
  /** When true, prepend early decision messaging to the outcome comment */
  earlyDecision?: boolean;
  /** Voting config for requiredVoters/minVoters/requires enforcement */
  votingConfig?: {
    minVoters: number;
    requiredVoters: RequiredVotersConfig;
    requires?: ExitRequires;
  };
  /**
   * Pre-fetched validated vote data (avoids redundant API call when caller already has it).
   * Treated as the snapshot for this evaluation and may be slightly stale if reactions change.
   */
  validatedVotes?: ValidatedVoteResult;
}

type VotingRequirementsEnforcement =
  | {
      status: "inconclusive";
      reason: "quorum" | "required";
      minVoters: number;
      validVoters: number;
      missingRequired: string[];
      requiredVotersNeeded: number;
      requiredVotersParticipated: number;
    }
  | null;

/**
 * Configuration for a voting outcome transition.
 * Defines the label, message, and state changes to apply.
 */
interface OutcomeTransitionConfig {
  /** Label to apply after transition */
  label: string;
  /** Message to post on the issue */
  message: string;
  /** Whether to close the issue */
  close: boolean;
  /** Reason for closing (only used when close is true) */
  closeReason?: "completed" | "not_planned";
  /** Whether to lock the issue */
  lock: boolean;
  /** Reason for locking (only used when lock is true) */
  lockReason?: LockReason;
  /** Whether to unlock the issue (mutually exclusive with lock) */
  unlock?: boolean;
}

/**
 * Create GovernanceService with validated dependencies.
 *
 * This factory function ensures consistent construction across webhooks
 * and scheduled scripts, following the pattern of other service factories.
 *
 * @param issues - IssueOperations instance for GitHub API calls
 * @param config - Optional configuration including custom logger
 * @throws Error if issues is null/undefined
 */
export function createGovernanceService(
  issues: IssueOperations,
  config?: GovernanceServiceConfig,
): GovernanceService {
  if (!issues) {
    throw new Error(
      "Invalid IssueOperations: expected a valid IssueOperations instance",
    );
  }
  return new GovernanceService(issues, config?.logger);
}

/**
 * Governance service for managing issue lifecycle phases
 */
export class GovernanceService {
  private logger: Logger;

  constructor(
    private issues: IssueOperations,
    logger?: Logger,
  ) {
    this.logger = logger ?? defaultLogger;
  }

  /**
   * Start the discussion phase for a new issue.
   *
   * Wraps the welcome message with metadata to enable future comment discovery.
   * Defaults to the voting-mode welcome text unless a caller provides an override.
   */
  async startDiscussion(ref: IssueRef, welcomeMessage = MESSAGES.ISSUE_WELCOME_VOTING): Promise<void> {
    // Always apply the label first — addLabels is idempotent, so it is safe to
    // re-apply on replay. Doing it before the comment-duplicate check ensures
    // that a partial failure (comment posted, label call failed) is fully
    // recovered on redelivery.
    await this.issues.addLabels(ref, [LABELS.DISCUSSION]);
    const exists = await this.issues.hasWelcomeComment(ref);
    if (exists) {
      this.logger.info(`Welcome comment already exists for issue #${ref.issueNumber}, skipping`);
      return;
    }
    await this.issues.comment(ref, buildDiscussionComment(welcomeMessage, ref.issueNumber));
  }

  /**
   * Transition from discussion phase to voting phase.
   *
   * Attempts to generate an LLM summary of the discussion for the voting
   * message. Falls back to the generic VOTING_START message if:
   * - LLM is not configured
   * - LLM API fails
   * - Summary generation fails for any reason
   *
   * Appends hidden metadata to track the voting cycle number, enabling
   * correct vote counting when issues return from needs-more-discussion.
   */
  async transitionToVoting(ref: IssueRef): Promise<void> {
    const commentBody = await this.buildVotingCommentBody(ref);

    await this.issues.transition(ref, {
      removeLabel: LABELS.DISCUSSION,
      addLabel: LABELS.VOTING,
      comment: commentBody,
    });

    await this.pinVotingComment(ref);
  }

  /**
   * Post a voting comment on an issue that already has the phase:voting label
   * but is missing the voting comment (e.g., manual label addition).
   *
   * Idempotent — skips if a voting comment already exists. Does NOT change labels.
   */
  async postVotingComment(ref: IssueRef): Promise<"posted" | "skipped"> {
    const existingId = await this.issues.findVotingCommentId(ref);
    if (existingId !== null) {
      this.logger.info(
        `Voting comment already exists for issue #${ref.issueNumber}, skipping`,
      );
      return "skipped";
    }

    const commentBody = await this.buildVotingCommentBody(ref);
    await this.issues.comment(ref, commentBody);
    await this.pinVotingComment(ref);
    return "posted";
  }

  /**
   * Pin the current voting comment on an issue.
   *
   * Fail-safe: pinning is a UX enhancement and must never interrupt the
   * governance flow if it fails (API unavailable, permission denied, etc.).
   */
  private async pinVotingComment(ref: IssueRef): Promise<void> {
    try {
      const commentId = await this.issues.findVotingCommentId(ref);
      if (commentId !== null) {
        await this.issues.pinComment(ref, commentId);
        this.logger.info(`Pinned voting comment ${commentId} on issue #${ref.issueNumber}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to pin voting comment on issue #${ref.issueNumber}: ${message}`);
    }
  }

  /**
   * Build the complete voting comment body with metadata.
   * Includes an LLM-generated discussion summary when available.
   */
  private async buildVotingCommentBody(ref: IssueRef): Promise<string> {
    const cycle = await this.calculateVotingCycle(ref);
    const votingMessage = await this.generateVotingMessage(ref);
    return buildVotingComment(votingMessage, ref.issueNumber, cycle);
  }

  /**
   * Calculate the voting cycle number for a new voting comment.
   *
   * Returns 1 for the first voting cycle, 2 for the second (after
   * needs-more-discussion), etc.
   */
  private async calculateVotingCycle(ref: IssueRef): Promise<number> {
    const existingCount = await this.issues.countVotingComments(ref);
    return existingCount + 1;
  }

  /**
   * Generate the voting message, with LLM summary if available.
   * Falls back to generic message on any failure.
   */
  private async generateVotingMessage(ref: IssueRef): Promise<string> {
    // Fetch labels first to extract priority
    let priority: "high" | "medium" | "low" | undefined;
    try {
      const labels = await this.issues.getIssueLabels(ref);
      priority = getIssuePriority({ labels });
    } catch {
      this.logger.debug(`Failed to fetch labels for issue #${ref.issueNumber}, continuing without priority`);
    }

    // Validate LLM is fully configured (including API key) BEFORE any GitHub calls.
    // createModelFromEnv() returns null if provider/model not set, or throws if API key missing.
    let modelResult: Awaited<ReturnType<typeof createModelFromEnv>>;
    try {
      modelResult = await createModelFromEnv(
        ref.installationId !== undefined
          ? { installationId: ref.installationId }
          : undefined
      );
    } catch (error) {
      // BYOK runtime failures (Redis outage, decryption errors) are operator-actionable —
      // log at warn. Config-missing errors are expected noise — log at debug.
      const message = error instanceof Error ? error.message : String(error);
      const isByokRuntime = message.startsWith("BYOK ");
      this.logger[isByokRuntime ? "warn" : "debug"](
        `LLM model resolution failed for issue #${ref.issueNumber}: ${message}`,
      );
      return MESSAGES.votingStart(priority);
    }

    if (!modelResult) {
      this.logger.debug(
        `LLM not configured, using generic voting message for issue #${ref.issueNumber}`,
      );
      return MESSAGES.votingStart(priority);
    }

    try {
      // Fetch issue context for summarization (only after LLM validation passes)
      const context = await this.issues.getIssueContext(ref);

      // Attempt LLM summarization with pre-validated model
      const summarizer = new DiscussionSummarizer({ logger: this.logger });
      const result = await summarizer.summarize(context, modelResult);

      if (result.success) {
        this.logger.info(`Generated LLM summary for issue #${ref.issueNumber}`);
        return formatVotingMessage(
          result.summary,
          context.title,
          SIGNATURE,
          SIGNATURES.VOTING,
          priority,
        );
      }

      // Summarization failed, use generic message
      this.logger.warn(
        `Using generic voting message for issue #${ref.issueNumber}: ${result.reason}`,
      );
      return MESSAGES.votingStart(priority);
    } catch (error) {
      // Any unexpected error, fail open with generic message
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to generate voting summary for issue #${ref.issueNumber}: ${message}. Using generic message.`,
      );
      return MESSAGES.votingStart(priority);
    }
  }

  /**
   * End voting and apply the outcome.
   * Votes are counted from the bot's voting comment reactions.
   *
   * If the voting comment is not found, attempts to self-heal by posting
   * the voting comment. Falls back to a human help request if self-healing
   * fails. Returns "skipped" in either case.
   *
   * @param options.earlyDecision - When true, prepend early decision note to outcome message
   * @param options.votingConfig - When provided, enforce requiredVoters/minVoters (missing → inconclusive)
   * @param options.validatedVotes - Pre-fetched validated votes (avoids redundant API call)
   */
  async endVoting(ref: IssueRef, options?: EndVotingOptions): Promise<VotingOutcome> {
    const commentId = await this.issues.findVotingCommentId(ref);

    if (!commentId) {
      await this.handleMissingVotingComment(ref, LABELS.VOTING);
      return "skipped";
    }

    // Use pre-fetched data or fetch with multi-reaction discard
    const validated = options?.validatedVotes
      ?? await this.issues.getValidatedVoteCounts(ref, commentId);

    // Enforce requiredVoters/minVoters if config provided
    const enforcement = this.enforceVotingRequirements(ref, validated, options);
    let outcome: Exclude<VotingOutcome, "skipped">;

    if (enforcement) {
      outcome = "inconclusive";
    } else if (options?.votingConfig?.requires === "unanimous" && !isUnanimous(validated.votes)) {
      // Unanimous required but votes are not unanimous → inconclusive
      outcome = "inconclusive";
    } else {
      outcome = this.determineOutcome(validated.votes);
    }

    const earlyPrefix = options?.earlyDecision && !enforcement && outcome !== "inconclusive"
      ? `**Early decision** — ${earlyDecisionReason(options.votingConfig)}.\n\n`
      : "";

    const inconclusiveMessage = enforcement
      ? MESSAGES.votingEndRequirementsNotMet({
          votes: validated.votes,
          minVoters: enforcement.minVoters,
          validVoters: enforcement.validVoters,
          missingRequired: enforcement.missingRequired,
          requiredVotersNeeded: enforcement.requiredVotersNeeded,
          requiredVotersParticipated: enforcement.requiredVotersParticipated,
          final: false,
        })
      : MESSAGES.votingEndInconclusive(validated.votes);

    // Type excludes "skipped" since determineOutcome() never returns it
    const outcomeConfig: Record<
      Exclude<VotingOutcome, "skipped">,
      OutcomeTransitionConfig
    > = {
      "ready-to-implement": {
        label: LABELS.READY_TO_IMPLEMENT,
        message: earlyPrefix + MESSAGES.votingEndReadyToImplement(validated.votes),
        close: false,
        // Keep unlocked so the bot can post/update additional (such as leaderboard) comments on the issue.
        lock: false,
      },
      rejected: {
        label: LABELS.REJECTED,
        message: earlyPrefix + MESSAGES.votingEndRejected(validated.votes),
        close: true,
        lock: true,
      },
      inconclusive: {
        label: LABELS.EXTENDED_VOTING,
        message: earlyPrefix + inconclusiveMessage,
        close: false,
        lock: false,
      },
      "needs-more-discussion": {
        label: LABELS.DISCUSSION,
        message: earlyPrefix + MESSAGES.votingEndNeedsMoreDiscussion(validated.votes),
        close: false,
        lock: false,
        unlock: true,
      },
      "needs-human-input": {
        label: LABELS.NEEDS_HUMAN,
        message: earlyPrefix + MESSAGES.votingEndNeedsHumanInput(validated.votes),
        close: false,
        lock: false,
      },
    };

    const config = outcomeConfig[outcome];

    await this.applyTransition(ref, LABELS.VOTING, config);

    return outcome;
  }

  /**
   * Resolve an inconclusive issue after extended voting period.
   *
   * Re-evaluates votes and applies the same logic as initial voting:
   * - thumbsUp > thumbsDown → ready-to-implement (open, unlocked)
   * - thumbsDown > thumbsUp → rejected (closed, locked)
   * - needs-more-discussion → return to discussion (open, unlocked)
   * - Still tied → final inconclusive (closed, locked)
   *
   * If the voting comment is not found, attempts to self-heal by posting
   * the voting comment. Falls back to a human help request if self-healing
   * fails. Returns "skipped" in either case.
   *
   * @param options.votingConfig - When provided, enforce requiredVoters/minVoters (missing → inconclusive)
   * @param options.validatedVotes - Pre-fetched validated votes (avoids redundant API call)
   */
  async resolveInconclusive(ref: IssueRef, options?: EndVotingOptions): Promise<VotingOutcome> {
    const commentId = await this.issues.findVotingCommentId(ref);

    if (!commentId) {
      await this.handleMissingVotingComment(ref, LABELS.EXTENDED_VOTING);
      return "skipped";
    }

    const validated = options?.validatedVotes
      ?? await this.issues.getValidatedVoteCounts(ref, commentId);

    // Enforce requiredVoters/minVoters/requires — same rules as endVoting
    const enforcement = this.enforceVotingRequirements(ref, validated, options);
    let outcome: Exclude<VotingOutcome, "skipped">;

    if (enforcement) {
      outcome = "inconclusive";
    } else if (options?.votingConfig?.requires === "unanimous" && !isUnanimous(validated.votes)) {
      // Unanimous required but votes are not unanimous → inconclusive
      outcome = "inconclusive";
    } else {
      outcome = this.determineOutcome(validated.votes);
    }

    const inconclusiveMessage = enforcement
      ? MESSAGES.votingEndRequirementsNotMet({
          votes: validated.votes,
          minVoters: enforcement.minVoters,
          validVoters: enforcement.validVoters,
          missingRequired: enforcement.missingRequired,
          requiredVotersNeeded: enforcement.requiredVotersNeeded,
          requiredVotersParticipated: enforcement.requiredVotersParticipated,
          final: true,
        })
      : MESSAGES.votingEndInconclusiveFinal(validated.votes);

    // Configuration for each possible outcome after extended voting
    // Type excludes "skipped" since determineOutcome() never returns it
    const outcomeConfig: Record<
      Exclude<VotingOutcome, "skipped">,
      OutcomeTransitionConfig
    > = {
      "ready-to-implement": {
        label: LABELS.READY_TO_IMPLEMENT,
        message: MESSAGES.votingEndInconclusiveResolved(
          validated.votes,
          "ready-to-implement",
        ),
        close: false,
        // Keep unlocked so the bot can post/update leaderboard comments on the issue.
        lock: false,
      },
      rejected: {
        label: LABELS.REJECTED,
        message: MESSAGES.votingEndInconclusiveResolved(validated.votes, "rejected"),
        close: true,
        lock: true,
      },
      inconclusive: {
        label: LABELS.INCONCLUSIVE,
        message: inconclusiveMessage,
        close: true,
        lock: true,
      },
      "needs-more-discussion": {
        label: LABELS.DISCUSSION,
        message: MESSAGES.votingEndNeedsMoreDiscussion(validated.votes),
        close: false,
        lock: false,
        unlock: true,
      },
      "needs-human-input": {
        label: LABELS.NEEDS_HUMAN,
        message: MESSAGES.votingEndInconclusiveResolved(validated.votes, "needs-human-input"),
        close: false,
        lock: false,
      },
    };

    const config = outcomeConfig[outcome];

    await this.applyTransition(ref, LABELS.EXTENDED_VOTING, config);

    return outcome;
  }

  /**
   * Apply a transition with the given configuration.
   * Centralizes the transition options construction to reduce duplication.
   */
  private async applyTransition(
    ref: IssueRef,
    removeLabel: string,
    config: OutcomeTransitionConfig,
  ): Promise<void> {
    await this.issues.transition(ref, {
      removeLabel,
      addLabel: config.label,
      comment: config.message,
      close: config.close,
      ...(config.close && { closeReason: "not_planned" as const }),
      lock: config.lock,
      ...(config.lock && { lockReason: "resolved" as const }),
      ...(config.unlock && { unlock: true }),
    });
  }

  /**
   * Handle missing voting comment by attempting to self-heal first.
   *
   * Three possible outcomes:
   * - "posted": voting comment was successfully created (self-healed)
   * - "skipped": voting comment appeared between the caller's check and ours
   *   (race with webhook handler or cron reconciliation — healthy state)
   * - exception: self-heal failed, falls back to human help request
   */
  private async handleMissingVotingComment(ref: IssueRef, currentPhaseLabel: string): Promise<void> {
    // Attempt self-heal: post the missing voting comment
    try {
      const result = await this.postVotingComment(ref);
      if (result === "posted") {
        this.logger.info(
          `Self-healed missing voting comment for issue #${ref.issueNumber}`,
        );
      } else {
        // "skipped" = comment appeared between the caller's check and ours
        // (race with webhook handler or cron reconciliation). Healthy state.
        this.logger.info(
          `Voting comment already present for issue #${ref.issueNumber} (concurrent post)`,
        );
      }
      return;
    } catch (error) {
      this.logger.warn(
        `Self-heal failed for issue #${ref.issueNumber}: ${(error as Error).message}. Falling back to human help.`,
      );
    }

    // Original behavior: flag for human intervention
    const errorCode = ERROR_CODES.VOTING_COMMENT_NOT_FOUND;

    // Check if we already posted this error (idempotent)
    const alreadyPosted = await this.issues.hasHumanHelpComment(ref, errorCode);
    if (alreadyPosted) {
      this.logger.info(
        `Human help comment already posted for issue #${ref.issueNumber}, skipping`,
      );
      return;
    }

    // Build and post the warning comment
    const errorComment = buildHumanHelpComment(
      MESSAGES.votingCommentNotFound(),
      ref.issueNumber,
      errorCode,
    );
    await this.issues.comment(ref, errorComment);

    // Add the hivemoot:needs-human label to make the issue visible in issue lists
    // and clear the active voting phase label so the issue does not end up dual-labeled.
    // Note: Label addition is best-effort - if the label doesn't exist in the repo,
    // we log a warning but don't fail the operation (the comment is the critical part)
    try {
      await this.issues.addLabels(ref, [LABELS.NEEDS_HUMAN]);
      await this.issues.removeLabel(ref, currentPhaseLabel);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to swap ${currentPhaseLabel} -> ${LABELS.NEEDS_HUMAN} labels on issue #${ref.issueNumber}: ${errorMsg}`,
      );
    }

    this.logger.warn(
      `Posted human help request for issue #${ref.issueNumber}: ${errorCode}`,
    );
  }

  /**
   * Check if voting requirements (requiredVoters, minVoters) are met.
   * Returns "inconclusive" if any requirement fails, null if all pass.
   *
   * This is a synchronous check using pre-fetched data — no API calls.
   */
  private enforceVotingRequirements(
    ref: IssueRef,
    validated: ValidatedVoteResult,
    options?: EndVotingOptions,
  ): VotingRequirementsEnforcement {
    if (!options?.votingConfig) {
      return null;
    }

    const { minVoters, requiredVoters } = options.votingConfig;
    const { minCount, voters } = requiredVoters;
    const base = {
      minVoters,
      validVoters: validated.voters.length,
      missingRequired: [] as string[],
      requiredVotersNeeded: 0,
      requiredVotersParticipated: 0,
    };

    // Check quorum using valid voters only (users with exactly one voting reaction).
    // Users who cast multiple different reactions are excluded from quorum.
    if (validated.voters.length < minVoters) {
      this.logger.warn(
        `Issue #${ref.issueNumber}: insufficient valid voters (${validated.voters.length}/${minVoters}). Forcing inconclusive.`,
      );
      return {
        status: "inconclusive",
        reason: "quorum",
        ...base,
      };
    }

    // Check required voters using participants (all users who reacted).
    // A required voter who cast conflicting reactions still participated —
    // they just don't count toward the tally or quorum.
    if (voters.length > 0 && minCount > 0) {
      const participantSet = new Set(validated.participants);
      const participated = voters.filter(v => participantSet.has(v));
      if (participated.length < minCount) {
        const missing = voters.filter(v => !participantSet.has(v));
        this.logger.warn(
          `Issue #${ref.issueNumber}: required voters ${participated.length}/${minCount}. Forcing inconclusive.`,
        );
        return {
          status: "inconclusive",
          reason: "required",
          ...base,
          missingRequired: missing,
          requiredVotersNeeded: minCount,
          requiredVotersParticipated: participated.length,
        };
      }
    }

    return null;
  }

  /**
   * Determine voting outcome based on reaction counts.
   *
   * Priority order:
   * 1. needs-human-input: 👀 > (👍 + 👎 + 😕) - hive wants human review
   * 2. needs-more-discussion: 😕 > (👍 + 👎) - majority wants more discussion
   * 3. ready-to-implement: 👍 > 👎
   * 4. rejected: 👎 > 👍
   * 5. inconclusive: 👍 = 👎 (triggers extended voting)
   *
   * Note: "skipped" is never returned here - it's only used when the voting
   * comment is missing (handled before this method is called).
   */
  private determineOutcome(
    votes: VoteCounts,
  ): Exclude<VotingOutcome, "skipped"> {
    // Check for eyes majority first - hive wants human input
    if (votes.eyes > votes.thumbsUp + votes.thumbsDown + votes.confused) {
      return "needs-human-input";
    }
    // Check for majority abstain - community needs more discussion
    if (votes.confused > votes.thumbsUp + votes.thumbsDown) {
      return "needs-more-discussion";
    }
    if (votes.thumbsUp > votes.thumbsDown) {
      return "ready-to-implement";
    }
    if (votes.thumbsDown > votes.thumbsUp) {
      return "rejected";
    }
    return "inconclusive";
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Generate the early decision reason text based on the voting config.
 */
function earlyDecisionReason(config?: EndVotingOptions["votingConfig"]): string {
  if (!config?.requiredVoters || config.requiredVoters.voters.length === 0) {
    return "quorum reached";
  }
  const { minCount, voters } = config.requiredVoters;
  if (minCount <= 0) {
    return "quorum reached";
  }
  if (minCount >= voters.length) {
    return "all required voters have participated";
  }
  if (minCount === 1) {
    return "a required voter has participated";
  }
  return `${minCount} of ${voters.length} required voters have participated`;
}

/**
 * Check if votes are unanimous — exactly one reaction type has votes.
 */
export function isUnanimous(votes: VoteCounts): boolean {
  const counts = [votes.thumbsUp, votes.thumbsDown, votes.confused, votes.eyes];
  return counts.filter(c => c > 0).length === 1;
}

/**
 * Check if votes produce a decisive outcome (not a tie).
 *
 * Returns true when the vote distribution would resolve to any outcome
 * other than "inconclusive" — i.e., eyes majority, confused majority,
 * thumbsUp wins, or thumbsDown wins. Returns false only for a
 * thumbsUp/thumbsDown tie.
 */
export function isDecisive(votes: VoteCounts): boolean {
  if (votes.eyes > votes.thumbsUp + votes.thumbsDown + votes.confused) return true;
  if (votes.confused > votes.thumbsUp + votes.thumbsDown) return true;
  return votes.thumbsUp !== votes.thumbsDown;
}

/**
 * Check whether a voting exit is eligible based on validated votes.
 *
 * Applies quorum (minVoters), required voters participation, and
 * requires condition (majority/unanimous).
 */
export function isExitEligible(
  exit: VotingAutoExit,
  validated: ValidatedVoteResult,
): boolean {
  if (validated.voters.length < exit.minVoters) {
    return false;
  }

  const { minCount, voters } = exit.requiredVoters;
  if (voters.length > 0 && minCount > 0) {
    const participants = new Set(validated.participants);
    const count = voters.filter((v) => participants.has(v)).length;
    if (count < minCount) {
      return false;
    }
  }

  if (exit.requires === "unanimous") {
    return isUnanimous(validated.votes);
  }
  return isDecisive(validated.votes);
}

/**
 * Check whether a discussion exit is eligible based on 👍 readiness reactions.
 *
 * Applies quorum (minReady) and required ready users check.
 * Simpler than isExitEligible — no majority/unanimous distinction.
 */
export function isDiscussionExitEligible(
  exit: DiscussionAutoExit,
  readyUsers: Set<string>,
): boolean {
  if (readyUsers.size < exit.minReady) {
    return false;
  }

  const { minCount, users } = exit.requiredReady;
  if (users.length > 0 && minCount > 0) {
    const readyCount = users.filter(u => readyUsers.has(u)).length;
    if (readyCount < minCount) {
      return false;
    }
  }

  return true;
}
