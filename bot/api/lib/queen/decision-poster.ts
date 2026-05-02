/**
 * DecisionPoster — posts the queen's synthesized decision back to
 * GitHub once a war room has been closed.
 *
 * Same dependency-injection shape as `Synthesizer`: the manager
 * loop (G'.2) calls `poster.postDecision(...)` after a successful
 * `closeRoom`, but the implementation is swappable for tests +
 * deployment variations.
 *
 * V1 scope: pr_review subjects only. mention_response and
 * issue_triage land in V1.1 alongside their respective workflows.
 *
 * Failure model: a post failure does NOT undo the room close. The
 * decision is durably stored on the room (closeRoom succeeded);
 * operators can manually re-post or wait for V1.1 retry. The
 * manager loop counts `postsFailed` separately so ops can alert.
 */

import type { Logger } from "../logger.js";
import { logger as defaultLogger } from "../logger.js";

export interface PostDecisionArgs {
  subjectType: "pr_review" | "mention_response" | "issue_triage";
  subjectRef: string;
  /** Markdown content to post. Already includes verdict header +
   * LLM prose + footer per G'.3's deterministic assembly. */
  content: string;
  /** RoomId for log correlation. */
  roomId: string;
}

export interface PostDecisionResult {
  /** Whether the post path was attempted. False when the subject
   * type isn't supported in V1 (mention_response, issue_triage).
   * The manager loop should treat this as a no-op, not an error. */
  attempted: boolean;
  /** Issue/PR comment URL on success. Null when not attempted OR
   * the underlying GitHub call returned no html_url (defensive). */
  commentUrl: string | null;
}

export interface DecisionPoster {
  postDecision(args: PostDecisionArgs): Promise<PostDecisionResult>;
}

/**
 * Octokit shape we depend on. Narrow interface so tests don't need
 * the full Octokit class — a hand-rolled fake satisfying this is
 * enough.
 */
export interface CommentingOctokit {
  rest: {
    issues: {
      createComment: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<{
        data: {
          html_url?: string;
        };
      }>;
    };
  };
}

export interface GitHubDecisionPosterConfig {
  octokit: CommentingOctokit;
  logger?: Logger;
}

export class GitHubDecisionPoster implements DecisionPoster {
  private octokit: CommentingOctokit;
  private logger: Logger;

  constructor(config: GitHubDecisionPosterConfig) {
    this.octokit = config.octokit;
    this.logger = config.logger ?? defaultLogger;
  }

  async postDecision(args: PostDecisionArgs): Promise<PostDecisionResult> {
    // V1 supports `pr_review`, `mention_response`, and `issue_triage`.
    // All three use the same `{owner}/{repo}#{number}` subject_ref
    // shape and the same `issues.createComment` GitHub API (which
    // works for both PRs and plain issues).
    const POSTABLE: ReadonlySet<typeof args.subjectType> = new Set([
      "pr_review",
      "mention_response",
      "issue_triage",
    ]);
    if (!POSTABLE.has(args.subjectType)) {
      this.logger.info(
        `[queen.poster] skip subject_type=${args.subjectType} roomId=${args.roomId} (no posting handler)`,
      );
      return { attempted: false, commentUrl: null };
    }

    const parsed = parseSubjectRef(args.subjectRef);
    if (!parsed.ok) {
      this.logger.warn(
        `[queen.poster] subject_ref parse failed roomId=${args.roomId} subject_ref=${args.subjectRef} reason=${parsed.reason}`,
      );
      throw new DecisionPostError(
        `Invalid ${args.subjectType} subject_ref: ${parsed.reason}`,
        args.roomId,
      );
    }

    this.logger.info(
      `[queen.poster] posting roomId=${args.roomId} subject_type=${args.subjectType} repo=${parsed.owner}/${parsed.repo} number=${parsed.number} bytes=${new TextEncoder().encode(args.content).length}`,
    );

    const response = await this.octokit.rest.issues.createComment({
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.number,
      body: args.content,
    });

    const url = response?.data?.html_url ?? null;
    this.logger.info(
      `[queen.poster] posted roomId=${args.roomId} url=${url ?? "no_url"}`,
    );
    return { attempted: true, commentUrl: url };
  }
}

/**
 * Error class that wraps post failures with the roomId so the
 * manager loop can correlate.
 */
export class DecisionPostError extends Error {
  constructor(
    message: string,
    public readonly roomId: string,
  ) {
    super(message);
    this.name = "DecisionPostError";
  }
}

/**
 * Parse a war-room subject_ref of the form `{owner}/{repo}#{number}`.
 * The same shape covers `pr_review`, `mention_response`, and
 * `issue_triage` (PR numbers and issue numbers share the per-repo
 * sequence on GitHub, and `issues.createComment` works for both).
 * Mirrors the format documented at WAR_ROOM_DESIGN.md L165-167 and
 * the storage layer's regex at room-create time.
 *
 * Strict regex (closes #540 builder R1):
 *   - owner / repo: `[A-Za-z0-9._-]+` (GitHub's allowed charset for
 *     org / repo names; rejects spaces, slashes-other-than-the-
 *     separator, and unicode)
 *   - PR number: `[1-9][0-9]*` (no leading zeros; positive integer)
 *   - Anchored at start AND end of input (no trailing whitespace,
 *     no extra path segments)
 *
 * Storage validates this same shape at room-create time, so a
 * failure here is a defense-in-depth signal: log + throw with
 * `DecisionPostError` so the manager loop counts as `postsFailed`
 * rather than reaching Octokit with a malformed ref and getting
 * a confusing GitHub 404.
 */
const SUBJECT_REF_REGEX = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#([1-9][0-9]*)$/;

function parseSubjectRef(
  ref: string,
):
  | { ok: true; owner: string; repo: string; number: number }
  | { ok: false; reason: string } {
  // Defense-in-depth: explicit length cap to keep regex backtracking
  // bounded even though the regex is linear-time.
  if (ref.length === 0 || ref.length > 256) {
    return { ok: false, reason: "shape_mismatch" };
  }
  const match = SUBJECT_REF_REGEX.exec(ref);
  if (!match) return { ok: false, reason: "shape_mismatch" };
  const [, owner, repo, numberStr] = match;
  const number = Number(numberStr);
  if (!Number.isInteger(number) || number <= 0) {
    // Unreachable given the regex (which already enforces positive
    // non-zero-leading integers), but defensive against Number()
    // edge cases on extreme inputs.
    return { ok: false, reason: "invalid_number" };
  }
  return { ok: true, owner, repo, number };
}

/**
 * Test/observability poster that records calls without making any
 * network requests.
 */
export class RecordingDecisionPoster implements DecisionPoster {
  public readonly calls: PostDecisionArgs[] = [];

  async postDecision(args: PostDecisionArgs): Promise<PostDecisionResult> {
    this.calls.push(args);
    if (args.subjectType !== "pr_review") {
      return { attempted: false, commentUrl: null };
    }
    return {
      attempted: true,
      commentUrl: `https://github.com/recorded/${args.roomId}/posted`,
    };
  }
}
