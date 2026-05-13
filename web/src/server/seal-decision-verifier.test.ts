import { describe, it, expect } from "vitest";
import {
  parseCommentUrl,
  parseSealHeader,
  verifyCommentMatches,
  buildSealHeader,
  type CommentPayload,
  type SealVerb,
} from "./seal-decision-verifier";
import type { ParsedPullRequestSubjectRef } from "./resolve-action-policy";

// ---------------------------------------------------------------------------
// parseCommentUrl — strict URL shape validation
// ---------------------------------------------------------------------------

describe("parseCommentUrl", () => {
  it("parses the canonical PR-comment URL shape", () => {
    const result = parseCommentUrl(
      "https://github.com/hivemoot/colony/pull/42#issuecomment-1234567",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed).toEqual({
        owner: "hivemoot",
        repo: "colony",
        prNumber: 42,
        commentId: 1234567,
      });
    }
  });

  it("rejects http (non-https) URLs (URL→PR check could be leaked via redirect)", () => {
    expect(
      parseCommentUrl("http://github.com/hivemoot/colony/pull/42#issuecomment-1").ok,
    ).toBe(false);
  });

  it("rejects hosts other than github.com (no Enterprise / api host substitution)", () => {
    expect(
      parseCommentUrl(
        "https://github.example.com/hivemoot/colony/pull/42#issuecomment-1",
      ).ok,
    ).toBe(false);
    expect(
      parseCommentUrl(
        "https://api.github.com/hivemoot/colony/pull/42#issuecomment-1",
      ).ok,
    ).toBe(false);
  });

  it("rejects /issues/{n} paths (must be /pull/{n} for our flow)", () => {
    expect(
      parseCommentUrl(
        "https://github.com/hivemoot/colony/issues/42#issuecomment-1",
      ).ok,
    ).toBe(false);
  });

  it("rejects extra path segments like /pull/{n}/files", () => {
    expect(
      parseCommentUrl(
        "https://github.com/hivemoot/colony/pull/42/files#issuecomment-1",
      ).ok,
    ).toBe(false);
  });

  it("rejects fragments that aren't #issuecomment-{numeric}", () => {
    expect(
      parseCommentUrl(
        "https://github.com/hivemoot/colony/pull/42#discussion_r123",
      ).ok,
    ).toBe(false);
    expect(
      parseCommentUrl(
        "https://github.com/hivemoot/colony/pull/42#issuecomment-",
      ).ok,
    ).toBe(false);
    expect(
      parseCommentUrl(
        "https://github.com/hivemoot/colony/pull/42#issuecomment-abc",
      ).ok,
    ).toBe(false);
  });

  it("rejects PR number = 0 or comment id = 0 (positive integers required)", () => {
    expect(
      parseCommentUrl("https://github.com/h/c/pull/0#issuecomment-1").ok,
    ).toBe(false);
    expect(
      parseCommentUrl("https://github.com/h/c/pull/1#issuecomment-0").ok,
    ).toBe(false);
  });

  it("rejects empty / non-string input", () => {
    expect(parseCommentUrl("").ok).toBe(false);
    expect(parseCommentUrl(null as unknown as string).ok).toBe(false);
    expect(parseCommentUrl(undefined as unknown as string).ok).toBe(false);
  });

  it("preserves casing on owner/repo (canonical webhook casing matters)", () => {
    const result = parseCommentUrl(
      "https://github.com/HiveMoot/Colony/pull/1#issuecomment-1",
    );
    if (result.ok) {
      expect(result.parsed.owner).toBe("HiveMoot");
      expect(result.parsed.repo).toBe("Colony");
    }
  });
});

// ---------------------------------------------------------------------------
// parseSealHeader — header pattern + verb + audit_id extraction
// ---------------------------------------------------------------------------

describe("parseSealHeader", () => {
  it("parses canonical merge header", () => {
    const result = parseSealHeader(
      "Some merge intent body\n<!-- hivemoot:queen-action:merge:1715000000000-0 -->\nmore text",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed).toEqual({
        verb: "merge",
        auditId: "1715000000000-0",
      });
    }
  });

  it("parses canonical comment header", () => {
    const result = parseSealHeader(
      "Comment text.\n<!-- hivemoot:queen-action:comment:abc-123_XYZ -->",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.verb).toBe("comment");
      expect(result.parsed.auditId).toBe("abc-123_XYZ");
    }
  });

  it("tolerates extra whitespace inside the HTML comment", () => {
    const result = parseSealHeader(
      "<!--   hivemoot:queen-action:merge:id-1   -->",
    );
    expect(result.ok).toBe(true);
  });

  it("rejects bodies without the header (most common forgery: a real comment with no marker)", () => {
    const result = parseSealHeader("LGTM ship it");
    expect(result.ok).toBe(false);
  });

  it("rejects malformed verbs (not 'merge' or 'comment')", () => {
    expect(parseSealHeader("<!-- hivemoot:queen-action:rebase:1 -->").ok).toBe(false);
    expect(parseSealHeader("<!-- hivemoot:queen-action:MERGE:1 -->").ok).toBe(false);
    expect(parseSealHeader("<!-- hivemoot:queen-action::1 -->").ok).toBe(false);
  });

  it("rejects audit_ids with disallowed characters (no spaces, no '<>', etc.)", () => {
    expect(parseSealHeader("<!-- hivemoot:queen-action:merge:abc xyz -->").ok).toBe(false);
    expect(parseSealHeader("<!-- hivemoot:queen-action:merge:abc<xyz -->").ok).toBe(false);
    expect(parseSealHeader("<!-- hivemoot:queen-action:merge:abc/xyz -->").ok).toBe(false);
  });

  it("rejects wrong namespace prefix (must be hivemoot:queen-action)", () => {
    expect(parseSealHeader("<!-- hivemoot:queen:merge:1 -->").ok).toBe(false);
    expect(parseSealHeader("<!-- queen-action:merge:1 -->").ok).toBe(false);
  });

  it("buildSealHeader round-trips through parseSealHeader", () => {
    for (const verb of ["merge", "comment"] as const) {
      const built = buildSealHeader(verb, "1715000000000-3");
      const parsed = parseSealHeader(built);
      expect(parsed.ok, `${verb} round-trip`).toBe(true);
      if (parsed.ok) {
        expect(parsed.parsed.verb).toBe(verb);
        expect(parsed.parsed.auditId).toBe("1715000000000-3");
      }
    }
  });

  it("rejects MULTIPLE seal-headers in the same body (guard pass-1 G1 — stacked-header forgery defense)", () => {
    // A legit queen comment carries exactly one header. Multiple
    // headers is either a queen comment-builder bug OR an attacker
    // trying to game first-match parsing with stacked headers
    // (e.g. their forged audit_id at the top, the legit one
    // lower). Fail closed.
    const body =
      "First header line\n" +
      buildSealHeader("merge", "1715000000000-0") +
      "\nintermediate body\n" +
      buildSealHeader("merge", "1715000000000-7");
    const result = parseSealHeader(body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/2 seal-headers/);
    }
  });

  it("rejects two headers with the same audit_id but different verbs (still ambiguous)", () => {
    const body =
      buildSealHeader("merge", "1715000000000-0") +
      "\n\n" +
      buildSealHeader("comment", "1715000000000-0");
    expect(parseSealHeader(body).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyCommentMatches — all four G17 checks (with the RFC-mandated
// negative test per check)
// ---------------------------------------------------------------------------

const SUBJECT_REF: ParsedPullRequestSubjectRef = {
  owner: "hivemoot",
  repo: "colony",
  prNumber: 42,
};
const COMMENT_URL_PARSED = {
  owner: "hivemoot",
  repo: "colony",
  prNumber: 42,
  commentId: 999,
};
const APP_ID = 12345;
const AUDIT_TS = "2026-05-12T10:00:00.000Z";

function happyComment(
  overrides: Partial<CommentPayload> = {},
  auditId = "1715000000000-0",
  verb: SealVerb = "merge",
): CommentPayload {
  return {
    id: 999, // matches COMMENT_URL_PARSED.commentId
    html_url:
      "https://github.com/hivemoot/colony/pull/42#issuecomment-999", // matches the supplied URL
    body: `Intent to merge.\n${buildSealHeader(verb, auditId)}`,
    created_at: "2026-05-12T10:01:00.000Z", // 1 minute after audit
    performed_via_github_app: { id: APP_ID },
    ...overrides,
  };
}

describe("verifyCommentMatches — happy path", () => {
  it("returns ok when all four checks pass", () => {
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: COMMENT_URL_PARSED,
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment(),
    });
    expect(result.ok).toBe(true);
  });
});

describe("verifyCommentMatches — check 1: URL → PR alignment (RFC negative test)", () => {
  it("rejects when comment URL points to a different PR than subject_ref", () => {
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: { ...COMMENT_URL_PARSED, prNumber: 99 }, // wrong PR
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.check).toBe("url_pr_mismatch");
    }
  });

  it("rejects when comment URL points to a different repo", () => {
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: { ...COMMENT_URL_PARSED, repo: "different-repo" },
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.check).toBe("url_pr_mismatch");
    }
  });

  it("rejects when comment URL points to a different owner (typosquatting forgery)", () => {
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: { ...COMMENT_URL_PARSED, owner: "hivemoot-fake" },
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.check).toBe("url_pr_mismatch");
    }
  });
});

describe("verifyCommentMatches — check 2: fetched-comment identity binding (builder pass-1 fix)", () => {
  it("REJECTS the launder-different-PR-comment attack: supplied URL says /pull/42 but fetched comment was actually posted on PR 99", async () => {
    // The attack: queen previously posted a real seal-header
    // comment on PR 99 (which they sealed legitimately at the
    // time). They now try to seal a NEW room for PR 42 by
    // supplying a URL `/pull/42#issuecomment-{thatId}`. GitHub
    // returns the actual comment, which has html_url pointing
    // to PR 99 — the divergence flips this check.
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: COMMENT_URL_PARSED, // queen claims /pull/42
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment({
        // GitHub returns the actual location of the comment:
        // posted on PR 99, NOT PR 42. The seal-header is
        // present + matches the audit_id (a real prior
        // seal-decision); the queen is just laundering it.
        html_url: "https://github.com/hivemoot/colony/pull/99#issuecomment-999",
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.check).toBe("comment_payload_identity_mismatch");
      if (result.failure.check === "comment_payload_identity_mismatch") {
        expect(result.failure.supplied.prNumber).toBe(42);
        expect(result.failure.fetched.htmlUrl).toContain("/pull/99");
      }
    }
  });

  it("rejects when GitHub returns a comment with a different id than requested (proxy/cache/WAF mutation defense)", async () => {
    // Defensive: GitHub should never return a different id than we
    // asked for, but a misconfigured CDN / proxy / WAF could.
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: COMMENT_URL_PARSED, // claims commentId=999
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment({
        id: 12345, // different from 999
        html_url:
          "https://github.com/hivemoot/colony/pull/42#issuecomment-12345",
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.check).toBe("comment_payload_identity_mismatch");
    }
  });

  it("rejects when comment.html_url is unparseable (malformed GitHub response)", async () => {
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: COMMENT_URL_PARSED,
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment({ html_url: "not-a-valid-url" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.check).toBe("comment_payload_identity_mismatch");
    }
  });

  it("rejects when html_url is for a different REPO entirely (cross-repo laundering)", async () => {
    // Two installations could grant the same App access to two
    // different repos; the queen for one repo can't seal with a
    // comment from another repo's PR.
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: COMMENT_URL_PARSED,
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment({
        html_url:
          "https://github.com/hivemoot/another-repo/pull/42#issuecomment-999",
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.check).toBe("comment_payload_identity_mismatch");
    }
  });

  it("accepts when fetched html_url and id match the supplied URL exactly", async () => {
    // Positive control: the happy comment's html_url + id match
    // COMMENT_URL_PARSED exactly. C2 should pass.
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: COMMENT_URL_PARSED,
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment(),
    });
    expect(result.ok).toBe(true);
  });
});

describe("verifyCommentMatches — check 3: comment author = bot (RFC negative test)", () => {
  it("rejects when comment was posted by a human (performed_via_github_app === null)", () => {
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: COMMENT_URL_PARSED,
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment({ performed_via_github_app: null }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.check).toBe("comment_author_mismatch");
    }
  });

  it("rejects when comment was posted by a DIFFERENT GitHub App (e.g. third-party bot)", () => {
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: COMMENT_URL_PARSED,
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment({ performed_via_github_app: { id: 99999 } }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.check).toBe("comment_author_mismatch");
    }
  });
});

describe("verifyCommentMatches — check 4: header binding (RFC negative test)", () => {
  it("rejects when comment body has no seal header (forgery: re-posted comment with no marker)", () => {
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: COMMENT_URL_PARSED,
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment({ body: "Looks good to me!" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.check).toBe("header_missing_or_malformed");
    }
  });

  it("rejects when verb in header doesn't match expected (queen claimed merge but comment says comment)", () => {
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: COMMENT_URL_PARSED,
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment(
        { body: "x\n" + buildSealHeader("comment", "1715000000000-0") },
      ),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.check).toBe("header_verb_mismatch");
    }
  });

  it("rejects when audit_id in header doesn't match expected (re-binding to an OLDER resolve-action call)", () => {
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: COMMENT_URL_PARSED,
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-7",
      resolveActionTs: AUDIT_TS,
      comment: happyComment(
        { body: "x\n" + buildSealHeader("merge", "1715000000000-0") },
      ),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.check).toBe("header_audit_id_mismatch");
    }
  });
});

describe("verifyCommentMatches — check 5: timestamp ordering (RFC negative test)", () => {
  it("rejects when comment created_at is BEFORE resolve-action audit timestamp (re-using old comment)", () => {
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: COMMENT_URL_PARSED,
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment({ created_at: "2026-05-12T09:59:59.000Z" }), // 1s before audit
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.check).toBe("comment_predates_resolve_action");
    }
  });

  it("rejects when comment created_at is EQUAL to resolve-action audit timestamp (must be strictly after)", () => {
    // Strict-after semantics: a comment posted in the SAME ms as the
    // audit row can't have been authorized by it (the audit row is
    // emitted before the queen could have posted). Reject.
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: COMMENT_URL_PARSED,
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment({ created_at: AUDIT_TS }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.check).toBe("comment_predates_resolve_action");
    }
  });

  it("rejects when either timestamp is unparseable (defensive — fail closed under same check)", () => {
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: COMMENT_URL_PARSED,
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment({ created_at: "not-a-timestamp" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.check).toBe("comment_predates_resolve_action");
    }
  });
});

// ---------------------------------------------------------------------------
// Evaluation order — checks fire in the documented order (cheap → expensive)
// ---------------------------------------------------------------------------

describe("verifyCommentMatches — check evaluation order", () => {
  it("URL mismatch dominates author mismatch (cheap check fires first)", () => {
    // Both check 1 + check 2 would fail; we should see check 1
    // in the failure (saves the GitHub API call cost when the
    // verifier is invoked via short-circuit short-circuit paths).
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: { ...COMMENT_URL_PARSED, prNumber: 99 },
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment({ performed_via_github_app: null }),
    });
    if (!result.ok) {
      expect(result.failure.check).toBe("url_pr_mismatch");
    }
  });

  it("author mismatch dominates header mismatch (no need to parse a comment from an unrelated bot)", () => {
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: COMMENT_URL_PARSED,
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment({
        body: "no header here",
        performed_via_github_app: { id: 99999 }, // wrong bot
      }),
    });
    if (!result.ok) {
      expect(result.failure.check).toBe("comment_author_mismatch");
    }
  });

  it("header mismatch dominates timestamp mismatch", () => {
    const result = verifyCommentMatches({
      subjectRefParsed: SUBJECT_REF,
      commentUrlParsed: COMMENT_URL_PARSED,
      expectedAppId: APP_ID,
      expectedVerb: "merge",
      expectedAuditId: "1715000000000-0",
      resolveActionTs: AUDIT_TS,
      comment: happyComment({
        body: "no header",
        created_at: "2026-01-01T00:00:00Z", // also before audit
      }),
    });
    if (!result.ok) {
      expect(result.failure.check).toBe("header_missing_or_malformed");
    }
  });
});
