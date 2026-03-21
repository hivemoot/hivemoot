/**
 * PR Operations
 *
 * Pull request-specific operations for the governance workflow.
 * Follows the same pattern as IssueOperations for consistency.
 */

import type { PRRef } from "./types.js";
import { validateClient, PR_CLIENT_CHECKS } from "./client-validation.js";
import { isNotificationComment } from "./bot-comments.js";
import { LABELS, isLabelMatch, getLabelQueryAliases } from "../config.js";
import { getErrorStatus } from "./github-client.js";

/**
 * Minimal GitHub client interface for PR operations.
 * Both Probot's octokit and @octokit/rest satisfy this interface.
 */
export interface PRClient {
  rest: {
    pulls: {
      get: (params: {
        owner: string;
        repo: string;
        pull_number: number;
      }) => Promise<{
        data: {
          number: number;
          node_id: string;
          state: string;
          merged: boolean;
          created_at: string;
          updated_at: string;
          user: { login: string } | null;
          head: { sha: string };
          draft?: boolean;
          mergeable: boolean | null;
        };
      }>;

      update: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        state?: "open" | "closed";
      }) => Promise<unknown>;

      listReviews: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }) => Promise<{
        data: Array<{
          state: string;
          user: { login: string } | null;
          submitted_at: string;
        }>;
      }>;

      listCommits: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }) => Promise<{
        data: Array<{
          sha: string;
          commit: { committer: { date: string } | null };
        }>;
      }>;

      listReviewComments: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }) => Promise<{
        data: Array<{
          id: number;
          created_at: string;
        }>;
      }>;

      listFiles: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }) => Promise<{
        data: Array<{
          filename: string;
          additions: number;
          deletions: number;
          changes: number;
          status: string;
        }>;
      }>;
    };
    issues: {
      get: (params: {
        owner: string;
        repo: string;
        issue_number: number;
      }) => Promise<{
        data: {
          labels: Array<{ name: string }>;
        };
      }>;
      addLabels: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        labels: string[];
      }) => Promise<unknown>;

      removeLabel: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        name: string;
      }) => Promise<unknown>;

      createComment: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<unknown>;

      listForRepo: (params: {
        owner: string;
        repo: string;
        state?: "open" | "closed" | "all";
        labels?: string;
        per_page?: number;
        page?: number;
      }) => Promise<{
        data: Array<{
          number: number;
          pull_request?: unknown;
          created_at: string;
          updated_at: string;
          labels: Array<{ name: string }>;
        }>;
      }>;

      listComments: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
      }) => Promise<{
        data: Array<{
          id: number;
          body?: string;
          created_at: string;
          performed_via_github_app?: { id: number } | null;
        }>;
      }>;
    };
    checks: {
      listForRef: (params: {
        owner: string;
        repo: string;
        ref: string;
        per_page?: number;
        page?: number;
      }) => Promise<{
        data: {
          total_count: number;
          check_runs: Array<{
            id: number;
            name?: string;
            status: string;
            conclusion: string | null;
          }>;
        };
      }>;
    };
    repos: {
      getCombinedStatusForRef: (params: {
        owner: string;
        repo: string;
        ref: string;
      }) => Promise<{
        data: {
          state: string;
          total_count: number;
          statuses: Array<{
            state: string;
            context: string;
          }>;
        };
      }>;
    };
  };
}

/**
 * Validate that an object has the expected structure of a PRClient.
 * Uses shared validation utilities to reduce code duplication.
 */
function isValidPRClient(obj: unknown): obj is PRClient {
  return validateClient(obj, PR_CLIENT_CHECKS);
}

/**
 * Configuration for PROperations.
 */
export interface PROperationsConfig {
  /** GitHub App ID, used to filter out bot's own comments when calculating staleness */
  appId: number;
}

/**
 * Create PROperations from any Octokit-like client.
 *
 * @param octokit - Octokit-like client with rest.pulls and rest.issues methods
 * @param config - Configuration including appId for bot comment filtering
 * @throws Error if the provided object doesn't have the required structure
 */
export function createPROperations(
  octokit: unknown,
  config: PROperationsConfig
): PROperations {
  if (!isValidPRClient(octokit)) {
    throw new Error(
      "Invalid GitHub client: expected an Octokit-like object with rest.pulls and rest.issues methods"
    );
  }
  return new PROperations(octokit, config.appId);
}

/**
 * PR operations - reusable across webhooks and scripts
 */
export class PROperations {
  constructor(
    private client: PRClient,
    private appId: number
  ) {}

  /**
   * Get PR details
   */
  async get(ref: PRRef): Promise<{
    number: number;
    nodeId: string;
    state: string;
    merged: boolean;
    createdAt: Date;
    updatedAt: Date;
    author: string;
    headSha: string;
    draft: boolean;
    mergeable: boolean | null;
  }> {
    const { data } = await this.client.rest.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.prNumber,
    });

    return {
      number: data.number,
      nodeId: data.node_id,
      state: data.state,
      merged: data.merged,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at),
      author: data.user?.login ?? "unknown",
      headSha: data.head.sha,
      draft: data.draft ?? false,
      mergeable: data.mergeable,
    };
  }

  /**
   * Close a PR
   */
  async close(ref: PRRef): Promise<void> {
    await this.client.rest.pulls.update({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.prNumber,
      state: "closed",
    });
  }

  /**
   * Add labels to a PR (uses issues API)
   */
  async addLabels(ref: PRRef, labels: string[]): Promise<void> {
    await this.client.rest.issues.addLabels({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.prNumber,
      labels,
    });
  }

  /**
   * Remove a label from a PR (uses issues API)
   */
  async removeLabel(ref: PRRef, label: string): Promise<void> {
    try {
      await this.client.rest.issues.removeLabel({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.prNumber,
        name: label,
      });
    } catch (error) {
      // Label might not exist - ignore 404 errors
      if (getErrorStatus(error) !== 404) {
        throw error;
      }
    }
  }

  /**
   * Remove all transient governance labels from a PR.
   * Safe to call on PRs that don't have these labels — removeLabel handles 404s.
   */
  async removeGovernanceLabels(ref: PRRef): Promise<void> {
    await this.removeLabel(ref, LABELS.IMPLEMENTATION);
    await this.removeLabel(ref, LABELS.MERGE_READY);
    await this.removeLabel(ref, LABELS.SQUASH_QUEUED);
    await this.removeLabel(ref, LABELS.AUTOMERGE);
  }

  /**
   * Post a comment on a PR (uses issues API)
   */
  async comment(ref: PRRef, body: string): Promise<void> {
    await this.client.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.prNumber,
      body,
    });
  }

  /**
   * Get label names for a PR.
   */
  async getLabels(ref: PRRef): Promise<string[]> {
    const { data } = await this.client.rest.issues.get({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.prNumber,
    });

    return data.labels.map((label) => label.name);
  }

  /**
   * Check if PR has a specific label (supports legacy label names)
   */
  hasLabel(pr: { labels: Array<{ name: string }> }, labelName: string): boolean {
    return pr.labels.some((label) => isLabelMatch(label.name, labelName));
  }

  /**
   * Find all open PRs with a specific label in a repository.
   * Queries both canonical and legacy label names to catch entities
   * carrying either old or new labels. Returns only actual PRs (not issues).
   */
  async findPRsWithLabel(
    owner: string,
    repo: string,
    labelName: string
  ): Promise<
    Array<{
      number: number;
      createdAt: Date;
      updatedAt: Date;
      labels: Array<{ name: string }>;
    }>
  > {
    const seen = new Set<number>();
    const allPRs: Array<{
      number: number;
      createdAt: Date;
      updatedAt: Date;
      labels: Array<{ name: string }>;
    }> = [];

    for (const alias of getLabelQueryAliases(labelName)) {
      let page = 1;
      const perPage = 100;

      while (true) {
        const { data } = await this.client.rest.issues.listForRepo({
          owner,
          repo,
          state: "open",
          labels: alias,
          per_page: perPage,
          page,
        });

        if (data.length === 0) break;

        for (const item of data) {
          if (item.pull_request !== undefined && !seen.has(item.number)) {
            seen.add(item.number);
            allPRs.push({
              number: item.number,
              createdAt: new Date(item.created_at),
              updatedAt: new Date(item.updated_at),
              labels: item.labels,
            });
          }
        }

        if (data.length < perPage) break;
        page++;
      }
    }

    return allPRs;
  }

  /**
   * Get the date of the latest activity on a PR (any source).
   *
   * Checks all activity types: issue comments, commits, reviews, and review comments.
   * Used for staleness detection where any engagement keeps the PR alive.
   * Filters out comments made by our own GitHub App (identified by appId).
   *
   * @param ref - PR reference
   * @param prCreatedAt - Fallback date when no activity is found
   * @returns Date of most recent activity across all sources
   */
  async getLatestActivityDate(ref: PRRef, prCreatedAt: Date): Promise<Date> {
    // Check all activity sources in parallel for performance
    const [commentDate, commitDate, reviewDate, reviewCommentDate] = await Promise.all([
      this.getLatestIssueCommentDate(ref, prCreatedAt),
      this.getLatestCommitDate(ref, prCreatedAt),
      this.getLatestReviewDate(ref, prCreatedAt),
      this.getLatestReviewCommentDate(ref, prCreatedAt),
    ]);

    // Return the most recent activity across all sources
    return new Date(Math.max(
      commentDate.getTime(),
      commitDate.getTime(),
      reviewDate.getTime(),
      reviewCommentDate.getTime()
    ));
  }

  /**
   * Get the date of the latest author-side activity on a PR.
   *
   * Author activity = commits + issue comments. Reviews and review comments
   * are excluded because they represent reviewer engagement, not author work.
   * Used by the anti-gaming guard to verify the PR author pushed real work
   * after the linked issue was approved for implementation.
   */
  async getLatestAuthorActivityDate(ref: PRRef, prCreatedAt: Date): Promise<Date> {
    const [commentDate, commitDate] = await Promise.all([
      this.getLatestIssueCommentDate(ref, prCreatedAt),
      this.getLatestCommitDate(ref, prCreatedAt),
    ]);

    return new Date(Math.max(
      prCreatedAt.getTime(),
      commentDate.getTime(),
      commitDate.getTime()
    ));
  }

  /**
   * Generic paginated date finder.
   * Iterates through paginated API results and returns the latest date found.
   */
  private async findLatestDatePaginated<T>(
    fetchPage: (page: number, perPage: number) => Promise<{ data: T[] }>,
    extractDate: (item: T) => Date | null,
    fallback: Date
  ): Promise<Date> {
    let latestDate = fallback;
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data } = await fetchPage(page, perPage);
      if (data.length === 0) break;

      for (const item of data) {
        const date = extractDate(item);
        if (date && date > latestDate) latestDate = date;
      }

      if (data.length < perPage) break;
      page++;
    }

    return latestDate;
  }

  /**
   * Get the latest issue comment date, excluding our own bot's comments.
   */
  private async getLatestIssueCommentDate(ref: PRRef, fallback: Date): Promise<Date> {
    return this.findLatestDatePaginated(
      (page, perPage) =>
        this.client.rest.issues.listComments({
          owner: ref.owner,
          repo: ref.repo,
          issue_number: ref.prNumber,
          per_page: perPage,
          page,
        }),
      (comment) => {
        if (comment.performed_via_github_app?.id === this.appId) return null;
        return new Date(comment.created_at);
      },
      fallback
    );
  }

  /**
   * Get the latest commit date on the PR.
   */
  private async getLatestCommitDate(ref: PRRef, fallback: Date): Promise<Date> {
    return this.findLatestDatePaginated(
      (page, perPage) =>
        this.client.rest.pulls.listCommits({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.prNumber,
          per_page: perPage,
          page,
        }),
      (commit) => {
        const dateStr = commit.commit.committer?.date;
        return dateStr ? new Date(dateStr) : null;
      },
      fallback
    );
  }

  /**
   * Get the latest review date on the PR.
   */
  private async getLatestReviewDate(ref: PRRef, fallback: Date): Promise<Date> {
    return this.findLatestDatePaginated(
      (page, perPage) =>
        this.client.rest.pulls.listReviews({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.prNumber,
          per_page: perPage,
          page,
        }),
      (review) => new Date(review.submitted_at),
      fallback
    );
  }

  /**
   * Get the latest review comment (inline code comment) date on the PR.
   */
  private async getLatestReviewCommentDate(ref: PRRef, fallback: Date): Promise<Date> {
    return this.findLatestDatePaginated(
      (page, perPage) =>
        this.client.rest.pulls.listReviewComments({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.prNumber,
          per_page: perPage,
          page,
        }),
      (comment) => new Date(comment.created_at),
      fallback
    );
  }

  /**
   * List files changed in a PR with pagination and early exit.
   * Fetches up to maxPages pages (100 files each). Stops early once
   * the accumulated file count exceeds earlyExitThreshold, since the
   * caller only needs to know "too many files" not the exact list.
   */
  async listFiles(
    ref: PRRef,
    opts?: { maxPages?: number; earlyExitThreshold?: number }
  ): Promise<Array<{ filename: string; additions: number; deletions: number; changes: number; status: string; previous_filename?: string }>> {
    const maxPages = opts?.maxPages ?? 3;
    const threshold = opts?.earlyExitThreshold;
    const allFiles: Array<{ filename: string; additions: number; deletions: number; changes: number; status: string; previous_filename?: string }> = [];
    const perPage = 100;

    for (let page = 1; page <= maxPages; page++) {
      const { data } = await this.client.rest.pulls.listFiles({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.prNumber,
        per_page: perPage,
        page,
      });

      if (data.length === 0) break;
      allFiles.push(...data);

      // Early exit when we know the PR exceeds the threshold
      if (threshold !== undefined && allFiles.length > threshold) break;
      if (data.length < perPage) break;
    }

    return allFiles;
  }

  /**
   * Get check runs for a given ref (SHA, branch, or tag).
   * Used by merge-readiness to verify CI status.
   */
  async getCheckRunsForRef(
    owner: string,
    repo: string,
    ref: string
  ): Promise<{
    totalCount: number;
    checkRuns: Array<{ id: number; name?: string; status: string; conclusion: string | null }>;
  }> {
    const { data } = await this.client.rest.checks.listForRef({
      owner,
      repo,
      ref,
      per_page: 100,
    });
    return { totalCount: data.total_count, checkRuns: data.check_runs };
  }

  /**
   * Get combined commit status for a given ref (SHA, branch, or tag).
   * Uses the legacy Status API for CI tools that don't use Check Runs.
   */
  async getCombinedStatus(
    owner: string,
    repo: string,
    ref: string
  ): Promise<{
    state: string;
    totalCount: number;
    statuses: Array<{
      state: string;
      context: string;
    }>;
  }> {
    const { data } = await this.client.rest.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref,
    });
    return { state: data.state, totalCount: data.total_count, statuses: data.statuses };
  }

  /**
   * Get the set of users whose most recent decisive review is APPROVED.
   * Uses pagination to handle PRs with >100 reviews.
   *
   * Decisive reviews are: APPROVED, CHANGES_REQUESTED, DISMISSED.
   * COMMENTED reviews don't change approval status.
   */
  async getApproverLogins(ref: PRRef): Promise<Set<string>> {
    const DECISIVE_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

    // Track each user's latest decisive review
    const latestDecisiveReview = new Map<string, { state: string; submittedAt: Date }>();

    let page = 1;
    const perPage = 100;

    while (true) {
      const { data: reviews } = await this.client.rest.pulls.listReviews({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.prNumber,
        per_page: perPage,
        page,
      });

      if (reviews.length === 0) {
        break;
      }

      for (const review of reviews) {
        if (!review.user || !DECISIVE_STATES.has(review.state)) {
          continue;
        }

        const login = review.user.login.toLowerCase();
        const submittedAt = new Date(review.submitted_at);
        const existing = latestDecisiveReview.get(login);

        if (!existing || submittedAt > existing.submittedAt) {
          latestDecisiveReview.set(login, { state: review.state, submittedAt });
        }
      }

      if (reviews.length < perPage) {
        break;
      }

      page++;
    }

    const approvers = new Set<string>();
    for (const [login, { state }] of latestDecisiveReview.entries()) {
      if (state === "APPROVED") {
        approvers.add(login);
      }
    }

    return approvers;
  }

  /**
   * Get approval count for a PR using REST API.
   * Counts users whose most recent decisive review is APPROVED.
   */
  async getApprovalCount(ref: PRRef): Promise<number> {
    const approvers = await this.getApproverLogins(ref);
    return approvers.size;
  }

  /**
   * List all comments on a PR/issue with their bodies.
   * Used by reconciliation scripts to scan comment text for legacy detection.
   */
  async listCommentsWithBody(
    ref: PRRef
  ): Promise<Array<{ id: number; body?: string; performed_via_github_app?: { id: number } | null }>> {
    const allComments: Array<{ id: number; body?: string; performed_via_github_app?: { id: number } | null }> = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data: comments } = await this.client.rest.issues.listComments({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.prNumber,
        per_page: perPage,
        page,
      });

      if (comments.length === 0) break;
      allComments.push(...comments);
      if (comments.length < perPage) break;
      page++;
    }

    return allComments;
  }

  /**
   * Check a pre-fetched comment list for a notification comment.
   * Avoids re-pagination when comments are already loaded.
   */
  hasNotificationCommentInComments(
    comments: Array<{ id: number; body?: string; performed_via_github_app?: { id: number } | null }>,
    notificationType: string,
    issueNumber?: number
  ): boolean {
    for (const comment of comments) {
      if (
        isNotificationComment(
          comment.body,
          this.appId,
          comment.performed_via_github_app?.id ?? null,
          notificationType,
          issueNumber
        )
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a notification comment of a given type already exists on a PR.
   * Iterates paginated comments, calling isNotificationComment() on each.
   * Optionally filter by issueNumber for targeted duplicate detection.
   */
  async hasNotificationComment(
    ref: PRRef,
    notificationType: string,
    issueNumber?: number
  ): Promise<boolean> {
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data: comments } = await this.client.rest.issues.listComments({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.prNumber,
        per_page: perPage,
        page,
      });

      if (comments.length === 0) break;

      for (const comment of comments) {
        if (
          isNotificationComment(
            comment.body,
            this.appId,
            comment.performed_via_github_app?.id ?? null,
            notificationType,
            issueNumber
          )
        ) {
          return true;
        }
      }

      if (comments.length < perPage) break;
      page++;
    }

    return false;
  }
}
