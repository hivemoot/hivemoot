/**
 * Implementation Intake Module
 *
 * Business logic for PR implementation intake and leaderboard recalculation.
 * Extracted from webhooks/index.ts to avoid module-level Probot side effects
 * when imported by scheduled scripts.
 */

import {
  LABELS,
  PR_MESSAGES,
  isLabelMatch,
} from "../config.js";
import { NOTIFICATION_TYPES } from "./bot-comments.js";
import {
  createIssueOperations,
  createPROperations,
  createLeaderboardService,
} from "./index.js";
import {
  getLinkedIssues,
  type GraphQLClient,
} from "./graphql-queries.js";
import type { IntakeMethod } from "./repo-config.js";
import type { LinkedIssue, PRWithApprovals, PullRequest } from "./types.js";
import { filterByLabel, hasLabel } from "./types.js";
import { getAppId } from "./env-validation.js";
import { logger } from "./logger.js";
import { getIssuePriority } from "./priority.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Max concurrent API calls when fetching PR approval counts */
const APPROVAL_FETCH_CONCURRENCY = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type IntakeTrigger = "opened" | "updated" | "edited";

/**
 * Combined client interface for leaderboard recalculation.
 * Probot's Context.octokit satisfies all these requirements.
 */
export type LeaderboardRecalcClient = GraphQLClient &
  Parameters<typeof createLeaderboardService>[0] &
  Parameters<typeof createPROperations>[0];

// ─────────────────────────────────────────────────────────────────────────────
// Internal Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a map of ready issue numbers to active implementation PRs.
 *
 * Uses PR-side linking (closingIssuesReferences) to avoid relying on
 * cross-reference timeline events that may lag behind PR creation.
 */
async function getImplementationPRsByIssue(params: {
  octokit: GraphQLClient;
  prs: ReturnType<typeof createPROperations>;
  owner: string;
  repo: string;
  issueNumbers: number[];
  ensurePRNumber?: number;
  linkedIssuesByPRNumber?: Map<number, LinkedIssue[]>;
}): Promise<Map<number, PullRequest[]>> {
  const {
    octokit,
    prs,
    owner,
    repo,
    issueNumbers,
    ensurePRNumber,
    linkedIssuesByPRNumber,
  } = params;

  const issueNumberSet = new Set(issueNumbers);
  const results = new Map<number, PullRequest[]>();

  for (const issueNumber of issueNumbers) {
    results.set(issueNumber, []);
  }

  if (issueNumberSet.size === 0) {
    return results;
  }

  const implementationPRs = await prs.findPRsWithLabel(owner, repo, LABELS.IMPLEMENTATION);
  const candidateNumbers = new Set(implementationPRs.map((pr) => pr.number));

  if (ensurePRNumber !== undefined && !candidateNumbers.has(ensurePRNumber)) {
    const labels = await prs.getLabels({ owner, repo, prNumber: ensurePRNumber });
    if (labels.some(l => isLabelMatch(l, LABELS.IMPLEMENTATION))) {
      candidateNumbers.add(ensurePRNumber);
      logger.debug(`ensurePR #${ensurePRNumber}: added via direct label check (not yet indexed)`);
    }
  }

  const linkedIssuesCache = linkedIssuesByPRNumber ?? new Map<number, LinkedIssue[]>();
  const prDetailsCache = new Map<number, PullRequest>();
  const candidates = Array.from(candidateNumbers);

  logger.debug(
    `Found ${candidates.length} candidate implementation PRs for issues [${issueNumbers.join(", ")}]`
  );

  const getPullRequestSummary = async (prNumber: number): Promise<PullRequest | null> => {
    const cached = prDetailsCache.get(prNumber);
    if (cached) {
      return cached;
    }

    const details = await prs.get({ owner, repo, prNumber });
    const normalizedState =
      details.merged ? "MERGED" : details.state.toUpperCase() === "OPEN" ? "OPEN" : "CLOSED";

    if (normalizedState !== "OPEN") {
      return null;
    }

    const summary: PullRequest = {
      number: prNumber,
      title: "",
      state: normalizedState,
      author: { login: details.author },
    };

    prDetailsCache.set(prNumber, summary);
    return summary;
  };

  for (let i = 0; i < candidates.length; i += APPROVAL_FETCH_CONCURRENCY) {
    const batch = candidates.slice(i, i + APPROVAL_FETCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (prNumber) => {
        try {
          const cachedLinkedIssues = linkedIssuesCache.get(prNumber);
          const linkedIssues =
            cachedLinkedIssues ?? (await getLinkedIssues(octokit, owner, repo, prNumber));

          if (!cachedLinkedIssues) {
            linkedIssuesCache.set(prNumber, linkedIssues);
          }

          const linkedIssueNumbers = linkedIssues
            .map((issue) => issue.number)
            .filter((number) => issueNumberSet.has(number));

          if (linkedIssueNumbers.length === 0) {
            return null;
          }

          const prSummary = await getPullRequestSummary(prNumber);
          if (!prSummary) {
            return null;
          }

          return { prSummary, linkedIssueNumbers };
        } catch (error) {
          // PR may have been deleted or is inaccessible — skip it rather than
          // crashing the entire batch and losing all other candidates.
          logger.warn(
            `Skipping candidate PR #${prNumber}: ${error instanceof Error ? error.message : String(error)}`
          );
          return null;
        }
      })
    );

    for (const result of batchResults) {
      if (!result) {
        continue;
      }

      for (const issueNumber of result.linkedIssueNumbers) {
        results.get(issueNumber)?.push(result.prSummary);
      }
    }
  }

  return results;
}

/**
 * Determine if a PR is eligible for intake based on activity after the ready label.
 *
 * Anti-gaming guard: requires PR activity (commit or human comment) to occur
 * AFTER the issue received the phase:ready-to-implement label. This prevents
 * agents from pre-creating empty/skeleton PRs during discussion or voting
 * to automatically claim implementation slots when voting passes.
 *
 * When voting passes, close-discussions.ts notifies existing PRs to push
 * an update — but does not auto-tag them. The PR author must demonstrate
 * real post-approval work before activation.
 */
function isActivationAfterReady(activationDate: Date, readyAt: Date): boolean {
  return activationDate.getTime() >= readyAt.getTime();
}

/**
 * Fetch approval counts for PRs with concurrency limiting.
 * Processes PRs in batches to avoid rate limiting.
 */
async function fetchApprovalScores(
  prs: ReturnType<typeof createPROperations>,
  competingPRs: PullRequest[],
  owner: string,
  repo: string
): Promise<PRWithApprovals[]> {
  const scores: PRWithApprovals[] = [];

  for (let i = 0; i < competingPRs.length; i += APPROVAL_FETCH_CONCURRENCY) {
    const batch = competingPRs.slice(i, i + APPROVAL_FETCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (pr) => ({
        number: pr.number,
        title: pr.title,
        author: pr.author.login,
        approvals: await prs.getApprovalCount({ owner, repo, prNumber: pr.number }),
      }))
    );
    scores.push(...batchResults);
  }

  return scores;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Intake a PR as an implementation when it becomes eligible.
 *
 * Eligibility rules:
 * - Issue must be phase:ready-to-implement
 * - PR must have activity (comment or commit) after the ready label time
 * - Only intake if there is room under the per-repo maxPRsPerIssue
 */
export async function processImplementationIntake(params: {
  octokit: GraphQLClient;
  issues: ReturnType<typeof createIssueOperations>;
  prs: ReturnType<typeof createPROperations>;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  owner: string;
  repo: string;
  prNumber: number;
  linkedIssues: LinkedIssue[];
  trigger: IntakeTrigger;
  maxPRsPerIssue: number;
  trustedReviewers?: string[];
  intake?: IntakeMethod[];
  /** Timestamp of a PR body edit, used as an activation signal by the edited webhook. */
  editedAt?: Date;
}): Promise<void> {
  const {
    octokit,
    issues,
    prs,
    log,
    owner,
    repo,
    prNumber,
    linkedIssues,
    trigger,
    maxPRsPerIssue,
  } = params;
  const trustedReviewers = params.trustedReviewers ?? [];
  const intake: IntakeMethod[] = params.intake ?? [{ method: "auto" }];

  if (linkedIssues.length === 0) {
    return;
  }

  const prRef = { owner, repo, prNumber };
  const [prDetails, prLabels] = await Promise.all([
    prs.get(prRef),
    prs.getLabels(prRef),
  ]);

  // Avoid re-processing PRs already accepted as implementations
  if (prLabels.some(l => isLabelMatch(l, LABELS.IMPLEMENTATION))) {
    return;
  }

  const activationDate = await prs.getLatestAuthorActivityDate(prRef, prDetails.createdAt);
  // PR body edits count as activation — the webhook provides the edit timestamp
  const effectiveActivation = params.editedAt
    ? new Date(Math.max(activationDate.getTime(), params.editedAt.getTime()))
    : activationDate;
  const readyIssues = filterByLabel(linkedIssues, LABELS.READY_TO_IMPLEMENT);
  const activeImplementationPRsByIssue =
    readyIssues.length > 0
      ? await getImplementationPRsByIssue({
          octokit,
          prs,
          owner,
          repo,
          issueNumbers: readyIssues.map((issue) => issue.number),
        })
      : new Map<number, PullRequest[]>();

  let welcomed = false;

  for (const linkedIssue of linkedIssues) {
    if (!hasLabel(linkedIssue, LABELS.READY_TO_IMPLEMENT)) {
      if (trigger === "opened") {
        const isTerminal =
          hasLabel(linkedIssue, LABELS.REJECTED) ||
          hasLabel(linkedIssue, LABELS.INCONCLUSIVE) ||
          hasLabel(linkedIssue, LABELS.IMPLEMENTED);
        const message = isTerminal
          ? PR_MESSAGES.issueClosedNoTracking(linkedIssue.number)
          : PR_MESSAGES.issueNotReadyToImplement(linkedIssue.number);
        await prs.comment(prRef, message);
      }
      continue;
    }

    const issueRef = { owner, repo, issueNumber: linkedIssue.number };
    const readyAt = await issues.getLabelAddedTime(issueRef, LABELS.READY_TO_IMPLEMENT);

    if (!readyAt) {
      log.warn(
        `Ready label time missing for issue #${linkedIssue.number}; skipping PR #${prNumber}`
      );
      continue;
    }

    if (!isActivationAfterReady(effectiveActivation, readyAt)) {
      // PR was opened before voting passed. Check if any intake method accepts it.
      let activated = false;

      for (const rule of intake) {
        if (rule.method === "update") {
          // The timing guard already failed — this method cannot activate.
          continue;
        }
        if (rule.method === "auto") {
          log.info(`PR #${prNumber} activated via auto intake for issue #${linkedIssue.number}`);
          activated = true;
          break;
        }
        if (rule.method === "approval") {
          const approverLogins = await prs.getApproverLogins(prRef);
          const trustedApprovals = trustedReviewers.filter(
            r => approverLogins.has(r)
          ).length;
          if (trustedApprovals >= rule.minApprovals) {
            log.info(
              `PR #${prNumber} activated via trusted approval: ${trustedApprovals} of ${rule.minApprovals} required for issue #${linkedIssue.number}`
            );
            activated = true;
            break;
          }
        }
      }

      if (!activated) {
        if (trigger === "opened") {
          await prs.comment(prRef, PR_MESSAGES.issueReadyNeedsUpdate(linkedIssue.number));
        }
        continue;
      }
    }

    const activePRs = activeImplementationPRsByIssue.get(linkedIssue.number) ?? [];
    const otherActivePRs = activePRs.filter((pr) => pr.number !== prNumber);
    const totalPRCountIfAccepted = otherActivePRs.length + 1;

    if (totalPRCountIfAccepted > maxPRsPerIssue) {
      if (trigger === "opened") {
        await prs.comment(
          prRef,
          PR_MESSAGES.prLimitReached(
            maxPRsPerIssue,
            otherActivePRs.map((pr) => pr.number)
          )
        );
        await prs.close(prRef);
      } else {
        await prs.comment(
          prRef,
          PR_MESSAGES.prNoRoomYet(
            maxPRsPerIssue,
            otherActivePRs.map((pr) => pr.number)
          )
        );
      }
      return;
    }

    await prs.addLabels(prRef, [LABELS.IMPLEMENTATION]);
    await recalculateLeaderboardForPR(octokit, log, owner, repo, prNumber);

    if (!welcomed) {
      const alreadyWelcomed = await prs.hasNotificationComment(
        prRef,
        NOTIFICATION_TYPES.IMPLEMENTATION_WELCOME,
        linkedIssue.number
      );
      if (!alreadyWelcomed) {
        // Extract labels from LinkedIssue structure to match IssueWithLabels interface
        const labels = linkedIssue.labels.nodes.filter((l): l is { name: string } => l !== null);
        const priority = getIssuePriority({ labels });
        await prs.comment(prRef, PR_MESSAGES.IMPLEMENTATION_WELCOME(linkedIssue.number, priority));
        welcomed = true;
      }
    }

    const alreadyNotified = await issues.hasNotificationComment(
      issueRef,
      NOTIFICATION_TYPES.ISSUE_NEW_PR,
      prNumber
    );
    if (!alreadyNotified) {
      await issues.comment(
        issueRef,
        PR_MESSAGES.issueNewPR(prNumber, totalPRCountIfAccepted)
      );
    }
  }
}

/**
 * Recalculate leaderboard for all linked issues of a PR.
 * Called when approval counts change (new approval, dismissal) or PR is closed.
 */
export async function recalculateLeaderboardForPR(
  octokit: LeaderboardRecalcClient,
  log: { info: (msg: string) => void },
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  const appId = getAppId();
  const leaderboard = createLeaderboardService(octokit, { appId });
  const prs = createPROperations(octokit, { appId });

  const linkedIssues = await getLinkedIssues(octokit, owner, repo, prNumber);
  const readyIssues = filterByLabel(linkedIssues, LABELS.READY_TO_IMPLEMENT);

  if (readyIssues.length === 0) {
    return;
  }

  const linkedIssuesCache = new Map<number, LinkedIssue[]>();
  linkedIssuesCache.set(prNumber, linkedIssues);

  const activeImplementationPRsByIssue = await getImplementationPRsByIssue({
    octokit,
    prs,
    owner,
    repo,
    issueNumbers: readyIssues.map((issue) => issue.number),
    ensurePRNumber: prNumber,
    linkedIssuesByPRNumber: linkedIssuesCache,
  });

  for (const linkedIssue of readyIssues) {
    const activePRs = activeImplementationPRsByIssue.get(linkedIssue.number) ?? [];
    const scores = await fetchApprovalScores(prs, activePRs, owner, repo);

    await leaderboard.upsertLeaderboard(
      { owner, repo, issueNumber: linkedIssue.number },
      scores
    );

    log.info(`Updated leaderboard for issue #${linkedIssue.number} with ${scores.length} active PRs`);
  }
}
