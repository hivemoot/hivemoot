import type { RepoRef } from "../config/types.js";
import { CliError } from "../config/types.js";
import { gh } from "./client.js";

export type IssuePostCommentCode = "comment_posted" | "dry_run";

export interface IssuePostCommentResult {
  schemaVersion: 1;
  kind: "issue_post_comment";
  generatedAt: string;
  repo: RepoRef;
  issue: number;
  dryRun: boolean;
  code: IssuePostCommentCode;
  commentId?: number;
  commentUrl?: string;
}

interface GitHubCommentResponse {
  id: number;
  html_url: string;
}

export async function postIssueComment(
  repo: RepoRef,
  issueNumber: number,
  body: string,
  dryRun: boolean,
): Promise<IssuePostCommentResult> {
  const generatedAt = new Date().toISOString();

  if (dryRun) {
    return {
      schemaVersion: 1,
      kind: "issue_post_comment",
      generatedAt,
      repo,
      issue: issueNumber,
      dryRun: true,
      code: "dry_run",
    };
  }

  const raw = await gh([
    "api",
    "-X", "POST",
    `/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}/comments`,
    "--raw-field", `body=${body}`,
  ]);

  let parsed: GitHubCommentResponse;
  try {
    parsed = JSON.parse(raw) as GitHubCommentResponse;
  } catch {
    throw new CliError(
      "Failed to parse GitHub API response for posted comment",
      "GH_ERROR",
      1,
    );
  }

  if (typeof parsed.id !== "number" || typeof parsed.html_url !== "string") {
    throw new CliError(
      "Unexpected GitHub API response shape for posted comment",
      "GH_ERROR",
      1,
    );
  }

  return {
    schemaVersion: 1,
    kind: "issue_post_comment",
    generatedAt,
    repo,
    issue: issueNumber,
    dryRun: false,
    code: "comment_posted",
    commentId: parsed.id,
    commentUrl: parsed.html_url,
  };
}
