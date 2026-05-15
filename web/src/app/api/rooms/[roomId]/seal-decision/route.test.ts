import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/agent-token-v1-auth", () => ({
  authenticateAgentRequestV1: vi.fn(),
}));

vi.mock("@/server/env", () => ({
  validateEnv: vi.fn(),
}));

vi.mock("@hivemoot/war-room", async () => {
  const real = await vi.importActual<typeof import("@hivemoot/war-room")>(
    "@hivemoot/war-room",
  );
  return {
    ...real,
    closeRoomWithDecision: vi.fn(),
    getRoomCore: vi.fn(),
  };
});

vi.mock("@/server/github-installation-token", async () => {
  const real = await vi.importActual<
    typeof import("@/server/github-installation-token")
  >("@/server/github-installation-token");
  return {
    ...real,
    mintInstallationToken: vi.fn(),
  };
});

vi.mock("@/server/github-issue-comment", async () => {
  const real = await vi.importActual<
    typeof import("@/server/github-issue-comment")
  >("@/server/github-issue-comment");
  return {
    ...real,
    getIssueComment: vi.fn(),
  };
});

vi.mock("@/server/queen-audit", async () => {
  const real = await vi.importActual<typeof import("@/server/queen-audit")>(
    "@/server/queen-audit",
  );
  return {
    ...real,
    checkSealDecisionRateLimit: vi.fn(async () => ({ allowed: true })),
    readQueenResolveActionAuditRow: vi.fn(),
    emitQueenIntendedActionPostFailed: vi.fn(async () => undefined),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { validateEnv } from "@/server/env";
import {
  closeRoomWithDecision,
  getRoomCore,
  RoomNotFoundError,
  RoomCloseClaimRunnerMismatchError,
} from "@hivemoot/war-room";
import { mintInstallationToken } from "@/server/github-installation-token";
import { getIssueComment } from "@/server/github-issue-comment";
import {
  checkSealDecisionRateLimit,
  readQueenResolveActionAuditRow,
  emitQueenIntendedActionPostFailed,
  QueenResolveActionAuditNotFoundError,
} from "@/server/queen-audit";
import { buildSealHeader } from "@/server/seal-decision-verifier";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedEnv = vi.mocked(validateEnv);
const mockedClose = vi.mocked(closeRoomWithDecision);
const mockedGetRoomCore = vi.mocked(getRoomCore);
const mockedMintToken = vi.mocked(mintInstallationToken);
const mockedGetIssueComment = vi.mocked(getIssueComment);
const mockedRateLimit = vi.mocked(checkSealDecisionRateLimit);
const mockedReadAudit = vi.mocked(readQueenResolveActionAuditRow);
const mockedEmitPostFailed = vi.mocked(emitQueenIntendedActionPostFailed);

const ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";
const AUDIT_ID = "1715000000000-0";
const AUDIT_TS = "2026-05-10T00:00:00.000Z";
const COMMENT_URL =
  "https://github.com/hivemoot/colony/pull/42#issuecomment-123456";

const VALID_DECISION = {
  synthesized_at: "2026-05-10T00:04:30.000Z",
  synthesis_runner: "queen-hive-1",
  content: "## Decision\nShip the comment path.",
  sequence_closed: 7,
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    `https://www.hivemoot.dev/api/rooms/${ROOM_ID}/seal-decision`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

function makeContext(roomId = ROOM_ID) {
  return { params: Promise.resolve({ roomId }) };
}

function makeAuthOk() {
  return {
    ok: true as const,
    installationId: "12345",
    name: "queen-hive-1",
    agent_role: "local_queen",
    capabilities: ["rooms.synthesize"],
    redis: {} as never,
    envelope: {
      fingerprint: "fp123",
      expiresAt: null,
    } as never,
  };
}

function makeRoom(overrides: Record<string, unknown> = {}) {
  return {
    manager: "bot-queen",
    subject_type: "pr_review" as const,
    subject_ref: "hivemoot/colony#42",
    opened_at: "2026-05-10T00:00:00Z",
    status: "deciding" as const,
    timing_config: {
      max_age_secs: 86400,
      drop_threshold_secs: 600,
      quiet_period_secs: 60,
    },
    last_transition_at: "2026-05-10T00:00:00Z",
    ...overrides,
  };
}

function makeAudit(overrides: {
  ts?: string;
  fingerprint?: string;
  name?: string;
  detail?: Record<string, unknown>;
} = {}) {
  return {
    id: AUDIT_ID,
    ts: overrides.ts ?? AUDIT_TS,
    fingerprint: overrides.fingerprint ?? "fp123",
    name: overrides.name ?? "queen-hive-1",
    actor: "queen-hive-1",
    detail: {
      room_id: ROOM_ID,
      subject_ref: "hivemoot/colony#42",
      recommended_action: "comment",
      permitted_action: "comment",
      clamped_verdict: "COMMENT",
      reviewed_head_sha: "deadbeef",
      current_head_sha: "deadbeef",
      downgrade_reason: null,
      floor_overridden: false,
      ...overrides.detail,
    },
  } as never;
}

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 123456,
    html_url: COMMENT_URL,
    body: `${buildSealHeader("comment", AUDIT_ID)}\n\nDecision body`,
    created_at: "2026-05-10T00:01:00Z",
    performed_via_github_app: { id: 12345 },
    ...overrides,
  } as never;
}

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    queenRunner: "queen-hive-1",
    auditId: AUDIT_ID,
    finalState: "closed",
    sealedThroughSequence: 7,
    decision: VALID_DECISION,
    commentUrl: COMMENT_URL,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-10T00:05:00.000Z"));
  mockedAuth.mockReset();
  mockedEnv.mockReset();
  mockedClose.mockReset();
  mockedGetRoomCore.mockReset();
  mockedMintToken.mockReset();
  mockedGetIssueComment.mockReset();
  mockedRateLimit.mockReset();
  mockedReadAudit.mockReset();
  mockedEmitPostFailed.mockReset();

  mockedAuth.mockResolvedValue(makeAuthOk());
  mockedEnv.mockReturnValue({
    ok: true,
    config: {
      githubAppId: "12345",
      githubAppPrivateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
    } as never,
  });
  mockedGetRoomCore.mockResolvedValue(makeRoom());
  mockedRateLimit.mockResolvedValue({ allowed: true });
  mockedReadAudit.mockResolvedValue(makeAudit());
  mockedMintToken.mockResolvedValue({
    token: "ghs_fake_installation_token",
    expires_at: "2026-05-10T01:00:00Z",
    installation_id: "12345",
    permissions: {},
    repositories: [],
    hashed_token: "hash",
  });
  mockedGetIssueComment.mockResolvedValue(makeComment());
  mockedClose.mockResolvedValue(8);
  mockedEmitPostFailed.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/rooms/:roomId/seal-decision", () => {
  it("requires rooms.synthesize capability", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({}, { status: 403 }),
    });
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(403);
    expect(mockedAuth).toHaveBeenCalledWith(expect.any(NextRequest), {
      requires: "rooms.synthesize",
    });
    expect(mockedClose).not.toHaveBeenCalled();
  });

  it("happy path: verifies GitHub comment then closes with expectedRunner", async () => {
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      finalState: "closed",
      closedSequence: 8,
      auditId: AUDIT_ID,
    });

    expect(mockedMintToken).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "hivemoot/colony",
        allowedPermissions: { issues: "read", metadata: "read" },
      }),
    );
    expect(mockedGetIssueComment).toHaveBeenCalledWith({
      token: "ghs_fake_installation_token",
      owner: "hivemoot",
      repo: "colony",
      commentId: 123456,
    });
    expect(mockedClose).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedThroughSequence: 7,
        expectedRunner: "queen-hive-1",
        subject: { type: "pr_review", ref: "hivemoot/colony#42" },
      }),
    );
  });

  it("accepts snake_case comment_url for the documented wire shape", async () => {
    const res = await POST(
      makeRequest({
        queen_runner: "queen-hive-1",
        audit_id: AUDIT_ID,
        final_state: "closed",
        sealed_through_sequence: 7,
        decision: VALID_DECISION,
        comment_url: COMMENT_URL,
      }),
      makeContext(),
    );
    expect(res.status).toBe(200);
    expect(mockedGetIssueComment).toHaveBeenCalled();
  });

  it("downgrade path closes without GitHub comment verification and emits G20 audit", async () => {
    mockedReadAudit.mockResolvedValue(
      makeAudit({
        detail: {
          recommended_action: "squash-merge",
          permitted_action: "squash-merge",
          clamped_verdict: "APPROVE",
        },
      }),
    );
    const res = await POST(
      makeRequest({
        ...makeBody({ commentUrl: undefined }),
        downgradeReason: "intended_action_post_failed",
        errorClass: "gh_comment_failed",
        retryCount: 3,
      }),
      makeContext(),
    );
    expect(res.status).toBe(200);
    expect(mockedMintToken).not.toHaveBeenCalled();
    expect(mockedGetIssueComment).not.toHaveBeenCalled();
    expect(mockedEmitPostFailed).toHaveBeenCalledTimes(1);
    expect(mockedEmitPostFailed.mock.calls[0][0].detail).toEqual(
      expect.objectContaining({
        room_id: ROOM_ID,
        recommended_action: "squash-merge",
        intended_action: "squash-merge",
        audit_id_from_resolve_action: AUDIT_ID,
        error_class: "gh_comment_failed",
        retry_count: 3,
      }),
    );
  });

  it("rejects malformed bodies before loading room state", async () => {
    const res = await POST(
      makeRequest({ ...makeBody(), commentUrl: undefined }),
      makeContext(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_body");
    expect(mockedGetRoomCore).not.toHaveBeenCalled();
  });

  it("returns 404 when the room does not exist", async () => {
    mockedGetRoomCore.mockRejectedValue(new RoomNotFoundError("12345", ROOM_ID));
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("room_not_found");
  });

  it("returns 404 when the resolve-action audit row is missing", async () => {
    mockedReadAudit.mockRejectedValue(
      new QueenResolveActionAuditNotFoundError(AUDIT_ID),
    );
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("audit_not_found");
    expect(mockedClose).not.toHaveBeenCalled();
  });

  it("returns 410 when audit_id is outside the 15 minute seal window", async () => {
    mockedReadAudit.mockResolvedValue(
      makeAudit({ ts: "2026-05-09T23:00:00.000Z" }),
    );
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("audit_id_stale");
  });

  it("returns 400 invalid_seal_precondition when verifier rejects the comment", async () => {
    mockedGetIssueComment.mockResolvedValue(
      makeComment({ body: "no seal header here" }),
    );
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_seal_precondition");
    expect(body.check).toBe("header_missing_or_malformed");
    expect(mockedClose).not.toHaveBeenCalled();
  });

  it("rejects closed+commentUrl when resolve-action had permitted squash-merge", async () => {
    mockedReadAudit.mockResolvedValue(
      makeAudit({ detail: { permitted_action: "squash-merge" } }),
    );
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(
      "invalid_final_state_for_permitted_action",
    );
    expect(mockedGetIssueComment).not.toHaveBeenCalled();
  });

  it("maps close claim-runner mismatch to a typed 409", async () => {
    mockedClose.mockRejectedValue(
      new RoomCloseClaimRunnerMismatchError(
        ROOM_ID,
        "queen-hive-1",
        "queen-hive-2",
      ),
    );
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("claim_runner_mismatch");
    expect(body.actualRunner).toBe("queen-hive-2");
  });

  it("is idempotent when retry sees the same seal_audit_id on an already-closed room", async () => {
    mockedGetRoomCore.mockResolvedValue(
      makeRoom({
        status: "closed",
        decision: { ...VALID_DECISION, seal_audit_id: AUDIT_ID },
      }),
    );
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      finalState: "closed",
      closedSequence: 8,
      auditId: AUDIT_ID,
      idempotent: true,
    });
    expect(mockedReadAudit).not.toHaveBeenCalled();
    expect(mockedClose).not.toHaveBeenCalled();
  });

  it("returns 429 when seal-decision is rate limited before GitHub reads", async () => {
    mockedRateLimit.mockResolvedValueOnce({
      allowed: false,
      scope: "per_bearer",
      currentCount: 61,
      resetAtSecs: 12,
    });
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("12");
    expect(mockedMintToken).not.toHaveBeenCalled();
    expect(mockedClose).not.toHaveBeenCalled();
  });
});
