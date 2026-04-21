import type { GitHubGoalIssue, RepoRef } from "../config/types.js";
import { CliError } from "../config/types.js";
import { gh } from "./client.js";

export async function fetchGoalIssues(repo: RepoRef): Promise<GitHubGoalIssue[]> {
  const json = await gh([
    "issue",
    "list",
    "-R",
    `${repo.owner}/${repo.repo}`,
    "--state",
    "open",
    "--label",
    "hivemoot:goal",
    "--json",
    "number,title,body,labels,assignees,author,comments,createdAt,updatedAt,url",
    "--limit",
    "50",
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CliError(
      "Failed to parse goal issues response from gh CLI",
      "GH_ERROR",
      1,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CliError(
      "Unexpected goal issues response format from gh CLI",
      "GH_ERROR",
      1,
    );
  }
  return parsed as GitHubGoalIssue[];
}

export function parseGoalProgress(body: string): { total: number; complete: number } {
  let total = 0;
  let complete = 0;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (/^- \[x\]/i.test(trimmed)) {
      total++;
      complete++;
    } else if (/^- \[ \]/.test(trimmed)) {
      total++;
    }
  }
  return { total, complete };
}
