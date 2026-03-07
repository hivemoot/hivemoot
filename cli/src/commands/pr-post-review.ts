import { readFileSync } from "node:fs";
import { CliError, type RepoRef } from "../config/types.js";
import { resolveRepo } from "../github/repo.js";
import { postPrReview, type PrPostReviewResult, type ReviewEvent } from "../github/pr-post-review.js";

export interface PrPostReviewOptions {
  repo?: string;
  json?: boolean;
  dryRun?: boolean;
  event: string;
  body?: string;
  bodyFile?: string;
}

function formatRepo(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

function formatResult(result: PrPostReviewResult): string {
  const lines: string[] = [
    `PR POST-REVIEW — ${formatRepo(result.repo)}#${result.pr} [${result.headSha.slice(0, 7)}]`,
  ];

  if (result.dryRun && result.code === "dry_run") {
    lines.push("mode: dry-run (no review posted)");
    lines.push(`event: ${result.event}`);
  } else {
    lines.push(`code: ${result.code}`);
    lines.push(`event: ${result.event}`);
    if (result.reviewUrl) {
      lines.push(`url: ${result.reviewUrl}`);
    }
  }

  for (const w of result.warnings) {
    lines.push(`warning [${w.code}]: ${w.message}`);
  }

  return lines.join("\n");
}

function parseEvent(raw: string): ReviewEvent {
  const normalized = raw.toUpperCase().replace(/-/g, "_");
  if (normalized === "APPROVE" || normalized === "REQUEST_CHANGES" || normalized === "COMMENT") {
    return normalized as ReviewEvent;
  }
  throw new CliError(
    `Invalid review event "${raw}". Must be one of: approve, request-changes, comment`,
    "GH_ERROR",
    1,
  );
}

export async function prPostReviewCommand(
  prArg: string,
  options: PrPostReviewOptions,
): Promise<void> {
  const prNumber = parseInt(prArg, 10);
  if (isNaN(prNumber) || prNumber <= 0) {
    throw new CliError(
      `Invalid pull request number: "${prArg}". Expected a positive integer.`,
      "GH_ERROR",
      1,
    );
  }

  const event = parseEvent(options.event);

  if (options.body && options.bodyFile) {
    throw new CliError(
      "--body and --body-file are mutually exclusive.",
      "GH_ERROR",
      1,
    );
  }

  let body = "";
  if (options.bodyFile) {
    try {
      body = readFileSync(options.bodyFile, "utf8");
    } catch (err) {
      throw new CliError(
        `Could not read body file "${options.bodyFile}": ${err instanceof Error ? err.message : String(err)}`,
        "GH_ERROR",
        1,
      );
    }
  } else if (options.body) {
    body = options.body;
  }

  const repo = await resolveRepo(options.repo);

  let result: PrPostReviewResult;
  try {
    result = await postPrReview(repo, prNumber, event, body, options.dryRun ?? false);
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
