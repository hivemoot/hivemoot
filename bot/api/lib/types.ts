/**
 * Shared Type Definitions
 *
 * Common types used across webhooks and scheduled scripts.
 */

import { isLabelMatch } from "../config.js";

/**
 * Minimal GitHub issue representation for governance operations
 */
export interface Issue {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
  reactions?: {
    "+1": number;
    "-1": number;
    confused: number;
    eyes?: number;
  };
}

/**
 * Repository reference with owner information
 */
export interface Repository {
  owner: {
    login: string;
  };
  name: string;
  full_name: string;
}

/**
 * Issue reference for API calls
 */
export interface IssueRef {
  owner: string;
  repo: string;
  issueNumber: number;
  installationId?: number;
}

/**
 * Vote counts from issue reactions
 */
export interface VoteCounts {
  thumbsUp: number;
  thumbsDown: number;
  confused: number;
  eyes: number;
}

/**
 * Validated vote result with multi-reaction discard.
 *
 * Users who cast multiple different voting reactions (e.g., both 👍 and 👎)
 * have ALL their votes discarded — they are ambiguous and counted as invalid.
 * They still appear in `participants` (for requiredVoters participation checks)
 * but not in `voters` (for quorum) or `votes` (for tallying).
 */
export interface ValidatedVoteResult {
  /** Vote counts excluding users who cast multiple different voting reaction types */
  votes: VoteCounts;
  /** Unique users who cast exactly one voting reaction type (valid for quorum/minVoters) */
  voters: string[];
  /** All unique users who cast any voting reaction (valid for requiredVoters participation) */
  participants: string[];
}

/**
 * Result of a voting decision.
 * "skipped" indicates the voting comment was not found and human help was requested.
 */
export type VotingOutcome =
  | "ready-to-implement"
  | "rejected"
  | "inconclusive"
  | "needs-more-discussion"
  | "needs-human-input"
  | "skipped";

/**
 * Valid reasons for locking an issue's conversation
 */
export type LockReason = "off-topic" | "too heated" | "resolved" | "spam";

/**
 * Timeline event for label tracking
 */
export interface TimelineEvent {
  event: string;
  created_at: string;
  label?: {
    name: string;
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// PR Types
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Pull request reference for API calls
 */
export interface PRRef {
  owner: string;
  repo: string;
  prNumber: number;
  installationId?: number;
}

/**
 * Minimal PR representation from GraphQL queries
 */
export interface PullRequest {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  author: {
    login: string;
  };
}

/**
 * Issue linked to a PR (from closingIssuesReferences)
 */
export interface LinkedIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: {
    nodes: Array<{ name: string } | null>;
  };
}

/**
 * Check if a linked issue has a specific label.
 * Supports both new hivemoot: labels and legacy names via isLabelMatch.
 */
export function hasLabel(issue: LinkedIssue, labelName: string): boolean {
  return issue.labels.nodes.some((l) => l !== null && isLabelMatch(l.name, labelName));
}

/**
 * Filter linked issues to only those with a specific label.
 */
export function filterByLabel(issues: LinkedIssue[], labelName: string): LinkedIssue[] {
  return issues.filter((issue) => hasLabel(issue, labelName));
}

/**
 * PR with approval count for leaderboard
 */
export interface PRWithApprovals {
  number: number;
  title: string;
  author: string;
  approvals: number;
}

// ───────────────────────────────────────────────────────────────────────────────
// GitHub API Types
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Comment data structure from GitHub API.
 * Used for iterating over issue comments to find bot-authored content.
 */
export interface IssueComment {
  id: number;
  body?: string;
  created_at?: string;
  performed_via_github_app?: { id: number } | null;
  reactions?: { "+1"?: number; "-1"?: number };
}
