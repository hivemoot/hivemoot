import { CliError, type RepoRef } from "../config/types.js";
import { resolveRepo } from "../github/repo.js";
import { buildIssueVoteResult, type IssueVoteResult } from "../github/issue-vote.js";

export interface IssueVoteOptions {
  repo?: string;
  json?: boolean;
  dryRun?: boolean;
}

function formatRepo(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

function formatVoteResult(result: IssueVoteResult): string {
  const lines: string[] = [
    `ISSUE VOTE — ${formatRepo(result.repo)}#${result.issue}`,
    `vote: ${result.vote} (${result.code})`,
  ];

  if (result.dryRun) {
    lines.push("mode: dry-run (no reaction applied)");
  }

  if (result.targetComment) {
    lines.push(`target: ${result.targetComment.url}`);
  }

  if (result.appliedReaction && result.code !== "already_voted") {
    lines.push(`reaction: ${result.appliedReaction}`);
  }

  if (result.warnings.length > 0) {
    lines.push("warnings:");
    for (const w of result.warnings) {
      lines.push(`- ${w.code}: ${w.message}`);
    }
  }

  return lines.join("\n");
}

const ACTIONABLE_CODES = new Set(["no_voting_target", "conflicting_vote"]);

export async function issueVoteCommand(
  issueArg: string,
  voteArg: string,
  options: IssueVoteOptions,
): Promise<void> {
  const issueNumber = parseInt(issueArg, 10);
  if (isNaN(issueNumber) || issueNumber <= 0) {
    throw new CliError(
      `Invalid issue number: "${issueArg}". Expected a positive integer.`,
      "GH_ERROR",
      1,
    );
  }

  const vote = voteArg.toLowerCase();
  if (vote !== "up" && vote !== "down") {
    throw new CliError(
      `Invalid vote: "${voteArg}". Expected "up" or "down".`,
      "GH_ERROR",
      2,
    );
  }

  const repo = await resolveRepo(options.repo);

  let result: IssueVoteResult;
  try {
    result = await buildIssueVoteResult(repo, issueNumber, vote, options.dryRun ?? false);
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
    console.log(formatVoteResult(result));
  }

  if (ACTIONABLE_CODES.has(result.code)) {
    process.exitCode = 2;
  }
}
