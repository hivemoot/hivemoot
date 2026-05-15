/**
 * POST /api/rooms/:roomId/seal-decision — local-queen transaction
 * completion for the comment/closed path.
 *
 * Capability: `rooms.synthesize`.
 *
 * This endpoint finishes a successful `/resolve-action` call only
 * after the local queen has either:
 *
 *   - posted a verifiable GitHub PR comment carrying the canonical
 *     seal header; or
 *   - failed to post the intended-action comment and explicitly
 *     downgraded the room to comment-only.
 *
 * `final_state=closed` seals a comment-only decision. When
 * resolve-action permitted squash-merge, `final_state=decided_pending_action`
 * seals the public intent comment and leaves the room ready for
 * confirm-merge's tick-N+1 recheck.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { parseJsonBody } from "@/server/request-utils";
import { validateEnv } from "@/server/env";
import {
  closeRoomWithDecision,
  sealRoomForPendingMerge,
  getRoomCore,
  type RoomDecision,
  type SubjectRef,
  RoomNotFoundError,
  RoomIdFormatError,
  RoomCloseClaimLostError,
  RoomCloseClaimThroughSeqMismatchError,
  RoomCloseClaimRunnerMismatchError,
  RoomCloseDriftError,
  RoomClaimPayloadCorruptError,
  RoomRunnerFormatError,
  RoomDecisionTooLargeError,
} from "@hivemoot/war-room";
import {
  mintInstallationToken,
  AppCredentialError,
} from "@/server/github-installation-token";
import type { GitHubPermissionLevel } from "@/server/agent-token-v1";
import {
  parsePullRequestSubjectRef,
} from "@/server/resolve-action-policy";
import {
  parseCommentUrl,
  verifyCommentMatches,
  type SealVerb,
} from "@/server/seal-decision-verifier";
import {
  getIssueComment,
  GitHubCommentNotFoundError,
  GitHubCommentAPIError,
  GitHubCommentMalformedError,
} from "@/server/github-issue-comment";
import {
  checkSealDecisionRateLimit,
  emitQueenIntendedActionPostFailed,
  readQueenResolveActionAuditRow,
  QueenResolveActionAuditNotFoundError,
  QueenResolveActionAuditMalformedError,
} from "@/server/queen-audit";

const SEAL_DECISION_PERMISSIONS: Readonly<
  Record<string, GitHubPermissionLevel>
> = Object.freeze({
  issues: "read",
  metadata: "read",
});

const AUDIT_ID_MAX_AGE_MS = 15 * 60 * 1000;

type FinalState = "closed" | "decided_pending_action";
type DowngradeReason = "intended_action_post_failed";

interface SealDecisionBody {
  queenRunner: string;
  auditId: string;
  finalState: FinalState;
  sealedThroughSequence: number;
  decision: RoomDecision;
  commentUrl?: string;
  downgradeReason?: DowngradeReason;
  errorClass?: string | null;
  retryCount?: number | null;
}

function pickAlias(
  body: Record<string, unknown>,
  camel: string,
  snake: string,
): unknown {
  return body[camel] ?? body[snake];
}

function parseSealDecisionBody(raw: Record<string, unknown>):
  | { ok: true; body: SealDecisionBody }
  | { ok: false; message: string } {
  const queenRunner = pickAlias(raw, "queenRunner", "queen_runner");
  const auditId = pickAlias(raw, "auditId", "audit_id");
  const finalState = pickAlias(raw, "finalState", "final_state");
  const sealedThroughSequence = pickAlias(
    raw,
    "sealedThroughSequence",
    "sealed_through_sequence",
  );

  if (typeof queenRunner !== "string" || queenRunner.length === 0) {
    return { ok: false, message: "queenRunner must be a non-empty string." };
  }
  if (typeof auditId !== "string" || auditId.length === 0) {
    return { ok: false, message: "auditId must be a non-empty string." };
  }
  if (finalState !== "closed" && finalState !== "decided_pending_action") {
    return {
      ok: false,
      message:
        "finalState must be 'closed' or 'decided_pending_action'.",
    };
  }
  if (
    typeof sealedThroughSequence !== "number" ||
    !Number.isInteger(sealedThroughSequence) ||
    sealedThroughSequence < 1
  ) {
    return {
      ok: false,
      message: "sealedThroughSequence must be a positive integer.",
    };
  }

  const commentUrl = pickAlias(raw, "commentUrl", "comment_url");
  const downgradeReason = pickAlias(raw, "downgradeReason", "downgrade_reason");
  const hasCommentUrl = typeof commentUrl === "string" && commentUrl.length > 0;
  const hasDowngrade = downgradeReason !== undefined && downgradeReason !== null;
  if (finalState === "closed" && hasCommentUrl === hasDowngrade) {
    return {
      ok: false,
      message:
        "Provide exactly one of commentUrl/comment_url or " +
        "downgradeReason/downgrade_reason.",
    };
  }
  if (finalState === "decided_pending_action") {
    if (!hasCommentUrl || hasDowngrade) {
      return {
        ok: false,
        message:
          "finalState=decided_pending_action requires commentUrl/comment_url " +
          "and must not include downgradeReason/downgrade_reason.",
      };
    }
  }
  if (hasDowngrade && downgradeReason !== "intended_action_post_failed") {
    return {
      ok: false,
      message:
        "downgradeReason must be 'intended_action_post_failed' when supplied.",
    };
  }

  if (raw.decision === null || typeof raw.decision !== "object") {
    return { ok: false, message: "decision must be an object." };
  }
  const d = raw.decision as Record<string, unknown>;
  if (
    typeof d.synthesized_at !== "string" ||
    typeof d.synthesis_runner !== "string" ||
    typeof d.content !== "string" ||
    typeof d.sequence_closed !== "number"
  ) {
    return {
      ok: false,
      message:
        "decision must include synthesized_at (string), " +
        "synthesis_runner (string), content (string), sequence_closed (number).",
    };
  }
  if (d.synthesis_runner !== queenRunner) {
    return {
      ok: false,
      message: "decision.synthesis_runner must match queenRunner.",
    };
  }
  if (d.sequence_closed !== sealedThroughSequence) {
    return {
      ok: false,
      message: "decision.sequence_closed must match sealedThroughSequence.",
    };
  }

  const errorClass = pickAlias(raw, "errorClass", "error_class");
  if (
    errorClass !== undefined &&
    errorClass !== null &&
    typeof errorClass !== "string"
  ) {
    return { ok: false, message: "errorClass must be a string when supplied." };
  }
  const retryCount = pickAlias(raw, "retryCount", "retry_count");
  if (
    retryCount !== undefined &&
    retryCount !== null &&
    (typeof retryCount !== "number" ||
      !Number.isInteger(retryCount) ||
      retryCount < 0)
  ) {
    return {
      ok: false,
      message: "retryCount must be a non-negative integer when supplied.",
    };
  }

  return {
    ok: true,
    body: {
      queenRunner,
      auditId,
      finalState,
      sealedThroughSequence,
      decision: {
        synthesized_at: d.synthesized_at,
        synthesis_runner: d.synthesis_runner,
        content: d.content,
        sequence_closed: d.sequence_closed,
      },
      commentUrl: hasCommentUrl ? (commentUrl as string) : undefined,
      downgradeReason: hasDowngrade
        ? (downgradeReason as DowngradeReason)
        : undefined,
      errorClass:
        typeof errorClass === "string" && errorClass.length > 0
          ? errorClass
          : null,
      retryCount:
        typeof retryCount === "number" ? retryCount : null,
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
    rateLimit = await checkSealDecisionRateLimit({
      redis: auth.redis,
      installationId: auth.installationId,
      fingerprint: auth.envelope.fingerprint,
    });
  } catch (err) {
    console.error("[rooms.seal-decision] rate limit check failed", {
      installationId: auth.installationId,
      error: err,
    });
    return NextResponse.json(
      { code: "storage_failure", message: "Failed to check rate limit." },
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
          `seal-decision rate limit exceeded — hit the ${scopeMessage}. ` +
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

  const rawBody = await parseJsonBody(request);
  if (!rawBody.ok) {
    return NextResponse.json(
      { code: rawBody.code, message: rawBody.message },
      { status: 400 },
    );
  }
  const parsedBody = parseSealDecisionBody(rawBody.body);
  if (!parsedBody.ok) {
    return NextResponse.json(
      { code: "invalid_body", message: parsedBody.message },
      { status: 400 },
    );
  }
  const body = parsedBody.body;

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
    console.error("[rooms.seal-decision] getRoomCore failed", {
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
    if (
      roomCore.status === "closed" &&
      body.finalState === "closed" &&
      roomCore.decision?.seal_audit_id === body.auditId
    ) {
      return NextResponse.json(
        {
          finalState: "closed",
          closedSequence: body.sealedThroughSequence + 1,
          auditId: body.auditId,
          idempotent: true,
        },
        { status: 200 },
      );
    }
    if (
      roomCore.status === "decided_pending_action" &&
      body.finalState === "decided_pending_action" &&
      roomCore.decision?.seal_audit_id === body.auditId
    ) {
      return NextResponse.json(
        {
          finalState: "decided_pending_action",
          pendingSequence: roomCore.decision.sequence_closed + 1,
          auditId: body.auditId,
          idempotent: true,
        },
        { status: 200 },
      );
    }
    return NextResponse.json(
      {
        code: "invalid_status_for_seal_decision",
        message:
          `Room must be in 'deciding'; current status is '${roomCore.status}'.`,
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
          `seal-decision only handles subject_type='pr_review'; got ` +
          `'${roomCore.subject_type}'.`,
      },
      { status: 409 },
    );
  }

  let auditRow;
  try {
    auditRow = await readQueenResolveActionAuditRow({
      redis: auth.redis,
      installationId: auth.installationId,
      auditId: body.auditId,
    });
  } catch (err) {
    if (err instanceof QueenResolveActionAuditNotFoundError) {
      return NextResponse.json(
        {
          code: "audit_not_found",
          message: `resolve-action audit row ${body.auditId} not found.`,
        },
        { status: 404 },
      );
    }
    if (err instanceof QueenResolveActionAuditMalformedError) {
      return NextResponse.json(
        { code: "invalid_audit_row", message: err.message },
        { status: 409 },
      );
    }
    console.error("[rooms.seal-decision] audit lookup failed", {
      installationId: auth.installationId,
      roomId,
      auditId: body.auditId,
      error: err,
    });
    return NextResponse.json(
      { code: "storage_failure", message: "Failed to load audit row." },
      { status: 500 },
    );
  }

  const auditTs = Date.parse(auditRow.ts);
  if (!Number.isFinite(auditTs)) {
    return NextResponse.json(
      {
        code: "invalid_audit_row",
        message: "resolve-action audit row has an invalid timestamp.",
      },
      { status: 409 },
    );
  }
  const auditAgeMs = Date.now() - auditTs;
  if (auditAgeMs > AUDIT_ID_MAX_AGE_MS) {
    return NextResponse.json(
      {
        code: "audit_id_stale",
        message:
          "resolve-action audit row is older than the 15 minute " +
          "seal-decision window; re-claim and resolve again.",
      },
      { status: 410 },
    );
  }
  if (
    auditRow.detail.room_id !== roomId ||
    auditRow.detail.subject_ref !== roomCore.subject_ref
  ) {
    return NextResponse.json(
      {
        code: "audit_room_mismatch",
        message:
          "resolve-action audit row does not belong to this room/subject.",
      },
      { status: 409 },
    );
  }
  if (
    auditRow.fingerprint !== auth.envelope.fingerprint ||
    auditRow.name !== auth.name
  ) {
    return NextResponse.json(
      {
        code: "audit_bearer_mismatch",
        message:
          "resolve-action audit row was produced by a different bearer.",
      },
      { status: 409 },
    );
  }

  if (body.commentUrl) {
    const verifyResponse = await verifyCommentSeal({
      installationId: auth.installationId,
      roomId,
      subjectRef: roomCore.subject_ref,
      commentUrl: body.commentUrl,
      auditId: body.auditId,
      auditTs: auditRow.ts,
      permittedAction: auditRow.detail.permitted_action,
      finalState: body.finalState,
    });
    if (!verifyResponse.ok) return verifyResponse.response;
  } else if (auditRow.detail.permitted_action !== "squash-merge") {
    return NextResponse.json(
      {
        code: "invalid_downgrade_for_permitted_action",
        message:
          "downgradeReason=intended_action_post_failed is only valid when " +
          "resolve-action permitted squash-merge.",
      },
      { status: 409 },
    );
  }

  const subject: SubjectRef = {
    type: roomCore.subject_type,
    ref: roomCore.subject_ref,
  };

  let finalSequence: number;
  try {
    if (body.finalState === "decided_pending_action") {
      finalSequence = await sealRoomForPendingMerge({
        installationId: auth.installationId,
        roomId,
        expectedThroughSequence: body.sealedThroughSequence,
        expectedRunner: body.queenRunner,
        decision: {
          ...body.decision,
          seal_audit_id: body.auditId,
          reviewed_head_sha: auditRow.detail.reviewed_head_sha,
        },
        subject,
        redis: auth.redis,
      });
    } else {
      finalSequence = await closeRoomWithDecision({
        installationId: auth.installationId,
        roomId,
        expectedThroughSequence: body.sealedThroughSequence,
        expectedRunner: body.queenRunner,
        decision: { ...body.decision, seal_audit_id: body.auditId },
        subject,
        redis: auth.redis,
      });
    }
  } catch (err) {
    const mapped = mapCloseError(err);
    if (mapped) return mapped;
    throw err;
  }

  if (body.downgradeReason === "intended_action_post_failed") {
    await emitQueenIntendedActionPostFailed({
      installationId: auth.installationId,
      redis: auth.redis,
      name: auth.name,
      fingerprint: auth.envelope.fingerprint,
      detail: {
        room_id: roomId,
        subject_ref: roomCore.subject_ref,
        recommended_action: "squash-merge",
        intended_action: "squash-merge",
        audit_id_from_resolve_action: body.auditId,
        error_class: body.errorClass ?? null,
        retry_count: body.retryCount ?? null,
      },
    });
  }

  const responseBody =
    body.finalState === "decided_pending_action"
      ? {
          finalState: "decided_pending_action" as const,
          pendingSequence: finalSequence,
          auditId: body.auditId,
        }
      : {
          finalState: "closed" as const,
          closedSequence: finalSequence,
          auditId: body.auditId,
        };
  return NextResponse.json(responseBody, { status: 200 });
}

async function verifyCommentSeal(args: {
  installationId: string;
  roomId: string;
  subjectRef: string;
  commentUrl: string;
  auditId: string;
  auditTs: string;
  permittedAction: "comment" | "squash-merge";
  finalState: FinalState;
}): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const expectedPermittedAction =
    args.finalState === "decided_pending_action" ? "squash-merge" : "comment";
  if (args.permittedAction !== expectedPermittedAction) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          code: "invalid_final_state_for_permitted_action",
          message:
            `finalState=${args.finalState} with commentUrl requires ` +
            `resolve-action permittedAction=${expectedPermittedAction}.`,
        },
        { status: 409 },
      ),
    };
  }

  const parsedRef = parsePullRequestSubjectRef(args.subjectRef);
  if (!parsedRef.ok) {
    console.error("[rooms.seal-decision] subject_ref parse failed", {
      installationId: args.installationId,
      roomId: args.roomId,
      subjectRef: args.subjectRef,
      reason: parsedRef.reason,
    });
    return {
      ok: false,
      response: NextResponse.json(
        {
          code: "configuration_error",
          message: `Room subject_ref could not be parsed: ${parsedRef.reason}`,
        },
        { status: 500 },
      ),
    };
  }

  const parsedUrl = parseCommentUrl(args.commentUrl);
  if (!parsedUrl.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          code: "invalid_seal_precondition",
          message: parsedUrl.reason,
          check: "comment_url_malformed",
        },
        { status: 400 },
      ),
    };
  }

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
  const appId = Number.parseInt(env.config.githubAppId, 10);
  if (!Number.isFinite(appId)) {
    return {
      ok: false,
      response: NextResponse.json(
        { code: "configuration_error", message: "GITHUB_APP_ID is invalid." },
        { status: 500 },
      ),
    };
  }

  let tokenResult;
  try {
    tokenResult = await mintInstallationToken({
      installationId: args.installationId,
      repo: `${parsedRef.ref.owner}/${parsedRef.ref.repo}`,
      appId: env.config.githubAppId,
      appPrivateKeyPem: env.config.githubAppPrivateKey,
      allowedPermissions: SEAL_DECISION_PERMISSIONS,
    });
  } catch (err) {
    if (err instanceof AppCredentialError) {
      console.error("[rooms.seal-decision] App credential error", err);
      return {
        ok: false,
        response: NextResponse.json(
          {
            code: "configuration_error",
            message: "GitHub App credentials are invalid.",
          },
          { status: 500 },
        ),
      };
    }
    console.error("[rooms.seal-decision] mintInstallationToken failed", {
      installationId: args.installationId,
      roomId: args.roomId,
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

  let comment;
  try {
    comment = await getIssueComment({
      token: tokenResult.token,
      owner: parsedUrl.parsed.owner,
      repo: parsedUrl.parsed.repo,
      commentId: parsedUrl.parsed.commentId,
    });
  } catch (err) {
    if (err instanceof GitHubCommentNotFoundError) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            code: "github_comment_not_found",
            message: `GitHub comment ${parsedUrl.parsed.commentId} not found.`,
          },
          { status: 404 },
        ),
      };
    }
    if (
      err instanceof GitHubCommentAPIError ||
      err instanceof GitHubCommentMalformedError
    ) {
      console.error("[rooms.seal-decision] GitHub comment read failed", {
        installationId: args.installationId,
        roomId: args.roomId,
        error: err,
      });
      return {
        ok: false,
        response: NextResponse.json(
          {
            code: "github_read_failed",
            message: "GitHub comment read failed.",
          },
          { status: 502 },
        ),
      };
    }
    throw err;
  }

  const expectedVerb: SealVerb =
    args.finalState === "decided_pending_action" ? "merge" : "comment";
  const verification = verifyCommentMatches({
    subjectRefParsed: parsedRef.ref,
    commentUrlParsed: parsedUrl.parsed,
    expectedAppId: appId,
    expectedVerb,
    expectedAuditId: args.auditId,
    resolveActionTs: args.auditTs,
    comment,
  });
  if (!verification.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          code: "invalid_seal_precondition",
          message: `comment_url failed ${verification.failure.check}.`,
          check: verification.failure.check,
          failure: verification.failure,
        },
        { status: 400 },
      ),
    };
  }

  return { ok: true };
}

function mapCloseError(err: unknown): NextResponse | null {
  if (err instanceof RoomRunnerFormatError) {
    return NextResponse.json(
      { code: "invalid_synthesis_runner", message: err.message },
      { status: 400 },
    );
  }
  if (err instanceof RoomCloseDriftError) {
    return NextResponse.json(
      {
        code: "sequence_drift",
        message: err.message,
        expectedThroughSequence: err.expectedThroughSequence,
        lastSeq: err.lastSeq,
      },
      { status: 409 },
    );
  }
  if (err instanceof RoomCloseClaimLostError) {
    return NextResponse.json(
      { code: "claim_lost", message: err.message },
      { status: 409 },
    );
  }
  if (err instanceof RoomCloseClaimThroughSeqMismatchError) {
    return NextResponse.json(
      {
        code: "claim_through_seq_mismatch",
        message: err.message,
        expectedThroughSequence: err.expectedThroughSequence,
        actualThroughSequence: err.actualThroughSequence,
      },
      { status: 409 },
    );
  }
  if (err instanceof RoomCloseClaimRunnerMismatchError) {
    return NextResponse.json(
      {
        code: "claim_runner_mismatch",
        message: err.message,
        expectedRunner: err.expectedRunner,
        actualRunner: err.actualRunner,
      },
      { status: 409 },
    );
  }
  if (err instanceof RoomClaimPayloadCorruptError) {
    return NextResponse.json(
      { code: "claim_payload_corrupt", message: err.message },
      { status: 409 },
    );
  }
  if (err instanceof RoomDecisionTooLargeError) {
    return NextResponse.json(
      {
        code: "decision_too_large",
        message: err.message,
        sizeBytes: err.sizeBytes,
      },
      { status: 400 },
    );
  }
  return null;
}
