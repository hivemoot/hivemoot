import type { GitHubPR, RepoRef } from "../config/types.js";
import { CliError } from "../config/types.js";
import { gh } from "./client.js";

/**
 * Fetch the latest commit date for each open PR via GraphQL.
 *
 * `gh pr list --json commits` requests the full commits connection, whose
 * `authors` sub-connection blows through GitHub's 500k node budget on repos
 * with many PRs.  Using `commits(last: 1)` avoids this entirely — we only
 * need the most recent commit date per PR.
 *
 * GitHub caps `first` at 100, so we paginate with cursors when limit > 100.
 */
async function fetchLatestCommitDates(
  repo: RepoRef,
  limit: number,
): Promise<Map<number, string>> {
  const query = `
    query($owner: String!, $name: String!, $pageSize: Int!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequests(first: $pageSize, after: $cursor, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number
            commits(last: 1) { nodes { commit { committedDate } } }
          }
        }
      }
    }`;

  const PAGE_SIZE = 100;
  const map = new Map<number, string>();
  let remaining = limit;
  let cursor: string | null = null;

  while (remaining > 0) {
    const pageSize = Math.min(remaining, PAGE_SIZE);
    const args = [
      "api", "graphql",
      "-F", `owner=${repo.owner}`,
      "-F", `name=${repo.repo}`,
      "-F", `pageSize=${pageSize}`,
      "-f", `query=${query}`,
    ];
    if (cursor) {
      args.push("-F", `cursor=${cursor}`);
    } else {
      // gh sends null when the variable is absent, which GraphQL accepts for String?
      args.push("-f", "cursor=");
    }

    const json = await gh(args);
    const data = JSON.parse(json);
    const prs = data?.data?.repository?.pullRequests;
    const nodes: Array<{ number: number; commits: { nodes: Array<{ commit: { committedDate: string } }> } }>
      = prs?.nodes ?? [];

    for (const pr of nodes) {
      const commit = pr.commits.nodes[0];
      if (commit) map.set(pr.number, commit.commit.committedDate);
    }

    remaining -= nodes.length;
    const hasNext = prs?.pageInfo?.hasNextPage === true;
    if (!hasNext || nodes.length === 0) break;
    cursor = prs.pageInfo.endCursor;
  }

  return map;
}

export async function fetchPulls(repo: RepoRef, limit = 200): Promise<GitHubPR[]> {
  // Fetch PR data and latest commit dates in parallel.
  // The main query omits `commits` to stay within GitHub's GraphQL node budget.
  const [listJson, commitDates] = await Promise.all([
    gh([
      "pr", "list",
      "-R", `${repo.owner}/${repo.repo}`,
      "--state", "open",
      "--json", "number,title,state,author,labels,comments,reviews,createdAt,updatedAt,url,isDraft,reviewDecision,mergeable,statusCheckRollup,closingIssuesReferences",
      "--limit", String(limit),
    ]),
    fetchLatestCommitDates(repo, limit),
  ]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(listJson);
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

  // Stitch the latest commit date back into each PR as a single-element array
  // so downstream code (`latestCommitAge`) works unchanged.
  const prs = parsed as GitHubPR[];
  for (const pr of prs) {
    const date = commitDates.get(pr.number);
    pr.commits = date ? [{ committedDate: date }] : [];
  }

  return prs;
}
