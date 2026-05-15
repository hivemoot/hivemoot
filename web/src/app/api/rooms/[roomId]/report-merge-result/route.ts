/**
 * POST /api/rooms/:roomId/report-merge-result
 *
 * Records the actual GitHub outcome for a merge attempt previously
 * approved by confirm-merge. The server cross-checks GitHub before
 * writing the outcome so local queen state cannot claim success or
 * failure that disagrees with the PR.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { parseJsonBody } from "@/server/request-utils";
import { validateEnv } from "@/server/env";
import {
  getRoomCore,
  reportMergeResultForRoom,
  type RoomDecision,
  RoomDecisionMissingError,
  RoomIdFormatError,
  RoomMergeAttemptBearerMismatchError,
  RoomMergeAttemptMismatchError,
  RoomMergeReportNotApprovedError,
  RoomNotFoundError,
  RoomPendingMergeInvalidStatusError,
} from "@hivemoot/war-room";
import {
  mintInstallationToken,
  AppCredentialError,
} from "@/server/github-installation-token";
import type { GitHubPermissionLevel } from "@/server/agent-token-v1";
import {
  getPullRequestMergeState,
  PullRequestNotFoundError,
  GitHubAPIError,
} from "@/server/github-pr-state";
import { parsePullRequestSubjectRef } from "@/server/resolve-action-policy";
import {
  checkReportMergeResultRateLimit,
  emitQueenMergeResult,
} from "@/server/queen-audit";

const REPORT_MERGE_PERMISSIONS: Readonly<
  Record<string, GitHubPermissionLevel>
> = Object.freeze({
  pull_requests: "read",
  metadata: "read",
});

const MAX_REPORT_AGE_MS = 15 * 60 * 1000;

interface ReportMergeResultBody {
  queenRunner: string;
  mergeAttemptId: string;
  githubMergeStatus: "succeeded" | "failed";
  mergeCommitOid: string | null;
  errorClass: string | null;
}

function pickAlias(
  body: Record<string, unknown>,
  camel: string,
  snake: string,
): unknown {
  return body[camel] ?? body[snake];
}

function parseReportMergeResultBody(raw: unknown):
  | { ok: true; body: ReportMergeResultBody }
  | { ok: false; message: string } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, message: "Body must be a JSON object." };
  }
  const b = raw as Record<string, unknown>;
  const queenRunner = pickAlias(b, "queenRunner", "queen_runner");
  const mergeAttemptId = pickAlias(b, "mergeAttemptId", "merge_attempt_id");
  const githubMergeStatus = pickAlias(
    b,
    "githubMergeStatus",
    "github_merge_status",
  );
  const mergeCommitOid = pickAlias(b, "mergeCommitOid", "merge_commit_oid");
  const errorClass = pickAlias(b, "errorClass", "error_class");

  if (typeof queenRunner !== "string" || queenRunner.length === 0) {
    return { ok: false, message: "queenRunner must be a non-empty string." };
  }
  if (typeof mergeAttemptId !== "string" || mergeAttemptId.length === 0) {
    return { ok: false, message: "mergeAttemptId must be a non-empty string." };
  }
  if (githubMergeStatus !== "succeeded" && githubMergeStatus !== "failed") {
    return {
      ok: false,
      message: "githubMergeStatus must be 'succeeded' or 'failed'.",
    };
  }
  if (
    mergeCommitOid !== undefined &&
    mergeCommitOid !== null &&
    typeof mergeCommitOid !== "string"
  ) {
    return {
      ok: false,
      message: "mergeCommitOid must be a string when supplied.",
    };
  }
  if (
    errorClass !== undefined &&
    errorClass !== null &&
    typeof errorClass !== "string"
  ) {
    return { ok: false, message: "errorClass must be a string when supplied." };
  }
  if (githubMergeStatus === "succeeded" && !mergeCommitOid) {
    return {
      ok: false,
      message: "mergeCommitOid is required when githubMergeStatus=succeeded.",
    };
  }

  return {
    ok: true,
    body: {
      queenRunner,
      mergeAttemptId,
      githubMergeStatus,
      mergeCommitOid:
        typeof mergeCommitOid === "string" && mergeCommitOid.length > 0
          ? mergeCommitOid
          : null,
      errorClass:
        typeof errorClass === "string" && errorClass.length > 0
          ? errorClass
          : null,
    },
  };
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
    rateLimit = await checkReportMergeResultRateLimit({
      redis: auth.redis,
      installationId: auth.installationId,
      fingerprint: auth.envelope.fingerprint,
    });
  } catch (err) {
    console.error("[rooms.report-merge-result] rate limit check failed", {
      installationId: auth.installationId,
      error: err,
    });
    return NextResponse.json(
      { code: "storage_failure", message: "Failed to check rate limit." },
      { status: 500 },
    );
  }
  if (!rateLimit.allowed) {
    return rateLimited("report-merge-result", rateLimit);
  }

  const rawBody = await parseJsonBody(request);
  if (!rawBody.ok) {
    return NextResponse.json(
      { code: rawBody.code, message: rawBody.message },
      { status: 400 },
    );
  }
  const parsedBody = parseReportMergeResultBody(rawBody.body);
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
    console.error("[rooms.report-merge-result] getRoomCore failed", {
      installationId: auth.installationId,
      roomId,
      error: err,
    });
    return NextResponse.json(
      { code: "storage_failure", message: "Failed to load room." },
      { status: 500 },
    );
  }

  if (roomCore.status !== "closed") {
    return NextResponse.json(
      {
        code: "invalid_status_for_report_merge_result",
        message:
          `Room must be in 'closed'; current status is '${roomCore.status}'.`,
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
          `report-merge-result only handles subject_type='pr_review'; got ` +
          `'${roomCore.subject_type}'.`,
      },
      { status: 409 },
    );
  }

  const decision = roomCore.decision;
  if (!decision) {
    return NextResponse.json(
      { code: "decision_missing", message: "Closed room has no decision." },
      { status: 409 },
    );
  }
  if (decision.synthesis_runner !== body.queenRunner) {
    return NextResponse.json(
      {
        code: "runner_mismatch",
        message: "queenRunner does not match the decision runner.",
        expectedRunner: decision.synthesis_runner,
        actualRunner: body.queenRunner,
      },
      { status: 409 },
    );
  }
  if (decision.decision_outcome !== "merge_approved") {
    return NextResponse.json(
      {
        code: "merge_not_approved",
        message: "report-merge-result requires a merge-approved decision.",
        decisionOutcome: decision.decision_outcome ?? null,
      },
      { status: 409 },
    );
  }
  if (decision.merge_attempt_id !== body.mergeAttemptId) {
    return NextResponse.json(
      {
        code: "merge_attempt_mismatch",
        message: "mergeAttemptId does not match the confirmed decision.",
        expectedMergeAttemptId: decision.merge_attempt_id ?? null,
        actualMergeAttemptId: body.mergeAttemptId,
      },
      { status: 409 },
    );
  }
  if (decision.merge_attempt_fingerprint !== auth.envelope.fingerprint) {
    return NextResponse.json(
      {
        code: "merge_attempt_bearer_mismatch",
        message:
          "report-merge-result must use the same bearer that received confirm-merge approval.",
        expectedFingerprint: decision.merge_attempt_fingerprint ?? null,
      },
      { status: 409 },
    );
  }
  if (
    decision.github_merge_status === "succeeded" ||
    decision.github_merge_status === "failed"
  ) {
    if (decision.github_merge_status !== body.githubMergeStatus) {
      return NextResponse.json(
        {
          code: "merge_result_conflict",
          message: "Merge result was already reported with a different status.",
          priorGithubMergeStatus: decision.github_merge_status,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      {
        githubMergeStatus: decision.github_merge_status,
        mergeAttemptId: body.mergeAttemptId,
        mergeCommitOid: decision.merge_commit_oid ?? null,
        errorClass: decision.github_merge_error_class ?? null,
        idempotent: true,
      },
      { status: 200 },
    );
  }

  const closedAtMs = Date.parse(roomCore.closed_at ?? "");
  if (!Number.isFinite(closedAtMs)) {
    return NextResponse.json(
      {
        code: "decision_missing_merge_context",
        message: "Closed merge-approved room must include closed_at.",
      },
      { status: 409 },
    );
  }
  if (Date.now() - closedAtMs > MAX_REPORT_AGE_MS) {
    return NextResponse.json(
      {
        code: "merge_report_stale",
        message:
          "Merge result report is older than 15 minutes; re-run synthesis.",
      },
      { status: 410 },
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

  let mergeState;
  try {
    mergeState = await getPullRequestMergeState({
      token: tokenResult.token,
      owner: subjectRef.ref.owner,
      repo: subjectRef.ref.repo,
      prNumber: subjectRef.ref.prNumber,
    });
  } catch (err) {
    return mapGitHubReadError(err);
  }

  if (body.githubMergeStatus === "succeeded") {
    if (!mergeState.merged || mergeState.mergeCommitSha !== body.mergeCommitOid) {
      return NextResponse.json(
        {
          code: "github_merge_result_mismatch",
          message: "GitHub does not show this PR merged at mergeCommitOid.",
          githubMerged: mergeState.merged,
          githubMergeCommitOid: mergeState.mergeCommitSha,
        },
        { status: 409 },
      );
    }
  } else if (mergeState.merged) {
    return NextResponse.json(
      {
        code: "github_merge_result_mismatch",
        message: "GitHub shows the PR merged; failed result is stale.",
        githubMerged: true,
        githubMergeCommitOid: mergeState.mergeCommitSha,
      },
      { status: 409 },
    );
  }

  const updatedDecision: RoomDecision = {
    ...decision,
    github_merge_status: body.githubMergeStatus,
    merge_commit_oid: body.mergeCommitOid ?? undefined,
    github_merge_error_class: body.errorClass ?? undefined,
  };
  try {
    await reportMergeResultForRoom({
      installationId: auth.installationId,
      roomId,
      mergeAttemptId: body.mergeAttemptId,
      mergeAttemptFingerprint: auth.envelope.fingerprint,
      decision: updatedDecision,
      redis: auth.redis,
    });
  } catch (err) {
    const mapped = mapStorageError(err);
    if (mapped) return mapped;
    throw err;
  }

  await emitQueenMergeResult({
    installationId: auth.installationId,
    redis: auth.redis,
    name: auth.name,
    fingerprint: auth.envelope.fingerprint,
    detail: {
      room_id: roomId,
      subject_ref: roomCore.subject_ref,
      merge_attempt_id: body.mergeAttemptId,
      github_merge_status: body.githubMergeStatus,
      merge_commit_oid: body.mergeCommitOid,
      error_class: body.errorClass,
    },
  });

  return NextResponse.json(
    {
      githubMergeStatus: body.githubMergeStatus,
      mergeAttemptId: body.mergeAttemptId,
      mergeCommitOid: body.mergeCommitOid,
      errorClass: body.errorClass,
    },
    { status: 200 },
  );
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
      permissionCeiling: REPORT_MERGE_PERMISSIONS,
      allowedPermissions: REPORT_MERGE_PERMISSIONS,
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
    console.error("[rooms.report-merge-result] mintInstallationToken failed", {
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

function mapGitHubReadError(err: unknown): NextResponse {
  if (err instanceof PullRequestNotFoundError) {
    return NextResponse.json(
      { code: "pull_request_not_found", message: err.message },
      { status: 404 },
    );
  }
  if (err instanceof GitHubAPIError) {
    console.error("[rooms.report-merge-result] GitHub read failed", {
      error: err,
    });
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
        code: "invalid_status_for_report_merge_result",
        message: err.message,
        actualStatus: err.actualStatus,
      },
      { status: 409 },
    );
  }
  if (err instanceof RoomDecisionMissingError) {
    return NextResponse.json(
      { code: "decision_missing", message: err.message },
      { status: 409 },
    );
  }
  if (err instanceof RoomMergeAttemptMismatchError) {
    return NextResponse.json(
      {
        code: "merge_attempt_mismatch",
        message: err.message,
        expectedMergeAttemptId: err.expectedMergeAttemptId,
        actualMergeAttemptId: err.actualMergeAttemptId,
      },
      { status: 409 },
    );
  }
  if (err instanceof RoomMergeAttemptBearerMismatchError) {
    return NextResponse.json(
      {
        code: "merge_attempt_bearer_mismatch",
        message: err.message,
        expectedFingerprint: err.expectedFingerprint,
        actualFingerprint: err.actualFingerprint,
      },
      { status: 409 },
    );
  }
  if (err instanceof RoomMergeReportNotApprovedError) {
    return NextResponse.json(
      {
        code: "merge_not_approved",
        message: err.message,
        decisionOutcome: err.decisionOutcome,
      },
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
