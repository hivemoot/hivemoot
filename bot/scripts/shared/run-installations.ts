/**
 * Shared Script Runner
 *
 * Eliminates boilerplate across scheduled scripts by providing
 * a common installation/repository iteration pattern.
 *
 * Each script provides a processRepository callback; this module
 * handles config loading, GitHub App initialization, installation
 * pagination, per-repo error isolation, and CI error reporting.
 */

import { App, Octokit } from "octokit";
import * as core from "@actions/core";
import { logger } from "../../api/lib/index.js";
import { getAppConfig } from "../../api/lib/env-validation.js";
import type { Repository } from "../../api/lib/index.js";

/**
 * Installation metadata available while iterating repositories.
 */
export interface InstallationContext {
  installationId: number;
  installationLogin?: string;
}

/**
 * Configuration for the shared script runner.
 */
export interface RunnerConfig<TResult = void> {
  /** Human-readable script name for log messages */
  scriptName: string;
  /** Optional additional startup message */
  startMessage?: string;
  /** Per-repository processing function */
  processRepository: (
    octokit: InstanceType<typeof Octokit>,
    repo: Repository,
    appId: number,
    installation: InstallationContext
  ) => Promise<TResult>;
  /** Called after all repos processed, before error handling. Use for aggregate reporting. */
  afterAll?: (context: {
    results: Array<{ repo: string; result: TResult }>;
    failedRepos: string[];
  }) => void;
}

/**
 * Run a script across all GitHub App installations and repositories.
 *
 * Handles config loading, app initialization, installation/repo pagination,
 * per-repo error isolation, and error reporting via @actions/core.
 */
export async function runForAllRepositories<TResult = void>(
  config: RunnerConfig<TResult>
): Promise<void> {
  let appConfig;
  try {
    appConfig = getAppConfig();
  } catch (error) {
    core.setFailed((error as Error).message);
    process.exit(1);
  }

  logger.info(`Starting ${config.scriptName}`);
  if (config.startMessage) {
    logger.info(config.startMessage);
  }

  const app = new App({
    appId: String(appConfig.appId),
    privateKey: appConfig.privateKey,
    Octokit: Octokit,
  });

  const installations = await app.octokit.paginate(
    app.octokit.rest.apps.listInstallations,
    { per_page: 100 }
  );
  logger.info(`Found ${installations.length} installation(s)`);

  let hasErrors = false;
  const failedRepos: string[] = [];
  const results: Array<{ repo: string; result: TResult }> = [];

  for (const installation of installations) {
    logger.group(`Installation ${installation.id} (${installation.account?.login})`);

    try {
      const octokit = await app.getInstallationOctokit(installation.id);

      const repos = await octokit.paginate(
        octokit.rest.apps.listReposAccessibleToInstallation,
        { per_page: 100 }
      );
      const installationContext: InstallationContext = {
        installationId: installation.id,
        installationLogin: installation.account?.login,
      };

      for (const repo of repos as Repository[]) {
        try {
          const result = await config.processRepository(
            octokit,
            repo,
            appConfig.appId,
            installationContext
          );
          results.push({ repo: repo.full_name, result });
        } catch (error) {
          hasErrors = true;
          failedRepos.push(repo.full_name);
          logger.error(`Failed to process ${repo.full_name}`, error as Error);
        }
      }
    } catch (error) {
      hasErrors = true;
      logger.error(
        `Failed to process installation ${installation.id}`,
        error as Error
      );
    } finally {
      logger.groupEnd();
    }
  }

  // Aggregate reporting before error handling
  config.afterAll?.({ results, failedRepos });

  if (hasErrors) {
    const message =
      failedRepos.length > 0
        ? `Failed to process: ${failedRepos.join(", ")}`
        : "Some installations failed to process";
    core.setFailed(message);
    process.exit(1);
  }

  logger.info(`Done - ${config.scriptName} completed successfully`);
}

/**
 * Standard entry point guard for scripts.
 * Runs main() only when the script is executed directly (not imported for testing).
 *
 * @param callerUrl - Pass `import.meta.url` from the calling module
 * @param main - The async main function to run
 */
export function runIfMain(callerUrl: string, main: () => Promise<void>): void {
  const entryUrl = process.argv[1] ? new URL(process.argv[1], "file://").href : "";
  if (callerUrl === entryUrl) {
    main().catch((error) => {
      core.setFailed(`Fatal error: ${error.message}`);
      process.exit(1);
    });
  }
}
