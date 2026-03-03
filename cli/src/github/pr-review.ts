import { CliError, type RepoRef } from "../config/types.js";
import { gh } from "./client.js";
import { fetchCurrentUser } from "./user.js";

export type ReviewEvent = "approve" | "comment" | "request-changes";

export type PrReviewCode =
  | "review_submitted"
  | "already_reviewed";

export interface PrReviewResult {
  schemaVersion: 1;
  kind: "pr_review";
  generatedAt: string;
  repo: RepoRef;
  pr: number;
  headSha: string;
  event: ReviewEvent;
  dryRun: boolean;
  code: PrReviewCode;
  reviewUrl?: string;
  priorState?: string;
  warnings: Array<{ code: string; message: string }>;
}

const EVENT_TO_API: Record<ReviewEvent, string> = {
  "approve": "APPROVE",
  "comment": "COMMENT",
  "request-changes": "REQUEST_CHANGES",
};

const TERMINAL_STATES = new Set(["APPROVED", "CHANGES_REQUESTED"]);

interface PrBasicInfo {
  number: number;
  headRefOid: string;
  author: { login: string } | null;
}

interface RestReview {
  id: number;
  user: { login: string } | null;
  state: string;
  commit_id: string;
  html_url: string;
}

async function fetchPrBasicInfo(repo: RepoRef, prRef: string): Promise<PrBasicInfo> {
  const raw = await gh([
    "pr", "view", prRef,
    "-R", `${repo.owner}/${repo.repo}`,
    "--json", "number,headRefOid,author",
  ]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(
      "Failed to parse pull request info from gh CLI.",
      "GH_ERROR",
      1,
    );
  }

  const pr = parsed as PrBasicInfo;
  if (typeof pr.number !== "number" || typeof pr.headRefOid !== "string") {
    throw new CliError(
      `Could not resolve pull request "${prRef}" in ${repo.owner}/${repo.repo}.`,
      "GH_NOT_FOUND",
      1,
    );
  }

  return pr;
}

async function fetchAllReviews(repo: RepoRef, prNumber: number): Promise<RestReview[]> {
  // Use --paginate to handle PRs with many reviews (>30 default page size).
  const raw = await gh([
    "api",
    "--paginate",
    `repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/reviews`,
  ]);

  // --paginate concatenates JSON arrays, resulting in a valid JSON array.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];
  return parsed as RestReview[];
}

function findTerminalReviewAtSha(
  reviews: RestReview[],
  userLogin: string,
  headSha: string,
): RestReview | undefined {
  // Scan in reverse (newest first) — last submitted state at the target SHA wins.
  for (let i = reviews.length - 1; i >= 0; i--) {
    const r = reviews[i];
    if (
      r.user?.login === userLogin &&
      r.commit_id === headSha &&
      TERMINAL_STATES.has(r.state)
    ) {
      return r;
    }
  }
  return undefined;
}

async function submitReview(
  repo: RepoRef,
  prNumber: number,
  event: ReviewEvent,
  body: string,
): Promise<{ html_url: string }> {
  const raw = await gh([
    "api",
    "-X", "POST",
    `repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/reviews`,
    "--field", `event=${EVENT_TO_API[event]}`,
    "--field", `body=${body}`,
  ]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(
      "Failed to parse review submission response from GitHub API.",
      "GH_ERROR",
      1,
    );
  }

  const result = parsed as { html_url?: string };
  if (typeof result.html_url !== "string") {
    throw new CliError(
      "Review submission succeeded but response did not include html_url.",
      "GH_ERROR",
      1,
    );
  }
  return { html_url: result.html_url };
}

export async function buildPrReviewResult(
  repo: RepoRef,
  prRef: string,
  event: ReviewEvent,
  body: string,
  dryRun: boolean,
): Promise<PrReviewResult> {
  const generatedAt = new Date().toISOString();

  const [prInfo, currentUser] = await Promise.all([
    fetchPrBasicInfo(repo, prRef),
    fetchCurrentUser(),
  ]);

  const { number: prNumber, headRefOid: headSha } = prInfo;
  const warnings: Array<{ code: string; message: string }> = [];

  // Warn if trying to review your own PR — GitHub will reject the API call.
  if (prInfo.author?.login === currentUser) {
    warnings.push({
      code: "own_pr",
      message: "You are the PR author. GitHub does not allow submitting reviews on your own PRs.",
    });
  }

  // Idempotency gate: check for an existing terminal review at the current HEAD SHA.
  const reviews = await fetchAllReviews(repo, prNumber);
  const priorReview = findTerminalReviewAtSha(reviews, currentUser, headSha);

  if (priorReview) {
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
      priorState: priorReview.state,
      warnings,
    };
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
      dryRun,
      code: "review_submitted",
      warnings,
    };
  }

  const submitted = await submitReview(repo, prNumber, event, body);

  return {
    schemaVersion: 1,
    kind: "pr_review",
    generatedAt,
    repo,
    pr: prNumber,
    headSha,
    event,
    dryRun,
    code: "review_submitted",
    reviewUrl: submitted.html_url,
    warnings,
  };
}
