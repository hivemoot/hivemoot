/**
 * GitHub PR state reader for the Queen Execution Mode local-queen
 * resolve-action endpoint (RFC PR 3c slice 2b).
 *
 * The local queen's resolve-action endpoint evaluates D1's merge
 * invariants server-side:
 *   1. Verdict == APPROVE (computed elsewhere via applyDowngradeOnlyFloor)
 *   2. `hivemoot:automerge` label present
 *   3. CI green (Check Runs + legacy Status API both passing)
 *   4. Head SHA stable (reviewed_head_sha in request body matches current)
 *
 * Items 2-4 require a live GitHub read. This module wraps the three
 * REST calls that pull them in one shot:
 *   - GET /repos/{owner}/{repo}/pulls/{pull_number}
 *     → labels + head.sha + mergeable_state
 *   - GET /repos/{owner}/{repo}/commits/{head_sha}/check-runs?per_page=100
 *     → GitHub Actions check runs
 *   - GET /repos/{owner}/{repo}/commits/{head_sha}/status
 *     → legacy combined status (external CI like Jenkins)
 *
 * CI semantics mirror `bot/api/lib/merge-readiness.ts:isCIPassing`:
 * BOTH check-runs AND legacy statuses must pass. Truncated check-runs
 * (>100) fail closed — we can't verify unseen checks. Zero
 * checks/statuses = passing (repo has no CI configured, also matching
 * bot semantics).
 *
 * Pattern matches `github-contents.ts`: `fetch` + Bearer token, no
 * `@octokit/rest` dep. Caller supplies the installation access token
 * (mint via `generateInstallationToken` in `github-auth.ts` or via
 * the `/api/github/installation-tokens` endpoint).
 */

const GH_API = "https://api.github.com";

function ghHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * CI state for the PR's current head commit, normalized to a small
 * enum the resolve-action endpoint can branch on.
 *
 * - `success`: both check-runs and legacy statuses pass (and ≥1 check
 *   or status exists — see `no_checks`).
 * - `failure`: any check-run or legacy status is in a failing state.
 * - `pending`: no failures, but at least one check-run is queued/
 *   in_progress OR the combined status is `pending`.
 * - `no_checks`: zero check-runs AND zero legacy statuses. The repo
 *   has no CI configured. Mirrors `bot/api/lib/merge-readiness.ts`
 *   isCIPassing semantics: treated as passing for merge eligibility.
 * - `truncated`: GitHub returned `total_count > 100` for check-runs.
 *   We can't verify unseen checks. Fail closed at the call site.
 */
export type CiState =
  | "success"
  | "failure"
  | "pending"
  | "no_checks"
  | "truncated";

export interface PullRequestState {
  /** Current head commit SHA. Compare to bearer's `reviewed_head_sha`
   * for D1 invariant #4 (head SHA stable). */
  headSha: string;
  /** Lowercase label names. Check `labels.includes("hivemoot:automerge")`
   * for D1 invariant #2. Label matching is case-sensitive on GitHub. */
  labels: string[];
  /** Normalized CI signal. Resolve-action treats `success` and
   * `no_checks` as passing for D1 invariant #3; anything else
   * downgrades to comment-only. */
  ciState: CiState;
  /**
   * GitHub's `mergeable_state` enum value (`clean`, `dirty`,
   * `behind`, `blocked`, `unknown`, etc.). Surfaced for diagnostic
   * use in audit events; resolve-action's invariant check uses
   * `ciState` + `headSha` directly, not this field. May be `null`
   * if GitHub is still computing the merge state.
   */
  mergeableState: string | null;
}

/**
 * Thrown when GitHub returns 404 for the PR (deleted / wrong repo).
 * Resolve-action surfaces this as 404 to the caller — the room core
 * has the subject_ref but GitHub no longer has the PR open.
 */
export class PullRequestNotFoundError extends Error {
  public readonly owner: string;
  public readonly repo: string;
  public readonly prNumber: number;
  constructor(owner: string, repo: string, prNumber: number) {
    super(`Pull request ${owner}/${repo}#${prNumber} not found.`);
    this.name = "PullRequestNotFoundError";
    this.owner = owner;
    this.repo = repo;
    this.prNumber = prNumber;
  }
}

/**
 * Thrown for any non-200, non-404 GitHub response. Caller surfaces
 * as 502 bad_gateway — the GitHub-side check failed for reasons
 * unrelated to PR existence.
 */
export class GitHubAPIError extends Error {
  public readonly status: number;
  public readonly endpoint: string;
  public readonly body: string;
  constructor(endpoint: string, status: number, body: string) {
    super(`GitHub API ${endpoint} returned ${status}: ${body.slice(0, 200)}`);
    this.name = "GitHubAPIError";
    this.status = status;
    this.endpoint = endpoint;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// CI normalization helpers
// ---------------------------------------------------------------------------

/**
 * Check-run conclusions that count as "passing" for merge eligibility.
 * Same set as `bot/api/lib/merge-readiness.ts:PASSING_CHECK_CONCLUSIONS`.
 * `neutral` and `skipped` are non-failing terminal states; `success`
 * is the obvious pass. Anything else (failure, cancelled, timed_out,
 * action_required, stale) blocks merge.
 */
const PASSING_CHECK_CONCLUSIONS = new Set<string>([
  "success",
  "neutral",
  "skipped",
]);

interface CheckRun {
  status: string; // queued | in_progress | completed
  conclusion: string | null;
}

interface CombinedStatusResponse {
  state: string; // success | pending | failure
  total_count: number;
}

/**
 * Combine GitHub's two CI surfaces into one `CiState` enum.
 *
 * @param checkRuns parsed check-runs response (truncation already detected by caller)
 * @param truncated true when GitHub returned `total_count > checkRuns.length`
 * @param status parsed combined-status response (legacy / external CI)
 */
export function deriveCiState(args: {
  checkRuns: CheckRun[];
  truncated: boolean;
  status: CombinedStatusResponse;
}): CiState {
  if (args.truncated) return "truncated";

  // Check-runs evaluation: any failure → "failure"; any in-flight → mark pending
  let anyCheckPending = false;
  for (const cr of args.checkRuns) {
    if (cr.status !== "completed") {
      anyCheckPending = true;
      continue;
    }
    if (!cr.conclusion || !PASSING_CHECK_CONCLUSIONS.has(cr.conclusion)) {
      return "failure";
    }
  }

  // Legacy status evaluation. GitHub's combined-status `state` is
  // one of: success | pending | failure | error. The bot's
  // isCIPassing treats anything except `success` as blocking when
  // `total_count > 0`; we mirror that exactly. Builder pass-1 fix:
  // a prior version handled `failure` + `pending` explicitly but
  // fell through `error` to the no-failure branch — green
  // check-runs + legacy `error` would have been reported as
  // `success`, letting resolve-action merge a PR with a broken
  // external check.
  const legacyHasStatuses = args.status.total_count > 0;
  if (legacyHasStatuses) {
    if (args.status.state === "success") {
      // Pass; fall through to the combined evaluation below.
    } else if (args.status.state === "pending") {
      anyCheckPending = true;
    } else {
      // `failure`, `error`, or any other non-success non-pending
      // value (defensive against future GitHub enum expansion).
      return "failure";
    }
  }

  if (anyCheckPending) return "pending";

  // No failures, no pendings. Either there's signal (success) or none.
  const hasAnySignal = args.checkRuns.length > 0 || legacyHasStatuses;
  return hasAnySignal ? "success" : "no_checks";
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

interface GetPullRequestStateArgs {
  /** Installation access token. Mint via `generateInstallationToken`. */
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Read the PR's labels, head SHA, mergeable state, and normalized CI
 * status in (at minimum) two round-trips: the pulls fetch first to
 * learn the head SHA, then the two CI calls in parallel against that
 * SHA.
 *
 * The PR fetch is sequential because the CI calls need `head.sha`.
 * Bot's `automerge.ts` accepts a pre-fetched labels array from the
 * webhook payload to avoid the first fetch; the resolve-action
 * endpoint doesn't have that — it's a queen-initiated request, not a
 * webhook receiver, so it must read PR state fresh.
 *
 * Failure modes:
 *   - PR returns 404 → throws `PullRequestNotFoundError`
 *   - Any call returns non-2xx (non-404) → throws `GitHubAPIError`
 *   - check-runs `total_count > 100` → returned `ciState: "truncated"`,
 *     no error (caller fail-closes at the policy boundary)
 */
export async function getPullRequestState(
  args: GetPullRequestStateArgs,
): Promise<PullRequestState> {
  const doFetch = args.fetchImpl ?? fetch;
  const baseRef = `${args.owner}/${args.repo}#${args.prNumber}`;

  // ----- 1. PR core (labels + head.sha + mergeable_state) -----
  const prEndpoint = `${GH_API}/repos/${args.owner}/${args.repo}/pulls/${args.prNumber}`;
  const prRes = await doFetch(prEndpoint, { headers: ghHeaders(args.token) });
  if (prRes.status === 404) {
    throw new PullRequestNotFoundError(args.owner, args.repo, args.prNumber);
  }
  if (!prRes.ok) {
    throw new GitHubAPIError(
      `GET /repos/{owner}/{repo}/pulls/{pull_number} (${baseRef})`,
      prRes.status,
      await prRes.text(),
    );
  }
  const prBody = (await prRes.json()) as {
    head: { sha: string };
    labels: Array<{ name: string }>;
    mergeable_state: string | null;
  };
  const headSha = prBody.head.sha;
  const labels = prBody.labels.map((l) => l.name);
  const mergeableState = prBody.mergeable_state ?? null;

  // ----- 2. CI signals (parallel) -----
  const checksEndpoint = `${GH_API}/repos/${args.owner}/${args.repo}/commits/${headSha}/check-runs?per_page=100`;
  const statusEndpoint = `${GH_API}/repos/${args.owner}/${args.repo}/commits/${headSha}/status`;

  const [checksRes, statusRes] = await Promise.all([
    doFetch(checksEndpoint, { headers: ghHeaders(args.token) }),
    doFetch(statusEndpoint, { headers: ghHeaders(args.token) }),
  ]);

  if (!checksRes.ok) {
    throw new GitHubAPIError(
      `GET /repos/{owner}/{repo}/commits/{ref}/check-runs (${baseRef} @ ${headSha.slice(0, 8)})`,
      checksRes.status,
      await checksRes.text(),
    );
  }
  if (!statusRes.ok) {
    throw new GitHubAPIError(
      `GET /repos/{owner}/{repo}/commits/{ref}/status (${baseRef} @ ${headSha.slice(0, 8)})`,
      statusRes.status,
      await statusRes.text(),
    );
  }

  const checksBody = (await checksRes.json()) as {
    total_count: number;
    check_runs: CheckRun[];
  };
  const statusBody = (await statusRes.json()) as CombinedStatusResponse;

  const truncated = checksBody.total_count > checksBody.check_runs.length;
  const ciState = deriveCiState({
    checkRuns: checksBody.check_runs,
    truncated,
    status: statusBody,
  });

  return { headSha, labels, ciState, mergeableState };
}
