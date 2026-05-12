/**
 * POST /api/rooms/:roomId/resolve-action — local-queen advisory
 * endpoint (RFC PR 3c slice 2c-b).
 *
 * The local queen's synthesis flow:
 *
 *   1. Poll `synthesis-ready` → see rooms in `awaiting_contributions`
 *   2. POST `claim-synthesis` → transitions `awaiting → deciding`,
 *      returns room core + participants + contributions + claim
 *      throughSequence
 *   3. Run LLM verdict derivation locally
 *   4. Capture `reviewed_head_sha` from GitHub (`gh pr view --json
 *      headRefOid`) — the queen's view of the PR state at synthesis
 *      time
 *   5. **POST this endpoint** with the derived verdict +
 *      recommended action + reviewed_head_sha. Server returns the
 *      permitted action (D1 server-side invariants).
 *   6. Post the action's comment / merge intent to GitHub
 *   7. POST `seal-decision` with the verified comment URL (slice 2d)
 *
 * # What this endpoint does
 *
 *   - Validates the claim is held by this queenRunner with the
 *     expected throughSequence (no drift).
 *   - Applies `applyDowngradeOnlyFloor` to the queen's submitted
 *     verdict using the room's contributions (RFC G1 — structural
 *     floor protects against prompt-injection-shaped LLM output).
 *     Emits `queen.verdict_floor_override` audit event if clamping
 *     changes the verdict.
 *   - Reads live GitHub state (labels, CI, head SHA) for the room's
 *     subject PR via `getPullRequestState`.
 *   - Evaluates D1 merge invariants via `evaluateResolveActionPolicy`.
 *     Permits `squash-merge` only when all hold; else downgrades to
 *     `comment` with a typed `DowngradeReason`.
 *   - Emits `queen.action_downgrade` audit event when the queen's
 *     `recommendedAction` differs from the server-computed
 *     `permittedAction`.
 *
 * # What this endpoint does NOT do
 *
 *   - **No room state mutation.** This is advisory. The state
 *     transition (`deciding → decided_pending_action` or `closed`)
 *     happens at `seal-decision` (slice 2d), AFTER the queen posts
 *     the comment / merge-intent to GitHub.
 *   - Does not call GitHub for the merge or comment itself — the
 *     queen does that from its hive container via `gh`.
 *
 * # Error envelopes
 *
 *   - 401 not_authenticated / agent_auth_v1_*
 *   - 403 capability_denied (`rooms.synthesize` missing)
 *   - 400 invalid_body (Zod-shaped validation failures)
 *   - 404 room_not_found
 *   - 409 invalid_status_for_resolve_action (room not in `deciding`)
 *   - 409 claim_not_held
 *   - 409 claim_runner_mismatch
 *   - 409 sequence_drift (sealedThroughSequence != claim's throughSequence)
 *   - 502 github_read_failed (PR not found / GitHub API error / App auth)
 *   - 500 storage_failure / configuration_error
 *
 * # Response (200)
 *
 *   {
 *     permittedAction: "comment" | "squash-merge",
 *     clampedVerdict: "APPROVE" | "COMMENT" | "CONCERNS" | "REQUEST_CHANGES",
 *     downgradeReason: DowngradeReason | null,
 *     reviewedHeadSha: string,        // echo back
 *     currentHeadSha: string,         // observed by server (may differ on drift)
 *     floorOverridden: boolean,       // true iff applyDowngradeOnlyFloor changed it
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { parseJsonBody } from "@/server/request-utils";
import { validateEnv } from "@/server/env";
import {
  getRoomCore,
  getRoomContributions,
  claimKey,
  applyDowngradeOnlyFloor,
  aggregateWorkerVerdicts,
  RoomNotFoundError,
  RoomIdFormatError,
  type WorkerVerdict,
} from "@hivemoot/war-room";
import {
  mintInstallationToken,
  AppCredentialError,
} from "@/server/github-installation-token";
import type { GitHubPermissionLevel } from "@/server/agent-token-v1";
import {
  getPullRequestState,
  PullRequestNotFoundError,
  GitHubAPIError,
} from "@/server/github-pr-state";
import {
  evaluateResolveActionPolicy,
  parsePullRequestSubjectRef,
} from "@/server/resolve-action-policy";
import {
  emitQueenVerdictFloorOverride,
  emitQueenActionDowngrade,
  emitQueenResolveAction,
  checkResolveActionRateLimit,
} from "@/server/queen-audit";

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

const VALID_VERDICTS: readonly WorkerVerdict[] = [
  "APPROVE",
  "COMMENT",
  "CONCERNS",
  "REQUEST_CHANGES",
];

const VALID_ACTIONS = ["comment", "squash-merge"] as const;
type RecommendedAction = (typeof VALID_ACTIONS)[number];

interface ResolveActionBody {
  queenRunner: string;
  derivedVerdict: { verdict: WorkerVerdict; reasoning: string };
  recommendedAction: RecommendedAction;
  reviewedHeadSha: string;
  sealedThroughSequence: number;
}

function parseResolveActionBody(raw: unknown):
  | { ok: true; body: ResolveActionBody }
  | { ok: false; message: string } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, message: "Body must be a JSON object." };
  }
  const b = raw as Record<string, unknown>;

  if (typeof b.queenRunner !== "string" || b.queenRunner.length === 0) {
    return { ok: false, message: "queenRunner must be a non-empty string." };
  }
  if (b.derivedVerdict === null || typeof b.derivedVerdict !== "object") {
    return { ok: false, message: "derivedVerdict must be an object." };
  }
  const dv = b.derivedVerdict as Record<string, unknown>;
  if (
    typeof dv.verdict !== "string" ||
    !VALID_VERDICTS.includes(dv.verdict as WorkerVerdict)
  ) {
    return {
      ok: false,
      message:
        `derivedVerdict.verdict must be one of ${VALID_VERDICTS.join(", ")}`,
    };
  }
  if (typeof dv.reasoning !== "string") {
    return { ok: false, message: "derivedVerdict.reasoning must be a string." };
  }
  if (dv.reasoning.length > 500) {
    return {
      ok: false,
      message: "derivedVerdict.reasoning must be ≤ 500 characters.",
    };
  }
  if (
    typeof b.recommendedAction !== "string" ||
    !VALID_ACTIONS.includes(b.recommendedAction as RecommendedAction)
  ) {
    return {
      ok: false,
      message: `recommendedAction must be one of ${VALID_ACTIONS.join(", ")}`,
    };
  }
  if (typeof b.reviewedHeadSha !== "string" || b.reviewedHeadSha.length === 0) {
    return {
      ok: false,
      message: "reviewedHeadSha must be a non-empty string.",
    };
  }
  if (
    typeof b.sealedThroughSequence !== "number" ||
    !Number.isInteger(b.sealedThroughSequence) ||
    b.sealedThroughSequence < 0
  ) {
    return {
      ok: false,
      message: "sealedThroughSequence must be a non-negative integer.",
    };
  }

  return {
    ok: true,
    body: {
      queenRunner: b.queenRunner,
      derivedVerdict: {
        verdict: dv.verdict as WorkerVerdict,
        reasoning: dv.reasoning,
      },
      recommendedAction: b.recommendedAction as RecommendedAction,
      reviewedHeadSha: b.reviewedHeadSha,
      sealedThroughSequence: b.sealedThroughSequence,
    },
  };
}

// ---------------------------------------------------------------------------
// Claim verification
// ---------------------------------------------------------------------------

/** Per `ROOM_DECIDE_CLAIM_SCRIPT`, the claim value is JSON
 * `{runner, throughSequence}`. */
interface ClaimPayload {
  runner: string;
  throughSequence: number;
}

function parseClaim(raw: string): ClaimPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.runner !== "string") return null;
    if (typeof p.throughSequence !== "number") return null;
    return { runner: p.runner, throughSequence: p.throughSequence };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-call mint scope — read-only, minimum needed for D1 invariants
// ---------------------------------------------------------------------------

/**
 * Permissions the server-side resolve-action mint requests. Strict
 * read-only — no `pull_requests: write`, no `contents: write`. The
 * queen does the actual GitHub mutation (comment / merge) from its
 * hive container with the bearer it already has; this server-side
 * mint is only for the D1 invariant reads.
 *
 *   - `pull_requests: read` — for labels via /pulls/:n
 *   - `checks: read` — for check-runs status
 *   - `contents: read` — required by GitHub for the
 *     /commits/:sha/status legacy combined-status endpoint
 *   - `metadata: read` — baseline access
 */
const RESOLVE_ACTION_PERMISSIONS: Readonly<
  Record<string, GitHubPermissionLevel>
> = Object.freeze({
  pull_requests: "read",
  checks: "read",
  contents: "read",
  metadata: "read",
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  // ----- auth (rooms.synthesize) -----
  const auth = await authenticateAgentRequestV1(request, {
    requires: "rooms.synthesize",
  });
  if (!auth.ok) return auth.response;

  // ----- rate limit (RFC G11) -----
  // Pass-1 builder fix: cap per-bearer-per-installation BEFORE the
  // expensive GitHub mint/read + audit writes. Healthy queens call
  // once per claim; this catches buggy loops and compromised bearers.
  let rateLimit;
  try {
    rateLimit = await checkResolveActionRateLimit({
      redis: auth.redis,
      installationId: auth.installationId,
      fingerprint: auth.envelope.fingerprint,
    });
  } catch (err) {
    console.error("[rooms.resolve-action] rate limit check failed", {
      installationId: auth.installationId,
      error: err,
    });
    return NextResponse.json(
      {
        code: "storage_failure",
        message: "Failed to check rate limit.",
      },
      { status: 500 },
    );
  }
  if (!rateLimit.allowed) {
    const scopeMessage =
      rateLimit.scope === "per_bearer"
        ? "per-bearer cap (60/min)"
        : "per-installation aggregate cap (240/min)";
    return NextResponse.json(
      {
        code: "rate_limited",
        message:
          `resolve-action rate limit exceeded — hit the ${scopeMessage}. ` +
          `Current count: ${rateLimit.currentCount}. Retry after ` +
          `${rateLimit.resetAtSecs}s.`,
        scope: rateLimit.scope,
        resetAtSecs: rateLimit.resetAtSecs,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.resetAtSecs) },
      },
    );
  }

  const { roomId } = await params;

  // ----- body -----
  const rawBody = await parseJsonBody(request);
  if (!rawBody.ok) {
    return NextResponse.json(
      { code: rawBody.code, message: rawBody.message },
      { status: 400 },
    );
  }
  const parsed = parseResolveActionBody(rawBody.body);
  if (!parsed.ok) {
    return NextResponse.json(
      { code: "invalid_body", message: parsed.message },
      { status: 400 },
    );
  }
  const body = parsed.body;

  // ----- load room core (must be `deciding`) -----
  let roomCore;
  try {
    roomCore = await getRoomCore({
      installationId: auth.installationId,
      roomId,
      redis: auth.redis,
    });
  } catch (err) {
    if (err instanceof RoomNotFoundError || err instanceof RoomIdFormatError) {
      return NextResponse.json(
        { code: "room_not_found", message: `Room ${roomId} not found.` },
        { status: 404 },
      );
    }
    console.error("[rooms.resolve-action] getRoomCore failed", {
      installationId: auth.installationId,
      roomId,
      error: err,
    });
    return NextResponse.json(
      { code: "storage_failure", message: "Failed to load room." },
      { status: 500 },
    );
  }
  if (roomCore.status !== "deciding") {
    return NextResponse.json(
      {
        code: "invalid_status_for_resolve_action",
        message: `Room must be in 'deciding'; current status is '${roomCore.status}'.`,
        actualStatus: roomCore.status,
      },
      { status: 409 },
    );
  }
  if (roomCore.subject_type !== "pr_review") {
    return NextResponse.json(
      {
        code: "unsupported_subject_type",
        message: `resolve-action only handles subject_type='pr_review'; got '${roomCore.subject_type}'.`,
      },
      { status: 409 },
    );
  }

  // ----- verify claim (held by this runner, expected throughSequence) -----
  let rawClaim;
  try {
    rawClaim = await auth.redis.get<string>(claimKey(roomId));
  } catch (err) {
    console.error("[rooms.resolve-action] claim fetch failed", {
      installationId: auth.installationId,
      roomId,
      error: err,
    });
    return NextResponse.json(
      { code: "storage_failure", message: "Failed to load synthesis claim." },
      { status: 500 },
    );
  }
  if (!rawClaim) {
    return NextResponse.json(
      {
        code: "claim_not_held",
        message:
          "Synthesis claim is no longer held (TTL expired or recovered). " +
          "Re-claim via claim-synthesis and retry.",
      },
      { status: 409 },
    );
  }
  const claim = parseClaim(rawClaim);
  if (!claim) {
    console.error("[rooms.resolve-action] claim payload corrupt", {
      installationId: auth.installationId,
      roomId,
      rawClaim: rawClaim.slice(0, 200),
    });
    return NextResponse.json(
      {
        code: "claim_payload_corrupt",
        message: "Synthesis claim payload could not be decoded.",
      },
      { status: 409 },
    );
  }
  if (claim.runner !== body.queenRunner) {
    return NextResponse.json(
      {
        code: "claim_runner_mismatch",
        message:
          `Claim is held by '${claim.runner}', not '${body.queenRunner}'. ` +
          "Another queen runner is synthesizing this room.",
        heldByRunner: claim.runner,
      },
      { status: 409 },
    );
  }
  if (claim.throughSequence !== body.sealedThroughSequence) {
    return NextResponse.json(
      {
        code: "sequence_drift",
        message:
          `sealedThroughSequence=${body.sealedThroughSequence} does not match ` +
          `the claim's throughSequence=${claim.throughSequence}. New events ` +
          "arrived during synthesis — re-claim via claim-synthesis and retry.",
        claimThroughSequence: claim.throughSequence,
      },
      { status: 409 },
    );
  }

  // ----- read contributions for applyDowngradeOnlyFloor -----
  let contributions;
  try {
    contributions = await getRoomContributions({
      roomId,
      redis: auth.redis,
    });
  } catch (err) {
    console.error("[rooms.resolve-action] getRoomContributions failed", {
      installationId: auth.installationId,
      roomId,
      error: err,
    });
    return NextResponse.json(
      {
        code: "storage_failure",
        message: "Failed to load room contributions.",
      },
      { status: 500 },
    );
  }

  // ----- apply structural floor + emit G1 if it changed the verdict -----
  const clampedVerdict = applyDowngradeOnlyFloor(
    body.derivedVerdict.verdict,
    contributions,
  );
  const floorOverridden = clampedVerdict !== body.derivedVerdict.verdict;
  if (floorOverridden) {
    // The floor is what `aggregateWorkerVerdicts` would have returned
    // standalone — surface it in the audit event for diagnostic
    // correlation. (Not used in the response — clamped is what
    // matters going forward.)
    const floorVerdict = aggregateWorkerVerdicts(contributions);
    await emitQueenVerdictFloorOverride({
      installationId: auth.installationId,
      redis: auth.redis,
      name: auth.name,
      fingerprint: auth.envelope.fingerprint,
      detail: {
        room_id: roomId,
        subject_ref: roomCore.subject_ref,
        submitted_verdict: body.derivedVerdict.verdict,
        floor_verdict: floorVerdict,
        clamped_verdict: clampedVerdict,
      },
    });
  }

  // ----- parse subject_ref for the GitHub call -----
  const parsedRef = parsePullRequestSubjectRef(roomCore.subject_ref);
  if (!parsedRef.ok) {
    console.error("[rooms.resolve-action] subject_ref parse failed", {
      installationId: auth.installationId,
      roomId,
      subject_ref: roomCore.subject_ref,
      reason: parsedRef.reason,
    });
    return NextResponse.json(
      {
        code: "configuration_error",
        message: `Room subject_ref could not be parsed: ${parsedRef.reason}`,
      },
      { status: 500 },
    );
  }

  // ----- load App creds + mint a per-call narrow read-only token -----
  const env = validateEnv();
  if (!env.ok || !env.config.githubAppId || !env.config.githubAppPrivateKey) {
    return NextResponse.json(
      {
        code: "configuration_error",
        message:
          "GitHub App credentials not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY).",
      },
      { status: 500 },
    );
  }

  let tokenResult;
  try {
    tokenResult = await mintInstallationToken({
      installationId: auth.installationId,
      repo: `${parsedRef.ref.owner}/${parsedRef.ref.repo}`,
      appId: env.config.githubAppId,
      appPrivateKeyPem: env.config.githubAppPrivateKey,
      allowedPermissions: RESOLVE_ACTION_PERMISSIONS,
    });
  } catch (err) {
    if (err instanceof AppCredentialError) {
      console.error("[rooms.resolve-action] App credential error", err);
      return NextResponse.json(
        {
          code: "configuration_error",
          message: "GitHub App credentials are invalid.",
        },
        { status: 500 },
      );
    }
    console.error("[rooms.resolve-action] mintInstallationToken failed", {
      installationId: auth.installationId,
      roomId,
      error: err,
    });
    return NextResponse.json(
      {
        code: "github_read_failed",
        message: "Failed to mint installation token for GitHub read.",
      },
      { status: 502 },
    );
  }

  // ----- read live PR state -----
  let prState;
  try {
    prState = await getPullRequestState({
      token: tokenResult.token,
      owner: parsedRef.ref.owner,
      repo: parsedRef.ref.repo,
      prNumber: parsedRef.ref.prNumber,
    });
  } catch (err) {
    if (err instanceof PullRequestNotFoundError) {
      return NextResponse.json(
        {
          code: "github_pr_not_found",
          message: `Pull request ${parsedRef.ref.owner}/${parsedRef.ref.repo}#${parsedRef.ref.prNumber} not found on GitHub.`,
        },
        { status: 404 },
      );
    }
    if (err instanceof GitHubAPIError) {
      console.error("[rooms.resolve-action] GitHub read failed", {
        installationId: auth.installationId,
        roomId,
        endpoint: err.endpoint,
        status: err.status,
      });
      return NextResponse.json(
        {
          code: "github_read_failed",
          message: `GitHub read failed: ${err.endpoint} returned ${err.status}.`,
        },
        { status: 502 },
      );
    }
    console.error("[rooms.resolve-action] getPullRequestState unexpected", {
      installationId: auth.installationId,
      roomId,
      error: err,
    });
    return NextResponse.json(
      {
        code: "github_read_failed",
        message: "GitHub PR state read failed unexpectedly.",
      },
      { status: 502 },
    );
  }

  // ----- evaluate D1 invariants -----
  // Pass-1 builder fix: pass roomCore.last_post_close_drift_at
  // through so the post_close_drift branch is reachable. The drift
  // marker is set by the post-merge flow (slice 2e) when post-close
  // events arrive; until then it stays unset, but the wire-up here
  // is needed so a future drift marker blocks re-merge.
  const policyDecision = evaluateResolveActionPolicy({
    clampedVerdict,
    prState,
    reviewedHeadSha: body.reviewedHeadSha,
    lastPostCloseDriftAt: roomCore.last_post_close_drift_at ?? null,
  });

  // ----- compute final permitted action (ceiling, not escalator) -----
  // Pass-1 builder fix: the server policy is a CEILING on the queen's
  // recommendation, never an escalator. If the queen recommended
  // `comment` and the policy says `squash-merge` would also be
  // permitted, we honor the queen's choice and return `comment`.
  // A downgrade event (G2) is only emitted when squash-merge → comment
  // — the genuine override case.
  let finalPermittedAction: "comment" | "squash-merge";
  let finalDowngradeReason = policyDecision.downgradeReason;
  if (
    body.recommendedAction === "squash-merge" &&
    policyDecision.permittedAction === "comment"
  ) {
    // Genuine downgrade — server forced comment over queen's merge intent.
    finalPermittedAction = "comment";
    // The policy decision always sets a non-null downgradeReason when
    // permittedAction='comment'; this is the actual reason.
  } else {
    // Queen recommended comment OR policy permits the queen's choice.
    // Honor the queen.
    finalPermittedAction = body.recommendedAction;
    // No downgrade — null out the reason if the policy had set one
    // (e.g. queen=comment + verdict=COMMENT puts policy at comment
    // with downgradeReason=verdict_not_approve, but the queen
    // CHOSE comment so it's not a downgrade).
    if (finalPermittedAction === body.recommendedAction) {
      finalDowngradeReason = null;
    }
  }
  const isGenuineDowngrade =
    body.recommendedAction === "squash-merge" &&
    finalPermittedAction === "comment";

  // ----- emit G2 only on genuine downgrade (squash-merge -> comment) -----
  if (isGenuineDowngrade) {
    await emitQueenActionDowngrade({
      installationId: auth.installationId,
      redis: auth.redis,
      name: auth.name,
      fingerprint: auth.envelope.fingerprint,
      detail: {
        room_id: roomId,
        subject_ref: roomCore.subject_ref,
        recommended_action: body.recommendedAction,
        permitted_action: "comment",
        downgrade_reason:
          policyDecision.downgradeReason ?? "verdict_not_approve",
        clamped_verdict: clampedVerdict,
        reviewed_head_sha: body.reviewedHeadSha,
      },
    });
  }

  // ----- emit baseline queen.resolve_action audit row + capture audit_id -----
  // RFC endpoint contract: every successful resolve-action call
  // gets an audit_id that seal-decision (slice 2d) verifies against
  // the public comment header. NOT fire-and-forget — a Redis hiccup
  // here MUST fail the call, not silently drop the audit row the
  // next slice's contract depends on.
  let auditId: string;
  try {
    auditId = await emitQueenResolveAction({
      installationId: auth.installationId,
      redis: auth.redis,
      name: auth.name,
      fingerprint: auth.envelope.fingerprint,
      detail: {
        room_id: roomId,
        subject_ref: roomCore.subject_ref,
        recommended_action: body.recommendedAction,
        permitted_action: finalPermittedAction,
        clamped_verdict: clampedVerdict,
        reviewed_head_sha: body.reviewedHeadSha,
        current_head_sha: prState.headSha,
        downgrade_reason: finalDowngradeReason,
        floor_overridden: floorOverridden,
      },
    });
  } catch (err) {
    console.error("[rooms.resolve-action] baseline audit emit failed", {
      installationId: auth.installationId,
      roomId,
      error: err,
    });
    return NextResponse.json(
      {
        code: "storage_failure",
        message:
          "Failed to record resolve-action audit row. The seal-decision " +
          "endpoint requires audit_id correlation — retrying may succeed.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      permittedAction: finalPermittedAction,
      clampedVerdict,
      downgradeReason: finalDowngradeReason,
      reviewedHeadSha: body.reviewedHeadSha,
      currentHeadSha: prState.headSha,
      floorOverridden,
      auditId,
    },
    { status: 200 },
  );
}
