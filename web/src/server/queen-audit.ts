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
/**
 * RFC G11 specifies BOTH `per-bearer-per-minute AND
 * per-installation-per-minute` caps. Per-bearer protects against a
 * single buggy/compromised bearer; per-installation aggregate
 * protects against multiple valid bearers in the same installation
 * each consuming their per-bearer quota (e.g. queen + dispatcher
 * + apiarist = 3 × 60 = 180/min — too much GitHub-mint + audit-write
 * surface).
 *
 * Per-installation cap = 4× per-bearer. Allows 4 healthy bearers
 * at full per-bearer rate (queen + dispatcher + apiarist + a
 * cushion), blocks the obvious abuse case where many bearers
 * coordinate.
 */
const RESOLVE_ACTION_RATE_LIMIT_WINDOW_SECS = 60;
const RESOLVE_ACTION_PER_BEARER_MAX = 60;
const RESOLVE_ACTION_PER_INSTALLATION_MAX = 240;

function perBearerRateLimitKey(installationId: string, fingerprint: string): string {
  return `hive:v1:queen:rl:resolve-action:${installationId}:${fingerprint}`;
}

function perInstallationRateLimitKey(installationId: string): string {
  return `hive:v1:queen:rl:resolve-action:${installationId}:_install`;
}

/**
 * Which counter hit the limit. The 429 response uses this to tell
 * the caller whether retrying with a DIFFERENT bearer would help
 * (per_bearer: yes; per_installation: no, the whole installation
 * is over budget).
 */
export type RateLimitScope = "per_bearer" | "per_installation";

/**
 * Check + increment BOTH rate-limit counters (RFC G11).
 *
 * Both counters use the INCR + EXPIRE-on-first pattern. Increments
 * happen in parallel against a fresh window each (separate keys
 * with the same 60s TTL). Either counter being over its cap returns
 * `allowed: false` with the offending scope.
 *
 * Pass-2 builder fix: previously only per-bearer was checked. RFC
 * G11 (docs/architecture/QUEEN_EXECUTION_MODE.md:672) requires
 * both per-bearer AND per-installation. The aggregate prevents
 * coordinated multi-bearer floods that would each be under their
 * per-bearer quota.
 *
 * Why increment BOTH even if one is already over: the per-bearer
 * counter still ticks on a rejected request (matches typical
 * fail-fast rate limit semantics). Operators see continued churn
 * in the metric, which is the signal they need.
 */
export async function checkResolveActionRateLimit(args: {
  redis: Redis;
  installationId: string;
  fingerprint: string;
}): Promise<
  | { allowed: true }
  | {
      allowed: false;
      scope: RateLimitScope;
      currentCount: number;
      resetAtSecs: number;
    }
> {
  const bearerKey = perBearerRateLimitKey(args.installationId, args.fingerprint);
  const installKey = perInstallationRateLimitKey(args.installationId);

  // Increment both in parallel. Order of failures: report per-bearer
  // first if both are over (queen sees "your bearer is hot" before
  // "the whole installation is hot" — actionable signal for them).
  const [bearerCount, installCount] = await Promise.all([
    args.redis.incr(bearerKey),
    args.redis.incr(installKey),
  ]);

  // Set TTLs on first request of each window — bearer and install
  // counters have independent first-of-window timing.
  if (bearerCount === 1) {
    await args.redis.expire(bearerKey, RESOLVE_ACTION_RATE_LIMIT_WINDOW_SECS);
  }
  if (installCount === 1) {
    await args.redis.expire(installKey, RESOLVE_ACTION_RATE_LIMIT_WINDOW_SECS);
  }

  if (bearerCount > RESOLVE_ACTION_PER_BEARER_MAX) {
    const ttl = await args.redis.ttl(bearerKey);
    return {
      allowed: false,
      scope: "per_bearer",
      currentCount: bearerCount,
      resetAtSecs:
        typeof ttl === "number" && ttl > 0
          ? ttl
          : RESOLVE_ACTION_RATE_LIMIT_WINDOW_SECS,
    };
  }

  if (installCount > RESOLVE_ACTION_PER_INSTALLATION_MAX) {
    const ttl = await args.redis.ttl(installKey);
    return {
      allowed: false,
      scope: "per_installation",
      currentCount: installCount,
      resetAtSecs:
        typeof ttl === "number" && ttl > 0
          ? ttl
          : RESOLVE_ACTION_RATE_LIMIT_WINDOW_SECS,
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
  perBearerMax: RESOLVE_ACTION_PER_BEARER_MAX,
  perInstallationMax: RESOLVE_ACTION_PER_INSTALLATION_MAX,
} as const;
