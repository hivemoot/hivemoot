/**
 * Scheduled Merge-Ready Label Reconciliation
 *
 * Sweeps all open PRs with the `implementation` label and re-evaluates
 * whether each should have the `merge-ready` label.
 *
 * Covers gaps that webhooks can't:
 * - Missed webhook events (transient errors, GitHub delivery failures)
 * - Stale labels from any cause (eventual consistency guarantee)
 * - Base branch updates causing conflicts (mergeable may be null during webhooks)
 */

import { Octokit } from "octokit";
import { LABELS } from "../api/config.js";
import {
  createPROperations,
  loadRepositoryConfig,
  evaluateMergeReadiness,
  logger,
} from "../api/lib/index.js";
import { runForAllRepositories, runIfMain } from "./shared/run-installations.js";
import type { Repository } from "../api/lib/index.js";
import type { InstallationContext } from "./shared/run-installations.js";

/**
 * Process a single repository — find all implementation PRs and reconcile each.
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
    const repoConfig = await loadRepositoryConfig(octokit, owner, repoName);
    if (!repoConfig) {
      logger.debug(`[${repo.full_name}] No config file found; skipping merge-ready reconciliation`);
      return;
    }

    if (!repoConfig.governance.pr?.mergeReady) {
      logger.debug(`[${repo.full_name}] PR workflows or mergeReady not configured, skipping`);
      return;
    }
    const { mergeReady, trustedReviewers } = repoConfig.governance.pr;

    const prs = createPROperations(octokit, { appId });
    const implementationPRs = await prs.findPRsWithLabel(owner, repoName, LABELS.IMPLEMENTATION);

    if (implementationPRs.length === 0) {
      logger.debug(`[${repo.full_name}] No implementation PRs found`);
      return;
    }

    logger.info(`[${repo.full_name}] Found ${implementationPRs.length} implementation PR(s)`);

    let added = 0;
    let removed = 0;
    let unchanged = 0;
    const collectedErrors: Error[] = [];

    for (const pr of implementationPRs) {
      try {
        const result = await evaluateMergeReadiness({
          prs,
          ref: { owner, repo: repoName, prNumber: pr.number },
          config: mergeReady,
          trustedReviewers,
          currentLabels: pr.labels.map((l) => l.name),
          log: logger,
        });

        if (result.action === "added") added++;
        else if (result.action === "removed") removed++;
        else unchanged++;
      } catch (error) {
        collectedErrors.push(error as Error);
        logger.error(
          `Failed to reconcile merge-ready for PR #${pr.number} in ${repo.full_name}`,
          error as Error
        );
      }
    }

    logger.info(
      `[${repo.full_name}] Reconciliation complete: +${added} -${removed} =${unchanged} errors=${collectedErrors.length}`
    );

    if (collectedErrors.length > 0) {
      throw new AggregateError(
        collectedErrors,
        `${collectedErrors.length} PR(s) failed reconciliation in ${repo.full_name}`
      );
    }
  } finally {
    logger.groupEnd();
  }
}

/**
 * Main entry point — processes all installations and their repositories.
 */
async function main(): Promise<void> {
  await runForAllRepositories({
    scriptName: "scheduled merge-ready reconciliation",
    processRepository,
  });
}

runIfMain(import.meta.url, main);
