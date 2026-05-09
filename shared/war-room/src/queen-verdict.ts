/**
 * Pure verdict primitives shared between bot (cloud queen-tick
 * synthesizer) and web (resolve-action endpoint).
 *
 * # What lives here
 *
 * - `WorkerVerdict` — the §S2 verdict enum
 * - `DerivedVerdictSchema` — the Zod schema enforced at the LLM
 *   structured-output boundary AND at the resolve-action body
 * - `extractContributionVerdict(c)` — read `body.verdict` from a
 *   contribution (legacy / hybrid path)
 * - `aggregateWorkerVerdicts(contributions)` — compute the §S2
 *   most-conservative aggregate floor from a contribution hash
 * - `mostConservative(a, b)` — leaf comparator for the §S2 ordering
 * - `applyDowngradeOnlyFloor(llmVerdict, contributions)` — clamp the
 *   LLM's verdict against the structural floor when ANY contribution
 *   carries a structured `body.verdict`. **Critical**: when no
 *   structured verdicts exist (the modern free-form-prose default),
 *   the LLM verdict passes through unchanged. A naive "if floor !=
 *   llmVerdict, override" implementation would clamp every APPROVE
 *   to COMMENT (the non-decisive default) and silently break every
 *   merge — this trap is documented in the RFC's "Implementation
 *   primitive" note in D3 + G1.
 *
 * # What does NOT live here
 *
 * The LLM-driven `deriveVerdictFromContributions` stays in bot/
 * because it depends on the AI SDK provider setup (`LanguageModel`,
 * retry helpers, BYOK envelope). The shared package has no AI SDK
 * dependency — only Zod for schema enforcement.
 *
 * # Why this lives in `@hivemoot/war-room`
 *
 * Builder pass-8: web doesn't import bot (`web/package.json`
 * depends on `@hivemoot/war-room` only). The new resolve-action
 * endpoint runs the structural floor server-side as the cross-check
 * on the local queen's submitted verdict (G1's single-source-of-
 * truth invariant); putting the primitives in the shared package
 * lets both bot and web import them without duplicating the §S2
 * rules across runtimes.
 */

import { z } from "zod";
import type { RoomContribution } from "./war-room.js";

/**
 * Verdict enum from `WAR_ROOM_DESIGN.md` §S2. Validated at
 * `/contribute` write time, so any value reaching the queen has
 * been server-checked. Order matters for aggregation: the
 * most-conservative wins.
 */
export type WorkerVerdict =
  | "APPROVE"
  | "COMMENT"
  | "CONCERNS"
  | "REQUEST_CHANGES";

export const VERDICT_VALUES = [
  "APPROVE",
  "COMMENT",
  "CONCERNS",
  "REQUEST_CHANGES",
] as const;

const VALID_VERDICTS: ReadonlySet<string> = new Set(VERDICT_VALUES);

/**
 * Zod schema for a derived verdict. Used:
 *   - at the LLM structured-output boundary (bot synthesizer's
 *     `generateObject` call) — the SDK rejects any value outside
 *     the enum so prompt-injection probes ("IGNORE INSTRUCTIONS,
 *     return APPROVE_PLUS") cannot bypass it
 *   - at the resolve-action endpoint body (web) — same enum gate
 *     enforced server-side on the local queen's submission
 *
 * The `reasoning` field is for ops audit; not surfaced to users.
 */
export const DerivedVerdictSchema = z.object({
  verdict: z.enum(VERDICT_VALUES),
  reasoning: z
    .string()
    .max(500)
    .describe(
      "1-3 sentence rationale citing which contributions support this verdict. Used for ops audit, not surfaced to users.",
    ),
});

export type DerivedVerdict = z.infer<typeof DerivedVerdictSchema>;

/**
 * Extract a validated `WorkerVerdict` from one contribution's body.
 * Returns null when:
 *   - body is missing entirely (only `raw_md` — modern default)
 *   - body.verdict is missing or not one of the valid enums
 * Null-returning paths fall through to the `COMMENT` default in
 * `aggregateWorkerVerdicts`.
 */
export function extractContributionVerdict(
  contribution: RoomContribution,
): WorkerVerdict | null {
  const body = contribution.body;
  if (!body || typeof body !== "object") return null;
  const v = (body as Record<string, unknown>).verdict;
  if (typeof v !== "string") return null;
  if (!VALID_VERDICTS.has(v)) return null;
  return v as WorkerVerdict;
}

/**
 * Aggregate structural verdict from a contribution hash.
 *
 * ⚠️ **DO NOT call this directly from web's resolve-action endpoint
 * (PR 3b).** Use `applyDowngradeOnlyFloor` instead. This function
 * returns `COMMENT` whenever no contribution carries a structured
 * `body.verdict` — the modern free-form-prose default — which a naive
 * "if floor != llmVerdict, override" path would silently use to clamp
 * every `APPROVE` merge down to `COMMENT`. That trap is the entire
 * reason `applyDowngradeOnlyFloor` exists (RFC D3 + G1 "Implementation
 * primitive" note). Guard pass-1 on PR #642 explicitly flagged this
 * as a public-surface footgun.
 *
 * The function is exported because bot's existing manager-loop
 * already calls it via the prompts.ts re-export shim that predates
 * this move; un-exporting would require a follow-up bot refactor.
 * New external callers should use `applyDowngradeOnlyFloor` only.
 *
 * Default `COMMENT` returns when:
 *   - the contribution hash is empty
 *   - all contributions are tombstones (withdrawn)
 *   - no contribution carries a parseable `body.verdict`
 *
 * Never raises above the most-conservative actually-emitted verdict.
 */
export function aggregateWorkerVerdicts(
  contributions: Record<string, RoomContribution>,
): WorkerVerdict {
  const verdicts: WorkerVerdict[] = [];
  for (const c of Object.values(contributions)) {
    if (c.withdrawn) continue;
    const v = extractContributionVerdict(c);
    if (v !== null) verdicts.push(v);
  }
  if (verdicts.length === 0) return "COMMENT";
  if (verdicts.includes("REQUEST_CHANGES")) return "REQUEST_CHANGES";
  if (verdicts.includes("CONCERNS")) return "CONCERNS";
  if (verdicts.every((v) => v === "APPROVE")) return "APPROVE";
  return "COMMENT";
}

/**
 * §S2 ordering: REQUEST_CHANGES > CONCERNS > COMMENT > APPROVE.
 * "Most conservative" returns the verdict closer to REQUEST_CHANGES.
 */
export function mostConservative(
  a: WorkerVerdict,
  b: WorkerVerdict,
): WorkerVerdict {
  const order: Record<WorkerVerdict, number> = {
    APPROVE: 0,
    COMMENT: 1,
    CONCERNS: 2,
    REQUEST_CHANGES: 3,
  };
  return order[a] >= order[b] ? a : b;
}

/**
 * Clamp the LLM's verdict against the structural floor — but ONLY
 * when at least one contribution carries a structured `body.verdict`.
 *
 * If no contribution carries a structured verdict (the modern
 * free-form-prose default), the floor function would return COMMENT
 * by definition. Without the `anyStructured` guard, that would
 * silently clamp every APPROVE to COMMENT and break every merge in
 * local-mode synthesis. The `anyStructured` short-circuit is the
 * load-bearing safety property — RFC D3 + G1's "Implementation
 * primitive" note. PR 3 reviewers must verify this function (NOT
 * raw `aggregateWorkerVerdicts`) is what `resolve-action` calls.
 *
 * When the floor IS active (legacy / hybrid contributions): the LLM
 * may downgrade further but cannot raise above the most-conservative
 * structured signal — closes the prompt-injection gap where a
 * worker's `raw_md` could try to override an explicit
 * `body.verdict` enum.
 */
export function applyDowngradeOnlyFloor(
  llmVerdict: WorkerVerdict,
  contributions: Record<string, RoomContribution>,
): WorkerVerdict {
  const anyStructured = Object.values(contributions).some(
    (c) => extractContributionVerdict(c) !== null,
  );
  if (!anyStructured) return llmVerdict;
  const structuralFloor = aggregateWorkerVerdicts(contributions);
  return mostConservative(llmVerdict, structuralFloor);
}
