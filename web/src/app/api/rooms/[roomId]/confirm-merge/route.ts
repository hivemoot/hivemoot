/**
 * POST /api/rooms/:roomId/confirm-merge
 *
 * Local-queen tick-N+1 merge gate. The queen may only run
 * `gh pr merge --squash` after this endpoint rereads GitHub state,
 * replays the same D1 policy used by resolve-action, and atomically
 * closes the pending room as either merge-approved or downgraded.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { parseJsonBody } from "@/server/request-utils";
import { validateEnv } from "@/server/env";
import {
  confirmPendingMergeDecision,
  getRoomCore,
  type RoomDecision,
  type SubjectRef,
  RoomDecisionMissingError,
  RoomIdFormatError,
  RoomMergeAttemptMismatchError,
  RoomNotFoundError,
  RoomPendingMergeDriftError,
  RoomPendingMergeInvalidStatusError,
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
  checkConfirmMergeRateLimit,
  emitQueenConfirmMerge,
  readQueenResolveActionAuditRow,
  QueenResolveActionAuditMalformedError,
  QueenResolveActionAuditNotFoundError,
} from "@/server/queen-audit";

const CONFIRM_MERGE_PERMISSIONS: Readonly<
  Record<string, GitHubPermissionLevel>
> = Object.freeze({
  pull_requests: "read",
  checks: "read",
  contents: "read",
  metadata: "read",
});

const MIN_PENDING_AGE_MS = 60 * 1000;
const MAX_PENDING_AGE_MS = 15 * 60 * 1000;

interface ConfirmMergeBody {
  queenRunner: string;
  mergeAttemptId: string;
  currentHeadSha: string;
}

function pickAlias(
  body: Record<string, unknown>,
  camel: string,
  snake: string,
): unknown {
  return body[camel] ?? body[snake];
}

function parseConfirmMergeBody(raw: unknown):
  | { ok: true; body: ConfirmMergeBody }
  | { ok: false; message: string } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, message: "Body must be a JSON object." };
  }
  const b = raw as Record<string, unknown>;
  const queenRunner = pickAlias(b, "queenRunner", "queen_runner");
  const mergeAttemptId = pickAlias(b, "mergeAttemptId", "merge_attempt_id");
  const currentHeadSha = pickAlias(b, "currentHeadSha", "current_head_sha");
  if (typeof queenRunner !== "string" || queenRunner.length === 0) {
    return { ok: false, message: "queenRunner must be a non-empty string." };
  }
  if (typeof mergeAttemptId !== "string" || mergeAttemptId.length === 0) {
    return { ok: false, message: "mergeAttemptId must be a non-empty string." };
  }
  if (typeof currentHeadSha !== "string" || currentHeadSha.length === 0) {
    return { ok: false, message: "currentHeadSha must be a non-empty string." };
  }
  return { ok: true, body: { queenRunner, mergeAttemptId, currentHeadSha } };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: "rooms.synthesize",
  });
  if (!auth.ok) return auth.response;

  let rateLimit;
  try {
    rateLimit = await checkConfirmMergeRateLimit({
      redis: auth.redis,
      installationId: auth.installationId,
      fingerprint: auth.envelope.fingerprint,
    });
  } catch (err) {
    console.error("[rooms.confirm-merge] rate limit check failed", {
      installationId: auth.installationId,
      error: err,
    });
    return NextResponse.json(
      { code: "storage_failure", message: "Failed to check rate limit." },
      { status: 500 },
    );
  }
  if (!rateLimit.allowed) {
    return rateLimited("confirm-merge", rateLimit);
  }

  const rawBody = await parseJsonBody(request);
  if (!rawBody.ok) {
    return NextResponse.json(
      { code: rawBody.code, message: rawBody.message },
      { status: 400 },
    );
  }
  const parsedBody = parseConfirmMergeBody(rawBody.body);
  if (!parsedBody.ok) {
    return NextResponse.json(
      { code: "invalid_body", message: parsedBody.message },
      { status: 400 },
    );
  }
  const body = parsedBody.body;
  const { roomId } = await params;

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
    console.error("[rooms.confirm-merge] getRoomCore failed", {
      installationId: auth.installationId,
      roomId,
      error: err,
    });
    return NextResponse.json(
      { code: "storage_failure", message: "Failed to load room." },
      { status: 500 },
    );
  }

  if (roomCore.status === "closed") {
    if (roomCore.decision?.merge_attempt_id === body.mergeAttemptId) {
      return NextResponse.json(
        {
          decisionOutcome: roomCore.decision.decision_outcome,
          decisionOutcomeReason:
            roomCore.decision.decision_outcome_reason ?? null,
          githubMergeStatus: roomCore.decision.github_merge_status ?? null,
          mergeAttemptId: body.mergeAttemptId,
          idempotent: true,
        },
        { status: 200 },
      );
    }
    return NextResponse.json(
      {
        code: "invalid_status_for_confirm_merge",
        message:
          "Room is already closed with a different or missing merge attempt.",
        actualStatus: roomCore.status,
        priorMergeAttemptId: roomCore.decision?.merge_attempt_id ?? null,
        priorDecisionOutcome: roomCore.decision?.decision_outcome ?? null,
      },
      { status: 409 },
    );
  }
  if (roomCore.status !== "decided_pending_action") {
    return NextResponse.json(
      {
        code: "invalid_status_for_confirm_merge",
        message:
          `Room must be in 'decided_pending_action'; current status is ` +
          `'${roomCore.status}'.`,
        actualStatus: roomCore.status,
      },
      { status: 409 },
    );
  }
  if (roomCore.subject_type !== "pr_review") {
    return NextResponse.json(
      {
        code: "unsupported_subject_type",
        message:
          `confirm-merge only handles subject_type='pr_review'; got ` +
          `'${roomCore.subject_type}'.`,
      },
      { status: 409 },
    );
  }

  const decision = roomCore.decision;
  if (!decision) {
    return NextResponse.json(
      { code: "decision_missing", message: "Pending room has no decision." },
      { status: 409 },
    );
  }
  if (decision.synthesis_runner !== body.queenRunner) {
    return NextResponse.json(
      {
        code: "runner_mismatch",
        message: "queenRunner does not match the sealed decision runner.",
        expectedRunner: decision.synthesis_runner,
        actualRunner: body.queenRunner,
      },
      { status: 409 },
    );
  }
  if (!decision.seal_audit_id || !decision.reviewed_head_sha) {
    return NextResponse.json(
      {
        code: "decision_missing_merge_context",
        message:
          "Pending decision must include seal_audit_id and reviewed_head_sha.",
      },
      { status: 409 },
    );
  }

  const pendingAt = Date.parse(decision.pending_action_at ?? "");
  if (!Number.isFinite(pendingAt)) {
    return NextResponse.json(
      {
        code: "decision_missing_merge_context",
        message: "Pending decision must include pending_action_at.",
      },
      { status: 409 },
    );
  }
  const pendingAgeMs = Date.now() - pendingAt;
  if (pendingAgeMs < MIN_PENDING_AGE_MS) {
    const retryAfterSecs = Math.ceil((MIN_PENDING_AGE_MS - pendingAgeMs) / 1000);
    return NextResponse.json(
      {
        code: "override_window_active",
        message: "confirm-merge must wait for the 60s override window.",
        retryAfterSecs,
      },
      { status: 409, headers: { "Retry-After": String(retryAfterSecs) } },
    );
  }
  if (pendingAgeMs > MAX_PENDING_AGE_MS) {
    return NextResponse.json(
      {
        code: "pending_merge_stale",
        message:
          "Pending merge intent is older than 15 minutes; re-run synthesis.",
      },
      { status: 410 },
    );
  }

  const auditCheck = await loadAndVerifyAudit({
    installationId: auth.installationId,
    roomId,
    subjectRef: roomCore.subject_ref,
    auditId: decision.seal_audit_id,
    fingerprint: auth.envelope.fingerprint,
    name: auth.name,
    redis: auth.redis,
  });
  if (!auditCheck.ok) return auditCheck.response;
  const auditRow = auditCheck.auditRow;
  if (auditRow.detail.permitted_action !== "squash-merge") {
    return NextResponse.json(
      {
        code: "invalid_pending_action",
        message: "Pending merge decision must come from squash-merge permission.",
      },
      { status: 409 },
    );
  }
  if (auditRow.detail.reviewed_head_sha !== decision.reviewed_head_sha) {
    return NextResponse.json(
      {
        code: "audit_decision_mismatch",
        message: "Decision reviewed_head_sha does not match resolve-action audit.",
      },
      { status: 409 },
    );
  }

  const subjectRef = parsePullRequestSubjectRef(roomCore.subject_ref);
  if (!subjectRef.ok) {
    return NextResponse.json(
      {
        code: "configuration_error",
        message: `Room subject_ref could not be parsed: ${subjectRef.reason}`,
      },
      { status: 500 },
    );
  }
  const tokenResult = await mintReadToken({
    installationId: auth.installationId,
    repo: `${subjectRef.ref.owner}/${subjectRef.ref.repo}`,
  });
  if (!tokenResult.ok) return tokenResult.response;

  let prState;
  try {
    prState = await getPullRequestState({
      token: tokenResult.token,
      owner: subjectRef.ref.owner,
      repo: subjectRef.ref.repo,
      prNumber: subjectRef.ref.prNumber,
    });
  } catch (err) {
    return mapGitHubReadError(err, "confirm-merge");
  }

  const policy =
    prState.headSha !== body.currentHeadSha
      ? { permittedAction: "comment" as const, downgradeReason: "head_sha_drift" }
      : evaluateResolveActionPolicy({
          clampedVerdict: auditRow.detail.clamped_verdict,
          prState,
          reviewedHeadSha: decision.reviewed_head_sha,
          lastPostCloseDriftAt: roomCore.last_post_close_drift_at ?? null,
        });
  const mergeApproved = policy.permittedAction === "squash-merge";
  const updatedDecision: RoomDecision = {
    ...decision,
    decision_outcome: mergeApproved ? "merge_approved" : "merge_downgraded",
    decision_outcome_reason: mergeApproved
      ? undefined
      : (policy.downgradeReason ?? "head_sha_drift"),
    merge_attempt_id: body.mergeAttemptId,
    merge_attempt_fingerprint: auth.envelope.fingerprint,
    github_merge_status: mergeApproved ? "pending" : undefined,
  };

  const subject: SubjectRef = {
    type: roomCore.subject_type,
    ref: roomCore.subject_ref,
  };
  let closedSequence: number;
  try {
    closedSequence = await confirmPendingMergeDecision({
      installationId: auth.installationId,
      roomId,
      expectedPendingSequence: decision.sequence_closed + 1,
      decision: updatedDecision,
      subject,
      redis: auth.redis,
    });
  } catch (err) {
    const mapped = mapStorageError(err);
    if (mapped) return mapped;
    throw err;
  }

  await emitQueenConfirmMerge({
    installationId: auth.installationId,
    redis: auth.redis,
    name: auth.name,
    fingerprint: auth.envelope.fingerprint,
    detail: {
      room_id: roomId,
      subject_ref: roomCore.subject_ref,
      audit_id_from_resolve_action: decision.seal_audit_id,
      merge_attempt_id: body.mergeAttemptId,
      decision_outcome: updatedDecision.decision_outcome!,
      decision_outcome_reason: updatedDecision.decision_outcome_reason ?? null,
      reviewed_head_sha: decision.reviewed_head_sha,
      current_head_sha: prState.headSha,
    },
  });

  return NextResponse.json(
    {
      decisionOutcome: updatedDecision.decision_outcome,
      decisionOutcomeReason: updatedDecision.decision_outcome_reason ?? null,
      githubMergeStatus: updatedDecision.github_merge_status ?? null,
      mergeAttemptId: body.mergeAttemptId,
      closedSequence,
    },
    { status: 200 },
  );
}

async function loadAndVerifyAudit(args: {
  installationId: string;
  roomId: string;
  subjectRef: string;
  auditId: string;
  fingerprint: string;
  name: string;
  redis: Parameters<typeof readQueenResolveActionAuditRow>[0]["redis"];
}): Promise<
  | { ok: true; auditRow: Awaited<ReturnType<typeof readQueenResolveActionAuditRow>> }
  | { ok: false; response: NextResponse }
> {
  let auditRow;
  try {
    auditRow = await readQueenResolveActionAuditRow({
      redis: args.redis,
      installationId: args.installationId,
      auditId: args.auditId,
    });
  } catch (err) {
    if (err instanceof QueenResolveActionAuditNotFoundError) {
      return {
        ok: false,
        response: NextResponse.json(
          { code: "audit_not_found", message: err.message },
          { status: 404 },
        ),
      };
    }
    if (err instanceof QueenResolveActionAuditMalformedError) {
      return {
        ok: false,
        response: NextResponse.json(
          { code: "invalid_audit_row", message: err.message },
          { status: 409 },
        ),
      };
    }
    console.error("[rooms.confirm-merge] audit lookup failed", {
      installationId: args.installationId,
      roomId: args.roomId,
      auditId: args.auditId,
      error: err,
    });
    return {
      ok: false,
      response: NextResponse.json(
        { code: "storage_failure", message: "Failed to load audit row." },
        { status: 500 },
      ),
    };
  }
  if (
    auditRow.detail.room_id !== args.roomId ||
    auditRow.detail.subject_ref !== args.subjectRef
  ) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          code: "audit_room_mismatch",
          message: "resolve-action audit row does not belong to this room.",
        },
        { status: 409 },
      ),
    };
  }
  if (auditRow.fingerprint !== args.fingerprint || auditRow.name !== args.name) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          code: "audit_bearer_mismatch",
          message: "resolve-action audit row was produced by a different bearer.",
        },
        { status: 409 },
      ),
    };
  }
  return { ok: true, auditRow };
}

async function mintReadToken(args: {
  installationId: string;
  repo: string;
}): Promise<{ ok: true; token: string } | { ok: false; response: NextResponse }> {
  const env = validateEnv();
  if (!env.ok || !env.config.githubAppId || !env.config.githubAppPrivateKey) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          code: "configuration_error",
          message:
            "GitHub App credentials not configured " +
            "(GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY).",
        },
        { status: 500 },
      ),
    };
  }
  try {
    const tokenResult = await mintInstallationToken({
      installationId: args.installationId,
      repo: args.repo,
      appId: env.config.githubAppId,
      appPrivateKeyPem: env.config.githubAppPrivateKey,
      allowedPermissions: CONFIRM_MERGE_PERMISSIONS,
    });
    return { ok: true, token: tokenResult.token };
  } catch (err) {
    if (err instanceof AppCredentialError) {
      return {
        ok: false,
        response: NextResponse.json(
          { code: "configuration_error", message: "GitHub App credentials are invalid." },
          { status: 500 },
        ),
      };
    }
    console.error("[rooms.confirm-merge] mintInstallationToken failed", {
      installationId: args.installationId,
      error: err,
    });
    return {
      ok: false,
      response: NextResponse.json(
        {
          code: "github_read_failed",
          message: "Failed to mint installation token for GitHub read.",
        },
        { status: 502 },
      ),
    };
  }
}

function mapGitHubReadError(err: unknown, endpoint: string): NextResponse {
  if (err instanceof PullRequestNotFoundError) {
    return NextResponse.json(
      { code: "pull_request_not_found", message: err.message },
      { status: 404 },
    );
  }
  if (err instanceof GitHubAPIError) {
    console.error(`[rooms.${endpoint}] GitHub read failed`, { error: err });
    return NextResponse.json(
      { code: "github_read_failed", message: "GitHub PR read failed." },
      { status: 502 },
    );
  }
  throw err;
}

function mapStorageError(err: unknown): NextResponse | null {
  if (err instanceof RoomPendingMergeInvalidStatusError) {
    return NextResponse.json(
      {
        code: "invalid_status_for_confirm_merge",
        message: err.message,
        actualStatus: err.actualStatus,
      },
      { status: 409 },
    );
  }
  if (err instanceof RoomPendingMergeDriftError) {
    return NextResponse.json(
      {
        code: "sequence_drift",
        message: err.message,
        expectedPendingSequence: err.expectedPendingSequence,
        lastSeq: err.lastSeq,
      },
      { status: 409 },
    );
  }
  if (
    err instanceof RoomDecisionMissingError ||
    err instanceof RoomMergeAttemptMismatchError
  ) {
    return NextResponse.json(
      { code: "decision_conflict", message: err.message },
      { status: 409 },
    );
  }
  return null;
}

function rateLimited(
  endpoint: string,
  rateLimit: {
    scope: "per_bearer" | "per_installation";
    currentCount: number;
    resetAtSecs: number;
  },
): NextResponse {
  const scopeMessage =
    rateLimit.scope === "per_bearer"
      ? "per-bearer cap (60/min)"
      : "per-installation aggregate cap (240/min)";
  return NextResponse.json(
    {
      code: "rate_limited",
      message:
        `${endpoint} rate limit exceeded — hit the ${scopeMessage}. ` +
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
