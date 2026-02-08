import type { GitHubIssue, RepoRef } from "../config/types.js";
import { CliError } from "../config/types.js";
import { gh } from "./client.js";

export async function fetchIssues(repo: RepoRef): Promise<GitHubIssue[]> {
  const json = await gh([
    "issue",
    "list",
    "-R",
    `${repo.owner}/${repo.repo}`,
    "--state",
    "open",
    "--json",
    "number,title,labels,assignees,author,comments,createdAt,updatedAt,url",
    "--limit",
    "200",
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CliError(
      "Failed to parse issues response from gh CLI",
      "GH_ERROR",
      1,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CliError(
      "Unexpected issues response format from gh CLI",
      "GH_ERROR",
      1,
    );
  }
  return parsed as GitHubIssue[];
}
