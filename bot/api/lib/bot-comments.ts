/**
 * Bot Comments Module
 *
 * Centralized definitions for all bot-generated comments:
 * - Type definitions (discriminated unions)
 * - Signatures for comment detection
 * - Builders to create comment bodies with embedded metadata
 * - Parsers to extract metadata from existing comments
 */

// ─────────────────────────────────────────────────────────────────────────────
// Comment Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All possible bot comment types.
 * Single source of truth: the array drives both runtime validation and the type.
 */
const COMMENT_TYPES = ["voting", "leaderboard", "welcome", "alignment", "status", "error", "notification", "standup"] as const;
export type CommentType = (typeof COMMENT_TYPES)[number];

/**
 * Base metadata fields shared by all comment types.
 */
interface BaseMetadata {
  version: 1;
  createdAt: string;
  issueNumber: number;
}

/**
 * Voting comment metadata - tracks voting cycles.
 */
export interface VotingMetadata extends BaseMetadata {
  type: "voting";
  cycle: number;
}

/**
 * Leaderboard comment metadata.
 */
export interface LeaderboardMetadata extends BaseMetadata {
  type: "leaderboard";
}

/**
 * Welcome comment metadata.
 */
export interface WelcomeMetadata extends BaseMetadata {
  type: "welcome";
}

/**
 * Alignment comment metadata.
 */
export interface AlignmentMetadata extends BaseMetadata {
  type: "alignment";
}

/**
 * Status comment metadata (voting outcomes, etc.).
 */
export interface StatusMetadata extends BaseMetadata {
  type: "status";
}

/**
 * Human help comment metadata - posted when the Queen needs human intervention.
 * Used for error conditions that require manual resolution.
 */
export interface HumanHelpMetadata extends BaseMetadata {
  type: "error";
  errorCode: string;
}

/**
 * Notification comment metadata - used for PR notifications (voting-passed, etc.).
 * The notificationType field allows extensibility for future notification kinds.
 */
export interface NotificationMetadata extends BaseMetadata {
  type: "notification";
  notificationType: string;
}

/**
 * Standup comment metadata - daily Colony Journal entries.
 * issueNumber is set to 0 because standup comments live on a Discussion, not an Issue.
 */
export interface StandupMetadata extends BaseMetadata {
  type: "standup";
  day: number;
  date: string;
  repo: string;
}

/**
 * Discriminated union of all comment metadata types.
 */
export type CommentMetadata =
  | VotingMetadata
  | LeaderboardMetadata
  | WelcomeMetadata
  | AlignmentMetadata
  | StatusMetadata
  | HumanHelpMetadata
  | NotificationMetadata
  | StandupMetadata;

// ─────────────────────────────────────────────────────────────────────────────
// Signatures for Comment Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unique signatures embedded in comment bodies for type detection.
 * These are visible to users and serve as UI anchors.
 */
export const SIGNATURES = {
  VOTING: "React to THIS comment to vote",
  LEADERBOARD: "# 🐝 Implementation Leaderboard 📊",
  ALIGNMENT: "# 🐝 Blueprint",
  HUMAN_HELP: "# 🐝 Summoning the Humans",
} as const;

/**
 * Error codes for human help comments.
 * Used for idempotent error detection and categorization.
 */
export const ERROR_CODES = {
  VOTING_COMMENT_NOT_FOUND: "VOTING_COMMENT_NOT_FOUND",
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

/**
 * Notification types for PR notification comments.
 * Extensible for future notification kinds beyond voting-passed.
 */
export const NOTIFICATION_TYPES = {
  VOTING_PASSED: "voting-passed",
  IMPLEMENTATION_WELCOME: "implementation-welcome",
  ISSUE_NEW_PR: "issue-new-pr",
} as const;

/**
 * Type-safe notification type derived from NOTIFICATION_TYPES.
 * Add new notification kinds to NOTIFICATION_TYPES and this type expands automatically.
 */
export type NotificationType = typeof NOTIFICATION_TYPES[keyof typeof NOTIFICATION_TYPES];

/**
 * Hidden metadata marker prefix.
 */
const METADATA_PREFIX = "hivemoot-metadata:";

// ─────────────────────────────────────────────────────────────────────────────
// Metadata Builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create voting comment metadata.
 */
export function createVotingMetadata(issueNumber: number, cycle: number): VotingMetadata {
  return {
    version: 1,
    type: "voting",
    cycle,
    createdAt: new Date().toISOString(),
    issueNumber,
  };
}

/**
 * Create leaderboard comment metadata.
 */
export function createLeaderboardMetadata(issueNumber: number): LeaderboardMetadata {
  return {
    version: 1,
    type: "leaderboard",
    createdAt: new Date().toISOString(),
    issueNumber,
  };
}

/**
 * Create welcome comment metadata.
 */
export function createWelcomeMetadata(issueNumber: number): WelcomeMetadata {
  return {
    version: 1,
    type: "welcome",
    createdAt: new Date().toISOString(),
    issueNumber,
  };
}

/**
 * Create alignment comment metadata.
 */
export function createAlignmentMetadata(issueNumber: number): AlignmentMetadata {
  return {
    version: 1,
    type: "alignment",
    createdAt: new Date().toISOString(),
    issueNumber,
  };
}

/**
 * Create status comment metadata.
 */
export function createStatusMetadata(issueNumber: number): StatusMetadata {
  return {
    version: 1,
    type: "status",
    createdAt: new Date().toISOString(),
    issueNumber,
  };
}

/**
 * Create human help comment metadata.
 */
export function createHumanHelpMetadata(issueNumber: number, errorCode: string): HumanHelpMetadata {
  return {
    version: 1,
    type: "error",
    errorCode,
    createdAt: new Date().toISOString(),
    issueNumber,
  };
}

/**
 * Create notification comment metadata.
 */
export function createNotificationMetadata(
  issueNumber: number,
  notificationType: NotificationType
): NotificationMetadata {
  return {
    version: 1,
    type: "notification",
    notificationType,
    createdAt: new Date().toISOString(),
    issueNumber,
  };
}

/**
 * Create standup comment metadata for Colony Journal entries.
 */
export function createStandupMetadata(day: number, date: string, repo: string): StandupMetadata {
  return {
    version: 1,
    type: "standup",
    day,
    date,
    repo,
    createdAt: new Date().toISOString(),
    issueNumber: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Comment Builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate hidden HTML comment containing metadata.
 */
export function generateMetadataTag(metadata: CommentMetadata): string {
  return `<!-- ${METADATA_PREFIX} ${JSON.stringify(metadata)} -->`;
}

/**
 * Build a complete voting comment with embedded metadata.
 */
export function buildVotingComment(content: string, issueNumber: number, cycle: number): string {
  const metadata = createVotingMetadata(issueNumber, cycle);
  return `${generateMetadataTag(metadata)}\n${content}`;
}

/**
 * Build a complete discussion (welcome) comment with embedded metadata.
 */
export function buildDiscussionComment(content: string, issueNumber: number): string {
  const metadata = createWelcomeMetadata(issueNumber);
  return `${generateMetadataTag(metadata)}\n${content}`;
}

/**
 * Build a complete alignment comment with embedded metadata.
 */
export function buildAlignmentComment(content: string, issueNumber: number): string {
  const metadata = createAlignmentMetadata(issueNumber);
  return `${generateMetadataTag(metadata)}\n${content}`;
}

/**
 * Build a complete leaderboard comment with embedded metadata.
 */
export function buildLeaderboardComment(content: string, issueNumber: number): string {
  const metadata = createLeaderboardMetadata(issueNumber);
  return `${generateMetadataTag(metadata)}\n${content}`;
}

/**
 * Build a complete human help comment with embedded metadata.
 * Used when the Queen needs human intervention for an error condition.
 */
export function buildHumanHelpComment(content: string, issueNumber: number, errorCode: string): string {
  const metadata = createHumanHelpMetadata(issueNumber, errorCode);
  return `${generateMetadataTag(metadata)}\n${content}`;
}

/**
 * Build a complete notification comment with embedded metadata.
 * Used for PR notifications (e.g., voting-passed).
 */
export function buildNotificationComment(
  content: string,
  issueNumber: number,
  notificationType: NotificationType
): string {
  const metadata = createNotificationMetadata(issueNumber, notificationType);
  return `${generateMetadataTag(metadata)}\n${content}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse metadata from a comment body.
 * Returns null if no valid metadata found.
 *
 * Uses a non-greedy regex that captures the first `{...}` block.
 * Does not support nested JSON objects in metadata fields — all
 * metadata values must be flat primitives (string, number, boolean).
 */
export function parseMetadata(body: string | undefined | null): CommentMetadata | null {
  if (!body) return null;

  // Match HTML comment with our metadata prefix
  // Uses [\s\S]*? (non-greedy) to capture the first metadata tag; nested JSON objects are not supported.
  const regex = /<!--\s*hivemoot-metadata:\s*(\{[\s\S]*?\})\s*-->/;
  const match = body.match(regex);

  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]) as unknown;

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      !("type" in parsed)
    ) {
      return null;
    }

    const obj = parsed as Record<string, unknown>;

    // Validate type is a known CommentType (defense-in-depth)
    if (typeof obj.type !== "string" || !COMMENT_TYPES.includes(obj.type as CommentType)) {
      return null;
    }

    // Validate notification-specific fields
    if (obj.type === "notification") {
      if (typeof obj.notificationType !== "string" || typeof obj.issueNumber !== "number") {
        return null;
      }
    }

    // Validate standup-specific fields
    if (obj.type === "standup") {
      if (typeof obj.day !== "number" || typeof obj.date !== "string" || typeof obj.repo !== "string") {
        return null;
      }
    }

    return parsed as CommentMetadata;
  } catch {
    return null;
  }
}

/**
 * Check if metadata indicates a specific comment type.
 * Returns true only if metadata exists and has the expected type.
 */
function hasMetadataType(body: string, expectedType: CommentType): boolean {
  const metadata = parseMetadata(body);
  return metadata?.type === expectedType;
}

/**
 * Check if a comment is a voting comment from our app.
 * Uses metadata type for stable detection - signatures are purely cosmetic.
 */
export function isVotingComment(
  body: string | undefined | null,
  appId: number,
  performedViaAppId: number | undefined | null
): boolean {
  if (performedViaAppId !== appId) {
    return false;
  }
  if (typeof body !== "string") {
    return false;
  }
  return hasMetadataType(body, "voting");
}

/**
 * Check if a comment is a leaderboard comment from our app.
 * Uses metadata type for stable detection - signatures are purely cosmetic.
 */
export function isLeaderboardComment(
  body: string | undefined | null,
  appId: number,
  performedViaAppId: number | undefined | null
): boolean {
  if (performedViaAppId !== appId) {
    return false;
  }
  if (typeof body !== "string") {
    return false;
  }
  return hasMetadataType(body, "leaderboard");
}

/**
 * Check if a comment is an alignment comment from our app.
 * Uses metadata type for stable detection.
 */
export function isAlignmentComment(
  body: string | undefined | null,
  appId: number,
  performedViaAppId: number | undefined | null
): boolean {
  if (performedViaAppId !== appId) {
    return false;
  }
  if (typeof body !== "string") {
    return false;
  }
  return hasMetadataType(body, "alignment");
}

/**
 * Check if a comment is a welcome comment from our app.
 * Uses metadata type for stable detection - signatures are purely cosmetic.
 */
export function isWelcomeComment(
  body: string | undefined | null,
  appId: number,
  performedViaAppId: number | undefined | null
): boolean {
  if (performedViaAppId !== appId) {
    return false;
  }
  if (typeof body !== "string") {
    return false;
  }
  return hasMetadataType(body, "welcome");
}

/**
 * Check if a comment is a human help comment from our app.
 * Uses metadata type for stable detection - signatures are purely cosmetic.
 * Optionally filter by specific error code.
 */
export function isHumanHelpComment(
  body: string | undefined | null,
  appId: number,
  performedViaAppId: number | undefined | null,
  errorCode?: string
): boolean {
  if (performedViaAppId !== appId) {
    return false;
  }
  if (typeof body !== "string") {
    return false;
  }

  const metadata = parseMetadata(body);
  if (metadata?.type !== "error") {
    return false;
  }

  if (errorCode) {
    return metadata.errorCode === errorCode;
  }
  return true;
}

/**
 * Check if a comment is a notification comment from our app.
 * Uses metadata type for stable detection.
 * Optionally filter by specific notificationType and/or issueNumber.
 */
export function isNotificationComment(
  body: string | undefined | null,
  appId: number,
  performedViaAppId: number | undefined | null,
  notificationType?: string,
  issueNumber?: number
): boolean {
  if (performedViaAppId !== appId) {
    return false;
  }
  if (typeof body !== "string") {
    return false;
  }

  const metadata = parseMetadata(body);
  if (metadata?.type !== "notification") {
    return false;
  }

  if (notificationType) {
    if ((metadata as NotificationMetadata).notificationType !== notificationType) {
      return false;
    }
  }
  if (issueNumber !== undefined) {
    if (metadata.issueNumber !== issueNumber) {
      return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Voting Comment Selection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collected voting comment info for selection.
 */
export interface VotingCommentInfo {
  id: number;
  cycle: number | null;
  createdAt: string;
}

/**
 * Select the current voting comment from a list.
 * Returns the one with the highest cycle number.
 */
export function selectCurrentVotingComment(comments: VotingCommentInfo[]): VotingCommentInfo | null {
  if (comments.length === 0) return null;

  // Sort by cycle DESC (nulls should not exist in new system)
  const sorted = [...comments].sort((a, b) => {
    if (a.cycle !== null && b.cycle !== null) {
      return b.cycle - a.cycle;
    }
    // Fallback: prefer comments with cycle metadata
    if (a.cycle !== null) return -1;
    if (b.cycle !== null) return 1;
    return 0;
  });

  return sorted[0];
}
