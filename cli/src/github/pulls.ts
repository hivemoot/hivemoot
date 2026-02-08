import type { GitHubPR, RepoRef } from "../config/types.js";
import { CliError } from "../config/types.js";
import { gh } from "./client.js";

export async function fetchPulls(repo: RepoRef): Promise<GitHubPR[]> {
  const json = await gh([
    "pr",
    "list",
    "-R",
    `${repo.owner}/${repo.repo}`,
    "--state",
    "open",
    "--json",
    "number,title,state,author,labels,comments,reviews,createdAt,updatedAt,url,isDraft,reviewDecision,mergeable,statusCheckRollup,closingIssuesReferences",
    "--limit",
    "200",
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CliError(
      "Failed to parse pull requests response from gh CLI",
      "GH_ERROR",
      1,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CliError(
      "Unexpected pull requests response format from gh CLI",
      "GH_ERROR",
      1,
    );
  }
  return parsed as GitHubPR[];
}
