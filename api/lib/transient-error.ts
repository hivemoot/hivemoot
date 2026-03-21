/**
 * Shared transient-error classifier
 *
 * A single source of truth for determining whether a GitHub API or network
 * error is transient and worth retrying, rather than a permanent auth denial
 * or validation failure.
 */

import { getErrorStatus } from "./github-client.js";

/**
 * Network-level error codes that indicate a transient failure.
 * Used by both webhook handlers and scheduled scripts.
 */
export const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

/**
 * Determine whether an error is transient — a network-level or server-side
 * failure worth retrying rather than a permanent auth/validation denial.
 *
 * Returns true for:
 * - Known transient network codes (ECONNRESET, ETIMEDOUT, ECONNREFUSED, etc.)
 * - HTTP 429 (rate limit) or any 5xx (server error)
 */
export function isTransientError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) {
      return true;
    }
  }
  const status = getErrorStatus(error);
  return status !== null && (status === 429 || status >= 500);
}

/**
 * Determine whether a GraphQL error means auto-merge was not active on the PR.
 *
 * GitHub returns `GraphqlResponseError` with `errors[].type === "UNPROCESSABLE"`
 * and a human-readable message containing "not enabled" when
 * `disablePullRequestAutoMerge` is called on a PR that has no active auto-merge.
 * The type identifier ("PullRequestAutoMergeNotEnabled") lives in `errors[].type`
 * and does NOT appear in `.message`, so string-matching `.message` silently fails.
 *
 * Uses duck-typing on `.name` rather than `instanceof GraphqlResponseError`
 * because the project has two installed versions of `@octokit/graphql` (root 7.1.1
 * and octokit-bundled 9.0.3). Errors thrown by `context.octokit.graphql` are
 * instances of the 9.x class; importing from `@octokit/graphql` resolves to 7.x.
 * `instanceof` checks fail across class boundaries, silently misclassifying errors
 * and leaving `hivemoot:automerge` intact when it should be removed.
 */
export function isAutoMergeNotEnabledError(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    (error as { name?: unknown }).name !== "GraphqlResponseError"
  ) {
    return false;
  }
  const errors = (error as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (e: unknown) =>
      typeof e === "object" &&
      e !== null &&
      (e as { type?: unknown }).type === "UNPROCESSABLE" &&
      /not enabled/i.test(String((e as { message?: unknown }).message ?? ""))
  );
}
