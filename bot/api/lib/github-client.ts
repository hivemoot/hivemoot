/**
 * GitHub API Client Abstraction
 *
 * Provides a unified interface for GitHub operations that works with both:
 * - Probot's Context.octokit (webhook handlers)
 * - @octokit/rest instances (scheduled scripts)
 *
 * This abstraction enables code reuse and testability.
 */

import {
  parseMetadata,
  isVotingComment,
  isAlignmentComment,
  isHumanHelpComment,
  isNotificationComment,
  isWelcomeComment,
  selectCurrentVotingComment,
  type VotingCommentInfo,
} from "./bot-comments.js";
import type { DiscussionComment, IssueContext } from "./llm/types.js";
import type { IssueRef, VoteCounts, ValidatedVoteResult, TimelineEvent, LockReason, IssueComment } from "./types.js";
import {
  validateClient,
  hasPaginateIterator,
  ISSUE_CLIENT_CHECKS,
} from "./client-validation.js";
import { LEGACY_LABEL_MAP, isLabelMatch } from "../config.js";
import { logger } from "./logger.js";

// Re-export IssueComment for backwards compatibility
export type { IssueComment } from "./types.js";

/**
 * Extract the HTTP status code from an unknown error object.
 * Returns null for non-objects, null values, or objects without a numeric status field.
 */
export function getErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/**
 * Reaction data structure from GitHub API
 */
export interface Reaction {
  content: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";
  user?: { login: string } | null;
}

/**
 * Minimal GitHub client interface for governance operations.
 * Both Probot's octokit and @octokit/rest satisfy this interface.
 */
/**
 * Extended issue comment with author info for summarization.
 */
export interface IssueCommentWithAuthor extends IssueComment {
  user?: { login: string; type?: string } | null;
  created_at?: string;
  reactions?: { "+1"?: number; "-1"?: number };
}

/**
 * Issue data returned from GitHub API.
 */
export interface IssueData {
  title: string;
  body?: string | null;
  user?: { login: string } | null;
  reactions?: { "+1": number; "-1": number; confused: number; eyes?: number };
  labels?: Array<string | { name?: string }>;
}

export interface GitHubClient {
  rest: {
    issues: {
      get: (params: {
        owner: string;
        repo: string;
        issue_number: number;
      }) => Promise<{ data: IssueData }>;

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

      update: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        state?: string;
        state_reason?: string;
      }) => Promise<unknown>;

      listEventsForTimeline: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
      }) => Promise<{ data: TimelineEvent[] }>;

      listComments: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
      }) => Promise<{ data: IssueCommentWithAuthor[] }>;

      lock: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        lock_reason?: LockReason;
      }) => Promise<unknown>;

      unlock: (params: {
        owner: string;
        repo: string;
        issue_number: number;
      }) => Promise<unknown>;
    };
    reactions: {
      listForIssueComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
        per_page?: number;
      }) => Promise<{ data: Reaction[] }>;
      listForIssue: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
      }) => Promise<{ data: Reaction[] }>;
    };
  };
  paginate: {
    iterator: <T>(
      method: unknown,
      params: unknown
    ) => AsyncIterable<{ data: T[] }>;
  };
  request: (
    route: string,
    params?: Record<string, unknown>
  ) => Promise<unknown>;
}

/**
 * Validate that an object has the expected structure of a GitHubClient.
 * Uses shared validation utilities to reduce code duplication.
 */
function isValidGitHubClient(obj: unknown): obj is GitHubClient {
  return validateClient(obj, ISSUE_CLIENT_CHECKS) && hasPaginateIterator(obj);
}

/**
 * Configuration for IssueOperations
 */
export interface IssueOperationsConfig {
  appId: number;
}

/**
 * Create IssueOperations from any Octokit-like client.
 *
 * This factory function handles the type coercion between different
 * Octokit implementations (Probot's Context.octokit, @octokit/rest, etc.)
 * in a single place, avoiding ugly `as unknown as GitHubClient` casts
 * throughout the codebase.
 *
 * @param octokit - The GitHub client (Probot's Context.octokit or @octokit/rest)
 * @param config - Configuration including appId for verifying bot-authored comments
 * @throws Error if the provided object doesn't have the required structure
 */
export function createIssueOperations(
  octokit: unknown,
  config: IssueOperationsConfig
): IssueOperations {
  if (!isValidGitHubClient(octokit)) {
    throw new Error(
      "Invalid GitHub client: expected an Octokit-like object with rest.issues methods and paginate.iterator"
    );
  }
  return new IssueOperations(octokit, config.appId);
}

function toReactionCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Issue operations - reusable across webhooks and scripts
 */
export class IssueOperations {
  constructor(
    private client: GitHubClient,
    private appId: number
  ) {}

  /**
   * Add labels to an issue
   */
  async addLabels(ref: IssueRef, labels: string[]): Promise<void> {
    await this.client.rest.issues.addLabels({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issueNumber,
      labels,
    });
  }

  /**
   * Remove a label from an issue.
   *
   * On 404 (canonical name not found), falls back to removing legacy aliases
   * that map to the same canonical label. This prevents dual label accumulation
   * during the transition period where issues may carry old label names.
   */
  async removeLabel(ref: IssueRef, label: string): Promise<void> {
    try {
      await this.client.rest.issues.removeLabel({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        name: label,
      });
    } catch (error) {
      if (getErrorStatus(error) !== 404) {
        throw error;
      }
      // Canonical not found — try legacy aliases
      for (const [legacy, canonical] of Object.entries(LEGACY_LABEL_MAP)) {
        if (canonical === label) {
          try {
            await this.client.rest.issues.removeLabel({
              owner: ref.owner,
              repo: ref.repo,
              issue_number: ref.issueNumber,
              name: legacy,
            });
            return;
          } catch (e) {
            if (getErrorStatus(e) !== 404) throw e;
          }
        }
      }
    }
  }

  /**
   * Post a comment on an issue
   */
  async comment(ref: IssueRef, body: string): Promise<void> {
    await this.client.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issueNumber,
      body,
    });
  }

  /**
   * Close an issue
   */
  async close(ref: IssueRef, reason: "completed" | "not_planned" = "not_planned"): Promise<void> {
    await this.client.rest.issues.update({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issueNumber,
      state: "closed",
      state_reason: reason,
    });
  }

  /**
   * Lock an issue to prevent further comments
   */
  async lock(ref: IssueRef, reason: LockReason = "resolved"): Promise<void> {
    await this.client.rest.issues.lock({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issueNumber,
      lock_reason: reason,
    });
  }

  /**
   * Unlock an issue to allow further comments.
   * Tolerates "not locked" errors (422) for idempotent behavior.
   */
  async unlock(ref: IssueRef): Promise<void> {
    try {
      await this.client.rest.issues.unlock({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
      });
    } catch (error) {
      // Issue might not be locked - ignore 422 errors
      // This makes unlock idempotent (safe to call regardless of lock state)
      if (getErrorStatus(error) !== 422) {
        throw error;
      }
    }
  }

  /**
   * Pin a comment on an issue.
   *
   * Uses octokit.request() directly because the pin endpoint is not yet included
   * in @octokit/plugin-rest-endpoint-methods' named methods.
   *
   * Pinning is a UX enhancement only — callers wrap this in try/catch so that
   * API failures (permission denied, endpoint unavailable) never interrupt the
   * governance flow.
   */
  async pinComment(ref: IssueRef, commentId: number): Promise<void> {
    await this.client.request(
      "PUT /repos/{owner}/{repo}/issues/comments/{comment_id}/pin",
      { owner: ref.owner, repo: ref.repo, comment_id: commentId }
    );
  }

  /**
   * Get vote counts from issue reactions.
   * Uses defensive null checking with explicit 0 fallback for all reaction counts.
   */
  async getVoteCounts(ref: IssueRef): Promise<VoteCounts> {
    const { data: issue } = await this.client.rest.issues.get({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issueNumber,
    });

    // Defensive null checking - API may return malformed response
    const reactions = issue.reactions as
      | { "+1"?: number; "-1"?: number; confused?: number; eyes?: number }
      | undefined;
    return {
      thumbsUp: toReactionCount(reactions?.["+1"]),
      thumbsDown: toReactionCount(reactions?.["-1"]),
      confused: toReactionCount(reactions?.confused),
      eyes: toReactionCount(reactions?.eyes),
    };
  }

  /**
   * Find the voting comment on an issue using metadata type detection
   * AND verifying it was created by our GitHub App (prevents spoofing).
   *
   * When multiple voting comments exist (e.g., after needs-more-discussion
   * returns the issue to voting), returns the one with the highest cycle number.
   *
   * Returns the comment ID if found, null otherwise.
   * Uses pagination to handle issues with >100 comments.
   */
  async findVotingCommentId(ref: IssueRef): Promise<number | null> {
    const iterator = this.client.paginate.iterator<IssueComment>(
      this.client.rest.issues.listComments,
      {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        per_page: 100,
      }
    );

    const votingComments: VotingCommentInfo[] = [];

    for await (const { data: comments } of iterator) {
      for (const comment of comments) {
        if (isVotingComment(comment.body, this.appId, comment.performed_via_github_app?.id)) {
          const metadata = parseMetadata(comment.body);
          votingComments.push({
            id: comment.id,
            // Explicit null coalescing handles legacy comments where cycle may be undefined
            cycle: metadata?.type === "voting" ? (metadata.cycle ?? null) : null,
            createdAt: comment.created_at ?? "",
          });
        }
      }
    }

    const selected = selectCurrentVotingComment(votingComments);
    return selected?.id ?? null;
  }

  /**
   * Count the number of voting comments on an issue.
   * Used to determine the next cycle number when creating a new voting comment.
   */
  async countVotingComments(ref: IssueRef): Promise<number> {
    const iterator = this.client.paginate.iterator<IssueComment>(
      this.client.rest.issues.listComments,
      {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        per_page: 100,
      }
    );

    let count = 0;

    for await (const { data: comments } of iterator) {
      for (const comment of comments) {
        if (isVotingComment(comment.body, this.appId, comment.performed_via_github_app?.id)) {
          count++;
        }
      }
    }

    return count;
  }

  /**
   * Find the canonical alignment comment on an issue.
   *
   * Returns the first alignment comment authored by this app, or null when absent.
   */
  async findAlignmentCommentId(ref: IssueRef): Promise<number | null> {
    const iterator = this.client.paginate.iterator<IssueComment>(
      this.client.rest.issues.listComments,
      {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        per_page: 100,
      }
    );

    for await (const { data: comments } of iterator) {
      for (const comment of comments) {
        if (isAlignmentComment(comment.body, this.appId, comment.performed_via_github_app?.id)) {
          return comment.id;
        }
      }
    }

    return null;
  }

  /**
   * Find the canonical alignment comment and return its id and metadata createdAt.
   *
   * Used by auto-gather to determine cooldown eligibility and the gather watermark.
   * Returns null when no alignment comment exists.
   */
  async findAlignmentCommentInfo(ref: IssueRef): Promise<{ id: number; createdAt: string } | null> {
    const iterator = this.client.paginate.iterator<IssueComment>(
      this.client.rest.issues.listComments,
      {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        per_page: 100,
      }
    );

    for await (const { data: comments } of iterator) {
      for (const comment of comments) {
        if (isAlignmentComment(comment.body, this.appId, comment.performed_via_github_app?.id)) {
          const metadata = parseMetadata(comment.body);
          const createdAt = metadata?.createdAt ?? new Date(0).toISOString();
          return { id: comment.id, createdAt };
        }
      }
    }

    return null;
  }

  /**
   * Count non-bot substantive comments on an issue created after the given ISO timestamp.
   *
   * Used by auto-gather to determine how many new human/agent comments have
   * arrived since the last gather, without counting bot chatter or commands.
   *
   * Skips:
   * - The queen's own app comments (performed_via_github_app.id === this.appId)
   * - Any GitHub Bot-type user account (other apps, bots)
   * - Command comments (body starting with `/` or `@hivemoot`)
   */
  async countNonBotCommentsSince(ref: IssueRef, since: string): Promise<number> {
    const sinceMs = new Date(since).getTime();
    let count = 0;

    const iterator = this.client.paginate.iterator<IssueCommentWithAuthor>(
      this.client.rest.issues.listComments,
      {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        since,
        per_page: 100,
      }
    );

    for await (const { data: comments } of iterator) {
      for (const comment of comments) {
        // Skip the queen's own app comments
        if (comment.performed_via_github_app?.id === this.appId) continue;
        // Skip any GitHub Bot-type account (other apps, automation)
        if (comment.user?.type === "Bot") continue;
        // Skip command comments — they don't add discussion signal
        const body = (comment.body ?? "").trimStart();
        if (body.startsWith("/") || body.startsWith("@hivemoot")) continue;
        const commentMs = new Date(comment.created_at ?? "").getTime();
        if (commentMs > sinceMs) {
          count++;
        }
      }
    }

    return count;
  }

  /**
   * Check if a human help comment with a specific error code exists on an issue.
   * Used for idempotent error posting - avoids duplicate warnings.
   */
  async hasHumanHelpComment(ref: IssueRef, errorCode: string): Promise<boolean> {
    const iterator = this.client.paginate.iterator<IssueComment>(
      this.client.rest.issues.listComments,
      {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        per_page: 100,
      }
    );

    for await (const { data: comments } of iterator) {
      for (const comment of comments) {
        if (isHumanHelpComment(comment.body, this.appId, comment.performed_via_github_app?.id, errorCode)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if a notification comment of a given type already exists on an issue.
   * Mirrors PROperations.hasNotificationComment for issue-side duplicate detection.
   * Optionally filter by issueNumber (used as a reference key in metadata).
   */
  async hasNotificationComment(
    ref: IssueRef,
    notificationType: string,
    issueNumber?: number
  ): Promise<boolean> {
    const iterator = this.client.paginate.iterator<IssueComment>(
      this.client.rest.issues.listComments,
      {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        per_page: 100,
      }
    );

    for await (const { data: comments } of iterator) {
      for (const comment of comments) {
        if (
          isNotificationComment(
            comment.body,
            this.appId,
            comment.performed_via_github_app?.id,
            notificationType,
            issueNumber
          )
        ) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if a welcome comment from our app already exists on an issue.
   * Used by startDiscussion for replay-safe idempotency.
   */
  async hasWelcomeComment(ref: IssueRef): Promise<boolean> {
    const iterator = this.client.paginate.iterator<IssueComment>(
      this.client.rest.issues.listComments,
      {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        per_page: 100,
      }
    );

    for await (const { data: comments } of iterator) {
      for (const comment of comments) {
        if (
          isWelcomeComment(
            comment.body,
            this.appId,
            comment.performed_via_github_app?.id
          )
        ) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get users who have reacted 👍 on the issue itself, indicating discussion readiness.
   *
   * Reads reactions from the issue description (not from a comment).
   * Much simpler than getValidatedVoteCounts — we only care about +1 reactions.
   *
   * Returns a set of lowercased usernames.
   */
  async getDiscussionReadiness(ref: IssueRef): Promise<Set<string>> {
    const iterator = this.client.paginate.iterator<Reaction>(
      this.client.rest.reactions.listForIssue,
      {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        per_page: 100,
      }
    );

    const readyUsers = new Set<string>();
    let nullUserReactions = 0;

    for await (const { data: reactions } of iterator) {
      for (const reaction of reactions) {
        if (reaction.content !== "+1") {
          continue;
        }
        if (!reaction.user?.login) {
          nullUserReactions++;
          continue;
        }
        readyUsers.add(reaction.user.login.toLowerCase());
      }
    }

    if (nullUserReactions > 0) {
      logger.info(
        `Issue #${ref.issueNumber}: skipped ${nullUserReactions} readiness reaction(s) without users (likely deleted accounts).`,
      );
    }

    return readyUsers;
  }

  /**
   * Get validated vote counts from a comment, with multi-reaction discard.
   *
   * Users who cast multiple different voting reactions (e.g., both 👍 and 👎)
   * have all their votes discarded from the tally and are excluded from the
   * voter list (quorum). They still appear in participants (for requiredVoters).
   *
   * Returns a single result containing votes, valid voters, and all participants
   * in one API call.
   */
  async getValidatedVoteCounts(ref: IssueRef, commentId: number): Promise<ValidatedVoteResult> {
    const VOTING_REACTIONS = new Set(["+1", "-1", "confused", "eyes"]);

    const iterator = this.client.paginate.iterator<Reaction>(
      this.client.rest.reactions.listForIssueComment,
      {
        owner: ref.owner,
        repo: ref.repo,
        comment_id: commentId,
        per_page: 100,
      }
    );

    // Group voting reactions by user
    const userReactions = new Map<string, Set<string>>();
    let nullUserReactions = 0;

    for await (const { data: reactions } of iterator) {
      for (const reaction of reactions) {
        if (!VOTING_REACTIONS.has(reaction.content)) {
          continue;
        }

        if (!reaction.user?.login) {
          nullUserReactions++;
          continue;
        }

        const user = reaction.user.login.toLowerCase();
        if (!userReactions.has(user)) {
          userReactions.set(user, new Set());
        }
        userReactions.get(user)!.add(reaction.content);
      }
    }

    let thumbsUp = 0;
    let thumbsDown = 0;
    let confused = 0;
    let eyes = 0;
    const voters: string[] = [];
    const participants: string[] = [];

    for (const [user, reactions] of userReactions) {
      participants.push(user);

      // Only count users with exactly one voting reaction type
      if (reactions.size === 1) {
        const reaction = [...reactions][0];
        if (reaction === "+1") thumbsUp++;
        else if (reaction === "-1") thumbsDown++;
        else if (reaction === "confused") confused++;
        else if (reaction === "eyes") eyes++;
        voters.push(user);
      }
      // Users with multiple reaction types are discarded from tally and quorum
    }

    if (nullUserReactions > 0) {
      logger.info(
        `Issue #${ref.issueNumber} comment ${commentId}: skipped ${nullUserReactions} voting reaction(s) without users (likely deleted accounts).`,
      );
    }

    return {
      votes: { thumbsUp, thumbsDown, confused, eyes },
      voters,
      participants,
    };
  }

  /**
   * Get issue details (title, body, author) for summarization.
   */
  async getIssueDetails(ref: IssueRef): Promise<{ title: string; body: string; author: string }> {
    const { data } = await this.client.rest.issues.get({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issueNumber,
    });

    return {
      title: data.title,
      body: data.body ?? "",
      author: data.user?.login ?? "",
    };
  }

  /**
   * Get issue labels.
   */
  async getIssueLabels(ref: IssueRef): Promise<string[]> {
    const { data } = await this.client.rest.issues.get({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issueNumber,
    });

    return (data.labels ?? []).map((label) => (typeof label === "string" ? label : label.name ?? ""));
  }

  /**
   * Get discussion comments for summarization.
   *
   * Filters out:
   * - Comments from our GitHub App (Queen's own comments)
   *
   * Other bots (dependabot, github-actions, etc.) are intentionally included
   * as they often provide valuable context for summarization.
   *
   * Uses pagination to handle issues with many comments.
   */
  async getDiscussionComments(ref: IssueRef): Promise<DiscussionComment[]> {
    const iterator = this.client.paginate.iterator<IssueCommentWithAuthor>(
      this.client.rest.issues.listComments,
      {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        per_page: 100,
      }
    );

    const comments: DiscussionComment[] = [];

    for await (const { data: page } of iterator) {
      for (const comment of page) {
        // Skip Queen's own comments (we don't want to summarize our own messages)
        if (this.isQueenComment(comment)) {
          continue;
        }

        if (!comment.user?.login || !comment.body) {
          continue;
        }

        const thumbsUp = comment.reactions?.["+1"] ?? 0;
        const thumbsDown = comment.reactions?.["-1"] ?? 0;

        comments.push({
          author: comment.user.login,
          body: comment.body,
          createdAt: comment.created_at ?? new Date().toISOString(),
          ...(thumbsUp > 0 || thumbsDown > 0
            ? { reactions: { thumbsUp, thumbsDown } }
            : {}),
        });
      }
    }

    return comments;
  }

  /**
   * Get full issue context for LLM summarization.
   * Combines issue details with filtered discussion comments.
   */
  async getIssueContext(ref: IssueRef): Promise<IssueContext> {
    const [details, comments] = await Promise.all([
      this.getIssueDetails(ref),
      this.getDiscussionComments(ref),
    ]);

    return {
      title: details.title,
      body: details.body,
      author: details.author,
      comments,
    };
  }

  /**
   * Check if a comment was posted by Queen (our GitHub App).
   * We filter out our own comments to avoid including bot-generated content
   * in the LLM summarization, but we ALLOW comments from other bots/users.
   */
  private isQueenComment(comment: IssueCommentWithAuthor): boolean {
    return comment.performed_via_github_app?.id === this.appId;
  }

  /**
   * Find when a specific label was most recently added to an issue.
   *
   * Tracks both "labeled" and "unlabeled" events to handle cases where
   * a label is removed and re-added. Returns the most recent addition
   * time, or null if the label was removed after being added.
   */
  async getLabelAddedTime(ref: IssueRef, labelName: string): Promise<Date | null> {
    const iterator = this.client.paginate.iterator(
      this.client.rest.issues.listEventsForTimeline,
      {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        per_page: 100,
      }
    );

    // Collect all label events first, then sort to ensure chronological order
    // (GitHub API typically returns chronological, but we don't rely on that)
    const labelEvents: Array<{ type: "labeled" | "unlabeled"; time: Date }> = [];

    for await (const { data: events } of iterator) {
      for (const event of events as TimelineEvent[]) {
        if (event.label?.name && isLabelMatch(event.label.name, labelName)) {
          if (event.event === "labeled") {
            labelEvents.push({ type: "labeled", time: new Date(event.created_at) });
          } else if (event.event === "unlabeled") {
            labelEvents.push({ type: "unlabeled", time: new Date(event.created_at) });
          }
        }
      }
    }

    // Sort by time ascending (oldest first) to process in chronological order
    labelEvents.sort((a, b) => a.time.getTime() - b.time.getTime());

    // Process events in guaranteed chronological order
    let mostRecentLabeledTime: Date | null = null;
    for (const event of labelEvents) {
      if (event.type === "labeled") {
        mostRecentLabeledTime = event.time;
      } else {
        // unlabeled - reset the timer
        mostRecentLabeledTime = null;
      }
    }

    return mostRecentLabeledTime;
  }

  /**
   * Transition an issue: add new label, post comment, remove old label.
   *
   * Operations are ordered to prevent "stuck" issues on partial failure:
   * 1. Unlock (if needed — prerequisite for comment on locked issues)
   * 2. Add new label FIRST (ensures issue always has at least one phase label)
   * 3. Post comment (must happen before lock)
   * 4. Close issue (if specified)
   * 5. Remove old label LAST (safe because new label is already present)
   * 6. Lock issue (must be last)
   *
   * The add-before-remove order means that if any step after addLabels fails,
   * the issue has both old and new labels. The cron job finds it via the old
   * label and retries the transition. This prevents the failure mode where
   * removeLabel succeeds but addLabels fails, leaving the issue with no phase
   * label and invisible to the cron job.
   *
   * @param ref - Issue reference (owner, repo, issueNumber)
   * @param options.removeLabel - Label to remove after transition
   * @param options.addLabel - Label to add (required)
   * @param options.comment - Comment to post (required)
   * @param options.close - Whether to close the issue
   * @param options.closeReason - Reason for closing ("completed" | "not_planned")
   * @param options.lock - Whether to lock the issue
   * @param options.lockReason - Reason for locking
   * @param options.unlock - Whether to unlock the issue (mutually exclusive with lock)
   */
  async transition(
    ref: IssueRef,
    options: {
      removeLabel?: string;
      addLabel: string;
      comment: string;
      close?: boolean;
      closeReason?: "completed" | "not_planned";
      lock?: boolean;
      lockReason?: LockReason;
      unlock?: boolean;
    }
  ): Promise<void> {
    // Step 1: Unlock first if specified (must precede comment on locked issues)
    if (options.unlock && !options.lock) {
      await this.unlock(ref);
    }

    // Step 2: Add new label FIRST — issue always has at least one phase label.
    // If this fails, the old label is still present and the cron job can retry.
    await this.addLabels(ref, [options.addLabel]);

    // Step 3: Post comment (must complete before lock)
    await this.comment(ref, options.comment);

    // Step 4: Close issue if specified
    if (options.close) {
      await this.close(ref, options.closeReason ?? "not_planned");
    }

    // Step 5: Remove old label LAST — safe because new label already present.
    // Skip when same as addLabel (self-transition guard)
    // to avoid removing the label we just added.
    if (options.removeLabel && options.removeLabel !== options.addLabel) {
      await this.removeLabel(ref, options.removeLabel);
    }

    // Step 6: Lock issue if specified (must be last)
    if (options.lock) {
      await this.lock(ref, options.lockReason ?? "resolved");
    }
  }
}
