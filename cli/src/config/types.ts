// ── YAML Config Types ──────────────────────────────────────────────

export interface RoleConfig {
  description: string;
  instructions: string;
}

export interface TeamConfig {
  name?: string;
  roles: Record<string, RoleConfig>;
}

export interface HivemootConfig {
  version?: number;
  governance?: unknown;
  team?: TeamConfig;
}

// ── GitHub Data Types ──────────────────────────────────────────────

export interface GitHubIssue {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  author: { login: string } | null;
  comments: Array<{ createdAt: string; author: { login: string } | null }>;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface StatusCheck {
  context: string;
  state: string | undefined;
  conclusion: string | null;
}

export interface PRReview {
  state: string;
  author: { login: string } | null;
  submittedAt?: string;
}

export interface PRCommit {
  committedDate: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  state: string;
  author: { login: string } | null;
  labels: Array<{ name: string }>;
  comments: Array<{ createdAt: string; author: { login: string } | null }>;
  reviews: PRReview[];
  createdAt: string;
  updatedAt: string;
  url: string;
  isDraft: boolean;
  reviewDecision: string;
  mergeable: string;
  statusCheckRollup: StatusCheck[] | null;
  closingIssuesReferences: Array<{ number: number }>;
  commits: PRCommit[];
}

// ── Repo Identity ──────────────────────────────────────────────────

export interface RepoRef {
  owner: string;
  repo: string;
}

// ── Summary Types ──────────────────────────────────────────────────

export interface ReviewSummary {
  approvals: number;
  changesRequested: number;
}

export interface SummaryItem {
  number: number;
  title: string;
  url?: string;
  tags: string[];
  author: string;
  // Common fields
  comments: number;
  age: string;                 // "just now" | "5 minutes ago" | "2 hours ago" | "3 days ago"
  // Issue-specific
  assigned?: string;           // comma-separated logins, or undefined (= unassigned)
  competingPRs?: number;       // only on implement items with competing PRs
  // PR-specific
  status?: string;             // "pending" | "approved" | "changes-requested" | "draft"
  checks?: string | null;      // "passing" | "failing" | "pending" | null
  mergeable?: string | null;   // "clean" | "conflicts" | null
  review?: ReviewSummary;
  yourComment?: string;                // "commented"
  yourCommentAge?: string;             // "3h ago" — when you last commented
  yourVote?: string;                   // "👍" | "👎" | "😕" | "👀"
  yourVoteAge?: string;                // "1d ago" — when you voted
  yourReview?: string;
  yourReviewAge?: string;             // "3 days ago" — when you last reviewed
  lastCommit?: string;                // "2 hours ago" — when the latest commit landed
  lastComment?: string;               // "5 hours ago" — when the latest comment was posted
  updated?: string;                   // "30 minutes ago" — pr.updatedAt (catch-all)
  // Notification fields
  unread?: boolean;                   // true if there's an unread notification
  unreadReason?: string;              // "comment" | "mention" | "author" | "ci_activity"
  unreadAge?: string;                 // "2h ago" — when the notification was last updated
}

export interface RepoSummary {
  repo: RepoRef;
  currentUser: string;
  needsHuman: SummaryItem[];
  driveDiscussion: SummaryItem[];
  driveImplementation: SummaryItem[];
  voteOn: SummaryItem[];
  discuss: SummaryItem[];
  implement: SummaryItem[];
  unclassified?: SummaryItem[];
  reviewPRs: SummaryItem[];
  draftPRs: SummaryItem[];
  addressFeedback: SummaryItem[];
  notes: string[];
}

// ── CLI Options ────────────────────────────────────────────────────

export interface BuzzOptions {
  role?: string;
  json?: boolean;
  limit?: number;
  fetchLimit?: number;
  repo?: string;
}

export interface RolesOptions {
  json?: boolean;
  repo?: string;
}

export interface RoleOptions {
  json?: boolean;
  repo?: string;
}

export interface WatchOptions {
  repo?: string;
  interval?: number;
  once?: boolean;
  stateFile?: string;
  reasons?: string;
}

export interface AckOptions {
  stateFile: string;
}

export interface MentionEvent {
  agent: string;      // authenticated user login
  repo: string;       // owner/repo
  number: number;     // issue/PR number
  type: string;       // "Issue" | "PullRequest"
  title: string;
  author: string;     // commenter who triggered the mention
  body: string;       // comment text
  url: string;        // HTML URL of the comment
  threadId: string;   // notification thread ID
  timestamp: string;  // ISO 8601
}

// ── Error Types ────────────────────────────────────────────────────

export type ErrorCode =
  | "GH_NOT_FOUND"
  | "GH_NOT_AUTHENTICATED"
  | "NOT_GIT_REPO"
  | "CONFIG_NOT_FOUND"
  | "NO_TEAM_CONFIG"
  | "ROLE_NOT_FOUND"
  | "INVALID_CONFIG"
  | "RATE_LIMITED"
  | "GH_ERROR";

export class CliError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}
