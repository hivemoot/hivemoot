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
import { auditAppend, auditAppendSync } from "./agent-token-v1-audit";
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
  try {
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
  } catch (err) {
    // Defense-in-depth: the underlying auditAppend already
    // catches internally, but the queen-audit module exports the
    // stronger "never throws" contract that the resolve-action
    // endpoint (slice 2c-b) will rely on. Wrap explicitly so a
    // future change to auditAppend can't surprise callers.
    console.warn(
      `[queen-audit] emitQueenVerdictFloorOverride failed for installation=${args.installationId} room=${args.detail.room_id}`,
      err,
    );
  }
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
  try {
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
  } catch (err) {
    console.warn(
      `[queen-audit] emitQueenActionDowngrade failed for installation=${args.installationId} room=${args.detail.room_id}`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Baseline resolve-action audit (RFC endpoint contract — audit_id return)
// ---------------------------------------------------------------------------

/**
 * `detail` payload for `queen.resolve_action` — the baseline audit
 * row written on EVERY successful resolve-action call. The XADD
 * entry ID is returned to the caller as `audit_id` so the upcoming
 * `seal-decision` endpoint can verify the public comment header
 * against the canonical decision row (RFC G17 + endpoint contract).
 *
 * Per RFC, seal-decision rejects if the operator-side comment URL
 * doesn't carry a header referencing this `audit_id` — closes the
 * gap where the queen could post a comment that doesn't match what
 * the server permitted at resolve-action time.
 */
export interface QueenResolveActionDetail {
  room_id: string;
  subject_ref: string;
  /** What the queen wanted. */
  recommended_action: "comment" | "squash-merge";
  /** What the server permitted (min of queen's choice + D1 ceiling). */
  permitted_action: "comment" | "squash-merge";
  /** Clamped verdict (post-applyDowngradeOnlyFloor). */
  clamped_verdict: WorkerVerdict;
  /** Submitted by queen — the SHA they synthesized against. */
  reviewed_head_sha: string;
  /** Observed by server at decision time — may differ on drift. */
  current_head_sha: string;
  /** Non-null if D1 forced a downgrade; null on all-pass. */
  downgrade_reason: DowngradeReason | null;
  /** True if applyDowngradeOnlyFloor changed the verdict from the
   * queen's submitted one (cross-correlate with
   * `queen.verdict_floor_override` emitted earlier in the request). */
  floor_overridden: boolean;
}

/**
 * Emit the baseline `queen.resolve_action` audit row. Returns the
 * stream entry ID (the `audit_id` the route returns to the caller).
 *
 * NOT fire-and-forget — Redis failures propagate. The audit_id is
 * load-bearing for the seal-decision endpoint's comment-header
 * verification (RFC G17), so a silently-dropped audit row would
 * break the next slice's contract. Callers should let the route
 * fail with 500 storage_failure if this throws.
 */
export async function emitQueenResolveAction(
  args: QueenAuditCallerContext & { detail: QueenResolveActionDetail },
): Promise<string> {
  return auditAppendSync({
    redis: args.redis,
    installationId: args.installationId,
    entry: {
      ts: new Date().toISOString(),
      fingerprint: args.fingerprint,
      name: args.name,
      action: "queen.resolve_action",
      actor: args.name,
      detail: args.detail as unknown as Record<string, unknown>,
    },
  });
}

// ---------------------------------------------------------------------------
// Per-bearer rate limit (RFC G11)
// ---------------------------------------------------------------------------

/**
 * Hard ceiling: 60 resolve-action calls per minute per (installation,
 * bearer fingerprint). Healthy queens make ~1 call per room per
 * synthesis tick; an installation with 20 active rooms would
 * comfortably stay under this even at 1-minute ticks. The limit
 * catches:
 *
 *   - A buggy queen looping on the same claim
 *   - A compromised bearer trying to fan out reads + audit writes
 *     across many rooms
 *   - A queen retrying without backoff after a transient failure
 *
 * Using a simple INCR + EXPIRE-on-first counter (vs. a sliding
 * window): one Redis call per request, bounded keyspace
 * (per-bearer-per-installation), drops naturally after the TTL.
 */
const RESOLVE_ACTION_RATE_LIMIT_WINDOW_SECS = 60;
const RESOLVE_ACTION_RATE_LIMIT_MAX = 60;

function rateLimitKey(installationId: string, fingerprint: string): string {
  return `hive:v1:queen:rl:resolve-action:${installationId}:${fingerprint}`;
}

/**
 * Check + increment the rate-limit counter atomically.
 *
 * Returns `{ allowed: true }` when the call is permitted (counter
 * incremented). Returns `{ allowed: false, currentCount,
 * resetAtSecs }` when the rate limit is exceeded — the route
 * surfaces this as 429 with `Retry-After: resetAtSecs`.
 *
 * Uses the standard INCR + EXPIRE-on-first pattern: increment
 * unconditionally, then EXPIRE only on the first request of the
 * window (when INCR returns 1). The TTL is window length —
 * 60 seconds.
 */
export async function checkResolveActionRateLimit(args: {
  redis: Redis;
  installationId: string;
  fingerprint: string;
}): Promise<
  | { allowed: true }
  | { allowed: false; currentCount: number; resetAtSecs: number }
> {
  const key = rateLimitKey(args.installationId, args.fingerprint);
  const count = await args.redis.incr(key);
  if (count === 1) {
    // First request of the window — set the TTL.
    await args.redis.expire(key, RESOLVE_ACTION_RATE_LIMIT_WINDOW_SECS);
  }
  if (count > RESOLVE_ACTION_RATE_LIMIT_MAX) {
    // Get remaining TTL for the Retry-After hint. Use PTTL? In
    // Upstash, `ttl` returns seconds (or -1 / -2 sentinels).
    const remainingTtl = await args.redis.ttl(key);
    const resetAtSecs =
      typeof remainingTtl === "number" && remainingTtl > 0
        ? remainingTtl
        : RESOLVE_ACTION_RATE_LIMIT_WINDOW_SECS;
    return {
      allowed: false,
      currentCount: count,
      resetAtSecs,
    };
  }
  return { allowed: true };
}

/**
 * Test seam — exposed for direct unit tests on the rate-limit
 * constants. Production callers use `checkResolveActionRateLimit`.
 */
export const RESOLVE_ACTION_RATE_LIMIT = {
  windowSecs: RESOLVE_ACTION_RATE_LIMIT_WINDOW_SECS,
  max: RESOLVE_ACTION_RATE_LIMIT_MAX,
} as const;
