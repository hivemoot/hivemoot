/**
 * Pure verdict primitives shared between bot (cloud queen-tick
 * synthesizer) and web (resolve-action endpoint).
 *
 * # What lives here
 *
 * - `WorkerVerdict` — the §S2 verdict enum
 * - `VERDICT_VALUES` — the canonical readonly tuple consumers build
 *   their own validation schemas from (see "Why no zod" below)
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
 * retry helpers, BYOK envelope).
 *
 * # Why no zod (pass-4 fix; supersedes pass-2 peerDep approach)
 *
 * An earlier draft exported a `DerivedVerdictSchema` zod object
 * from this file. Pass-2 tried to make it work via
 * `peerDependencies: { zod }` + adding zod to web. Builder pass-3
 * confirmed that STILL broke a fresh `web npm ci && npm run build`
 * because web reaches the shared package via a `file:../shared/war-room`
 * symlink, and Next.js's symlink-resolved module resolution walks
 * the shared package's *real-path* parents (none of which contain
 * `zod`), not web's hoisted `node_modules/`. peerDependencies are
 * a declaration of intent, not a hoisting mechanism — npm doesn't
 * install peer deps into the consumer for `file:` deps.
 *
 * Fix: keep this module dependency-free. Export only the
 * `VERDICT_VALUES` enum constant; let each consumer build its own
 * `z.enum(VERDICT_VALUES)` schema with its own zod install. Two
 * short `z.object` declarations is cheaper than the build-time
 * package-resolution surgery, and avoids the dual-zod
 * runtime-instance hazard (two zod copies producing
 * non-assignable types).
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
import type { RoomContribution } from "./war-room.js";
/**
 * Verdict enum from `WAR_ROOM_DESIGN.md` §S2. Validated at
 * `/contribute` write time, so any value reaching the queen has
 * been server-checked. Order matters for aggregation: the
 * most-conservative wins.
 */
export type WorkerVerdict = "APPROVE" | "COMMENT" | "CONCERNS" | "REQUEST_CHANGES";
export declare const VERDICT_VALUES: readonly ["APPROVE", "COMMENT", "CONCERNS", "REQUEST_CHANGES"];
/**
 * Shape consumers must enforce at runtime against any LLM-derived
 * or operator-submitted verdict envelope. This is the canonical
 * description of the schema; each consumer (bot synthesizer, web
 * resolve-action endpoint) builds its own zod schema from
 * `VERDICT_VALUES` using its own zod install. See module header
 * for the dep-resolution rationale.
 *
 * Reference schema (consumers should mirror exactly):
 *   z.object({
 *     verdict: z.enum(VERDICT_VALUES),
 *     reasoning: z.string().max(500),
 *   })
 *
 * The `reasoning` field is for ops audit; not surfaced to users.
 */
export interface DerivedVerdict {
    verdict: WorkerVerdict;
    reasoning: string;
}
/**
 * Extract a validated `WorkerVerdict` from one contribution's body.
 * Returns null when:
 *   - body is missing entirely (only `raw_md` — modern default)
 *   - body.verdict is missing or not one of the valid enums
 * Null-returning paths fall through to the `COMMENT` default in
 * `aggregateWorkerVerdicts`.
 */
export declare function extractContributionVerdict(contribution: RoomContribution): WorkerVerdict | null;
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
export declare function aggregateWorkerVerdicts(contributions: Record<string, RoomContribution>): WorkerVerdict;
/**
 * §S2 ordering: REQUEST_CHANGES > CONCERNS > COMMENT > APPROVE.
 * "Most conservative" returns the verdict closer to REQUEST_CHANGES.
 */
export declare function mostConservative(a: WorkerVerdict, b: WorkerVerdict): WorkerVerdict;
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
export declare function applyDowngradeOnlyFloor(llmVerdict: WorkerVerdict, contributions: Record<string, RoomContribution>): WorkerVerdict;
//# sourceMappingURL=queen-verdict.d.ts.map