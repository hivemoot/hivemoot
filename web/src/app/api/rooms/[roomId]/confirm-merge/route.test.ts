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
    getRoomCore: vi.fn(),
    confirmPendingMergeDecision: vi.fn(),
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

vi.mock("@/server/github-pr-state", async () => {
  const real = await vi.importActual<
    typeof import("@/server/github-pr-state")
  >("@/server/github-pr-state");
  return {
    ...real,
    getPullRequestState: vi.fn(),
  };
});

vi.mock("@/server/queen-audit", async () => {
  const real = await vi.importActual<typeof import("@/server/queen-audit")>(
    "@/server/queen-audit",
  );
  return {
    ...real,
    checkConfirmMergeRateLimit: vi.fn(async () => ({ allowed: true })),
    readQueenResolveActionAuditRow: vi.fn(),
    emitQueenConfirmMerge: vi.fn(async () => undefined),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { validateEnv } from "@/server/env";
import {
  confirmPendingMergeDecision,
  getRoomCore,
} from "@hivemoot/war-room";
import { mintInstallationToken } from "@/server/github-installation-token";
import { getPullRequestState } from "@/server/github-pr-state";
import {
  checkConfirmMergeRateLimit,
  emitQueenConfirmMerge,
  readQueenResolveActionAuditRow,
} from "@/server/queen-audit";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedEnv = vi.mocked(validateEnv);
const mockedGetRoomCore = vi.mocked(getRoomCore);
const mockedConfirm = vi.mocked(confirmPendingMergeDecision);
const mockedMintToken = vi.mocked(mintInstallationToken);
const mockedGetPrState = vi.mocked(getPullRequestState);
const mockedRateLimit = vi.mocked(checkConfirmMergeRateLimit);
const mockedReadAudit = vi.mocked(readQueenResolveActionAuditRow);
const mockedEmit = vi.mocked(emitQueenConfirmMerge);

const ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";
const AUDIT_ID = "1715000000000-0";
const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    `https://www.hivemoot.dev/api/rooms/${ROOM_ID}/confirm-merge`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function makeContext(roomId = ROOM_ID) {
  return { params: Promise.resolve({ roomId }) };
}

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    queenRunner: "queen-hive-1",
    mergeAttemptId: "attempt-1",
    currentHeadSha: HEAD_SHA,
    ...overrides,
  };
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
    status: "decided_pending_action" as const,
    timing_config: {
      max_age_secs: 86400,
      drop_threshold_secs: 600,
      quiet_period_secs: 60,
    },
    decision: {
      synthesized_at: "2026-05-10T00:02:00.000Z",
      synthesis_runner: "queen-hive-1",
      content: "Decision",
      sequence_closed: 7,
      seal_audit_id: AUDIT_ID,
      reviewed_head_sha: HEAD_SHA,
      pending_action_at: "2026-05-10T00:03:00.000Z",
    },
    ...overrides,
  };
}

function makeAudit(overrides: Record<string, unknown> = {}) {
  return {
    id: AUDIT_ID,
    ts: "2026-05-10T00:02:30.000Z",
    fingerprint: "fp123",
    name: "queen-hive-1",
    actor: "queen-hive-1",
    detail: {
      room_id: ROOM_ID,
      subject_ref: "hivemoot/colony#42",
      recommended_action: "squash-merge",
      permitted_action: "squash-merge",
      clamped_verdict: "APPROVE",
      reviewed_head_sha: HEAD_SHA,
      current_head_sha: HEAD_SHA,
      downgrade_reason: null,
      floor_overridden: false,
      ...overrides,
    },
  } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-10T00:05:00.000Z"));
  mockedAuth.mockReset();
  mockedEnv.mockReset();
  mockedGetRoomCore.mockReset();
  mockedConfirm.mockReset();
  mockedMintToken.mockReset();
  mockedGetPrState.mockReset();
  mockedRateLimit.mockReset();
  mockedReadAudit.mockReset();
  mockedEmit.mockReset();

  mockedAuth.mockResolvedValue(makeAuthOk());
  mockedEnv.mockReturnValue({
    ok: true,
    config: {
      githubAppId: "12345",
      githubAppPrivateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
    } as never,
  });
  mockedGetRoomCore.mockResolvedValue(makeRoom());
  mockedConfirm.mockResolvedValue(9);
  mockedMintToken.mockResolvedValue({
    token: "ghs_fake_installation_token",
    expires_at: "2026-05-10T01:00:00Z",
    installation_id: "12345",
    permissions: {},
    repositories: [],
    hashed_token: "hash",
  });
  mockedGetPrState.mockResolvedValue({
    headSha: HEAD_SHA,
    labels: ["hivemoot:automerge"],
    ciState: "success",
    mergeableState: "clean",
  });
  mockedRateLimit.mockResolvedValue({ allowed: true });
  mockedReadAudit.mockResolvedValue(makeAudit());
  mockedEmit.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/rooms/:roomId/confirm-merge", () => {
  it("approves a server-verified merge attempt", async () => {
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      decisionOutcome: "merge_approved",
      decisionOutcomeReason: null,
      githubMergeStatus: "pending",
      mergeAttemptId: "attempt-1",
      closedSequence: 9,
    });
    expect(mockedConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPendingSequence: 8,
        decision: expect.objectContaining({
          decision_outcome: "merge_approved",
          merge_attempt_id: "attempt-1",
          merge_attempt_fingerprint: "fp123",
          github_merge_status: "pending",
        }),
      }),
    );
    expect(mockedMintToken).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionCeiling: expect.objectContaining({ checks: "read" }),
        allowedPermissions: expect.objectContaining({ checks: "read" }),
      }),
    );
    expect(mockedEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          decision_outcome: "merge_approved",
          merge_attempt_id: "attempt-1",
        }),
      }),
    );
  });

  it("downgrades when the tick-N+1 head SHA differs from GitHub", async () => {
    mockedGetPrState.mockResolvedValue({
      headSha: "cafebabecafebabecafebabecafebabecafebabe",
      labels: ["hivemoot:automerge"],
      ciState: "success",
      mergeableState: "clean",
    });
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      decisionOutcome: "merge_downgraded",
      decisionOutcomeReason: "head_sha_drift",
      githubMergeStatus: null,
    });
    expect(mockedConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          decision_outcome: "merge_downgraded",
          decision_outcome_reason: "head_sha_drift",
          github_merge_status: undefined,
        }),
      }),
    );
  });

  it("downgrades when an operator hold label is present", async () => {
    mockedGetPrState.mockResolvedValue({
      headSha: HEAD_SHA,
      labels: ["hivemoot:automerge", "hivemoot:hold"],
      ciState: "success",
      mergeableState: "clean",
    });
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      decisionOutcome: "merge_downgraded",
      decisionOutcomeReason: "hold_label_present",
      githubMergeStatus: null,
    });
    expect(mockedConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          decision_outcome: "merge_downgraded",
          decision_outcome_reason: "hold_label_present",
          github_merge_status: undefined,
        }),
      }),
    );
  });

  it("enforces the 60s override window", async () => {
    mockedGetRoomCore.mockResolvedValue(
      makeRoom({
        decision: {
          ...makeRoom().decision,
          pending_action_at: "2026-05-10T00:04:30.000Z",
        },
      }),
    );
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("override_window_active");
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it("is idempotent when the same merge attempt already closed the room", async () => {
    mockedGetRoomCore.mockResolvedValue(
      makeRoom({
        status: "closed",
        decision: {
          ...makeRoom().decision,
          decision_outcome: "merge_approved",
          merge_attempt_id: "attempt-1",
          github_merge_status: "pending",
        },
      }),
    );
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      decisionOutcome: "merge_approved",
      mergeAttemptId: "attempt-1",
      idempotent: true,
    });
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

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
  });
});
