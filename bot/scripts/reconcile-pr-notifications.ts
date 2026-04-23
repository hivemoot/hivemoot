/**
 * Scheduled PR Notification Reconciliation
 *
 * Catches missed PR notifications by sweeping all hivemoot:ready-to-implement
 * issues and posting ready-to-implement notifications to un-notified PRs.
 *
 * Covers two gaps:
 * 1. Backfill — Issues already in ready-to-implement before the live trigger deployed
 * 2. Retry — If the live trigger's try/catch swallowed an API error
 *
 * Uses the bot-comments metadata system for idempotent duplicate detection.
 * Named generically to support additional PR monitoring logic in the future.
 */

import { Octokit } from "octokit";
import {
  LABELS,
  PR_MESSAGES,
  getLabelQueryAliases,
} from "../api/config.js";
import {
  createPROperations,
  createIssueOperations,
  getOpenPRsForIssue,
  getLinkedIssues,
  getPRBodyLastEditedAt,
  loadRepositoryConfig,
  logger,
} from "../api/lib/index.js";
import { NOTIFICATION_TYPES } from "../api/lib/bot-comments.js";
import { processImplementationIntake } from "../api/lib/implementation-intake.js";
import { runForAllRepositories, runIfMain } from "./shared/run-installations.js";
import type { Repository, PRRef } from "../api/lib/index.js";
import type { PROperations } from "../api/lib/pr-operations.js";
import type { IssueOperations } from "../api/lib/github-client.js";
import type { InstallationContext } from "./shared/run-installations.js";

/**
 * Legacy/plaintext signatures for pre-metadata ready notifications.
 * Keep both old and new phrasing for backward compatibility in fallback detection.
 */
const READY_TO_IMPLEMENT_LEGACY_SIGNATURES = [
  "passed voting and is ready for implementation",
  "is ready for implementation!\n\nPush a new commit or add a comment to activate it for implementation tracking.",
] as const;

/**
 * Parse all "Issue #N" tokens and require exact numeric equality.
 * This avoids prefix collisions (#1 matching #10) in legacy fallback detection.
 */
function hasLegacyIssueNumberMatch(body: string, issueNumber: number): boolean {
  const expectedToken = String(issueNumber);
  const matches = body.matchAll(/\bIssue #(\d+)\b/g);
  for (const match of matches) {
    if (match[1] === expectedToken) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a PR already has a ready-to-implement notification for this issue.
 *
 * Single-pass detection:
 * 1. Fetch comments once
 * 2. Check metadata-tagged comments
 * 3. Fallback to legacy signature text
 *
 * Exported for testing.
 */
export async function hasReadyToImplementNotification(
  prs: PROperations,
  ref: PRRef,
  issueNumber: number
): Promise<boolean> {
  const comments = await prs.listCommentsWithBody(ref);

  // Tier 1: Check for metadata-tagged notification comments
  const hasMetadata = prs.hasNotificationCommentInComments(
    comments,
    NOTIFICATION_TYPES.VOTING_PASSED,
    issueNumber
  );
  if (hasMetadata) return true;

  // Tier 2: Fallback for pre-metadata comments from the live trigger.
  // These contain the legacy signature + "Issue #N".
  // We scan comment bodies to detect them without requiring metadata.
  for (const comment of comments) {
    const body = comment.body;
    if (
      body &&
      READY_TO_IMPLEMENT_LEGACY_SIGNATURES.some((signature) => body.includes(signature)) &&
      hasLegacyIssueNumberMatch(body, issueNumber)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Process one ready-to-implement issue: find linked PRs, skip notified/implementation ones, notify the rest.
 * Also attempts implementation label reconciliation for unlabeled PRs via processImplementationIntake.
 * Exported for testing.
 */
export async function reconcileIssue(
  octokit: InstanceType<typeof Octokit>,
  prs: PROperations,
  issues: IssueOperations,
  owner: string,
  repo: string,
  issueNumber: number,
  maxPRsPerIssue: number,
  trustedReviewers: string[] = [],
  intake: import("../api/lib/repo-config.js").IntakeMethod[] = [{ method: "update" }]
): Promise<{ notified: number; skipped: number }> {
  const linkedPRs = await getOpenPRsForIssue(octokit, owner, repo, issueNumber);
  if (linkedPRs.length === 0) {
    logger.debug(`No open PRs linked to issue #${issueNumber}`);
    return { notified: 0, skipped: 0 };
  }

  // Build exclusion set: PRs already labeled as implementation don't need notification
  const implementationPRs = await prs.findPRsWithLabel(owner, repo, LABELS.IMPLEMENTATION);
  const implementationPRNumbers = new Set(implementationPRs.map((pr) => pr.number));

  let notified = 0;
  let skipped = 0;

  for (const linkedPR of linkedPRs) {
    if (implementationPRNumbers.has(linkedPR.number)) {
      skipped++;
      continue;
    }

    const ref: PRRef = { owner, repo, prNumber: linkedPR.number };

    // Concern 1: Notification (skip if already posted)
    const alreadyNotified = await hasReadyToImplementNotification(prs, ref, issueNumber);
    if (!alreadyNotified) {
      await prs.comment(
        ref,
        PR_MESSAGES.issueReadyToImplement(issueNumber, linkedPR.author.login)
      );
      logger.info(`Reconciled: notified PR #${linkedPR.number} (@${linkedPR.author.login}) that issue #${issueNumber} is ready`);
      notified++;
    } else {
      skipped++;
    }

    // Concern 2: Intake (always attempt for unlabeled PRs)
    // processImplementationIntake is idempotent and has its own anti-gaming guard.
    // This covers the gap where notifyPendingPRs() posted the notification
    // but the PR was never labeled (no post-ready activity at the time, or
    // transient error). The hourly reconciler retries until the author responds.
    try {
      const linkedIssues = await getLinkedIssues(octokit, owner, repo, linkedPR.number);

      // Optional: fetch body-edit timestamp for the anti-gaming guard.
      // Isolated so a transient GraphQL failure doesn't block intake.
      let bodyLastEditedAt: Date | null = null;
      try {
        bodyLastEditedAt = await getPRBodyLastEditedAt(octokit, owner, repo, linkedPR.number);
      } catch {
        logger.warn(
          `Failed to fetch PR body edit time for PR #${linkedPR.number}, proceeding without it`
        );
      }

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
        maxPRsPerIssue,
        trustedReviewers,
        intake,
        editedAt: bodyLastEditedAt ?? undefined,
      });
    } catch (error) {
      logger.error(
        `Failed to reconcile implementation label for PR #${linkedPR.number} (issue #${issueNumber})`,
        error as Error
      );
    }
  }

  return { notified, skipped };
}

/**
 * Process a single repository - find all hivemoot:ready-to-implement issues and reconcile each.
 * Exported for testing.
 */
export async function processRepository(
  octokit: InstanceType<typeof Octokit>,
  repo: Repository,
  appId: number,
  _installation?: InstallationContext
): Promise<void> {
  const owner = repo.owner.login;
  const repoName = repo.name;

  logger.group(`Processing ${repo.full_name}`);

  try {
    const prs = createPROperations(octokit, { appId });
    const issues = createIssueOperations(octokit, { appId });
    const repoConfig = await loadRepositoryConfig(octokit, owner, repoName);
    if (!repoConfig) {
      logger.debug(`[${repo.full_name}] No config file found; skipping PR notification reconciliation`);
      return;
    }

    if (!repoConfig.governance.pr) {
      logger.debug(`[${repo.full_name}] PR workflows disabled, skipping`);
      return;
    }
    const { maxPRsPerIssue, trustedReviewers, intake } = repoConfig.governance.pr;

    // Paginate through all open issues with ready-to-implement label (canonical + legacy)
    const failedIssues: number[] = [];
    const seenIssues = new Set<number>();

    for (const alias of getLabelQueryAliases(LABELS.READY_TO_IMPLEMENT)) {
      const readyIterator = octokit.paginate.iterator(
        octokit.rest.issues.listForRepo,
        {
          owner,
          repo: repoName,
          state: "open",
          labels: alias,
          per_page: 100,
        }
      );

      for await (const { data: page } of readyIterator) {
        const filteredIssues = (page as Array<{ number: number; pull_request?: unknown }>).filter(
          (item) => !item.pull_request
        );

        for (const issue of filteredIssues) {
          if (seenIssues.has(issue.number)) continue;
          seenIssues.add(issue.number);
          try {
            const result = await reconcileIssue(octokit, prs, issues, owner, repoName, issue.number, maxPRsPerIssue, trustedReviewers, intake);
            if (result.notified > 0) {
              logger.info(`Issue #${issue.number}: notified ${result.notified} PR(s), skipped ${result.skipped}`);
            }
          } catch (error) {
            failedIssues.push(issue.number);
            logger.error(`Failed to reconcile issue #${issue.number}`, error as Error);
          }
        }
      }
    }

    if (failedIssues.length > 0) {
      throw new Error(
        `Failed to reconcile ${failedIssues.length} issue(s): ${failedIssues.map((n) => `#${n}`).join(", ")}`
      );
    }
  } finally {
    logger.groupEnd();
  }
}

/**
 * Main entry point - processes all installations and their repositories
 */
async function main(): Promise<void> {
  await runForAllRepositories({
    scriptName: "scheduled PR notification reconciliation",
    processRepository,
  });
}

runIfMain(import.meta.url, main);
