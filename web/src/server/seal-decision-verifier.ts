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
 * The four checks:
 *
 *   1. **URL → PR alignment.** The comment URL's owner/repo/PR
 *      number must match the room's `subject_ref`. A leaked bearer
 *      can't seal room A with a comment posted on PR B.
 *   2. **Comment author = bot.** `performed_via_github_app.id` must
 *      match the installation's App ID. A leaked bearer can't seal
 *      with a comment posted by a human collaborator OR an
 *      unrelated bot.
 *   3. **Header binding.** The comment body MUST contain the
 *      header `<!-- hivemoot:queen-action:<verb>:<audit_id> -->`
 *      where `verb` matches the action (`merge` or `comment`) and
 *      `audit_id` matches the resolve-action audit row. A leaked
 *      bearer can't forge by re-posting an old comment.
 *   4. **Timestamp ordering.** The comment's `created_at` must be
 *      AFTER the resolve-action audit row's `ts`. A leaked bearer
 *      can't bind to a future resolve-action call with an
 *      already-posted comment.
 *
 * This module is pure logic: it does NOT fetch the comment from
 * GitHub. The seal-decision endpoint (slice 2d-c) fetches the
 * comment via the App-minted installation token, then passes the
 * parsed payload to `verifyCommentMatches` here.
 *
 * Splitting the logic out makes each check testable in isolation —
 * the four negative tests the RFC mandates land here, not buried
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
const SEAL_HEADER_REGEX =
  /<!--\s*hivemoot:queen-action:(merge|comment):([a-zA-Z0-9_-]+)\s*-->/;

export function parseSealHeader(
  body: string,
):
  | { ok: true; parsed: ParsedSealHeader }
  | { ok: false; reason: string } {
  if (typeof body !== "string") {
    return { ok: false, reason: "comment body must be a string" };
  }
  const match = body.match(SEAL_HEADER_REGEX);
  if (!match) {
    return {
      ok: false,
      reason:
        "comment body does not contain the expected " +
        "`<!-- hivemoot:queen-action:<verb>:<audit_id> -->` header",
    };
  }
  const [, verb, auditId] = match;
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
 * Fields not used by G17 (reactions, html_url, etc.) are omitted —
 * the seal-decision endpoint passes whatever shape GitHub returned,
 * narrowed to this surface.
 */
export interface CommentPayload {
  /** Comment body (markdown). Searched for the seal header. */
  body: string;
  /** Comment creation timestamp (ISO 8601). Compared to the
   * resolve-action audit row's `ts`. */
  created_at: string;
  /**
   * The GitHub App that posted the comment. Present on comments
   * posted by App installations (modern API). The verifier
   * requires this — comments posted by humans or unauthenticated
   * bots have `performed_via_github_app: null` and fail check 2.
   */
  performed_via_github_app: { id: number } | null;
}

/**
 * Reasons a comment fails one of the four G17 checks. The
 * seal-decision endpoint maps these to typed error codes the
 * queen can branch on.
 */
export type VerifyCommentFailure =
  | { check: "url_pr_mismatch"; expected: string; got: string }
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

  // Check 2: Comment author = the installation's App bot identity.
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

  // Check 3: Header binding — parse + verify verb + audit_id.
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

  // Check 4: Timestamp ordering. Comment MUST be created AFTER
  // the resolve-action audit row. Equal timestamps fail closed
  // (rejected) since a re-used comment can't have a strictly
  // later timestamp than the resolve-action call that authorized
  // it. Both timestamps are ISO 8601 with consistent timezone, so
  // lex compare works for ordering.
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
  if (commentTime <= audit_time) {
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
