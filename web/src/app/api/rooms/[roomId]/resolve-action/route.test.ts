import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Mock all dependencies
// ---------------------------------------------------------------------------

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
    getRoomContributions: vi.fn(),
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

vi.mock("@/server/queen-audit", () => ({
  emitQueenVerdictFloorOverride: vi.fn(async () => undefined),
  emitQueenActionDowngrade: vi.fn(async () => undefined),
}));

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { validateEnv } from "@/server/env";
import {
  getRoomCore,
  getRoomContributions,
  RoomNotFoundError,
} from "@hivemoot/war-room";
import {
  mintInstallationToken,
  AppCredentialError,
} from "@/server/github-installation-token";
import {
  getPullRequestState,
  PullRequestNotFoundError,
  GitHubAPIError,
} from "@/server/github-pr-state";
import {
  emitQueenVerdictFloorOverride,
  emitQueenActionDowngrade,
} from "@/server/queen-audit";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedEnv = vi.mocked(validateEnv);
const mockedGetRoomCore = vi.mocked(getRoomCore);
const mockedGetRoomContributions = vi.mocked(getRoomContributions);
const mockedMintToken = vi.mocked(mintInstallationToken);
const mockedGetPrState = vi.mocked(getPullRequestState);
const mockedEmitG1 = vi.mocked(emitQueenVerdictFloorOverride);
const mockedEmitG2 = vi.mocked(emitQueenActionDowngrade);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function makeRedis(claimRaw: string | null = JSON.stringify({
  runner: "queen-hive-1",
  throughSequence: 42,
})) {
  return {
    get: vi.fn(async () => claimRaw),
  } as never;
}

function makeAuthOk(redis = makeRedis()) {
  return {
    ok: true as const,
    installationId: "12345",
    name: "queen-hive-1",
    agent_role: "local_queen",
    capabilities: ["rooms.synthesize"],
    envelope: {
      ciphertext: "ct",
      iv: "iv",
      tag: "tag",
      keyVersion: "v1",
      tokenHash: "hash",
      fingerprint: "fp123",
      createdAt: "2026-05-09T00:00:00Z",
      createdBy: "ops",
      expiresAt: null,
      name: "queen-hive-1",
      agent_role: "local_queen",
      capabilities: ["rooms.synthesize"],
    },
    redis,
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
    last_post_close_drift_count: 0,
    ...overrides,
  };
}

function makePrState(overrides: Record<string, unknown> = {}) {
  return {
    headSha: HEAD_SHA,
    labels: ["hivemoot:automerge"],
    ciState: "success" as const,
    mergeableState: "clean" as string | null,
    ...overrides,
  };
}

function makeEnvOk() {
  return {
    ok: true as const,
    config: {
      githubAppId: "12345",
      githubAppPrivateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      // Other fields not relevant to this endpoint
    } as never,
  };
}

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    queenRunner: "queen-hive-1",
    derivedVerdict: { verdict: "APPROVE", reasoning: "all reviewers approved" },
    recommendedAction: "squash-merge",
    reviewedHeadSha: HEAD_SHA,
    sealedThroughSequence: 42,
    ...overrides,
  };
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    "https://www.hivemoot.dev/api/rooms/rm-abc/resolve-action",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

function makeContext(roomId = "rm-abc") {
  return { params: Promise.resolve({ roomId }) };
}

beforeEach(() => {
  mockedAuth.mockReset();
  mockedEnv.mockReset();
  mockedGetRoomCore.mockReset();
  mockedGetRoomContributions.mockReset();
  mockedMintToken.mockReset();
  mockedGetPrState.mockReset();
  mockedEmitG1.mockReset();
  mockedEmitG2.mockReset();
  // Defaults — individual tests override.
  mockedEnv.mockReturnValue(makeEnvOk());
  mockedGetRoomContributions.mockResolvedValue({});
  mockedMintToken.mockResolvedValue({
    token: "ghs_fake_installation_token",
    expiresAt: "2026-05-10T01:00:00Z",
    permissions: {},
    repositorySelection: "selected",
  } as never);
  mockedGetPrState.mockResolvedValue(makePrState());
});

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe("POST /api/rooms/:roomId/resolve-action — auth", () => {
  it("delegates 401 when bearer is missing", async () => {
    mockedAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { code: "agent_auth_v1_missing_bearer" },
        { status: 401 },
      ),
    });
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(401);
    expect(mockedGetRoomCore).not.toHaveBeenCalled();
  });

  it("requires rooms.synthesize capability", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue(makeRoom());
    await POST(makeRequest(makeBody()), makeContext());
    expect(mockedAuth).toHaveBeenCalledWith(expect.any(NextRequest), {
      requires: "rooms.synthesize",
    });
  });
});

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

describe("POST /api/rooms/:roomId/resolve-action — body validation", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeAuthOk());
  });

  it("rejects missing queenRunner", async () => {
    const res = await POST(
      makeRequest({ ...makeBody(), queenRunner: undefined }),
      makeContext(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_body");
  });

  it("rejects malformed JSON", async () => {
    const res = await POST(makeRequest("not-valid-json{{{"), makeContext());
    expect(res.status).toBe(400);
  });

  it("rejects verdict outside the enum", async () => {
    const res = await POST(
      makeRequest({
        ...makeBody(),
        derivedVerdict: { verdict: "APPROVE_PLUS", reasoning: "x" },
      }),
      makeContext(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects reasoning over 500 chars", async () => {
    const res = await POST(
      makeRequest({
        ...makeBody(),
        derivedVerdict: { verdict: "APPROVE", reasoning: "x".repeat(501) },
      }),
      makeContext(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects recommendedAction outside the enum", async () => {
    const res = await POST(
      makeRequest({ ...makeBody(), recommendedAction: "force-merge" }),
      makeContext(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects empty reviewedHeadSha", async () => {
    const res = await POST(
      makeRequest({ ...makeBody(), reviewedHeadSha: "" }),
      makeContext(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects non-integer sealedThroughSequence", async () => {
    const res = await POST(
      makeRequest({ ...makeBody(), sealedThroughSequence: 3.14 }),
      makeContext(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects negative sealedThroughSequence", async () => {
    const res = await POST(
      makeRequest({ ...makeBody(), sealedThroughSequence: -1 }),
      makeContext(),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Room load + status check
// ---------------------------------------------------------------------------

describe("POST /api/rooms/:roomId/resolve-action — room load", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeAuthOk());
  });

  it("returns 404 when getRoomCore throws RoomNotFoundError", async () => {
    mockedGetRoomCore.mockRejectedValue(new RoomNotFoundError("12345", "rm-abc"));
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("room_not_found");
  });

  it("returns 409 invalid_status when room is awaiting_contributions", async () => {
    mockedGetRoomCore.mockResolvedValue(makeRoom({ status: "awaiting_contributions" }));
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("invalid_status_for_resolve_action");
    expect(body.actualStatus).toBe("awaiting_contributions");
  });

  it("returns 409 invalid_status when room is closed", async () => {
    mockedGetRoomCore.mockResolvedValue(makeRoom({ status: "closed" }));
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(409);
  });

  it("returns 409 unsupported_subject_type for non-pr_review rooms", async () => {
    mockedGetRoomCore.mockResolvedValue(
      makeRoom({ subject_type: "issue_triage" as never }),
    );
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("unsupported_subject_type");
  });
});

// ---------------------------------------------------------------------------
// Claim verification
// ---------------------------------------------------------------------------

describe("POST /api/rooms/:roomId/resolve-action — claim verification", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue(makeRoom());
  });

  it("returns 409 claim_not_held when the claim key is missing (TTL'd)", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk(makeRedis(null)));
    mockedGetRoomCore.mockResolvedValue(makeRoom());
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("claim_not_held");
  });

  it("returns 409 claim_payload_corrupt when the claim JSON is unparseable", async () => {
    mockedAuth.mockResolvedValue(makeAuthOk(makeRedis("not-json-at-all")));
    mockedGetRoomCore.mockResolvedValue(makeRoom());
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("claim_payload_corrupt");
    errSpy.mockRestore();
  });

  it("returns 409 claim_runner_mismatch when a different runner holds the claim", async () => {
    mockedAuth.mockResolvedValue(
      makeAuthOk(
        makeRedis(JSON.stringify({ runner: "other-queen", throughSequence: 42 })),
      ),
    );
    mockedGetRoomCore.mockResolvedValue(makeRoom());
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("claim_runner_mismatch");
    expect(body.heldByRunner).toBe("other-queen");
  });

  it("returns 409 sequence_drift when sealedThroughSequence doesn't match", async () => {
    // Claim is at throughSequence=42; body says 41 (queen synthesized
    // against older sequence).
    const res = await POST(
      makeRequest({ ...makeBody(), sealedThroughSequence: 41 }),
      makeContext(),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("sequence_drift");
    expect(body.claimThroughSequence).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Happy path — squash-merge permitted
// ---------------------------------------------------------------------------

describe("POST /api/rooms/:roomId/resolve-action — squash-merge happy path", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue(makeRoom());
  });

  it("returns permittedAction=squash-merge when all D1 invariants pass", async () => {
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.permittedAction).toBe("squash-merge");
    expect(body.clampedVerdict).toBe("APPROVE");
    expect(body.downgradeReason).toBeNull();
    expect(body.reviewedHeadSha).toBe(HEAD_SHA);
    expect(body.currentHeadSha).toBe(HEAD_SHA);
    expect(body.floorOverridden).toBe(false);
  });

  it("mints with read-only permissions only (no write scopes)", async () => {
    await POST(makeRequest(makeBody()), makeContext());
    expect(mockedMintToken).toHaveBeenCalled();
    const mintCall = mockedMintToken.mock.calls[0][0];
    expect(mintCall.allowedPermissions).toEqual({
      pull_requests: "read",
      checks: "read",
      contents: "read",
      metadata: "read",
    });
  });

  it("does NOT emit G1 or G2 audit events on the all-pass squash-merge path", async () => {
    await POST(makeRequest(makeBody()), makeContext());
    expect(mockedEmitG1).not.toHaveBeenCalled();
    expect(mockedEmitG2).not.toHaveBeenCalled();
  });

  it("does NOT mutate room state (advisory endpoint)", async () => {
    const redis = makeRedis();
    mockedAuth.mockResolvedValue(makeAuthOk(redis));
    await POST(makeRequest(makeBody()), makeContext());
    // The only Redis call we make is the claim GET. No HSET, no
    // SADD/SREM, nothing on the room hash.
    expect((redis as unknown as { get: ReturnType<typeof vi.fn> }).get).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Downgrade paths — each D1 invariant maps to a typed reason
// ---------------------------------------------------------------------------

describe("POST /api/rooms/:roomId/resolve-action — downgrade reasons", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue(makeRoom());
  });

  it("verdict_not_approve: COMMENT verdict downgrades to comment", async () => {
    const res = await POST(
      makeRequest({
        ...makeBody(),
        derivedVerdict: { verdict: "COMMENT", reasoning: "mixed signals" },
      }),
      makeContext(),
    );
    const body = await res.json();
    expect(body.permittedAction).toBe("comment");
    expect(body.downgradeReason).toBe("verdict_not_approve");
  });

  it("label_missing: no hivemoot:automerge → comment + G2 emission", async () => {
    mockedGetPrState.mockResolvedValue(makePrState({ labels: ["ready"] }));
    const res = await POST(makeRequest(makeBody()), makeContext());
    const body = await res.json();
    expect(body.permittedAction).toBe("comment");
    expect(body.downgradeReason).toBe("label_missing");
    // G2 fires because recommended=squash-merge but permitted=comment
    expect(mockedEmitG2).toHaveBeenCalledTimes(1);
    const g2Detail = mockedEmitG2.mock.calls[0][0].detail;
    expect(g2Detail.downgrade_reason).toBe("label_missing");
    expect(g2Detail.recommended_action).toBe("squash-merge");
    expect(g2Detail.permitted_action).toBe("comment");
  });

  it("ci_failure: failing check-runs → comment", async () => {
    mockedGetPrState.mockResolvedValue(makePrState({ ciState: "failure" }));
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect((await res.json()).downgradeReason).toBe("ci_failure");
  });

  it("head_sha_drift: current head differs from reviewedHeadSha", async () => {
    mockedGetPrState.mockResolvedValue(
      makePrState({ headSha: "00000000000000000000000000000000000000ff" }),
    );
    const res = await POST(makeRequest(makeBody()), makeContext());
    const body = await res.json();
    expect(body.downgradeReason).toBe("head_sha_drift");
    expect(body.currentHeadSha).toBe("00000000000000000000000000000000000000ff");
    expect(body.reviewedHeadSha).toBe(HEAD_SHA);
  });

  it("does NOT emit G2 when queen ALSO recommended comment (no downgrade — concurrence)", async () => {
    // Queen says "comment" + verdict COMMENT → permitted is "comment".
    // No downgrade, no G2.
    await POST(
      makeRequest({
        ...makeBody(),
        recommendedAction: "comment",
        derivedVerdict: { verdict: "COMMENT", reasoning: "x" },
      }),
      makeContext(),
    );
    expect(mockedEmitG2).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Floor override (G1)
// ---------------------------------------------------------------------------

describe("POST /api/rooms/:roomId/resolve-action — verdict floor override (G1)", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue(makeRoom());
  });

  it("emits queen.verdict_floor_override when applyDowngradeOnlyFloor clamps the verdict", async () => {
    // Worker contribution carries a structured CONCERNS verdict.
    // Queen submits APPROVE. Floor clamps to CONCERNS.
    mockedGetRoomContributions.mockResolvedValue({
      drone: {
        actor_role: "drone",
        actor_id: "drone-1",
        body: { verdict: "CONCERNS" } as never,
        raw_md: "",
        submitted_at: "2026-05-10T00:00:00Z",
        last_seq: 1,
        withdrawn: false,
      } as never,
    });

    const res = await POST(makeRequest(makeBody()), makeContext());
    const body = await res.json();

    expect(body.clampedVerdict).toBe("CONCERNS");
    expect(body.floorOverridden).toBe(true);
    expect(mockedEmitG1).toHaveBeenCalledTimes(1);
    const detail = mockedEmitG1.mock.calls[0][0].detail;
    expect(detail.submitted_verdict).toBe("APPROVE");
    expect(detail.floor_verdict).toBe("CONCERNS");
    expect(detail.clamped_verdict).toBe("CONCERNS");
    expect(detail.room_id).toBe("rm-abc");
    expect(detail.subject_ref).toBe("hivemoot/colony#42");
  });

  it("does NOT emit G1 when contributions are free-form prose (no structured verdicts, floor dormant)", async () => {
    // Modern default: workers submit raw_md only. applyDowngradeOnlyFloor
    // passes through unchanged. No G1.
    mockedGetRoomContributions.mockResolvedValue({
      drone: {
        actor_role: "drone",
        actor_id: "drone-1",
        body: undefined,
        raw_md: "looks good to me",
        submitted_at: "2026-05-10T00:00:00Z",
        last_seq: 1,
        withdrawn: false,
      } as never,
    });

    await POST(makeRequest(makeBody()), makeContext());
    expect(mockedEmitG1).not.toHaveBeenCalled();
  });

  it("clamping APPROVE → CONCERNS also triggers G2 because clampedVerdict != APPROVE causes verdict_not_approve downgrade", async () => {
    mockedGetRoomContributions.mockResolvedValue({
      drone: {
        actor_role: "drone",
        actor_id: "drone-1",
        body: { verdict: "CONCERNS" } as never,
        raw_md: "",
        submitted_at: "2026-05-10T00:00:00Z",
        last_seq: 1,
        withdrawn: false,
      } as never,
    });

    await POST(makeRequest(makeBody()), makeContext());
    expect(mockedEmitG1).toHaveBeenCalledTimes(1);
    expect(mockedEmitG2).toHaveBeenCalledTimes(1);
    // The G2 reason is verdict_not_approve because the policy
    // evaluator sees clampedVerdict=CONCERNS and short-circuits
    // before checking label/CI/head_sha.
    expect(mockedEmitG2.mock.calls[0][0].detail.downgrade_reason).toBe(
      "verdict_not_approve",
    );
  });
});

// ---------------------------------------------------------------------------
// GitHub / configuration errors
// ---------------------------------------------------------------------------

describe("POST /api/rooms/:roomId/resolve-action — GitHub + config errors", () => {
  beforeEach(() => {
    mockedAuth.mockResolvedValue(makeAuthOk());
    mockedGetRoomCore.mockResolvedValue(makeRoom());
  });

  it("returns 500 configuration_error when GitHub App env is missing", async () => {
    mockedEnv.mockReturnValue({
      ok: true,
      config: { githubAppId: undefined, githubAppPrivateKey: undefined } as never,
    });
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("configuration_error");
  });

  it("returns 500 configuration_error when AppCredentialError is thrown by mint", async () => {
    mockedMintToken.mockRejectedValue(
      new AppCredentialError("malformed private key"),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("configuration_error");
    errSpy.mockRestore();
  });

  it("returns 502 github_read_failed when mint throws generic error", async () => {
    mockedMintToken.mockRejectedValue(new Error("API down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("github_read_failed");
    errSpy.mockRestore();
  });

  it("returns 404 github_pr_not_found when getPullRequestState throws PullRequestNotFoundError", async () => {
    mockedGetPrState.mockRejectedValue(
      new PullRequestNotFoundError("hivemoot", "colony", 42),
    );
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("github_pr_not_found");
  });

  it("returns 502 github_read_failed when getPullRequestState throws GitHubAPIError", async () => {
    mockedGetPrState.mockRejectedValue(
      new GitHubAPIError("/pulls/42", 503, "service unavailable"),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("github_read_failed");
    errSpy.mockRestore();
  });

  it("returns 500 configuration_error when subject_ref can't be parsed", async () => {
    mockedGetRoomCore.mockResolvedValue(
      makeRoom({ subject_ref: "no-slash-no-hash" }),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(makeRequest(makeBody()), makeContext());
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("configuration_error");
    errSpy.mockRestore();
  });
});
