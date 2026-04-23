/**
 * Shared Client Validation Utilities
 *
 * Provides reusable validation logic for GitHub API clients.
 * Eliminates duplication across github-client.ts, pr-operations.ts, and leaderboard.ts.
 */

/**
 * Client validation check result
 */
export interface ValidationCheck {
  /** Dot-notation path to check (e.g., "rest.issues") */
  path: string;
  /** Required method names at this path (if any) */
  requiredMethods?: string[];
}

/**
 * Navigate to a nested property by dot-notation path.
 * Returns null if any part of the path is invalid.
 */
function getNestedProperty(
  obj: Record<string, unknown>,
  path: string
): Record<string, unknown> | null {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    // Check current value is a valid object before accessing property
    if (current == null || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[part];
  }

  // Final value must also be a valid object
  if (current == null || typeof current !== "object") {
    return null;
  }

  return current as Record<string, unknown>;
}

/**
 * Validate that an object has methods at a specific path.
 */
function hasRequiredMethods(
  obj: Record<string, unknown>,
  path: string,
  methods: string[]
): boolean {
  const target = getNestedProperty(obj, path);
  if (!target) {
    return false;
  }

  return methods.every((method) => typeof target[method] === "function");
}

/**
 * Validate that an object satisfies all specified checks.
 *
 * @example
 * ```typescript
 * const isValid = validateClient(octokit, [
 *   { path: "rest.issues", requiredMethods: ["get", "addLabels"] },
 *   { path: "paginate", requiredMethods: ["iterator"] }
 * ]);
 * ```
 */
export function validateClient(
  obj: unknown,
  checks: ValidationCheck[]
): boolean {
  // Must be a non-null object
  if (typeof obj !== "object" || obj === null) {
    return false;
  }

  const client = obj as Record<string, unknown>;

  for (const check of checks) {
    // If methods are specified, validate they exist
    if (check.requiredMethods && check.requiredMethods.length > 0) {
      if (!hasRequiredMethods(client, check.path, check.requiredMethods)) {
        return false;
      }
    } else {
      // Just check the path exists as an object
      if (getNestedProperty(client, check.path) === null) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Check if paginate.iterator is available.
 * Handles both Octokit v4 (paginate as object) and v5+ (paginate as function with iterator property).
 */
export function hasPaginateIterator(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }

  const client = obj as Record<string, unknown>;

  // In octokit v5+, `paginate` is a function with an `iterator` property,
  // so we need to accept both functions and objects (but not null/undefined)
  if (client.paginate == null) {
    return false;
  }

  const paginate = client.paginate as Record<string, unknown>;
  return typeof paginate.iterator === "function";
}

/**
 * Common validation checks for IssueOperations client.
 */
export const ISSUE_CLIENT_CHECKS: ValidationCheck[] = [
  {
    path: "rest.issues",
    requiredMethods: ["get", "addLabels", "removeLabel", "createComment", "update", "lock", "unlock"],
  },
  {
    path: "rest.reactions",
    requiredMethods: ["listForIssueComment", "listForIssue"],
  },
];

/**
 * Common validation checks for PROperations client.
 */
export const PR_CLIENT_CHECKS: ValidationCheck[] = [
  {
    path: "rest.pulls",
    requiredMethods: ["get", "update", "listReviews", "listCommits", "listReviewComments", "listFiles"],
  },
  {
    path: "rest.issues",
    requiredMethods: ["get", "addLabels", "removeLabel", "createComment", "listForRepo", "listComments"],
  },
  {
    path: "rest.checks",
    requiredMethods: ["listForRef"],
  },
  {
    path: "rest.repos",
    requiredMethods: ["getCombinedStatusForRef"],
  },
];

/**
 * Common validation checks for LeaderboardService client.
 */
export const LEADERBOARD_CLIENT_CHECKS: ValidationCheck[] = [
  {
    path: "rest.issues",
    requiredMethods: ["listComments", "createComment", "updateComment"],
  },
];
