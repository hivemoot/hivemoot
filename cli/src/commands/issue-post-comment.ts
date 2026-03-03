import { readFileSync } from "node:fs";
import { CliError, type RepoRef } from "../config/types.js";
import { resolveRepo } from "../github/repo.js";
import { postIssueComment, type IssuePostCommentResult } from "../github/issue-post-comment.js";

export interface IssuePostCommentOptions {
  repo?: string;
  json?: boolean;
  dryRun?: boolean;
  body?: string;
  bodyFile?: string;
}

function formatRepo(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

function formatResult(result: IssuePostCommentResult): string {
  const lines: string[] = [
    `ISSUE POST-COMMENT — ${formatRepo(result.repo)}#${result.issue}`,
  ];

  if (result.dryRun) {
    lines.push("mode: dry-run (no comment posted)");
  } else {
    lines.push(`code: ${result.code}`);
    if (result.commentUrl) {
      lines.push(`url: ${result.commentUrl}`);
    }
    if (result.commentId !== undefined) {
      lines.push(`id: ${result.commentId}`);
    }
  }

  return lines.join("\n");
}

export async function issuePostCommentCommand(
  issueArg: string,
  options: IssuePostCommentOptions,
): Promise<void> {
  const issueNumber = parseInt(issueArg, 10);
  if (isNaN(issueNumber) || issueNumber <= 0) {
    throw new CliError(
      `Invalid issue number: "${issueArg}". Expected a positive integer.`,
      "GH_ERROR",
      1,
    );
  }

  if (!options.body && !options.bodyFile) {
    throw new CliError(
      "One of --body or --body-file is required.",
      "GH_ERROR",
      1,
    );
  }

  if (options.body && options.bodyFile) {
    throw new CliError(
      "--body and --body-file are mutually exclusive.",
      "GH_ERROR",
      1,
    );
  }

  let body: string;
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
  } else {
    body = options.body!;
  }

  const repo = await resolveRepo(options.repo);

  let result: IssuePostCommentResult;
  try {
    result = await postIssueComment(repo, issueNumber, body, options.dryRun ?? false);
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
}
