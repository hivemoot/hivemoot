/**
 * Scheduled Daily Standup
 *
 * Runs daily at 00:05 UTC via GitHub Actions. For each repository
 * with standup enabled, appends a Colony Report comment to the
 * Colony Journal discussion.
 *
 * Reports cover the previous calendar day (UTC).
 * Idempotent — skips if today's report already exists.
 */

import { Octokit } from "octokit";
import {
  loadRepositoryConfig,
  createPROperations,
  logger,
} from "../api/lib/index.js";
import {
  getRepoDiscussionInfo,
  findOrCreateColonyJournal,
  addStandupComment,
  getLastStandupDate,
  computeDayNumber,
} from "../api/lib/discussions.js";
import {
  collectStandupData,
  formatStandupComment,
  generateStandupLLMContent,
  hasAnyContent,
} from "../api/lib/standup.js";
import { runForAllRepositories, runIfMain } from "./shared/run-installations.js";
import type { Repository } from "../api/lib/index.js";
import type { InstallationContext } from "./shared/run-installations.js";

/**
 * Get today's UTC date string and the reporting date (yesterday UTC).
 * The standup posted at 00:05 UTC on Feb 7 covers Feb 6.
 */
function getReportDate(): string {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return yesterday.toISOString().split("T")[0];
}

/**
 * Process a single repository for daily standup.
 * Exported for testing.
 */
export async function processRepository(
  octokit: InstanceType<typeof Octokit>,
  repo: Repository,
  _appId: number,
  installation?: InstallationContext
): Promise<void> {
  const owner = repo.owner.login;
  const repoName = repo.name;

  logger.group(`Processing ${repo.full_name}`);

  try {
    // 1. Load repo config — check if standup is enabled
    const repoConfig = await loadRepositoryConfig(octokit, owner, repoName);
    if (!repoConfig) {
      logger.debug(`No config file found for ${repo.full_name}; skipping standup`);
      return;
    }
    if (!repoConfig.standup.enabled) {
      logger.debug(`Standup not enabled for ${repo.full_name}`);
      return;
    }

    // 2. Check if discussions are enabled
    const repoInfo = await getRepoDiscussionInfo(octokit, owner, repoName);
    if (!repoInfo.hasDiscussions) {
      logger.debug(`Discussions not enabled for ${repo.full_name}`);
      return;
    }

    // 3. Find the configured category
    const categoryName = repoConfig.standup.category;
    const category = repoInfo.categories.find((c) => c.name === categoryName);
    if (!category) {
      logger.warn(
        `[${repo.full_name}] Discussion category "${categoryName}" not found. ` +
        `Create this category in Settings → Discussions, or set standup.category in .github/hivemoot.yml.`
      );
      return;
    }

    // 4. Find or create the Colony Journal discussion
    const journal = await findOrCreateColonyJournal(
      octokit,
      repoInfo.repoId,
      category.id,
      owner,
      repoName
    );

    // 5. Idempotency check — skip if today's report already exists
    const reportDate = getReportDate();
    const lastDate = await getLastStandupDate(octokit, owner, repoName, journal.number);
    if (lastDate === reportDate) {
      logger.info(`[${repo.full_name}] Today's standup already posted, skipping`);
      return;
    }

    // 6. Compute day number
    const dayNumber = computeDayNumber(repoInfo.repoCreatedAt, reportDate);

    // 7. Collect standup data
    const prs = createPROperations(octokit, { appId: _appId });
    const data = await collectStandupData(
      octokit,
      prs,
      owner,
      repoName,
      reportDate,
      dayNumber
    );

    // 8. Generate LLM content (optional — graceful fallback)
    let llmContent = null;
    if (hasAnyContent(data)) {
      llmContent = await generateStandupLLMContent(data, {
        installationId: installation?.installationId,
      });
    }

    // 9. Format the comment body
    const body = formatStandupComment(data, llmContent);

    // 10. Post the standup comment (with write-then-verify)
    const result = await addStandupComment(
      octokit,
      journal.discussionId,
      body,
      owner,
      repoName,
      journal.number,
      reportDate
    );

    logger.info(`[${repo.full_name}] Posted Colony Report — Day ${dayNumber} (${result.url || "verified"})`);
  } finally {
    logger.groupEnd();
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await runForAllRepositories({
    scriptName: "daily standup",
    startMessage: "Posting Colony Reports for repositories with standup enabled",
    processRepository,
  });
}

runIfMain(import.meta.url, main);
