/**
 * Smoke test that the @hivemoot/war-room Zod schema validates correctly
 * under web's runtime zod, not just shared's devDependency zod (guard
 * pass-1 on PR #642 G2: "dual-zod risk").
 *
 * The shared package declares zod as a peerDependency `^3.25.0 || ^4.0.0`
 * and ships its built dist/ that imports zod by bare specifier. Whichever
 * zod web resolves transitively (or, post-fix, declares directly) is
 * the runtime that validates the resolve-action body when PR 3b ships
 * the endpoint. This test exercises that exact path: import the schema
 * from the package, pass it through the SAME validation surface
 * `parseBody` uses, and check the structural defenses still hold.
 *
 * If web ever upgrades to a zod version that doesn't accept the
 * shared package's schema shape, this test fails before the broken
 * resolve-action body shows up at runtime.
 */

import { describe, it, expect } from "vitest";
import { DerivedVerdictSchema, VERDICT_VALUES } from "@hivemoot/war-room";

describe("@hivemoot/war-room queen-verdict Zod schema runtime (web)", () => {
  it("VERDICT_VALUES is the §S2 enum (guards against accidental reordering)", () => {
    expect([...VERDICT_VALUES]).toEqual([
      "APPROVE",
      "COMMENT",
      "CONCERNS",
      "REQUEST_CHANGES",
    ]);
  });

  it("accepts a valid {verdict, reasoning} payload", () => {
    const result = DerivedVerdictSchema.safeParse({
      verdict: "APPROVE",
      reasoning: "all reviewers approved without concerns",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an out-of-enum verdict value (prompt-injection defense)", () => {
    const result = DerivedVerdictSchema.safeParse({
      verdict: "APPROVE_PLUS",
      reasoning: "test",
    });
    expect(result.success).toBe(false);
  });

  it("rejects reasoning over the 500-char cap", () => {
    const result = DerivedVerdictSchema.safeParse({
      verdict: "APPROVE",
      reasoning: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing fields (resolve-action body must be complete)", () => {
    const result = DerivedVerdictSchema.safeParse({ verdict: "APPROVE" });
    expect(result.success).toBe(false);
  });

  it("rejects non-string reasoning", () => {
    const result = DerivedVerdictSchema.safeParse({
      verdict: "APPROVE",
      reasoning: 12345,
    });
    expect(result.success).toBe(false);
  });
});
