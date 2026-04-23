/**
 * Scheduled Stale PR Cleanup
 *
 * This script runs on a schedule (via GitHub Actions) to automatically
 * handle stale implementation PRs:
 *
 * 1. Warning: After PR_STALE_THRESHOLD_DAYS of inactivity, add 'stale' label and warn
 * 2. Close: After 2x threshold days of inactivity, close the PR
 * 3. Recovery: If activity resumes, remove 'stale' label
 *
 * This frees up slots for new implementations when PRs are abandoned.
 */

import { Octokit } from "octokit";
import {
  LABELS,
  PR_MESSAGES,
} from "../api/config.js";
import {
  createPROperations,
  loadRepositoryConfig,
  logger,
} from "../api/lib/index.js";
import { runForAllRepositories, runIfMain } from "./shared/run-installations.js";
import type { Repository, PRRef } from "../api/lib/index.js";
import type { PROperations } from "../api/lib/pr-operations.js";
import type { InstallationContext } from "./shared/run-installations.js";

/**
 * Calculate days since last activity.
 * Exported for testing.
 */
export function getDaysSinceActivity(updatedAt: Date): number {
  const now = Date.now();
  const updated = updatedAt.getTime();
  return Math.floor((now - updated) / (1000 * 60 * 60 * 24));
}

/**
 * Process a single PR for staleness.
 * Exported for testing.
 *
 * @param staleDays - Threshold in days before PR is considered stale (from repo config)
 * @param lastActivityDate - Date of last non-bot activity (used for staleness calculation)
 */
export async function processPR(
  prs: PROperations,
  ref: PRRef,
  pr: { number: number; labels: Array<{ name: string }> },
  staleDays: number,
  lastActivityDate: Date
): Promise<void> {
  const daysSinceActivity = getDaysSinceActivity(lastActivityDate);
  const threshold = staleDays;
  const closeThreshold = threshold * 2;
  const hasStaleLabel = prs.hasLabel(pr, LABELS.STALE);

  if (daysSinceActivity >= closeThreshold) {
    // Close the PR due to inactivity
    logger.info(`Closing stale PR #${pr.number} (${daysSinceActivity} days inactive)`);

    await prs.comment(ref, PR_MESSAGES.prStaleClosed(daysSinceActivity));
    await prs.close(ref);
    await prs.removeGovernanceLabels(ref);
    await prs.removeLabel(ref, LABELS.STALE);

  } else if (daysSinceActivity >= threshold) {
    // Warn if not already warned
    if (!hasStaleLabel) {
      logger.info(`Warning stale PR #${pr.number} (${daysSinceActivity} days inactive)`);

      const daysUntilClose = closeThreshold - daysSinceActivity;
      await prs.addLabels(ref, [LABELS.STALE]);
      await prs.comment(ref, PR_MESSAGES.prStaleWarning(daysSinceActivity, daysUntilClose));
    } else {
      logger.debug(`PR #${pr.number} already has stale warning`);
    }

  } else {
    // Activity has resumed - remove stale label if present
    if (hasStaleLabel) {
      logger.info(`Removing stale label from PR #${pr.number} (activity resumed)`);
      await prs.removeLabel(ref, LABELS.STALE);
    }
  }
}

/**
 * Process a single repository - find implementation PRs and check for staleness.
 * Exported for testing.
 *
 * Loads per-repo config from .github/hivemoot.yml if present and only runs
 * when `governance.pr.staleDays` is explicitly configured for the repo.
 *
 * @param appId - GitHub App ID for filtering out bot comments
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
    // Load per-repo configuration (returns null when no config file exists)
    const repoConfig = await loadRepositoryConfig(octokit, owner, repoName);
    if (!repoConfig) {
      logger.debug(`[${repo.full_name}] No config file found; skipping stale PR cleanup`);
      return;
    }

    // PR workflows disabled for this repo — skip stale cleanup
    if (!repoConfig.governance.pr) {
      logger.debug("PR workflows disabled (no pr: section in config). Skipping.");
      return;
    }

    const staleDays = repoConfig.governance.pr.staleDays;
    if (staleDays === null) {
      logger.debug("Stale PR cleanup disabled (no pr.staleDays in config). Skipping.");
      return;
    }

    const prs = createPROperations(octokit, { appId });

    // Find all open PRs with 'implementation' label
    const implementationPRs = await prs.findPRsWithLabel(owner, repoName, LABELS.IMPLEMENTATION);

    if (implementationPRs.length === 0) {
      logger.debug("No implementation PRs found");
      return;
    }

    logger.info(`Found ${implementationPRs.length} implementation PR(s)`);

    const failedPRs: number[] = [];

    for (const pr of implementationPRs) {
      try {
        const ref: PRRef = { owner, repo: repoName, prNumber: pr.number };
        const lastActivityDate = await prs.getLatestActivityDate(ref, pr.createdAt);
        await processPR(prs, ref, pr, staleDays, lastActivityDate);
      } catch (error) {
        failedPRs.push(pr.number);
        logger.error(`Failed to process PR #${pr.number}`, error as Error);
      }
    }

    if (failedPRs.length > 0) {
      throw new Error(
        `Failed to process ${failedPRs.length} PR(s): ${failedPRs.map((n) => `#${n}`).join(", ")}`
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
    scriptName: "scheduled stale PR cleanup",
    startMessage: "Per-repo config loaded from .github/hivemoot.yml (runs only when governance.pr.staleDays is set)",
    processRepository,
  });
}

runIfMain(import.meta.url, main);
