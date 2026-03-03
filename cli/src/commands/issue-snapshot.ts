import { CliError, type RepoRef } from "../config/types.js";
import { resolveRepo } from "../github/repo.js";
import { buildIssueSnapshot, type IssueSnapshotResult } from "../github/issue-snapshot.js";

export interface IssueSnapshotOptions {
  repo?: string;
  json?: boolean;
}

function formatRepo(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

function formatSnapshot(snapshot: IssueSnapshotResult): string {
  const { issue } = snapshot;
  const phase = issue.phase ?? "unknown";
  const labels = issue.labels.length > 0 ? issue.labels.join(", ") : "none";
  const assignees = issue.assignees.length > 0 ? issue.assignees.join(", ") : "unassigned";

  const lines: string[] = [
    `ISSUE SNAPSHOT — ${formatRepo(snapshot.repo)}#${issue.number}`,
    `${issue.title}`,
    `state: ${issue.state}  phase: ${phase}`,
    `labels: ${labels}`,
    `assignees: ${assignees}`,
  ];

  if (snapshot.queenSummary) {
    lines.push(`queen summary: ${snapshot.queenSummary.url}`);
    lines.push(`  ${snapshot.queenSummary.bodyPreview.replace(/\n/g, "\n  ")}`);
  }

  if (snapshot.votingComment) {
    const { votingComment: vc } = snapshot;
    const yourVote = vc.yourVote ? ` (your vote: ${vc.yourVote})` : "";
    lines.push(
      `voting comment: ${vc.url}  👍 ${vc.thumbsUp}  👎 ${vc.thumbsDown}${yourVote}`,
    );
  }

  return lines.join("\n");
}

export async function issueSnapshotCommand(
  issueArg: string,
  options: IssueSnapshotOptions,
): Promise<void> {
  const issueNumber = parseInt(issueArg, 10);
  if (isNaN(issueNumber) || issueNumber <= 0) {
    throw new CliError(
      `Invalid issue number: "${issueArg}". Expected a positive integer.`,
      "GH_ERROR",
      1,
    );
  }

  const repo = await resolveRepo(options.repo);

  let snapshot: IssueSnapshotResult;
  try {
    snapshot = await buildIssueSnapshot(repo, issueNumber);
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
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  console.log(formatSnapshot(snapshot));
}
