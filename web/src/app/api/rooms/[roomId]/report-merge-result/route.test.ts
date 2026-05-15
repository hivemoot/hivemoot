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
    reportMergeResultForRoom: vi.fn(),
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
    getPullRequestMergeState: vi.fn(),
  };
});

vi.mock("@/server/queen-audit", async () => {
  const real = await vi.importActual<typeof import("@/server/queen-audit")>(
    "@/server/queen-audit",
  );
  return {
    ...real,
    checkReportMergeResultRateLimit: vi.fn(async () => ({ allowed: true })),
    emitQueenMergeResult: vi.fn(async () => undefined),
  };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { validateEnv } from "@/server/env";
import {
  getRoomCore,
  reportMergeResultForRoom,
} from "@hivemoot/war-room";
import { mintInstallationToken } from "@/server/github-installation-token";
import { getPullRequestMergeState } from "@/server/github-pr-state";
import {
  checkReportMergeResultRateLimit,
  emitQueenMergeResult,
} from "@/server/queen-audit";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedEnv = vi.mocked(validateEnv);
const mockedGetRoomCore = vi.mocked(getRoomCore);
const mockedReport = vi.mocked(reportMergeResultForRoom);
const mockedMintToken = vi.mocked(mintInstallationToken);
const mockedGetMergeState = vi.mocked(getPullRequestMergeState);
const mockedRateLimit = vi.mocked(checkReportMergeResultRateLimit);
const mockedEmit = vi.mocked(emitQueenMergeResult);

const ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";
const MERGE_SHA = "feedfacefeedfacefeedfacefeedfacefeedface";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    `https://www.hivemoot.dev/api/rooms/${ROOM_ID}/report-merge-result`,
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
    githubMergeStatus: "succeeded",
    mergeCommitOid: MERGE_SHA,
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
    status: "closed" as const,
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
      decision_outcome: "merge_approved" as const,
      merge_attempt_id: "attempt-1",
      github_merge_status: "pending" as const,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-10T00:05:00.000Z"));
  mockedAuth.mockReset();
  mockedEnv.mockReset();
  mockedGetRoomCore.mockReset();
  mockedReport.mockReset();
  mockedMintToken.mockReset();
  mockedGetMergeState.mockReset();
  mockedRateLimit.mockReset();
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
  mockedReport.mockResolvedValue(undefined);
  mockedMintToken.mockResolvedValue({
    token: "ghs_fake_installation_token",
    expires_at: "2026-05-10T01:00:00Z",
    installation_id: "12345",
    permissions: {},
    repositories: [],
    hashed_token: "hash",
  });
  mockedGetMergeState.mockResolvedValue({
    state: "closed",
    merged: true,
    mergeCommitSha: MERGE_SHA,
    headSha: "deadbeef",
  });
  mockedRateLimit.mockResolvedValue({ allowed: true });
  mockedEmit.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/rooms/:roomId/report-merge-result", () => {
  it("records a verified successful GitHub merge", async () => {
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      githubMergeStatus: "succeeded",
      mergeAttemptId: "attempt-1",
      mergeCommitOid: MERGE_SHA,
      errorClass: null,
    });
    expect(mockedReport).toHaveBeenCalledWith(
      expect.objectContaining({
        mergeAttemptId: "attempt-1",
        decision: expect.objectContaining({
          github_merge_status: "succeeded",
          merge_commit_oid: MERGE_SHA,
        }),
      }),
    );
    expect(mockedEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          github_merge_status: "succeeded",
          merge_commit_oid: MERGE_SHA,
        }),
      }),
    );
  });

  it("records a failed result only when GitHub does not show the PR merged", async () => {
    mockedGetMergeState.mockResolvedValue({
      state: "open",
      merged: false,
      mergeCommitSha: null,
      headSha: "deadbeef",
    });
    const res = await POST(
      makeRequest(
        makeBody({
          githubMergeStatus: "failed",
          mergeCommitOid: undefined,
          errorClass: "merge_conflict",
        }),
      ),
      makeContext(),
    );
    expect(res.status).toBe(200);
    expect(mockedReport).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          github_merge_status: "failed",
          github_merge_error_class: "merge_conflict",
        }),
      }),
    );
  });

  it("rejects a failed report when GitHub already shows the PR merged", async () => {
    const res = await POST(
      makeRequest(
        makeBody({
          githubMergeStatus: "failed",
          mergeCommitOid: undefined,
        }),
      ),
      makeContext(),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("github_merge_result_mismatch");
    expect(mockedReport).not.toHaveBeenCalled();
  });

  it("is idempotent when the same result is already recorded", async () => {
    mockedGetRoomCore.mockResolvedValue(
      makeRoom({
        decision: {
          ...makeRoom().decision,
          github_merge_status: "succeeded",
          merge_commit_oid: MERGE_SHA,
        },
      }),
    );
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      githubMergeStatus: "succeeded",
      mergeAttemptId: "attempt-1",
      idempotent: true,
    });
    expect(mockedReport).not.toHaveBeenCalled();
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
