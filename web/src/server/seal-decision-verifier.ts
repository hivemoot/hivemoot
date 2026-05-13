/**
 * G17 server-side comment_url verification for `seal-decision`
 * (RFC PR 3c slice 2d-a foundation).
 *
 * Per RFC G17, `seal-decision` runs four checks against the queen-
 * submitted comment URL before transitioning the room state. Each
 * check has a negative-test requirement — a leaked bearer must not
 * be able to forge the URL and seal without a public override
 * window having been posted.
 *
 * # Builder pass-1 expansion (RFC G17 + 1)
 *
 * The RFC's four checks become FIVE in the implementation because
 * GitHub's comment IDs are repo-scoped, not PR-scoped. Without a
 * fetched-comment cross-check (C2 below), C1's URL→PR alignment
 * only validates the queen's OWN claim about which PR the comment
 * was posted on, not GitHub's authoritative location. A queen who
 * posted a real seal-header comment on PR 99 could supply a URL
 * with `/pull/42#issuecomment-{thatId}` to launder it onto room
 * 42. C2 fetches the comment's authoritative html_url and re-
 * parses it to catch the divergence.
 *
 * The five checks:
 *
 *   C1. **URL → PR alignment** (queen-supplied URL vs subject_ref).
 *       Cheap — fires BEFORE the GitHub fetch. Catches the obvious
 *       forgery where the URL path doesn't even claim the right PR.
 *
 *   C2. **Fetched-comment identity binding** (builder pass-1).
 *       After the GitHub fetch, the response's `id` must equal
 *       the supplied comment_id, and the response's authoritative
 *       `html_url` must re-parse to the SAME owner/repo/PR/comment
 *       as the supplied URL. Catches the launder-different-PR-
 *       comment-by-rewriting-the-URL-path attack vector.
 *
 *   C3. **Comment author = bot.** `performed_via_github_app.id`
 *       must match the installation's App ID. A leaked bearer
 *       can't seal with a comment posted by a human or unrelated
 *       bot.
 *
 *   C4. **Header binding.** The comment body MUST contain the
 *       header `<!-- hivemoot:queen-action:<verb>:<audit_id> -->`
 *       where `verb` matches the action (`merge` or `comment`)
 *       and `audit_id` matches the resolve-action audit row.
 *       A leaked bearer can't forge by re-posting an old comment.
 *
 *   C5. **Timestamp ordering.** The comment's `created_at` must
 *       be STRICTLY AFTER the resolve-action audit row's `ts`.
 *       A leaked bearer can't bind to a future resolve-action
 *       call with an already-posted comment.
 *
 * This module is pure logic: it does NOT fetch the comment from
 * GitHub. The seal-decision endpoint (slice 2d-c) fetches the
 * comment via the App-minted installation token, then passes the
 * parsed payload to `verifyCommentMatches` here.
 *
 * Splitting the logic out makes each check testable in isolation —
 * the negative tests the RFC mandates land here, not buried
 * inside the endpoint's mock dance.
 */

import type { ParsedPullRequestSubjectRef } from "./resolve-action-policy";

// ---------------------------------------------------------------------------
// Comment URL parsing
// ---------------------------------------------------------------------------

/**
 * GitHub PR-comment URL shape:
 *
 *   https://github.com/{owner}/{repo}/pull/{number}#issuecomment-{commentId}
 *
 * Strict parser — rejects:
 *   - non-https schemes
 *   - hosts other than `github.com` (no github enterprise / api host
 *     mismatches that could leak the URL→PR alignment check)
 *   - paths that don't match `/{owner}/{repo}/pull/{n}` (no `/issues/`,
 *     no `/discussions/`, no `/pull/{n}/files`, etc.)
 *   - fragments that don't match `#issuecomment-{id}` with a numeric id
 *
 * Returns the four parsed fields. The seal-decision endpoint uses
 * these to (a) cross-check against the room's subject_ref and (b)
 * fetch the comment via `GET /repos/{owner}/{repo}/issues/comments/{id}`.
 */
export interface ParsedCommentUrl {
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
}

const COMMENT_URL_REGEX =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)#issuecomment-(\d+)$/;

export function parseCommentUrl(
  url: string,
):
  | { ok: true; parsed: ParsedCommentUrl }
  | { ok: false; reason: string } {
  if (typeof url !== "string" || url.length === 0) {
    return { ok: false, reason: "comment_url must be a non-empty string" };
  }
  const match = url.match(COMMENT_URL_REGEX);
  if (!match) {
    return {
      ok: false,
      reason:
        "comment_url must match the canonical " +
        "https://github.com/{owner}/{repo}/pull/{n}#issuecomment-{id} shape",
    };
  }
  const [, owner, repo, prNumberStr, commentIdStr] = match;
  const prNumber = Number.parseInt(prNumberStr, 10);
  const commentId = Number.parseInt(commentIdStr, 10);
  if (
    !Number.isFinite(prNumber) ||
    prNumber <= 0 ||
    !Number.isFinite(commentId) ||
    commentId <= 0
  ) {
    return {
      ok: false,
      reason: "comment_url PR number and comment id must be positive integers",
    };
  }
  return { ok: true, parsed: { owner, repo, prNumber, commentId } };
}

// ---------------------------------------------------------------------------
// Header binding parser
// ---------------------------------------------------------------------------

/**
 * The header the queen's comment body MUST carry to bind the
 * comment to a resolve-action audit row:
 *
 *   <!-- hivemoot:queen-action:<verb>:<audit_id> -->
 *
 * Where `verb` is `merge` or `comment` and `audit_id` is the XADD
 * stream entry id returned by resolve-action. The header appears
 * in the comment body (HTML comment so it doesn't render visibly
 * to PR participants — operators can inspect the raw markdown).
 *
 * Strict parser — anchored at start of string OR with leading/
 * trailing whitespace tolerated. Rejects malformed verbs, audit_ids
 * with disallowed characters, or extra payload inside the header.
 */
export type SealVerb = "merge" | "comment";

export interface ParsedSealHeader {
  verb: SealVerb;
  auditId: string;
}

// Verb is a fixed enum; audit_id is the XADD stream entry id format
// `{ms-timestamp}-{seq}` plus a defensive char class. Capture and
// validate further at use site.
//
// Global flag for multi-occurrence detection (guard pass-1 G1):
// the verifier rejects bodies with MORE than one header — see
// the parser body for rationale.
const SEAL_HEADER_REGEX_GLOBAL =
  /<!--\s*hivemoot:queen-action:(merge|comment):([a-zA-Z0-9_-]+)\s*-->/g;

export function parseSealHeader(
  body: string,
):
  | { ok: true; parsed: ParsedSealHeader }
  | { ok: false; reason: string } {
  if (typeof body !== "string") {
    return { ok: false, reason: "comment body must be a string" };
  }
  // Use matchAll + global regex so we can detect multiple
  // occurrences (guard pass-1 G1). A legit queen comment posts
  // exactly one header; multiple headers in one body is either a
  // bug in the queen's comment-builder OR an attempt to game
  // first-match parsing with a stacked-headers payload. Either
  // way, fail closed — the operator inspects the comment manually.
  const matches = [...body.matchAll(SEAL_HEADER_REGEX_GLOBAL)];
  if (matches.length === 0) {
    return {
      ok: false,
      reason:
        "comment body does not contain the expected " +
        "`<!-- hivemoot:queen-action:<verb>:<audit_id> -->` header",
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason:
        `comment body contains ${matches.length} seal-headers; exactly 1 ` +
        `required. Multiple headers in a single comment is either a queen ` +
        `comment-builder bug or a stacked-headers forgery attempt. Reject.`,
    };
  }
  const [, verb, auditId] = matches[0];
  if (auditId.length === 0) {
    return { ok: false, reason: "audit_id in header is empty" };
  }
  return {
    ok: true,
    parsed: { verb: verb as SealVerb, auditId },
  };
}

// ---------------------------------------------------------------------------
// Combined verification — all four G17 checks
// ---------------------------------------------------------------------------

/**
 * Subset of GitHub's issue-comment payload the verifier needs.
 *
 * The `id` and `html_url` fields are load-bearing for the
 * fetched-comment identity check (added builder pass-1):
 *
 *   - `id` lets us assert the fetched comment is the one the
 *     supplied URL claimed (defensive — GitHub should never
 *     return a different id, but a proxy / cache / WAF rewrite
 *     could).
 *   - `html_url` is the GitHub-authoritative URL for the comment.
 *     We re-parse it and compare to the queen-supplied URL. This
 *     closes the C1 forgery where the queen supplies a URL with
 *     a PR-path that matches `subject_ref` but a comment_id that
 *     was actually posted on a DIFFERENT PR in the same repo —
 *     the fetched `html_url` carries the comment's real PR.
 */
export interface CommentPayload {
  /** Comment id. Repo-scoped, not PR-scoped — see the
   * fetched-comment identity check at C2. */
  id: number;
  /**
   * GitHub's authoritative URL for this comment. Re-parsed by
   * the verifier and compared to the queen-supplied URL. A
   * forged supply with a mismatched PR path will diverge here.
   */
  html_url: string;
  /** Comment body (markdown). Searched for the seal header. */
  body: string;
  /** Comment creation timestamp (ISO 8601). Compared to the
   * resolve-action audit row's `ts`. */
  created_at: string;
  /**
   * The GitHub App that posted the comment. Present on comments
   * posted by App installations (modern API). The verifier
   * requires this — comments posted by humans or unauthenticated
   * bots have `performed_via_github_app: null` and fail check 3.
   */
  performed_via_github_app: { id: number } | null;
}

/**
 * Reasons a comment fails one of the four G17 checks. The
 * seal-decision endpoint maps these to typed error codes the
 * queen can branch on.
 */
export type VerifyCommentFailure =
  /** C1: queen-supplied URL path doesn't match the room's
   * subject_ref. Cheap check, fires BEFORE the GitHub fetch. */
  | { check: "url_pr_mismatch"; expected: string; got: string }
  /**
   * C2: the fetched comment payload disagrees with the queen-
   * supplied URL. Either the comment.id is different (defensive —
   * proxy / cache / WAF mutation), OR comment.html_url parses to
   * a different PR than the supplied URL — meaning the comment_id
   * was actually posted on a different PR in the same repo, and
   * the queen tried to launder it through the URL path. Builder
   * pass-1 fix: without this check, C1 only validates the queen's
   * own claim, not GitHub's authoritative location of the comment.
   */
  | {
      check: "comment_payload_identity_mismatch";
      reason: string;
      supplied: { commentId: number; owner: string; repo: string; prNumber: number };
      fetched: { commentId: number; htmlUrl: string };
    }
  | { check: "comment_author_mismatch"; expected_app_id: number; got_app_id: number | null }
  | { check: "header_missing_or_malformed"; reason: string }
  | { check: "header_verb_mismatch"; expected: SealVerb; got: SealVerb }
  | { check: "header_audit_id_mismatch"; expected: string; got: string }
  | { check: "comment_predates_resolve_action"; commentCreatedAt: string; resolveActionTs: string };

/**
 * Run all four G17 checks against a fetched comment payload.
 *
 * @param subjectRefParsed Pre-parsed room.subject_ref from
 *   `parsePullRequestSubjectRef`. The caller does this parse once;
 *   we accept the result directly.
 * @param commentUrlParsed Pre-parsed `body.comment_url` from
 *   `parseCommentUrl`. Caller does this before fetching the
 *   comment from GitHub (the URL → PR check is cheap and can
 *   short-circuit a needless fetch).
 * @param expectedAppId The installation's GitHub App ID (numeric).
 *   Compared to `comment.performed_via_github_app.id`.
 * @param expectedVerb `"merge"` or `"comment"` — derived from the
 *   queen's seal-decision request body (or the resolve-action
 *   permittedAction).
 * @param expectedAuditId The resolve-action audit row id the
 *   queen claims to bind to. Must match the audit_id in the
 *   comment header.
 * @param resolveActionTs ISO 8601 timestamp of the resolve-action
 *   audit row. The comment MUST have been created after this.
 * @param comment Parsed comment payload from GitHub.
 */
export function verifyCommentMatches(args: {
  subjectRefParsed: ParsedPullRequestSubjectRef;
  commentUrlParsed: ParsedCommentUrl;
  expectedAppId: number;
  expectedVerb: SealVerb;
  expectedAuditId: string;
  resolveActionTs: string;
  comment: CommentPayload;
}): { ok: true } | { ok: false; failure: VerifyCommentFailure } {
  // Check 1: URL → PR alignment (subject_ref vs comment's URL).
  // Caller has already parsed both; we just compare the three
  // fields. Owner/repo are case-insensitive on GitHub but the
  // canonical casing should match — the subject_ref carries what
  // the webhook delivered, and a forged URL with different casing
  // is suspicious enough to reject.
  if (
    args.subjectRefParsed.owner !== args.commentUrlParsed.owner ||
    args.subjectRefParsed.repo !== args.commentUrlParsed.repo ||
    args.subjectRefParsed.prNumber !== args.commentUrlParsed.prNumber
  ) {
    return {
      ok: false,
      failure: {
        check: "url_pr_mismatch",
        expected: `${args.subjectRefParsed.owner}/${args.subjectRefParsed.repo}#${args.subjectRefParsed.prNumber}`,
        got: `${args.commentUrlParsed.owner}/${args.commentUrlParsed.repo}#${args.commentUrlParsed.prNumber}`,
      },
    };
  }

  // Check 2 (builder pass-1 fix): fetched-comment identity binding.
  //
  // Comment IDs are repo-scoped on GitHub, not PR-scoped. The
  // queen-supplied URL `/pull/42#issuecomment-999` claims comment
  // 999 was posted on PR 42, but `GET /repos/{owner}/{repo}/issues/
  // comments/999` will return comment 999 regardless of which PR
  // it was actually posted on. Without this check, a queen who
  // earlier posted a valid seal-header comment on PR 99 (a
  // different PR in the same repo where they previously had a
  // resolve-action approved) could supply that comment_id with a
  // forged URL pointing to PR 42 in the same repo. C1 would pass
  // (queen's URL says PR 42, subject_ref is PR 42) and the
  // author/header/timestamp checks would line up.
  //
  // Defense: cross-check the fetched comment's authoritative
  // identity (`id` + `html_url`) against the queen-supplied URL.
  // `html_url` is GitHub's canonical URL for the comment — re-
  // parse it and ensure it points to the SAME PR the queen
  // claimed. If they disagree, the queen is laundering a
  // different-PR comment.
  if (args.comment.id !== args.commentUrlParsed.commentId) {
    return {
      ok: false,
      failure: {
        check: "comment_payload_identity_mismatch",
        reason:
          `fetched comment.id (${args.comment.id}) does not match the ` +
          `supplied URL's commentId (${args.commentUrlParsed.commentId}). ` +
          `GitHub returned a different comment than the URL claimed.`,
        supplied: {
          commentId: args.commentUrlParsed.commentId,
          owner: args.commentUrlParsed.owner,
          repo: args.commentUrlParsed.repo,
          prNumber: args.commentUrlParsed.prNumber,
        },
        fetched: {
          commentId: args.comment.id,
          htmlUrl: args.comment.html_url,
        },
      },
    };
  }
  const fetchedUrlParse = parseCommentUrl(args.comment.html_url);
  if (!fetchedUrlParse.ok) {
    return {
      ok: false,
      failure: {
        check: "comment_payload_identity_mismatch",
        reason:
          `fetched comment.html_url is not a parseable PR comment URL: ` +
          `${fetchedUrlParse.reason}`,
        supplied: {
          commentId: args.commentUrlParsed.commentId,
          owner: args.commentUrlParsed.owner,
          repo: args.commentUrlParsed.repo,
          prNumber: args.commentUrlParsed.prNumber,
        },
        fetched: {
          commentId: args.comment.id,
          htmlUrl: args.comment.html_url,
        },
      },
    };
  }
  if (
    fetchedUrlParse.parsed.owner !== args.commentUrlParsed.owner ||
    fetchedUrlParse.parsed.repo !== args.commentUrlParsed.repo ||
    fetchedUrlParse.parsed.prNumber !== args.commentUrlParsed.prNumber ||
    fetchedUrlParse.parsed.commentId !== args.commentUrlParsed.commentId
  ) {
    return {
      ok: false,
      failure: {
        check: "comment_payload_identity_mismatch",
        reason:
          `fetched comment.html_url disagrees with the supplied URL. ` +
          `The comment_id (${args.commentUrlParsed.commentId}) was actually ` +
          `posted on ${fetchedUrlParse.parsed.owner}/${fetchedUrlParse.parsed.repo}` +
          `#${fetchedUrlParse.parsed.prNumber}, not ` +
          `${args.commentUrlParsed.owner}/${args.commentUrlParsed.repo}` +
          `#${args.commentUrlParsed.prNumber}. The supplied URL was forged.`,
        supplied: {
          commentId: args.commentUrlParsed.commentId,
          owner: args.commentUrlParsed.owner,
          repo: args.commentUrlParsed.repo,
          prNumber: args.commentUrlParsed.prNumber,
        },
        fetched: {
          commentId: args.comment.id,
          htmlUrl: args.comment.html_url,
        },
      },
    };
  }

  // Check 3: Comment author = the installation's App bot identity.
  // `performed_via_github_app` is set by GitHub when the comment
  // was posted by a GitHub App installation (the modern API
  // surface). null when posted by a human OR by an unauthenticated
  // bot — both fail this check.
  const performedAppId = args.comment.performed_via_github_app?.id ?? null;
  if (performedAppId !== args.expectedAppId) {
    return {
      ok: false,
      failure: {
        check: "comment_author_mismatch",
        expected_app_id: args.expectedAppId,
        got_app_id: performedAppId,
      },
    };
  }

  // Check 4: Header binding — parse + verify verb + audit_id.
  const headerParse = parseSealHeader(args.comment.body);
  if (!headerParse.ok) {
    return {
      ok: false,
      failure: {
        check: "header_missing_or_malformed",
        reason: headerParse.reason,
      },
    };
  }
  const header = headerParse.parsed;
  if (header.verb !== args.expectedVerb) {
    return {
      ok: false,
      failure: {
        check: "header_verb_mismatch",
        expected: args.expectedVerb,
        got: header.verb,
      },
    };
  }
  if (header.auditId !== args.expectedAuditId) {
    return {
      ok: false,
      failure: {
        check: "header_audit_id_mismatch",
        expected: args.expectedAuditId,
        got: header.auditId,
      },
    };
  }

  // Check 5: Timestamp ordering. Comment MUST be created AFTER
  // the resolve-action audit row.
  //
  // Builder pass-2 fix: GitHub's issue-comment API returns
  // `created_at` at SECOND precision (e.g. "2026-05-12T10:00:00Z"),
  // while our audit row uses `new Date().toISOString()` which
  // includes MILLISECONDS (e.g. "2026-05-12T10:00:00.500Z").
  //
  // Pre-fix logic (`commentTime <= audit_time`) would reject a
  // valid comment posted at 10:00:00.900Z when the audit was at
  // 10:00:00.500Z, because GitHub-floored commentTime = 10:00:00.000
  // < audit 10:00:00.500. The endpoint would be flaky on the
  // happy path.
  //
  // Fix: treat the second-precision comment timestamp as the
  // LATEST possible actual time it represents — `commentTime +
  // 1000ms exclusive`. Reject only when even that latest-possible
  // time is at or before the audit time, i.e. when the comment's
  // entire second is strictly before the audit. Same semantic as
  // "the comment was posted in a wall-clock second BEFORE the
  // audit row."
  //
  // Negligible leakage if GitHub ever adds ms precision to this
  // field (would be at most 999ms of acceptance slack vs. the
  // ms-precise check, way under the real-world gap between a
  // resolve-action audit emit and a queen's GitHub comment-post).
  const COMMENT_PRECISION_WINDOW_MS = 1000;
  const commentTime = Date.parse(args.comment.created_at);
  const audit_time = Date.parse(args.resolveActionTs);
  if (!Number.isFinite(commentTime) || !Number.isFinite(audit_time)) {
    // Defensive — both should parse since GitHub + our XADD-time
    // both emit ISO 8601. If either is bogus, fail closed under
    // the same check; the operator sees the values in the response.
    return {
      ok: false,
      failure: {
        check: "comment_predates_resolve_action",
        commentCreatedAt: args.comment.created_at,
        resolveActionTs: args.resolveActionTs,
      },
    };
  }
  // Reject only when the latest possible comment time (end of
  // GitHub's 1-second precision window) is at or before the audit.
  if (commentTime + COMMENT_PRECISION_WINDOW_MS <= audit_time) {
    return {
      ok: false,
      failure: {
        check: "comment_predates_resolve_action",
        commentCreatedAt: args.comment.created_at,
        resolveActionTs: args.resolveActionTs,
      },
    };
  }

  return { ok: true };
}

/**
 * Build the canonical seal-header string given a verb + audit_id.
 * Used by:
 *   - tests (to generate valid comment bodies for happy-path tests)
 *   - the queen runtime in PR 4 (to embed the header before posting
 *     the comment to GitHub) — when slice 4 ships, the queen will
 *     call this from its Python plugin via the matching format
 *     spec, NOT this function directly. Source of truth lives here
 *     so any future change to the format updates the verifier and
 *     the queen in lockstep.
 */
export function buildSealHeader(verb: SealVerb, auditId: string): string {
  return `<!-- hivemoot:queen-action:${verb}:${auditId} -->`;
}
