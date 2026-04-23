/**
 * Scheduled Repository Label Reconciliation
 *
 * Ensures every installed repository has the full required label set with
 * canonical names, colors, and descriptions. Runs on a scheduled cadence to
 * backfill newly required labels and repair label drift.
 *
 * Safe to run repeatedly — `ensureRequiredLabels` is idempotent and handles
 * 422 conflicts gracefully.
 */

import { Octokit } from "octokit";
import { createRepositoryLabelService, logger } from "../api/lib/index.js";
import { runForAllRepositories, runIfMain } from "./shared/run-installations.js";
import type { Repository } from "../api/lib/index.js";
import type { InstallationContext } from "./shared/run-installations.js";

/**
 * Process a single repository — ensure all required labels exist.
 * Exported for testing.
 */
export async function processRepository(
  octokit: InstanceType<typeof Octokit>,
  repo: Repository,
  _appId: number,
  _installation?: InstallationContext
): Promise<void> {
  const owner = repo.owner.login;
  const repoName = repo.name;

  logger.group(`Processing ${repo.full_name}`);
  try {
    const labelService = createRepositoryLabelService(octokit);
    const result = await labelService.ensureRequiredLabels(owner, repoName);

    logger.info(
      `[${repo.full_name}] Labels reconciled: ` +
        `created=${result.created} renamed=${result.renamed} ` +
        `updated=${result.updated} skipped=${result.skipped}`
    );

    if (result.renamedLabels.length > 0) {
      for (const rename of result.renamedLabels) {
        logger.info(`[${repo.full_name}] Renamed label: ${rename.from} → ${rename.to}`);
      }
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
    scriptName: "scheduled repository label reconciliation",
    processRepository,
  });
}

runIfMain(import.meta.url, main);
