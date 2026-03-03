import { CliError, type RepoRef } from "../config/types.js";
import { resolveRepo } from "../github/repo.js";
import {
  buildPrReviewResult,
  type PrReviewResult,
  type ReviewEvent,
} from "../github/pr-review.js";

export interface PrReviewOptions {
  repo?: string;
  body?: string;
  json?: boolean;
  dryRun?: boolean;
}

const VALID_EVENTS = new Set<ReviewEvent>(["approve", "comment", "request-changes"]);

function formatRepo(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

function formatResult(result: PrReviewResult): string {
  const lines: string[] = [
    `PR REVIEW — ${formatRepo(result.repo)}#${result.pr}`,
    `event: ${result.event} (${result.code})`,
    `head: ${result.headSha.slice(0, 7)}`,
  ];

  if (result.dryRun) {
    lines.push("mode: dry-run (no review submitted)");
  }

  if (result.code === "already_reviewed" && result.priorState) {
    lines.push(`prior: ${result.priorState} at current HEAD — skipping duplicate review`);
  }

  if (result.reviewUrl) {
    lines.push(`url: ${result.reviewUrl}`);
  }

  if (result.warnings.length > 0) {
    lines.push("warnings:");
    for (const w of result.warnings) {
      lines.push(`- ${w.code}: ${w.message}`);
    }
  }

  return lines.join("\n");
}

export async function prReviewCommand(
  prArg: string,
  eventArg: string,
  options: PrReviewOptions,
): Promise<void> {
  const event = eventArg.toLowerCase() as ReviewEvent;
  if (!VALID_EVENTS.has(event)) {
    throw new CliError(
      `Invalid event: "${eventArg}". Expected "approve", "comment", or "request-changes".`,
      "GH_ERROR",
      2,
    );
  }

  const repo = await resolveRepo(options.repo);
  const body = options.body ?? "";

  let result: PrReviewResult;
  try {
    result = await buildPrReviewResult(repo, prArg, event, body, options.dryRun ?? false);
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
    console.log(formatResult(result));
  }

  if (result.code === "already_reviewed") {
    process.exitCode = 2;
  }
}
