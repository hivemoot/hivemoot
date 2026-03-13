import type { RepoRef } from "../config/types.js";
import { CliError } from "../config/types.js";
import { gh } from "./client.js";
import { fetchCurrentUser } from "./user.js";

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export type PrPostReviewCode =
  | "review_posted"
  | "already_reviewed"
  | "dry_run";

export interface PrPostReviewWarning {
  code: string;
  message: string;
}

export interface PrPostReviewResult {
  schemaVersion: 1;
  kind: "pr_review";
  generatedAt: string;
  repo: RepoRef;
  pr: number;
  headSha: string;
  event: ReviewEvent;
  dryRun: boolean;
  code: PrPostReviewCode;
  reviewId?: number;
  reviewUrl?: string;
  warnings: PrPostReviewWarning[];
}

// Terminal review states — COMMENT is non-terminal; DISMISSED counts as a prior
// terminal review that was overridden, so we don't treat it as blocking.
const TERMINAL_STATES = new Set(["APPROVED", "CHANGES_REQUESTED"]);

interface GraphQLReviewNode {
  databaseId: number;
  state: string;
  author: { login: string } | null;
  submittedAt: string;
  commit: { oid: string } | null;
  url: string;
}

interface GraphQLReviewsResponse {
  data: {
    repository: {
      pullRequest: {
        headRefOid: string;
        author: { login: string } | null;
        reviews: {
          pageInfo: {
            hasNextPage: boolean;
            endCursor: string | null;
          };
          nodes: GraphQLReviewNode[];
        };
      } | null;
    } | null;
  } | null;
}

const PR_REVIEWS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      author { login }
      reviews(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          databaseId
          state
          author { login }
          submittedAt
          commit { oid }
          url
        }
      }
    }
  }
}`;

interface GitHubReviewResponse {
  id: number;
  html_url: string;
}

async function fetchPrReviewContext(
  repo: RepoRef,
  prNumber: number,
): Promise<{
  headSha: string;
  prAuthorLogin: string | null;
  userTerminalReviewAtHead: GraphQLReviewNode | undefined;
}> {
  let headSha: string | undefined;
  let prAuthorLogin: string | null = null;
  const currentUser = await fetchCurrentUser();
  let cursor: string | null = null;
  let userTerminalReviewAtHead: GraphQLReviewNode | undefined;

  while (true) {
    const args = [
      "api", "graphql",
      "-f", `query=${PR_REVIEWS_QUERY}`,
      "-F", `owner=${repo.owner}`,
      "-F", `repo=${repo.repo}`,
      "-F", `number=${prNumber}`,
    ];
    if (cursor) {
      args.push("-F", `cursor=${cursor}`);
    } else {
      args.push("-f", "cursor=");
    }

    const raw = await gh(args);
    const response: GraphQLReviewsResponse = JSON.parse(raw);
    const pr = response.data?.repository?.pullRequest;

    if (!pr) {
      throw new CliError(
        `Pull request #${prNumber} not found in ${repo.owner}/${repo.repo}`,
        "GH_ERROR",
        1,
      );
    }

    if (!headSha) {
      headSha = pr.headRefOid;
      prAuthorLogin = pr.author?.login ?? null;
    }

    for (const review of pr.reviews.nodes) {
      const reviewerLogin = review.author?.login ?? "";
      if (reviewerLogin === currentUser && TERMINAL_STATES.has(review.state)) {
        if (review.commit?.oid === headSha) {
          userTerminalReviewAtHead = review;
        }
      }
    }

    if (!pr.reviews.pageInfo.hasNextPage) break;
    cursor = pr.reviews.pageInfo.endCursor;
    if (!cursor) break;
  }

  return { headSha: headSha!, prAuthorLogin, userTerminalReviewAtHead };
}

export async function postPrReview(
  repo: RepoRef,
  prNumber: number,
  event: ReviewEvent,
  body: string,
  dryRun: boolean,
): Promise<PrPostReviewResult> {
  const generatedAt = new Date().toISOString();
  const warnings: PrPostReviewWarning[] = [];

  const currentUser = await fetchCurrentUser();
  const { headSha, prAuthorLogin, userTerminalReviewAtHead } =
    await fetchPrReviewContext(repo, prNumber);

  // Idempotency gate: terminal review already exists at current HEAD SHA
  if (userTerminalReviewAtHead) {
    return {
      schemaVersion: 1,
      kind: "pr_review",
      generatedAt,
      repo,
      pr: prNumber,
      headSha,
      event,
      dryRun,
      code: "already_reviewed",
      warnings: [
        {
          code: "already_reviewed",
          message: `Already submitted ${userTerminalReviewAtHead.state} review at ${headSha.slice(0, 7)}. Skipping duplicate submission.`,
        },
      ],
    };
  }

  // Warn if reviewing own PR (GitHub will reject this, but warn upfront)
  if (prAuthorLogin && prAuthorLogin === currentUser) {
    warnings.push({
      code: "own_pr",
      message: `PR #${prNumber} was authored by ${currentUser}. GitHub does not allow reviewing your own PR — this request will fail.`,
    });
  }

  if (dryRun) {
    return {
      schemaVersion: 1,
      kind: "pr_review",
      generatedAt,
      repo,
      pr: prNumber,
      headSha,
      event,
      dryRun: true,
      code: "dry_run",
      warnings,
    };
  }

  const raw = await gh([
    "api",
    "-X", "POST",
    `/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/reviews`,
    "--raw-field", `event=${event}`,
    "--raw-field", `body=${body}`,
    "--raw-field", `commit_id=${headSha}`,
  ]);

  let parsed: GitHubReviewResponse;
  try {
    parsed = JSON.parse(raw) as GitHubReviewResponse;
  } catch {
    throw new CliError(
      "Failed to parse GitHub API response for posted review",
      "GH_ERROR",
      1,
    );
  }

  if (typeof parsed.id !== "number" || typeof parsed.html_url !== "string") {
    throw new CliError(
      "Unexpected GitHub API response shape for posted review",
      "GH_ERROR",
      1,
    );
  }

  return {
    schemaVersion: 1,
    kind: "pr_review",
    generatedAt,
    repo,
    pr: prNumber,
    headSha,
    event,
    dryRun: false,
    code: "review_posted",
    reviewId: parsed.id,
    reviewUrl: parsed.html_url,
    warnings,
  };
}
