/**
 * GitHub issue-comment reader for local-queen `seal-decision`.
 *
 * Pull-request comments created by `gh pr comment` are issue
 * comments under GitHub's REST API:
 *
 *   GET /repos/{owner}/{repo}/issues/comments/{comment_id}
 *
 * The route verifies the returned payload with
 * `seal-decision-verifier.ts`; this module only owns the GitHub
 * fetch, HTTP error mapping, and minimal payload shape validation.
 */

import type { CommentPayload } from "./seal-decision-verifier";

const GH_API = "https://api.github.com";

function ghHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export class GitHubCommentNotFoundError extends Error {
  constructor(
    public readonly owner: string,
    public readonly repo: string,
    public readonly commentId: number,
  ) {
    super(`GitHub comment ${owner}/${repo}#issuecomment-${commentId} not found.`);
    this.name = "GitHubCommentNotFoundError";
  }
}

export class GitHubCommentAPIError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`GitHub API ${endpoint} returned ${status}: ${body.slice(0, 200)}`);
    this.name = "GitHubCommentAPIError";
  }
}

export class GitHubCommentMalformedError extends Error {
  constructor(public readonly reason: string) {
    super(`GitHub comment payload is malformed: ${reason}`);
    this.name = "GitHubCommentMalformedError";
  }
}

export async function getIssueComment(args: {
  token: string;
  owner: string;
  repo: string;
  commentId: number;
  fetchImpl?: typeof fetch;
}): Promise<CommentPayload> {
  const doFetch = args.fetchImpl ?? fetch;
  const endpoint = `${GH_API}/repos/${args.owner}/${args.repo}/issues/comments/${args.commentId}`;
  const res = await doFetch(endpoint, { headers: ghHeaders(args.token) });
  if (res.status === 404) {
    throw new GitHubCommentNotFoundError(args.owner, args.repo, args.commentId);
  }
  if (!res.ok) {
    throw new GitHubCommentAPIError(
      `GET /repos/{owner}/{repo}/issues/comments/{comment_id} (${args.owner}/${args.repo}#issuecomment-${args.commentId})`,
      res.status,
      await res.text(),
    );
  }

  const body = (await res.json()) as unknown;
  if (!isCommentPayload(body)) {
    throw new GitHubCommentMalformedError(
      "missing id, html_url, body, created_at, or performed_via_github_app",
    );
  }
  return body;
}

function isCommentPayload(value: unknown): value is CommentPayload {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const app = v.performed_via_github_app;
  return (
    typeof v.id === "number" &&
    typeof v.html_url === "string" &&
    typeof v.body === "string" &&
    typeof v.created_at === "string" &&
    (app === null ||
      (typeof app === "object" &&
        app !== null &&
        typeof (app as { id?: unknown }).id === "number"))
  );
}
