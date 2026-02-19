import { CliError, type RepoRef } from "../config/types.js";
import { resolveRepo } from "../github/repo.js";
import {
  ISSUE_VOTE_CHOICES,
  submitIssueVote,
  type IssueVoteResult,
  type VoteChoice,
} from "../github/workflow.js";

export interface IssueVoteOptions {
  repo?: string;
  json?: boolean;
  vote: string;
}

function formatRepo(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

function parseVoteChoice(value: string): VoteChoice {
  const normalized = value.trim().toLowerCase();
  if (!ISSUE_VOTE_CHOICES.includes(normalized as VoteChoice)) {
    const allowed = ISSUE_VOTE_CHOICES.join(", ");
    throw new CliError(
      `Invalid vote "${value}". Expected one of: ${allowed}.`,
      "GH_ERROR",
      1,
    );
  }
  return normalized as VoteChoice;
}

function formatVoteResult(result: IssueVoteResult): string {
  return [
    `ISSUE VOTE — ${formatRepo(result.repo)}#${result.issue.number}`,
    `${result.issue.title}`,
    `choice: ${result.vote.choice} (${result.vote.reaction})`,
    `comment: ${result.targetComment.url}`,
  ].join("\n");
}

export async function issueVoteCommand(
  issueRef: string,
  options: IssueVoteOptions,
): Promise<void> {
  const voteChoice = parseVoteChoice(options.vote);
  const repo = await resolveRepo(options.repo);
  const result = await submitIssueVote(repo, issueRef, voteChoice);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatVoteResult(result));
}
