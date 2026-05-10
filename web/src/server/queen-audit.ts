/**
 * Queen-audit emit primitives for the local-queen runtime
 * (RFC PR 3c slice 2c-a foundation).
 *
 * Per the RFC, the queen's `resolve-action` endpoint emits two
 * audit event classes when the queen's submitted verdict / action
 * is overridden by server-side policy:
 *
 *   - G1 `queen.verdict_floor_override` — emitted when
 *     `applyDowngradeOnlyFloor` clamps the queen's submitted
 *     verdict (any worker contribution carries a structured
 *     `body.verdict` that's more conservative than the queen's
 *     LLM-derived verdict). This is the structural defense against
 *     prompt-injection-shaped queen verdicts.
 *
 *   - G2 `queen.action_downgrade` — emitted when the D1 invariant
 *     check forces `permittedAction: "comment"` despite the queen's
 *     `recommendedAction: "squash-merge"`. The `downgrade_reason`
 *     field is the first failed D1 invariant (see
 *     `resolve-action-policy.ts` for the order).
 *
 * # Stream choice
 *
 * Reuses the existing per-installation `:audit` stream
 * (`hive:v1:agent-token:{installationId}:audit`) rather than
 * introducing a new stream. Rationale:
 *
 *   - Storage rent is amortized across the agent-token audit
 *     events already there. Same retention math (MAXLEN ~10000),
 *     same per-installation isolation.
 *   - Operators forensic-grep the audit stream by installation +
 *     date range; having queen events in the same stream means a
 *     single jq pipeline covers both token mutations and queen
 *     actions.
 *   - The action enum's `queen.*` prefix keeps the two event
 *     classes filterable without a stream split.
 *
 * The agent-token audit emitter (`auditAppend` in
 * `agent-token-v1-audit.ts`) is the underlying primitive — this
 * module is a thin typed wrapper that constructs the
 * `AuditMutationEntry` payload with the queen-specific `detail`
 * shape, then delegates to `auditAppend`.
 *
 * # Best-effort emission
 *
 * Inherits the underlying `auditAppend` semantics: emission
 * failures are logged but do not throw. A Redis hiccup at audit
 * emission time MUST NOT fail the operator's resolve-action call —
 * the room state hasn't mutated (resolve-action is advisory) so
 * the worst case is a missing audit row, not a wedged room.
 */

import { type Redis } from "@upstash/redis";
import { auditAppend } from "./agent-token-v1-audit";
import type { WorkerVerdict } from "@hivemoot/war-room";
import type { DowngradeReason } from "./resolve-action-policy";

// ---------------------------------------------------------------------------
// Detail payload shapes
// ---------------------------------------------------------------------------

/**
 * `detail` payload for `queen.verdict_floor_override` (G1).
 *
 * The queen submitted `submittedVerdict` from its LLM derivation.
 * The structural floor (`aggregateWorkerVerdicts` over structured
 * worker contributions) computed `floorVerdict`. `applyDowngradeOnlyFloor`
 * returned `clampedVerdict` = `mostConservative(submittedVerdict, floorVerdict)`.
 * This event fires whenever `submittedVerdict !== clampedVerdict`.
 *
 * Operators audit this stream to detect:
 *   - Queen submitting non-conservative verdicts despite worker
 *     contributions saying otherwise (signal: worker is more
 *     careful than the queen on this room).
 *   - Prompt-injection shaped queen output that the floor caught.
 */
export interface QueenVerdictFloorOverrideDetail {
  room_id: string;
  /** Room's `subject_ref` for human-readable correlation. */
  subject_ref: string;
  /** What the queen submitted (LLM output). */
  submitted_verdict: WorkerVerdict;
  /** What the structural floor computed (from worker contributions). */
  floor_verdict: WorkerVerdict;
  /** What the endpoint will USE (most conservative of the two). */
  clamped_verdict: WorkerVerdict;
}

/**
 * `detail` payload for `queen.action_downgrade` (G2).
 *
 * The queen submitted `recommendedAction` (typically `"squash-merge"`).
 * The D1 invariant check found one failed invariant and forced
 * `permittedAction: "comment"`. `downgrade_reason` is the FIRST
 * failed invariant in the policy evaluation order (see
 * `resolve-action-policy.ts:evaluateResolveActionPolicy` for the
 * order pin).
 */
export interface QueenActionDowngradeDetail {
  room_id: string;
  subject_ref: string;
  /** What the queen wanted to do. */
  recommended_action: "comment" | "squash-merge";
  /** What the endpoint permitted (always `"comment"` when this
   * event fires — squash-merge events aren't downgrades). */
  permitted_action: "comment";
  /** First failed D1 invariant. */
  downgrade_reason: DowngradeReason;
  /** Clamped verdict at time of decision (for cross-correlation
   * with `queen.verdict_floor_override` events on the same room). */
  clamped_verdict: WorkerVerdict;
  /** Queen-submitted `reviewed_head_sha` (the SHA the queen
   * synthesized against). Useful for diagnostics when downgrade
   * is `head_sha_drift`. */
  reviewed_head_sha: string;
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

/**
 * Common bearer-identity arguments. Carried on the audit entry's
 * `BaseAuditEntry` fields. Match what the agent-token audit
 * emitter writes for caller correlation.
 */
export interface QueenAuditCallerContext {
  installationId: string;
  redis: Redis;
  /** Bearer's name (e.g. `"queen"` for the local-queen runner). */
  name: string;
  /** First 8 hex chars of SHA-256(bearer). */
  fingerprint: string;
}

/**
 * Emit G1 `queen.verdict_floor_override` audit event.
 *
 * Fire-and-forget — never throws. Always pair with the route's
 * response: emit BEFORE returning the policy decision so a Redis
 * hiccup doesn't lose the audit context.
 */
export async function emitQueenVerdictFloorOverride(
  args: QueenAuditCallerContext & {
    detail: QueenVerdictFloorOverrideDetail;
  },
): Promise<void> {
  await auditAppend({
    redis: args.redis,
    installationId: args.installationId,
    entry: {
      ts: new Date().toISOString(),
      fingerprint: args.fingerprint,
      name: args.name,
      action: "queen.verdict_floor_override",
      actor: args.name,
      detail: args.detail as unknown as Record<string, unknown>,
    },
  });
}

/**
 * Emit G2 `queen.action_downgrade` audit event.
 *
 * Same semantics as the G1 emitter — fire-and-forget, always pair
 * with the response, never throws.
 */
export async function emitQueenActionDowngrade(
  args: QueenAuditCallerContext & {
    detail: QueenActionDowngradeDetail;
  },
): Promise<void> {
  await auditAppend({
    redis: args.redis,
    installationId: args.installationId,
    entry: {
      ts: new Date().toISOString(),
      fingerprint: args.fingerprint,
      name: args.name,
      action: "queen.action_downgrade",
      actor: args.name,
      detail: args.detail as unknown as Record<string, unknown>,
    },
  });
}
