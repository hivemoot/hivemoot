import { describe, it, expect } from "vitest";
import {
  evaluateResolveActionPolicy,
  parsePullRequestSubjectRef,
  type DowngradeReason,
} from "./resolve-action-policy";
import type { PullRequestState } from "./github-pr-state";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function makePrState(overrides: Partial<PullRequestState> = {}): PullRequestState {
  return {
    headSha: HEAD_SHA,
    labels: ["hivemoot:automerge"],
    ciState: "success",
    mergeableState: "clean",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// evaluateResolveActionPolicy — the all-pass happy path
// ---------------------------------------------------------------------------

describe("evaluateResolveActionPolicy — happy path", () => {
  it("all invariants pass → squash-merge", () => {
    const result = evaluateResolveActionPolicy({
      clampedVerdict: "APPROVE",
      prState: makePrState(),
      reviewedHeadSha: HEAD_SHA,
      lastPostCloseDriftAt: null,
    });
    expect(result).toEqual({
      permittedAction: "squash-merge",
      downgradeReason: null,
    });
  });

  it("all invariants pass with `no_checks` CI state (repo has no CI configured)", () => {
    // `no_checks` mirrors `bot/api/lib/merge-readiness.ts:isCIPassing`
    // — treated as passing for merge eligibility.
    const result = evaluateResolveActionPolicy({
      clampedVerdict: "APPROVE",
      prState: makePrState({ ciState: "no_checks" }),
      reviewedHeadSha: HEAD_SHA,
      lastPostCloseDriftAt: null,
    });
    expect(result.permittedAction).toBe("squash-merge");
  });
});

// ---------------------------------------------------------------------------
// evaluateResolveActionPolicy — each downgrade path
// ---------------------------------------------------------------------------

describe("evaluateResolveActionPolicy — downgrade reasons", () => {
  const baseInputs = {
    clampedVerdict: "APPROVE" as const,
    prState: makePrState(),
    reviewedHeadSha: HEAD_SHA,
    lastPostCloseDriftAt: null as string | null,
  };

  it("verdict_not_approve: COMMENT verdict downgrades", () => {
    for (const v of ["COMMENT", "CONCERNS", "REQUEST_CHANGES"] as const) {
      const result = evaluateResolveActionPolicy({
        ...baseInputs,
        clampedVerdict: v,
      });
      expect(result.downgradeReason, `verdict=${v}`).toBe("verdict_not_approve");
      expect(result.permittedAction).toBe("comment");
    }
  });

  it("ci_truncated: GitHub returned >100 check-runs, fail closed", () => {
    const result = evaluateResolveActionPolicy({
      ...baseInputs,
      prState: makePrState({ ciState: "truncated" }),
    });
    expect(result.downgradeReason).toBe("ci_truncated");
  });

  it("label_missing: no `hivemoot:automerge` label", () => {
    const result = evaluateResolveActionPolicy({
      ...baseInputs,
      prState: makePrState({ labels: ["ready", "documentation"] }),
    });
    expect(result.downgradeReason).toBe("label_missing");
  });

  it("hold_label_present: operator hold label blocks merge", () => {
    const result = evaluateResolveActionPolicy({
      ...baseInputs,
      prState: makePrState({
        labels: ["hivemoot:automerge", "hivemoot:hold"],
      }),
    });
    expect(result.downgradeReason).toBe("hold_label_present");
    expect(result.permittedAction).toBe("comment");
  });

  it("ci_failure: any failing check-run", () => {
    const result = evaluateResolveActionPolicy({
      ...baseInputs,
      prState: makePrState({ ciState: "failure" }),
    });
    expect(result.downgradeReason).toBe("ci_failure");
  });

  it("ci_pending: check-runs still in-progress", () => {
    const result = evaluateResolveActionPolicy({
      ...baseInputs,
      prState: makePrState({ ciState: "pending" }),
    });
    expect(result.downgradeReason).toBe("ci_pending");
  });

  it("head_sha_drift: current GitHub head differs from queen's reviewed_head_sha", () => {
    const result = evaluateResolveActionPolicy({
      ...baseInputs,
      prState: makePrState({ headSha: "0000000000000000000000000000000000000000" }),
    });
    expect(result.downgradeReason).toBe("head_sha_drift");
  });

  it("post_close_drift: room has last_post_close_drift_at set", () => {
    const result = evaluateResolveActionPolicy({
      ...baseInputs,
      lastPostCloseDriftAt: "2026-05-10T00:00:00Z",
    });
    expect(result.downgradeReason).toBe("post_close_drift");
  });
});

// ---------------------------------------------------------------------------
// Evaluation order — first failure wins
// ---------------------------------------------------------------------------

describe("evaluateResolveActionPolicy — first failure wins", () => {
  // The order pin lets the queen see which invariant to fix first
  // when multiple fail. Tests below set TWO failures simultaneously
  // and assert that the earlier-in-the-order one surfaces.

  it("verdict_not_approve dominates ci_truncated", () => {
    const result = evaluateResolveActionPolicy({
      clampedVerdict: "REQUEST_CHANGES",
      prState: makePrState({ ciState: "truncated", labels: [] }),
      reviewedHeadSha: HEAD_SHA,
      lastPostCloseDriftAt: null,
    });
    expect(result.downgradeReason).toBe("verdict_not_approve");
  });

  it("ci_truncated dominates label_missing", () => {
    const result = evaluateResolveActionPolicy({
      clampedVerdict: "APPROVE",
      prState: makePrState({ ciState: "truncated", labels: [] }),
      reviewedHeadSha: HEAD_SHA,
      lastPostCloseDriftAt: null,
    });
    expect(result.downgradeReason).toBe("ci_truncated");
  });

  it("label_missing dominates ci_failure", () => {
    const result = evaluateResolveActionPolicy({
      clampedVerdict: "APPROVE",
      prState: makePrState({ ciState: "failure", labels: [] }),
      reviewedHeadSha: HEAD_SHA,
      lastPostCloseDriftAt: null,
    });
    expect(result.downgradeReason).toBe("label_missing");
  });

  it("hold_label_present dominates ci_failure", () => {
    const result = evaluateResolveActionPolicy({
      clampedVerdict: "APPROVE",
      prState: makePrState({
        ciState: "failure",
        labels: ["hivemoot:automerge", "hivemoot:hold"],
      }),
      reviewedHeadSha: HEAD_SHA,
      lastPostCloseDriftAt: null,
    });
    expect(result.downgradeReason).toBe("hold_label_present");
  });

  it("ci_failure dominates ci_pending (the failure already happened)", () => {
    // Can't actually have both at the same time per CiState, but
    // pin the order between failure and pending here in case the
    // CI normalization layer changes.
    const result = evaluateResolveActionPolicy({
      clampedVerdict: "APPROVE",
      prState: makePrState({ ciState: "failure" }),
      reviewedHeadSha: HEAD_SHA,
      lastPostCloseDriftAt: null,
    });
    expect(result.downgradeReason).toBe("ci_failure");
  });

  it("ci_pending dominates head_sha_drift", () => {
    const result = evaluateResolveActionPolicy({
      clampedVerdict: "APPROVE",
      prState: makePrState({
        ciState: "pending",
        headSha: "0000000000000000000000000000000000000000",
      }),
      reviewedHeadSha: HEAD_SHA,
      lastPostCloseDriftAt: null,
    });
    expect(result.downgradeReason).toBe("ci_pending");
  });

  it("head_sha_drift dominates post_close_drift", () => {
    const result = evaluateResolveActionPolicy({
      clampedVerdict: "APPROVE",
      prState: makePrState({ headSha: "0000000000000000000000000000000000000000" }),
      reviewedHeadSha: HEAD_SHA,
      lastPostCloseDriftAt: "2026-05-10T00:00:00Z",
    });
    expect(result.downgradeReason).toBe("head_sha_drift");
  });
});

// ---------------------------------------------------------------------------
// Pair invariant: comment <-> downgradeReason
// ---------------------------------------------------------------------------

describe("evaluateResolveActionPolicy — response shape invariant", () => {
  it("permittedAction='squash-merge' iff downgradeReason===null", () => {
    // Generate all (verdict × ciState × label-presence × head-match
    // × drift) combinations and check the pair invariant. Cheap
    // exhaustive coverage.
    const verdicts = ["APPROVE", "COMMENT", "CONCERNS", "REQUEST_CHANGES"] as const;
    const ciStates = ["success", "failure", "pending", "no_checks", "truncated"] as const;
    const labelSets = [
      ["hivemoot:automerge"],
      ["hivemoot:automerge", "hivemoot:hold"],
      [],
    ];
    const driftStates = [null, "2026-05-10T00:00:00Z"];

    for (const v of verdicts) {
      for (const ci of ciStates) {
        for (const labels of labelSets) {
          for (const drift of driftStates) {
            const result = evaluateResolveActionPolicy({
              clampedVerdict: v,
              prState: makePrState({ ciState: ci, labels }),
              reviewedHeadSha: HEAD_SHA,
              lastPostCloseDriftAt: drift,
            });
            const isMerge = result.permittedAction === "squash-merge";
            const hasReason = result.downgradeReason !== null;
            // squash-merge → reason MUST be null;
            // comment → reason MUST be non-null.
            expect(
              isMerge === !hasReason,
              `verdict=${v} ci=${ci} labels=${JSON.stringify(labels)} drift=${drift} permitted=${result.permittedAction} reason=${result.downgradeReason}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("all DowngradeReason values are reachable from at least one input combination", () => {
    // Catch dead-code reasons (e.g. enum value added but no branch
    // emits it). Each reason MUST be produced by at least one input.
    const required: DowngradeReason[] = [
      "verdict_not_approve",
      "label_missing",
      "ci_truncated",
      "ci_failure",
      "ci_pending",
      "head_sha_drift",
      "post_close_drift",
    ];
    const observed = new Set<DowngradeReason>();

    observed.add(
      evaluateResolveActionPolicy({
        clampedVerdict: "COMMENT",
        prState: makePrState(),
        reviewedHeadSha: HEAD_SHA,
        lastPostCloseDriftAt: null,
      }).downgradeReason as DowngradeReason,
    );
    observed.add(
      evaluateResolveActionPolicy({
        clampedVerdict: "APPROVE",
        prState: makePrState({ ciState: "truncated" }),
        reviewedHeadSha: HEAD_SHA,
        lastPostCloseDriftAt: null,
      }).downgradeReason as DowngradeReason,
    );
    observed.add(
      evaluateResolveActionPolicy({
        clampedVerdict: "APPROVE",
        prState: makePrState({ labels: [] }),
        reviewedHeadSha: HEAD_SHA,
        lastPostCloseDriftAt: null,
      }).downgradeReason as DowngradeReason,
    );
    observed.add(
      evaluateResolveActionPolicy({
        clampedVerdict: "APPROVE",
        prState: makePrState({ ciState: "failure" }),
        reviewedHeadSha: HEAD_SHA,
        lastPostCloseDriftAt: null,
      }).downgradeReason as DowngradeReason,
    );
    observed.add(
      evaluateResolveActionPolicy({
        clampedVerdict: "APPROVE",
        prState: makePrState({ ciState: "pending" }),
        reviewedHeadSha: HEAD_SHA,
        lastPostCloseDriftAt: null,
      }).downgradeReason as DowngradeReason,
    );
    observed.add(
      evaluateResolveActionPolicy({
        clampedVerdict: "APPROVE",
        prState: makePrState({ headSha: "0".repeat(40) }),
        reviewedHeadSha: HEAD_SHA,
        lastPostCloseDriftAt: null,
      }).downgradeReason as DowngradeReason,
    );
    observed.add(
      evaluateResolveActionPolicy({
        clampedVerdict: "APPROVE",
        prState: makePrState(),
        reviewedHeadSha: HEAD_SHA,
        lastPostCloseDriftAt: "2026-05-10T00:00:00Z",
      }).downgradeReason as DowngradeReason,
    );

    for (const r of required) {
      expect(observed.has(r), `${r} unreachable`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// parsePullRequestSubjectRef
// ---------------------------------------------------------------------------

describe("parsePullRequestSubjectRef", () => {
  it("parses canonical `<owner>/<repo>#<number>` shape", () => {
    const result = parsePullRequestSubjectRef("hivemoot/colony#42");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ref).toEqual({ owner: "hivemoot", repo: "colony", prNumber: 42 });
    }
  });

  it("preserves owner/repo casing (GitHub canonical casing matters at API call time)", () => {
    const result = parsePullRequestSubjectRef("HiveMoot/Colony#1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ref.owner).toBe("HiveMoot");
      expect(result.ref.repo).toBe("Colony");
    }
  });

  it("rejects missing `#` separator", () => {
    const result = parsePullRequestSubjectRef("hivemoot/colony");
    expect(result.ok).toBe(false);
  });

  it("rejects non-numeric PR number", () => {
    const result = parsePullRequestSubjectRef("hivemoot/colony#abc");
    expect(result.ok).toBe(false);
  });

  it("rejects PR number = 0 (positive integer required)", () => {
    const result = parsePullRequestSubjectRef("hivemoot/colony#0");
    expect(result.ok).toBe(false);
  });

  it("rejects empty owner or repo", () => {
    expect(parsePullRequestSubjectRef("/colony#1").ok).toBe(false);
    expect(parsePullRequestSubjectRef("hivemoot/#1").ok).toBe(false);
  });

  it("rejects extra path segments (`<owner>/<repo>/<extra>#<n>`)", () => {
    const result = parsePullRequestSubjectRef("hivemoot/colony/src#1");
    expect(result.ok).toBe(false);
  });

  it("rejects `#` inside repo name", () => {
    // Defensive: GitHub repo names can't contain `#`, but the
    // regex should reject this explicitly.
    const result = parsePullRequestSubjectRef("hivemoot/colo#ny#1");
    expect(result.ok).toBe(false);
  });

  it("accepts repo names with hyphens, underscores, dots", () => {
    expect(parsePullRequestSubjectRef("hivemoot/my-repo#1").ok).toBe(true);
    expect(parsePullRequestSubjectRef("hivemoot/my_repo#1").ok).toBe(true);
    expect(parsePullRequestSubjectRef("hivemoot/repo.name#1").ok).toBe(true);
  });

  it("accepts large PR numbers (e.g. 99999)", () => {
    const result = parsePullRequestSubjectRef("hivemoot/colony#99999");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ref.prNumber).toBe(99999);
  });
});
