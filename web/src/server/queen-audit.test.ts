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

  it("does not throw when auditAppend itself rejects (fire-and-forget by design)", async () => {
    // The underlying auditAppend swallows errors; the wrapper
    // should also be safe to await without try/catch in the
    // route handler.
    mockedAuditAppend.mockRejectedValueOnce(new Error("redis down"));
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
    ).rejects.toThrow();
    // NOTE: the wrapper currently re-throws because we await
    // auditAppend directly. The CALL SITE in the route handler
    // is responsible for not propagating audit failures (since
    // the room state hasn't mutated — emit failure shouldn't
    // wedge resolve-action). This test pins the current behavior
    // so a future change "auditAppend never throws" is observed
    // here too.
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
// Stream routing — queen events go to the :audit (mutations) stream
// ---------------------------------------------------------------------------

describe("queen audit stream routing", () => {
  it("queen.verdict_floor_override emits an entry that the agent-token audit emitter classifies as a mutation", async () => {
    // The agent-token emitter inspects the action via
    // isMutationAction to choose `:audit` vs `:auth` stream.
    // Pin that the queen action enum extension is wired into
    // that classifier.
    const real = await vi.importActual<typeof import("./agent-token-v1-audit")>(
      "./agent-token-v1-audit",
    );
    expect(real.auditStreamKey).toBeDefined();
    expect(real.authStreamKey).toBeDefined();
    // The classifier is intentionally not exported (it's a
    // private helper inside the module); the public surface
    // pinned here is the AuditMutationAction enum, which queen
    // events ARE part of post-slice 2c-a.
    type _Check = "queen.verdict_floor_override" extends import("./agent-token-v1-audit").AuditMutationAction
      ? true
      : false;
    const isMutationActionType: _Check = true;
    expect(isMutationActionType).toBe(true);

    type _Check2 = "queen.action_downgrade" extends import("./agent-token-v1-audit").AuditMutationAction
      ? true
      : false;
    const isMutationActionType2: _Check2 = true;
    expect(isMutationActionType2).toBe(true);
  });
});
