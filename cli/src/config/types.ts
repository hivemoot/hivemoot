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
  comments: Array<{ createdAt: string }>;
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
}

export interface GitHubPR {
  number: number;
  title: string;
  state: string;
  author: { login: string } | null;
  labels: Array<{ name: string }>;
  comments: Array<{ createdAt: string }>;
  reviews: PRReview[];
  createdAt: string;
  updatedAt: string;
  url: string;
  isDraft: boolean;
  reviewDecision: string;
  mergeable: string;
  statusCheckRollup: StatusCheck[] | null;
  closingIssuesReferences: Array<{ number: number }>;
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
  tags: string[];
  author: string;
  // Common fields
  comments: number;
  age: string;                 // "just now" | "5 minutes ago" | "2 hours ago" | "3 days ago"
  // Issue-specific
  assigned?: string;           // comma-separated logins, or undefined (= unassigned)
  competingPRs?: number;       // only on implement items with competing PRs
  // PR-specific
  status?: string;             // "waiting" | "approved" | "changes-requested" | "draft"
  checks?: string | null;      // "passing" | "failing" | "pending" | null
  mergeable?: string | null;   // "clean" | "conflicts" | null
  review?: ReviewSummary;
}

export interface Alert {
  icon: string;
  message: string;
}

export interface RepoSummary {
  repo: RepoRef;
  currentUser: string;
  driveDiscussion: SummaryItem[];
  driveImplementation: SummaryItem[];
  voteOn: SummaryItem[];
  discuss: SummaryItem[];
  implement: SummaryItem[];
  reviewPRs: SummaryItem[];
  addressFeedback: SummaryItem[];
  alerts: Alert[];
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
