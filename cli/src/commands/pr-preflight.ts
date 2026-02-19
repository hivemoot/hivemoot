import { CliError, type RepoRef } from "../config/types.js";
import { resolveRepo } from "../github/repo.js";
import { buildPrPreflight, type PullRequestPreflightResult } from "../github/workflow.js";

export interface PrPreflightOptions {
  repo?: string;
  json?: boolean;
}

function formatRepo(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

function formatPreflight(result: PullRequestPreflightResult): string {
  const lines = [
    `PR PREFLIGHT — ${formatRepo(result.repo)}#${result.pr.number}`,
    `${result.pr.title}`,
    `result: ${result.pass ? "pass" : "blocked"}`,
  ];

  if (result.blockers.length > 0) {
    lines.push("blockers:");
    for (const blocker of result.blockers) {
      lines.push(`- ${blocker.code}: ${blocker.message}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of result.warnings) {
      lines.push(`- ${warning.code}: ${warning.message}`);
    }
  }

  return lines.join("\n");
}

export async function prPreflightCommand(
  prRef: string,
  options: PrPreflightOptions,
): Promise<void> {
  const repo = await resolveRepo(options.repo);

  let result: PullRequestPreflightResult;
  try {
    result = await buildPrPreflight(repo, prRef);
  } catch (err) {
    if (err instanceof CliError) {
      throw new CliError(err.message, err.code, Math.max(err.exitCode, 3));
    }
    throw new CliError(
      err instanceof Error ? err.message : String(err),
      "GH_ERROR",
      3,
    );
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatPreflight(result));
  }

  if (!result.pass) {
    process.exitCode = 2;
  }
}
