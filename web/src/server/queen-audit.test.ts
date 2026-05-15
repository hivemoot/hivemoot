import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock auditAppend before the queen-audit module imports it.
vi.mock("./agent-token-v1-audit", async () => {
  const real = await vi.importActual<typeof import("./agent-token-v1-audit")>(
    "./agent-token-v1-audit",
  );
  return { ...real, auditAppend: vi.fn(async () => undefined) };
});

import { auditAppend } from "./agent-token-v1-audit";
import {
  emitQueenVerdictFloorOverride,
  emitQueenActionDowngrade,
  emitQueenIntendedActionPostFailed,
} from "./queen-audit";

const mockedAuditAppend = vi.mocked(auditAppend);

beforeEach(() => {
  mockedAuditAppend.mockReset();
  mockedAuditAppend.mockResolvedValue(undefined);
});

const CALLER = {
  installationId: "12345",
  redis: {} as never,
  name: "queen-hive-1",
  fingerprint: "abcd1234",
};

// ---------------------------------------------------------------------------
// emitQueenVerdictFloorOverride
// ---------------------------------------------------------------------------

describe("emitQueenVerdictFloorOverride", () => {
  it("delegates to auditAppend with the queen.verdict_floor_override action", async () => {
    await emitQueenVerdictFloorOverride({
      ...CALLER,
      detail: {
        room_id: "rm-abc",
        subject_ref: "hivemoot/colony#42",
        submitted_verdict: "APPROVE",
        floor_verdict: "CONCERNS",
        clamped_verdict: "CONCERNS",
      },
    });

    expect(mockedAuditAppend).toHaveBeenCalledTimes(1);
    const call = mockedAuditAppend.mock.calls[0][0];
    expect(call.installationId).toBe("12345");
    expect(call.entry.action).toBe("queen.verdict_floor_override");
  });

  it("carries fingerprint + name from caller context onto the entry (correlation)", async () => {
    await emitQueenVerdictFloorOverride({
      ...CALLER,
      detail: {
        room_id: "rm-abc",
        subject_ref: "hivemoot/colony#42",
        submitted_verdict: "APPROVE",
        floor_verdict: "COMMENT",
        clamped_verdict: "COMMENT",
      },
    });
    const entry = mockedAuditAppend.mock.calls[0][0].entry;
    expect(entry.fingerprint).toBe("abcd1234");
    expect(entry.name).toBe("queen-hive-1");
    // Mutation entries also have an `actor` field — for queen
    // events that's the bearer's name (the queen runner identity).
    if (entry.action === "queen.verdict_floor_override") {
      expect(entry.actor).toBe("queen-hive-1");
    }
  });

  it("puts detail payload on entry.detail verbatim (room_id, subject_ref, verdicts)", async () => {
    const detail = {
      room_id: "rm-abc-123",
      subject_ref: "hivemoot/colony#7",
      submitted_verdict: "APPROVE" as const,
      floor_verdict: "REQUEST_CHANGES" as const,
      clamped_verdict: "REQUEST_CHANGES" as const,
    };
    await emitQueenVerdictFloorOverride({ ...CALLER, detail });
    const entry = mockedAuditAppend.mock.calls[0][0].entry;
    if (entry.action === "queen.verdict_floor_override") {
      expect(entry.detail).toEqual(detail);
    }
  });

  it("sets ts to a parseable ISO 8601 string", async () => {
    await emitQueenVerdictFloorOverride({
      ...CALLER,
      detail: {
        room_id: "rm-abc",
        subject_ref: "hivemoot/colony#42",
        submitted_verdict: "APPROVE",
        floor_verdict: "COMMENT",
        clamped_verdict: "COMMENT",
      },
    });
    const ts = mockedAuditAppend.mock.calls[0][0].entry.ts;
    expect(typeof ts).toBe("string");
    expect(Number.isFinite(Date.parse(ts))).toBe(true);
  });

  it("does not throw when auditAppend rejects (pass-1 fix — wrapper exports stronger 'never throws' contract for resolve-action call sites)", async () => {
    // Builder pass-1: the module header + emitter docstrings
    // promise fire-and-forget semantics. The underlying auditAppend
    // catches internally, but the wrapper now also catches
    // explicitly so a future change to auditAppend can't surprise
    // resolve-action call sites — they MUST be able to safely
    // await these emitters without duplicating audit failure
    // handling at every call site.
    mockedAuditAppend.mockRejectedValueOnce(new Error("redis down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      emitQueenVerdictFloorOverride({
        ...CALLER,
        detail: {
          room_id: "rm-abc",
          subject_ref: "hivemoot/colony#42",
          submitted_verdict: "APPROVE",
          floor_verdict: "COMMENT",
          clamped_verdict: "COMMENT",
        },
      }),
    ).resolves.toBeUndefined();
    // Failure logged via console.warn for ops visibility.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("emitQueenActionDowngrade also swallows underlying audit failures (same contract)", async () => {
    mockedAuditAppend.mockRejectedValueOnce(new Error("redis down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      emitQueenActionDowngrade({
        ...CALLER,
        detail: {
          room_id: "rm-down",
          subject_ref: "hivemoot/colony#1",
          recommended_action: "squash-merge",
          permitted_action: "comment",
          downgrade_reason: "ci_failure",
          clamped_verdict: "APPROVE",
          reviewed_head_sha: "deadbeef",
        },
      }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("emitQueenIntendedActionPostFailed also swallows underlying audit failures (same contract)", async () => {
    mockedAuditAppend.mockRejectedValueOnce(new Error("redis down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      emitQueenIntendedActionPostFailed({
        ...CALLER,
        detail: {
          room_id: "rm-intent",
          subject_ref: "hivemoot/colony#1",
          recommended_action: "squash-merge",
          intended_action: "squash-merge",
          audit_id_from_resolve_action: "1715000000000-0",
          error_class: "gh_comment_failed",
          retry_count: 3,
        },
      }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// emitQueenActionDowngrade
// ---------------------------------------------------------------------------

describe("emitQueenActionDowngrade", () => {
  it("delegates to auditAppend with the queen.action_downgrade action", async () => {
    await emitQueenActionDowngrade({
      ...CALLER,
      detail: {
        room_id: "rm-xyz",
        subject_ref: "hivemoot/colony#99",
        recommended_action: "squash-merge",
        permitted_action: "comment",
        downgrade_reason: "label_missing",
        clamped_verdict: "APPROVE",
        reviewed_head_sha: "deadbeef",
      },
    });
    const call = mockedAuditAppend.mock.calls[0][0];
    expect(call.entry.action).toBe("queen.action_downgrade");
  });

  it("carries downgrade_reason verbatim — operators grep by reason class", async () => {
    // The downgrade_reason is the actionable field for operators
    // ('we keep seeing ci_pending — is CI slow today?'). Pin the
    // verbatim shape so a future enum rename doesn't break grep
    // queries silently.
    for (const reason of [
      "verdict_not_approve",
      "label_missing",
      "ci_truncated",
      "ci_failure",
      "ci_pending",
      "head_sha_drift",
      "post_close_drift",
    ] as const) {
      mockedAuditAppend.mockClear();
      await emitQueenActionDowngrade({
        ...CALLER,
        detail: {
          room_id: "rm-x",
          subject_ref: "hivemoot/colony#1",
          recommended_action: "squash-merge",
          permitted_action: "comment",
          downgrade_reason: reason,
          clamped_verdict: "APPROVE",
          reviewed_head_sha: "deadbeef",
        },
      });
      const entry = mockedAuditAppend.mock.calls[0][0].entry;
      if (entry.action === "queen.action_downgrade") {
        expect((entry.detail as { downgrade_reason: string }).downgrade_reason).toBe(reason);
      }
    }
  });

  it("carries reviewed_head_sha for head_sha_drift diagnostics", async () => {
    // When downgrade_reason='head_sha_drift', an operator looking
    // at the audit row needs both the SHA the queen synthesized
    // against (reviewed_head_sha) and the time (entry.ts) so they
    // can correlate with the PR's push history.
    await emitQueenActionDowngrade({
      ...CALLER,
      detail: {
        room_id: "rm-drift",
        subject_ref: "hivemoot/colony#5",
        recommended_action: "squash-merge",
        permitted_action: "comment",
        downgrade_reason: "head_sha_drift",
        clamped_verdict: "APPROVE",
        reviewed_head_sha: "feedfacefeedface",
      },
    });
    const entry = mockedAuditAppend.mock.calls[0][0].entry;
    if (entry.action === "queen.action_downgrade") {
      expect((entry.detail as { reviewed_head_sha: string }).reviewed_head_sha).toBe(
        "feedfacefeedface",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Runtime stream routing — queen events go to the :audit (mutations) stream
// ---------------------------------------------------------------------------
//
// Builder pass-1 follow-up: the prior version was a type-only pin
// (TypeScript narrowing on the AuditMutationAction union). The
// stream-routing decision happens at RUNTIME via the
// `isMutationAction` classifier inside agent-token-v1-audit.ts.
// We export the classifier and test it directly here — confirms
// the new queen actions are wired into the runtime branch, not
// just the type-level union.

import { isMutationAction } from "./agent-token-v1-audit";

describe("isMutationAction runtime classifier (builder pass-1 follow-up)", () => {
  it("accepts queen.verdict_floor_override → routes to :audit (mutations) stream", () => {
    expect(isMutationAction("queen.verdict_floor_override")).toBe(true);
  });

  it("accepts queen.action_downgrade → routes to :audit (mutations) stream", () => {
    expect(isMutationAction("queen.action_downgrade")).toBe(true);
  });

  it("accepts queen.resolve_action → routes to :audit (mutations) stream (slice 2c-b)", () => {
    expect(isMutationAction("queen.resolve_action")).toBe(true);
  });

  it("accepts queen.intended_action_post_failed → routes to :audit (mutations) stream", () => {
    expect(isMutationAction("queen.intended_action_post_failed")).toBe(true);
  });

  it("still accepts existing mutation actions (no regression)", () => {
    for (const a of ["issue", "revoke", "set_capabilities", "rotate", "bootstrap"]) {
      expect(isMutationAction(a), a).toBe(true);
    }
  });

  it("rejects auth actions (still routed to :auth stream)", () => {
    expect(isMutationAction("auth.success")).toBe(false);
    expect(isMutationAction("auth.failure")).toBe(false);
  });

  it("rejects unknown actions (defensive — future enum additions need explicit wiring)", () => {
    expect(isMutationAction("queen.unknown_event")).toBe(false);
    expect(isMutationAction("rogue")).toBe(false);
    expect(isMutationAction("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// emitQueenResolveAction — baseline audit row with returned audit_id
// ---------------------------------------------------------------------------
//
// Note: the module-level mock at the top of this file overrides
// ONLY `auditAppend` (the fire-and-forget variant). `auditAppendSync`
// is passed through from the real module, so these tests can
// directly exercise it via a fake redis.eval.

import {
  emitQueenResolveAction,
  readQueenResolveActionAuditRow,
  QueenResolveActionAuditNotFoundError,
  QueenResolveActionAuditMalformedError,
  checkResolveActionRateLimit,
} from "./queen-audit";

describe("emitQueenResolveAction — pass-1 audit_id contract", () => {
  it("returns the stream entry id from the underlying XADD (audit_id for seal-decision)", async () => {
    const fakeRedis = {
      eval: vi.fn(async () => "1715000000000-3"),
    } as never;

    const id = await emitQueenResolveAction({
      installationId: "12345",
      redis: fakeRedis,
      name: "queen",
      fingerprint: "fp1",
      detail: {
        room_id: "rm-1",
        subject_ref: "hivemoot/colony#1",
        recommended_action: "squash-merge",
        permitted_action: "squash-merge",
        clamped_verdict: "APPROVE",
        reviewed_head_sha: "deadbeef",
        current_head_sha: "deadbeef",
        downgrade_reason: null,
        floor_overridden: false,
      },
    });
    expect(id).toBe("1715000000000-3");
  });

  it("throws (not swallows) when the underlying audit XADD fails — seal-decision needs a real audit row, not a silently-dropped one", async () => {
    const fakeRedis = {
      eval: vi.fn(async () => {
        throw new Error("redis down");
      }),
    } as never;

    await expect(
      emitQueenResolveAction({
        installationId: "12345",
        redis: fakeRedis,
        name: "queen",
        fingerprint: "fp1",
        detail: {
          room_id: "rm-1",
          subject_ref: "hivemoot/colony#1",
          recommended_action: "comment",
          permitted_action: "comment",
          clamped_verdict: "COMMENT",
          reviewed_head_sha: "deadbeef",
          current_head_sha: "deadbeef",
          downgrade_reason: null,
          floor_overridden: false,
        },
      }),
    ).rejects.toThrow();
  });

  it("throws when XADD returns an empty result (defensive — never let the caller see audit_id='')", async () => {
    const fakeRedis = {
      eval: vi.fn(async () => ""),
    } as never;
    await expect(
      emitQueenResolveAction({
        installationId: "12345",
        redis: fakeRedis,
        name: "queen",
        fingerprint: "fp1",
        detail: {
          room_id: "rm-1",
          subject_ref: "hivemoot/colony#1",
          recommended_action: "comment",
          permitted_action: "comment",
          clamped_verdict: "COMMENT",
          reviewed_head_sha: "deadbeef",
          current_head_sha: "deadbeef",
          downgrade_reason: null,
          floor_overridden: false,
        },
      }),
    ).rejects.toThrow();
  });
});

describe("readQueenResolveActionAuditRow — seal-decision lookup", () => {
  function makeEntry(overrides: Record<string, unknown> = {}) {
    return {
      ts: "2026-05-10T00:00:00.000Z",
      fingerprint: "fp1",
      name: "queen",
      action: "queen.resolve_action",
      actor: "queen",
      detail: {
        room_id: "rm-1",
        subject_ref: "hivemoot/colony#1",
        recommended_action: "comment",
        permitted_action: "comment",
        clamped_verdict: "COMMENT",
        reviewed_head_sha: "deadbeef",
        current_head_sha: "deadbeef",
        downgrade_reason: null,
        floor_overridden: false,
      },
      ...overrides,
    };
  }

  it("reads and validates the exact resolve-action audit row by id", async () => {
    const fakeRedis = {
      eval: vi.fn(async () => JSON.stringify(makeEntry())),
    } as never;
    const row = await readQueenResolveActionAuditRow({
      redis: fakeRedis,
      installationId: "12345",
      auditId: "1715000000000-0",
    });
    expect(row.id).toBe("1715000000000-0");
    expect(row.detail.room_id).toBe("rm-1");
    expect(row.detail.permitted_action).toBe("comment");
  });

  it("accepts parsed JSON audit entries returned by Redis clients", async () => {
    const fakeRedis = {
      eval: vi.fn(async () => makeEntry()),
    } as never;
    const row = await readQueenResolveActionAuditRow({
      redis: fakeRedis,
      installationId: "12345",
      auditId: "1715000000000-0",
    });
    expect(row.id).toBe("1715000000000-0");
    expect(row.detail.room_id).toBe("rm-1");
  });

  it("throws typed not-found when the stream row is missing", async () => {
    const fakeRedis = {
      eval: vi.fn(async () => null),
    } as never;
    await expect(
      readQueenResolveActionAuditRow({
        redis: fakeRedis,
        installationId: "12345",
        auditId: "missing-0",
      }),
    ).rejects.toBeInstanceOf(QueenResolveActionAuditNotFoundError);
  });

  it("throws typed malformed when the row is not a resolve-action entry", async () => {
    const fakeRedis = {
      eval: vi.fn(async () =>
        JSON.stringify(makeEntry({ action: "queen.action_downgrade" })),
      ),
    } as never;
    await expect(
      readQueenResolveActionAuditRow({
        redis: fakeRedis,
        installationId: "12345",
        auditId: "bad-0",
      }),
    ).rejects.toBeInstanceOf(QueenResolveActionAuditMalformedError);
  });
});

// ---------------------------------------------------------------------------
// checkResolveActionRateLimit (RFC G11) — per-bearer cap
// ---------------------------------------------------------------------------

describe("checkResolveActionRateLimit — G11 per-bearer + per-installation rate caps", () => {
  /**
   * Build a fakeRedis that maps INCR keys to canned counts. The keys
   * contain the installationId / fingerprint substrings so the test
   * can simulate per-bearer vs per-installation hits independently.
   */
  function makeFakeRedis(counts: {
    perBearer?: number;
    perInstallation?: number;
    ttl?: number;
  }) {
    const expireCalls: Array<{ key: string; ttl: number }> = [];
    return {
      expireCalls,
      redis: {
        incr: vi.fn(async (key: string) => {
          if (key.includes(":_install")) return counts.perInstallation ?? 1;
          return counts.perBearer ?? 1;
        }),
        expire: vi.fn(async (key: string, ttl: number) => {
          expireCalls.push({ key, ttl });
          return 1;
        }),
        ttl: vi.fn(async () => counts.ttl ?? 60),
      } as never,
    };
  }

  it("allows the first call: both INCR return 1, EXPIRE wired on both keys", async () => {
    const { redis, expireCalls } = makeFakeRedis({ perBearer: 1, perInstallation: 1 });
    const result = await checkResolveActionRateLimit({
      redis,
      installationId: "12345",
      fingerprint: "fp1",
    });
    expect(result.allowed).toBe(true);
    // Both keys should have had EXPIRE set on the first call.
    expect(expireCalls.length).toBe(2);
    const expiredKeys = expireCalls.map((c) => c.key).sort();
    expect(expiredKeys[0]).toMatch(/_install/);
    expect(expiredKeys[1]).toMatch(/fp1/);
  });

  it("allows subsequent calls under both caps without re-setting TTL", async () => {
    const { redis, expireCalls } = makeFakeRedis({ perBearer: 5, perInstallation: 20 });
    const result = await checkResolveActionRateLimit({
      redis,
      installationId: "12345",
      fingerprint: "fp1",
    });
    expect(result.allowed).toBe(true);
    expect(expireCalls.length).toBe(0);
  });

  it("blocks with scope='per_bearer' when per-bearer counter exceeds 60", async () => {
    const { redis } = makeFakeRedis({ perBearer: 61, perInstallation: 100, ttl: 17 });
    const result = await checkResolveActionRateLimit({
      redis,
      installationId: "12345",
      fingerprint: "fp1",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.scope).toBe("per_bearer");
      expect(result.currentCount).toBe(61);
      expect(result.resetAtSecs).toBe(17);
    }
  });

  it("blocks with scope='per_installation' when bearer is under cap but installation aggregate exceeds 240 (builder pass-2 fix)", async () => {
    // The key case the builder pass-2 fix targets: a SECOND bearer in
    // the same installation, under its OWN cap (5/60), but the
    // installation aggregate is over (241/240) because other bearers
    // have been busy.
    const { redis } = makeFakeRedis({ perBearer: 5, perInstallation: 241, ttl: 22 });
    const result = await checkResolveActionRateLimit({
      redis,
      installationId: "12345",
      fingerprint: "fp2-second-bearer-still-under-its-own-cap",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.scope).toBe("per_installation");
      expect(result.currentCount).toBe(241);
      expect(result.resetAtSecs).toBe(22);
    }
  });

  it("reports per_bearer FIRST when both caps are over (actionable signal for the calling bearer)", async () => {
    // Both 61 (>60 per-bearer) AND 241 (>240 per-installation).
    // Returns per_bearer because the calling bearer can self-correct
    // (slow down) without coordinating with other bearers.
    const { redis } = makeFakeRedis({ perBearer: 61, perInstallation: 241 });
    const result = await checkResolveActionRateLimit({
      redis,
      installationId: "12345",
      fingerprint: "fp1",
    });
    if (!result.allowed) {
      expect(result.scope).toBe("per_bearer");
    }
  });

  it("uses 60-second fallback when TTL returns a sentinel (-1 / -2)", async () => {
    const { redis } = makeFakeRedis({ perBearer: 61, ttl: -1 });
    const result = await checkResolveActionRateLimit({
      redis,
      installationId: "12345",
      fingerprint: "fp1",
    });
    if (!result.allowed) {
      expect(result.resetAtSecs).toBe(60);
    }
  });
});
