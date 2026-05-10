import { describe, it, expect } from "vitest";
import {
  aggregateWorkerVerdicts,
  applyDowngradeOnlyFloor,
  extractContributionVerdict,
  mostConservative,
  VERDICT_VALUES,
} from "./queen-verdict.ts";
import type { RoomContribution } from "./war-room.ts";

function contribution(
  overrides: Partial<RoomContribution> = {},
): RoomContribution {
  return {
    actor_role: "worker",
    actor_id: "test",
    body: undefined,
    raw_md: "",
    submitted_at: "2026-05-08T00:00:00Z",
    last_seq: 1,
    withdrawn: false,
    ...overrides,
  } as unknown as RoomContribution;
}

describe("extractContributionVerdict", () => {
  it("returns null when body is missing", () => {
    expect(extractContributionVerdict(contribution({ body: undefined }))).toBeNull();
  });

  it("returns null when body is not an object", () => {
    expect(
      extractContributionVerdict(contribution({ body: "string" as never })),
    ).toBeNull();
  });

  it("returns null when body.verdict is missing", () => {
    expect(
      extractContributionVerdict(contribution({ body: { other: "x" } as never })),
    ).toBeNull();
  });

  it("returns null when body.verdict is not in the enum", () => {
    expect(
      extractContributionVerdict(
        contribution({ body: { verdict: "MAYBE" } as never }),
      ),
    ).toBeNull();
  });

  it("returns the verdict when present and valid", () => {
    const v = extractContributionVerdict(
      contribution({ body: { verdict: "REQUEST_CHANGES" } as never }),
    );
    expect(v).toBe("REQUEST_CHANGES");
  });
});

describe("aggregateWorkerVerdicts", () => {
  it("returns COMMENT for empty contributions", () => {
    expect(aggregateWorkerVerdicts({})).toBe("COMMENT");
  });

  it("returns COMMENT when no contribution carries a structured verdict (modern default)", () => {
    expect(
      aggregateWorkerVerdicts({
        a: contribution({ raw_md: "looks good" }),
        b: contribution({ raw_md: "ship it" }),
      }),
    ).toBe("COMMENT");
  });

  it("returns REQUEST_CHANGES when any contribution requests changes", () => {
    expect(
      aggregateWorkerVerdicts({
        a: contribution({ body: { verdict: "APPROVE" } as never }),
        b: contribution({ body: { verdict: "REQUEST_CHANGES" } as never }),
      }),
    ).toBe("REQUEST_CHANGES");
  });

  it("returns CONCERNS when CONCERNS present and no REQUEST_CHANGES", () => {
    expect(
      aggregateWorkerVerdicts({
        a: contribution({ body: { verdict: "APPROVE" } as never }),
        b: contribution({ body: { verdict: "CONCERNS" } as never }),
      }),
    ).toBe("CONCERNS");
  });

  it("returns APPROVE when every contribution is APPROVE", () => {
    expect(
      aggregateWorkerVerdicts({
        a: contribution({ body: { verdict: "APPROVE" } as never }),
        b: contribution({ body: { verdict: "APPROVE" } as never }),
      }),
    ).toBe("APPROVE");
  });

  it("falls back to COMMENT for mixed APPROVE + verdict-less", () => {
    expect(
      aggregateWorkerVerdicts({
        a: contribution({ body: { verdict: "APPROVE" } as never }),
        b: contribution({ raw_md: "no body verdict" }),
      }),
    ).toBe("APPROVE");
    // (the verdict-less contribution is filtered, doesn't drag to COMMENT)
  });

  it("ignores withdrawn contributions", () => {
    expect(
      aggregateWorkerVerdicts({
        a: contribution({
          body: { verdict: "REQUEST_CHANGES" } as never,
          withdrawn: true,
        }),
        b: contribution({ body: { verdict: "APPROVE" } as never }),
      }),
    ).toBe("APPROVE");
  });
});

describe("mostConservative", () => {
  it("REQUEST_CHANGES > CONCERNS > COMMENT > APPROVE", () => {
    expect(mostConservative("APPROVE", "COMMENT")).toBe("COMMENT");
    expect(mostConservative("COMMENT", "CONCERNS")).toBe("CONCERNS");
    expect(mostConservative("CONCERNS", "REQUEST_CHANGES")).toBe("REQUEST_CHANGES");
    expect(mostConservative("REQUEST_CHANGES", "APPROVE")).toBe("REQUEST_CHANGES");
  });

  it("returns the same value when both arguments are equal", () => {
    expect(mostConservative("APPROVE", "APPROVE")).toBe("APPROVE");
  });
});

describe("applyDowngradeOnlyFloor — RFC D3 + G1 implementation primitive", () => {
  it("passes through LLM verdict unchanged when NO contribution has structured verdict (modern default)", () => {
    const contributions: Record<string, RoomContribution> = {
      a: contribution({ raw_md: "free-form prose" }),
      b: contribution({ raw_md: "more prose" }),
    };
    expect(applyDowngradeOnlyFloor("APPROVE", contributions)).toBe("APPROVE");
    expect(applyDowngradeOnlyFloor("COMMENT", contributions)).toBe("COMMENT");
    expect(applyDowngradeOnlyFloor("REQUEST_CHANGES", contributions)).toBe(
      "REQUEST_CHANGES",
    );
  });

  it("clamps LLM APPROVE to floor when ANY structured verdict says CONCERNS", () => {
    const contributions: Record<string, RoomContribution> = {
      a: contribution({ body: { verdict: "CONCERNS" } as never }),
      b: contribution({ raw_md: "no body" }),
    };
    expect(applyDowngradeOnlyFloor("APPROVE", contributions)).toBe("CONCERNS");
  });

  it("does NOT raise LLM verdict above structural floor (downgrade-only)", () => {
    const contributions: Record<string, RoomContribution> = {
      a: contribution({ body: { verdict: "APPROVE" } as never }),
    };
    // Floor would say APPROVE; LLM says REQUEST_CHANGES. The function
    // returns the more conservative one (REQUEST_CHANGES) — downgrade-
    // only means LLM may downgrade further, not that floor caps from above.
    expect(applyDowngradeOnlyFloor("REQUEST_CHANGES", contributions)).toBe(
      "REQUEST_CHANGES",
    );
  });

  it("THE TRAP — naive floor with no structured verdicts would clamp APPROVE to COMMENT; this function correctly does not", () => {
    // This is the test that documents the load-bearing safety
    // property from RFC D3's "Implementation primitive" note.
    // A naive PR 3 implementation that called raw aggregateWorkerVerdicts
    // would return COMMENT here and silently break every merge.
    const contributions: Record<string, RoomContribution> = {
      a: contribution({ raw_md: "looks good to me" }),
      b: contribution({ raw_md: "lgtm" }),
    };
    expect(aggregateWorkerVerdicts(contributions)).toBe("COMMENT"); // raw floor
    expect(applyDowngradeOnlyFloor("APPROVE", contributions)).toBe("APPROVE"); // floor disabled
  });
});

describe("VERDICT_VALUES — canonical enum exported for consumer schemas", () => {
  it("contains exactly the four §S2 verdicts in conservatism order", () => {
    expect(VERDICT_VALUES).toEqual([
      "APPROVE",
      "COMMENT",
      "CONCERNS",
      "REQUEST_CHANGES",
    ]);
  });

  it("is the type-level pin for consumer-side z.enum() schemas (pass-4)", () => {
    // Each consumer (bot synthesizer, web resolve-action) builds its
    // own zod schema from this constant. The shared package itself
    // intentionally imports no zod — see queen-verdict.ts header for
    // the file:-symlink-resolution rationale.
    expect(VERDICT_VALUES.length).toBe(4);
  });
});
