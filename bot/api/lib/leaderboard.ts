/**
 * Implementation Leaderboard
 *
 * Manages the leaderboard comment on issues that shows competing PRs
 * ranked by approval count. Updated when reviews are submitted.
 */

import { SIGNATURE } from "../config.js";
import { SIGNATURES, isLeaderboardComment, buildLeaderboardComment } from "./bot-comments.js";
import type { IssueRef, PRWithApprovals, IssueComment } from "./types.js";
import {
  validateClient,
  hasPaginateIterator,
  LEADERBOARD_CLIENT_CHECKS,
} from "./client-validation.js";

/**
 * Minimal client interface for leaderboard operations.
 */
export interface LeaderboardClient {
  rest: {
    issues: {
      listComments: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
      }) => Promise<{
        data: Array<{
          id: number;
          body?: string;
        }>;
      }>;

      createComment: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<unknown>;

      updateComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }) => Promise<unknown>;
    };
  };
  paginate: {
    iterator: <T>(
      method: unknown,
      params: unknown
    ) => AsyncIterable<{ data: T[] }>;
  };
}

/**
 * Format the leaderboard body for display.
 * Exported for testing.
 */
export function formatLeaderboard(scores: PRWithApprovals[]): string {
  // Sort by approvals descending, then by PR number ascending (older first as tiebreaker)
  const sorted = [...scores].sort((a, b) => {
    if (b.approvals !== a.approvals) {
      return b.approvals - a.approvals;
    }
    return a.number - b.number;
  });

  const rows = sorted.map(
    (s) => `| #${s.number} | @${s.author} | ${s.approvals} |`
  );

  if (scores.length === 0) {
    return `${SIGNATURES.LEADERBOARD}

No linked PRs are eligible for the implementation leaderboard yet.

Next steps:
- Open a PR that links this issue using a closing keyword (e.g., \`Fixes #<issue-number>\` or \`Fixes https://github.com/owner/repo/issues/<issue-number>\`).
- If your PR was opened before the issue became ready to implement, add a new commit (or leave a comment) to activate it for consideration.

| PR | Author | Approvals |
|----|--------|-----------|

Best implementation gets merged.${SIGNATURE}`;
  }

  return `${SIGNATURES.LEADERBOARD}

| PR | Author | Approvals |
|----|--------|-----------|
${rows.join("\n")}

Want your PR to rise to the top? Keep changes high-quality, respond quickly to reviews, and make sure checks pass so it's ready to approve and merge.

Best implementation gets merged.${SIGNATURE}`;
}

/**
 * Validate that an object has the expected structure of a LeaderboardClient.
 * Uses shared validation utilities to reduce code duplication.
 */
function isValidLeaderboardClient(obj: unknown): obj is LeaderboardClient {
  return validateClient(obj, LEADERBOARD_CLIENT_CHECKS) && hasPaginateIterator(obj);
}

/**
 * Configuration for LeaderboardService
 */
export interface LeaderboardServiceConfig {
  appId: number;
}

/**
 * Create LeaderboardService from any Octokit-like client.
 *
 * @param octokit - The GitHub client (Probot's Context.octokit or @octokit/rest)
 * @param config - Configuration including appId for verifying bot-authored comments
 * @throws Error if the provided object doesn't have the required structure
 */
export function createLeaderboardService(
  octokit: unknown,
  config: LeaderboardServiceConfig
): LeaderboardService {
  if (!isValidLeaderboardClient(octokit)) {
    throw new Error(
      "Invalid GitHub client: expected an Octokit-like object with rest.issues methods and paginate.iterator"
    );
  }
  return new LeaderboardService(octokit, config.appId);
}

/**
 * Service for managing implementation leaderboard comments.
 */
export class LeaderboardService {
  constructor(
    private client: LeaderboardClient,
    private appId: number
  ) {}

  /**
   * Find the existing leaderboard comment on an issue.
   * Verifies the comment was created by our GitHub App (prevents spoofing).
   *
   * If multiple leaderboard comments exist, returns the most recent one
   * (by created_at timestamp).
   *
   * NOTE: Unlike voting comments (which use cycle numbers for selection),
   * leaderboard comments don't have cycles - they're simply updated in place.
   * Multiple leaderboard comments only occur due to race conditions or bugs,
   * so we select the most recent one as the authoritative version.
   *
   * Returns the comment ID if found, null otherwise.
   */
  async findLeaderboardCommentId(ref: IssueRef): Promise<number | null> {
    const iterator = this.client.paginate.iterator<IssueComment>(
      this.client.rest.issues.listComments,
      {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        per_page: 100,
      }
    );

    // Collect all matching comments to find the most recent
    const leaderboardComments: Array<{ id: number; createdAt: string }> = [];

    for await (const { data: comments } of iterator) {
      for (const comment of comments) {
        if (isLeaderboardComment(comment.body, this.appId, comment.performed_via_github_app?.id)) {
          leaderboardComments.push({
            id: comment.id,
            createdAt: comment.created_at ?? "",
          });
        }
      }
    }

    if (leaderboardComments.length === 0) {
      return null;
    }

    // Return the most recent leaderboard comment
    leaderboardComments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return leaderboardComments[0].id;
  }

  /**
   * Create or update the leaderboard comment on an issue.
   */
  async upsertLeaderboard(ref: IssueRef, scores: PRWithApprovals[]): Promise<void> {
    const body = buildLeaderboardComment(formatLeaderboard(scores), ref.issueNumber);
    const existingCommentId = await this.findLeaderboardCommentId(ref);

    if (existingCommentId) {
      await this.client.rest.issues.updateComment({
        owner: ref.owner,
        repo: ref.repo,
        comment_id: existingCommentId,
        body,
      });
    } else {
      await this.client.rest.issues.createComment({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        body,
      });
    }
  }
}
