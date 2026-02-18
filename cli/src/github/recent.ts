import type { RepoRef } from "../config/types.js";
import { CliError, type RecentClosedItem } from "../config/types.js";
import { gh } from "./client.js";

interface RawIssue {
  number: number;
  title: string;
  url: string;
  labels: Array<{ name: string }>;
  closedAt: string;
}

interface RawPR {
  number: number;
  title: string;
  url: string;
  labels: Array<{ name: string }>;
  mergedAt: string | null;
  closedAt: string;
}

function parseArray<T>(json: string, parseError: string, formatError: string): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CliError(parseError, "GH_ERROR", 1);
  }
  if (!Array.isArray(parsed)) {
    throw new CliError(formatError, "GH_ERROR", 1);
  }
  return parsed as T[];
}

function isRejected(labels: Array<{ name: string }>): boolean {
  return labels.some((label) => {
    const normalized = label.name.toLowerCase();
    return normalized === "rejected" || normalized === "hivemoot:rejected";
  });
}

export async function fetchRecentClosedByAuthor(
  repo: RepoRef,
  author: string,
  now: Date,
  maxItems = 10,
  lookbackDays = 7,
): Promise<RecentClosedItem[]> {
  const fetchLimit = Math.max(maxItems * 5, 100);
  const cutoffMs = now.getTime() - lookbackDays * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);
  const searchQuery = `closed:>=${cutoffDate} sort:updated-desc`;

  const [issuesJson, prsJson] = await Promise.all([
    gh([
      "issue",
      "list",
      "-R",
      `${repo.owner}/${repo.repo}`,
      "--author",
      author,
      "--state",
      "closed",
      "--search",
      searchQuery,
      "--json",
      "number,title,url,labels,closedAt",
      "--limit",
      String(fetchLimit),
    ]),
    gh([
      "pr",
      "list",
      "-R",
      `${repo.owner}/${repo.repo}`,
      "--author",
      author,
      "--state",
      "closed",
      "--search",
      searchQuery,
      "--json",
      "number,title,url,labels,state,mergedAt,closedAt",
      "--limit",
      String(fetchLimit),
    ]),
  ]);

  const issues = parseArray<RawIssue>(
    issuesJson,
    "Failed to parse closed issues response from gh CLI",
    "Unexpected closed issues response format from gh CLI",
  );
  const prs = parseArray<RawPR>(
    prsJson,
    "Failed to parse closed pull requests response from gh CLI",
    "Unexpected closed pull requests response format from gh CLI",
  );

  const issueItems: RecentClosedItem[] = issues
    .filter((issue) => issue.closedAt)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      itemType: "issue" as const,
      outcome: isRejected(issue.labels) ? "rejected" : "closed",
      closedAt: issue.closedAt,
    }));

  const prItems: RecentClosedItem[] = prs
    .filter((pr) => pr.closedAt)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      itemType: "pr" as const,
      outcome: pr.mergedAt ? "merged" : isRejected(pr.labels) ? "rejected" : "closed",
      closedAt: pr.closedAt,
    }));

  return [...issueItems, ...prItems]
    .filter((item) => Date.parse(item.closedAt) >= cutoffMs)
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))
    .slice(0, maxItems);
}
