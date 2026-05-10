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
