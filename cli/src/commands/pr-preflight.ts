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
  const linkedIssueRefs =
    result.linkedIssues.length > 0
      ? result.linkedIssues.map((issue) => `#${issue.number}`).join(", ")
      : "none";
  const requiredChecks = result.checks.required;
  const requiredPassed = requiredChecks.filter((check) => check.bucket === "pass");
  const requiredFailing = requiredChecks.filter((check) => check.bucket === "fail");
  const requiredPending = requiredChecks.filter((check) => check.bucket === "pending");

  const lines = [
    `PR PREFLIGHT — ${formatRepo(result.repo)}#${result.pr.number}`,
    `${result.pr.title}`,
    `result: ${result.pass ? "pass" : "blocked"}`,
    `linked issues: ${linkedIssueRefs}`,
    `required checks: ${requiredChecks.length} total (${requiredPassed.length} passed, ${requiredFailing.length} failing, ${requiredPending.length} pending)`,
  ];

  if (requiredPassed.length > 0) {
    lines.push(`checks passed: ${requiredPassed.map((check) => check.name).join(", ")}`);
  } else if (requiredChecks.length === 0) {
    lines.push("checks passed: none required");
  }

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
