/**
 * Tests for WarRoomStore — the per-installation direct-Redis adapter
 * that replaced the HTTP+bearer WarRoomClient.
 *
 * Two surfaces under test:
 *
 *   1. **Constructor validation** (closes #581 guard B1) — strict
 *      reject of missing / "0" / non-numeric installationId so a
 *      caller's `?? 0` fallback can't silently write to a phantom
 *      tenant namespace.
 *
 *   2. **Error translation** (closes #581 guard N1) — the 14-branch
 *      `toApiError` table mapping shared-library exception classes
 *      to `WarRoomApiError` codes that callers in the manager loop
 *      and routing layer branch on (`subject_already_open`,
 *      `room_not_found`, `claim_already_held`, etc.). A typo in
 *      one branch wouldn't fail typecheck but would silently break
 *      caller branching downstream — these tests pin the mapping
 *      so the next refactor can't drift.
 *
 * Strategy: vi.mock the shared `@hivemoot/war-room` module so each
 * primitive (`createRoom`, `appendRoomEvent`, etc.) returns a mock
 * that EITHER resolves to a value OR throws a specific exception
 * class. The store wraps them; tests assert the wrapper's input/
 * output mapping without exercising real Redis.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted so the mocks are defined before the import that pulls them in.
const sharedMocks = vi.hoisted(() => ({
  createRoom: vi.fn(),
  appendRoomEvent: vi.fn(),
  claimSynthesis: vi.fn(),
  closeRoomWithDecision: vi.fn(),
  getRoomCore: vi.fn(),
  listRooms: vi.fn(),
  listRoomEvents: vi.fn(),
  getRoomParticipants: vi.fn(),
  getRoomContributions: vi.fn(),
}));

// Real exception classes — we want instanceof checks against the
// SAME constructors the production code uses, so import them from
// the actual module instead of mocking them out.
vi.mock("@hivemoot/war-room", async () => {
  const real = await vi.importActual<typeof import("@hivemoot/war-room")>(
    "@hivemoot/war-room",
  );
  return {
    ...real,
    createRoom: sharedMocks.createRoom,
    appendRoomEvent: sharedMocks.appendRoomEvent,
    claimSynthesis: sharedMocks.claimSynthesis,
    closeRoomWithDecision: sharedMocks.closeRoomWithDecision,
    getRoomCore: sharedMocks.getRoomCore,
    listRooms: sharedMocks.listRooms,
    listRoomEvents: sharedMocks.listRoomEvents,
    getRoomParticipants: sharedMocks.getRoomParticipants,
    getRoomContributions: sharedMocks.getRoomContributions,
  };
});

import {
  RoomSubjectAlreadyOpenError,
  RoomNotFoundError,
  RoomSubjectRefError,
  RoomIdFormatError,
  RoomIdTakenError,
  RoomEventStatusPreconditionError,
  RoomEventIdempotencyReplayError,
  RoomEventBodyTooLargeError,
  RoomClaimAlreadyHeldError,
  RoomTransitionInvalidStatusError,
  RoomCloseClaimLostError,
  RoomCloseClaimThroughSeqMismatchError,
  RoomCloseDriftError,
  RoomAlreadyClosedError,
  RoomDecisionTooLargeError,
} from "@hivemoot/war-room";
import { WarRoomStore, WarRoomApiError } from "./war-room-store.js";
import type { Redis } from "@upstash/redis";

const fakeRedis = {} as Redis;

beforeEach(() => {
  for (const m of Object.values(sharedMocks)) m.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Constructor validation (closes #581 guard B1)
// ---------------------------------------------------------------------------

describe("WarRoomStore — installationId validation (closes #581 guard B1)", () => {
  it("rejects undefined", () => {
    expect(
      () =>
        new WarRoomStore({
          installationId: undefined as unknown as string,
          redis: fakeRedis,
        }),
    ).toThrow(/installationId.*non-zero numeric string/);
  });

  it("rejects empty string", () => {
    expect(
      () => new WarRoomStore({ installationId: "", redis: fakeRedis }),
    ).toThrow(/installationId.*non-zero numeric string/);
  });

  it("rejects \"0\" (the killer case — `?? 0` would land here)", () => {
    expect(
      () => new WarRoomStore({ installationId: "0", redis: fakeRedis }),
    ).toThrow(/installationId.*non-zero numeric string/);
  });

  it("rejects non-numeric strings", () => {
    expect(
      () => new WarRoomStore({ installationId: "abc", redis: fakeRedis }),
    ).toThrow(/installationId.*non-zero numeric string/);
    expect(
      () => new WarRoomStore({ installationId: "12a", redis: fakeRedis }),
    ).toThrow(/installationId.*non-zero numeric string/);
    expect(
      () => new WarRoomStore({ installationId: "01", redis: fakeRedis }),
    ).toThrow(/installationId.*non-zero numeric string/); // leading zero
  });

  it("accepts a valid non-zero numeric string", () => {
    expect(
      () => new WarRoomStore({ installationId: "12345", redis: fakeRedis }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Error translation table (closes #581 guard N1)
// ---------------------------------------------------------------------------

describe("WarRoomStore — error translation (closes #581 guard N1)", () => {
  let store: WarRoomStore;

  beforeEach(() => {
    store = new WarRoomStore({ installationId: "12345", redis: fakeRedis });
  });

  // Each `it` exercises one path: a shared-library exception class
  // thrown from a primitive that the store calls, and asserts the
  // `WarRoomApiError` shape (status + code) the caller branches on.

  it("RoomSubjectAlreadyOpenError → 409 subject_already_open with existingRoomId in response", async () => {
    sharedMocks.createRoom.mockRejectedValueOnce(
      new RoomSubjectAlreadyOpenError(
        "12345",
        "pr_review",
        "x/y#1",
        "existing-room-id",
      ),
    );
    try {
      await store.createRoom({
        subject: { type: "pr_review", ref: "x/y#1" },
        roomId: "01234567-89ab-4cde-9012-3456789abcde",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WarRoomApiError);
      expect((err as WarRoomApiError).status).toBe(409);
      expect((err as WarRoomApiError).code).toBe("subject_already_open");
      expect((err as WarRoomApiError).response.existingRoomId).toBe(
        "existing-room-id",
      );
    }
  });

  it("RoomNotFoundError → 404 room_not_found", async () => {
    sharedMocks.getRoomCore.mockRejectedValueOnce(
      new RoomNotFoundError("12345", "missing-room"),
    );
    try {
      await store.getRoomCore("missing-room");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WarRoomApiError);
      expect((err as WarRoomApiError).status).toBe(404);
      expect((err as WarRoomApiError).code).toBe("room_not_found");
    }
  });

  it("RoomSubjectRefError → 400 invalid_subject_ref", async () => {
    sharedMocks.createRoom.mockRejectedValueOnce(
      new RoomSubjectRefError("subject", "bad ref format"),
    );
    try {
      await store.createRoom({ subject: { type: "pr_review", ref: "bad" } });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as WarRoomApiError).status).toBe(400);
      expect((err as WarRoomApiError).code).toBe("invalid_subject_ref");
    }
  });

  it("RoomIdFormatError → 400 invalid_room_id", async () => {
    sharedMocks.createRoom.mockRejectedValueOnce(
      new RoomIdFormatError("not-a-uuid"),
    );
    try {
      await store.createRoom({
        subject: { type: "pr_review", ref: "x/y#1" },
        roomId: "not-a-uuid",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as WarRoomApiError).status).toBe(400);
      expect((err as WarRoomApiError).code).toBe("invalid_room_id");
    }
  });

  it("RoomIdTakenError → 409 room_id_taken", async () => {
    sharedMocks.createRoom.mockRejectedValueOnce(
      new RoomIdTakenError("12345", "taken-id"),
    );
    try {
      await store.createRoom({
        subject: { type: "pr_review", ref: "x/y#1" },
        roomId: "01234567-89ab-4cde-9012-3456789abcde",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as WarRoomApiError).status).toBe(409);
      expect((err as WarRoomApiError).code).toBe("room_id_taken");
    }
  });

  it("RoomEventStatusPreconditionError → 409 status_precondition_failed", async () => {
    sharedMocks.appendRoomEvent.mockRejectedValueOnce(
      new RoomEventStatusPreconditionError(
        "room-id",
        "subject_updated",
        "deciding",
      ),
    );
    try {
      await store.appendEvent({
        roomId: "room-id",
        eventType: "subject_updated",
        body: {},
        idempotencyKey: "k",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as WarRoomApiError).status).toBe(409);
      expect((err as WarRoomApiError).code).toBe("status_precondition_failed");
    }
  });

  it("RoomEventIdempotencyReplayError → returns {sequence, replay: true} (NOT thrown)", async () => {
    // The HTTP route's contract for replays is to return success with
    // a `replay: true` flag — the store preserves that shape so
    // callers don't have to special-case it as an error.
    sharedMocks.appendRoomEvent.mockRejectedValueOnce(
      new RoomEventIdempotencyReplayError("room-id", 42),
    );
    const result = await store.appendEvent({
      roomId: "room-id",
      eventType: "subject_updated",
      body: {},
      idempotencyKey: "k",
    });
    expect(result).toEqual({ sequence: 42, replay: true });
  });

  it("RoomEventBodyTooLargeError → 413 event_body_too_large", async () => {
    sharedMocks.appendRoomEvent.mockRejectedValueOnce(
      new RoomEventBodyTooLargeError(9999, 8192),
    );
    try {
      await store.appendEvent({
        roomId: "r",
        eventType: "subject_updated",
        body: {},
        idempotencyKey: "k",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as WarRoomApiError).status).toBe(413);
      expect((err as WarRoomApiError).code).toBe("event_body_too_large");
    }
  });

  it("RoomClaimAlreadyHeldError → 409 claim_already_held", async () => {
    sharedMocks.claimSynthesis.mockRejectedValueOnce(
      new RoomClaimAlreadyHeldError("12345", "room-id", "other-runner"),
    );
    try {
      await store.claimSynthesis({
        roomId: "room-id",
        queenRunner: "vercel-queen.42",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as WarRoomApiError).status).toBe(409);
      expect((err as WarRoomApiError).code).toBe("claim_already_held");
    }
  });

  it("RoomTransitionInvalidStatusError → 409 invalid_status_for_transition", async () => {
    sharedMocks.claimSynthesis.mockRejectedValueOnce(
      new RoomTransitionInvalidStatusError(
        "room-id",
        "claim",
        ["awaiting_contributions"],
        "closed",
      ),
    );
    try {
      await store.claimSynthesis({
        roomId: "room-id",
        queenRunner: "vercel-queen.42",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as WarRoomApiError).status).toBe(409);
      expect((err as WarRoomApiError).code).toBe("invalid_status_for_transition");
    }
  });

  it("RoomCloseClaimLostError → 409 claim_lost", async () => {
    // closeRoom calls getRoomCore first to fetch the subject, so we
    // need to mock both.
    sharedMocks.getRoomCore.mockResolvedValueOnce({
      manager: "queen",
      subject_type: "pr_review",
      subject_ref: "x/y#1",
      status: "deciding",
      opened_at: new Date().toISOString(),
    });
    sharedMocks.closeRoomWithDecision.mockRejectedValueOnce(
      new RoomCloseClaimLostError("12345", "room-id"),
    );
    try {
      await store.closeRoom({
        roomId: "room-id",
        expectedThroughSequence: 5,
        decision: {
          synthesized_at: new Date().toISOString(),
          synthesis_runner: "vercel-queen.42",
          content: "x",
          sequence_closed: 5,
        },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as WarRoomApiError).status).toBe(409);
      expect((err as WarRoomApiError).code).toBe("claim_lost");
    }
  });

  it("RoomCloseClaimThroughSeqMismatchError → 409 claim_through_seq_mismatch", async () => {
    sharedMocks.getRoomCore.mockResolvedValueOnce({
      manager: "queen",
      subject_type: "pr_review",
      subject_ref: "x/y#1",
      status: "deciding",
      opened_at: new Date().toISOString(),
    });
    sharedMocks.closeRoomWithDecision.mockRejectedValueOnce(
      new RoomCloseClaimThroughSeqMismatchError("12345", "room-id", 5, 7),
    );
    try {
      await store.closeRoom({
        roomId: "room-id",
        expectedThroughSequence: 5,
        decision: {
          synthesized_at: new Date().toISOString(),
          synthesis_runner: "vercel-queen.42",
          content: "x",
          sequence_closed: 5,
        },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as WarRoomApiError).status).toBe(409);
      expect((err as WarRoomApiError).code).toBe("claim_through_seq_mismatch");
    }
  });

  it("RoomCloseDriftError → 409 sequence_drift", async () => {
    sharedMocks.getRoomCore.mockResolvedValueOnce({
      manager: "queen",
      subject_type: "pr_review",
      subject_ref: "x/y#1",
      status: "deciding",
      opened_at: new Date().toISOString(),
    });
    sharedMocks.closeRoomWithDecision.mockRejectedValueOnce(
      new RoomCloseDriftError("12345", "room-id", 5, 7),
    );
    try {
      await store.closeRoom({
        roomId: "room-id",
        expectedThroughSequence: 5,
        decision: {
          synthesized_at: new Date().toISOString(),
          synthesis_runner: "vercel-queen.42",
          content: "x",
          sequence_closed: 5,
        },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as WarRoomApiError).status).toBe(409);
      expect((err as WarRoomApiError).code).toBe("sequence_drift");
    }
  });

  it("RoomAlreadyClosedError → 409 room_already_closed", async () => {
    sharedMocks.getRoomCore.mockResolvedValueOnce({
      manager: "queen",
      subject_type: "pr_review",
      subject_ref: "x/y#1",
      status: "closed",
      opened_at: new Date().toISOString(),
    });
    sharedMocks.closeRoomWithDecision.mockRejectedValueOnce(
      new RoomAlreadyClosedError("12345", "room-id"),
    );
    try {
      await store.closeRoom({
        roomId: "room-id",
        expectedThroughSequence: 5,
        decision: {
          synthesized_at: new Date().toISOString(),
          synthesis_runner: "vercel-queen.42",
          content: "x",
          sequence_closed: 5,
        },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as WarRoomApiError).status).toBe(409);
      expect((err as WarRoomApiError).code).toBe("room_already_closed");
    }
  });

  it("RoomDecisionTooLargeError → 400 decision_too_large", async () => {
    sharedMocks.getRoomCore.mockResolvedValueOnce({
      manager: "queen",
      subject_type: "pr_review",
      subject_ref: "x/y#1",
      status: "deciding",
      opened_at: new Date().toISOString(),
    });
    sharedMocks.closeRoomWithDecision.mockRejectedValueOnce(
      new RoomDecisionTooLargeError(70_000, 65_536),
    );
    try {
      await store.closeRoom({
        roomId: "room-id",
        expectedThroughSequence: 5,
        decision: {
          synthesized_at: new Date().toISOString(),
          synthesis_runner: "vercel-queen.42",
          content: "x".repeat(70000),
          sequence_closed: 5,
        },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as WarRoomApiError).status).toBe(400);
      expect((err as WarRoomApiError).code).toBe("decision_too_large");
    }
  });

  it("unrecognized error → propagated as-is (NOT wrapped)", async () => {
    // Defense-in-depth: the translation table should NOT swallow
    // unknown errors. If the shared library introduces a new
    // exception class without us updating the table, the new error
    // should propagate so callers can see it (vs being silently
    // converted to a generic WarRoomApiError that loses information).
    const novel = new Error("Brand-new error class we don't know about");
    sharedMocks.createRoom.mockRejectedValueOnce(novel);
    try {
      await store.createRoom({
        subject: { type: "pr_review", ref: "x/y#1" },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBe(novel);
      expect(err).not.toBeInstanceOf(WarRoomApiError);
    }
  });
});

// ---------------------------------------------------------------------------
// Happy-path read/write delegation
// ---------------------------------------------------------------------------
//
// One test per delegating method to confirm:
//   1. installationId / redis are threaded through to the shared
//      function (the only state the store carries).
//   2. The return shape matches what callers (manager-loop.ts,
//      war-room-routing.ts) expect — pinning the contract so future
//      shared-library refactors don't drift the wire shape.

describe("WarRoomStore — happy-path delegation", () => {
  let store: WarRoomStore;

  beforeEach(() => {
    store = new WarRoomStore({ installationId: "12345", redis: fakeRedis });
  });

  it("createRoom threads installationId + roomId + subject through to shared.createRoom", async () => {
    const expectedCore = {
      manager: "hivemoot-bot",
      subject_type: "pr_review" as const,
      subject_ref: "x/y#1",
      status: "awaiting_contributions" as const,
      opened_at: "2026-04-30T00:00:00.000Z",
    };
    sharedMocks.createRoom.mockResolvedValueOnce(expectedCore);
    const result = await store.createRoom({
      subject: { type: "pr_review", ref: "x/y#1" },
      roomId: "01234567-89ab-4cde-9012-3456789abcde",
    });
    expect(result).toBe(expectedCore);
    expect(sharedMocks.createRoom).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "12345",
        roomId: "01234567-89ab-4cde-9012-3456789abcde",
        manager: "hivemoot-bot",
        subject: { type: "pr_review", ref: "x/y#1" },
        redis: fakeRedis,
      }),
    );
  });

  it("appendEvent returns {sequence} on success (no replay flag)", async () => {
    sharedMocks.appendRoomEvent.mockResolvedValueOnce(7);
    const result = await store.appendEvent({
      roomId: "r",
      eventType: "subject_updated",
      body: { kind: "synchronize" },
      idempotencyKey: "k1",
    });
    expect(result).toEqual({ sequence: 7 });
    expect(sharedMocks.appendRoomEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "12345",
        roomId: "r",
        idempotencyKey: "k1",
        event: expect.objectContaining({
          event_type: "subject_updated",
          actor_role: "hivemoot-bot",
        }),
      }),
    );
  });

  it("listRooms threads installationId + limit through", async () => {
    sharedMocks.listRooms.mockResolvedValueOnce([]);
    const result = await store.listRooms({ limit: 25 });
    expect(result).toEqual([]);
    expect(sharedMocks.listRooms).toHaveBeenCalledWith({
      installationId: "12345",
      limit: 25,
      redis: fakeRedis,
    });
  });

  it("listRoomEvents wraps result with roomId for caller convenience", async () => {
    const events = [{ seq: 1 } as never, { seq: 2 } as never];
    sharedMocks.listRoomEvents.mockResolvedValueOnce(events);
    const result = await store.listRoomEvents({ roomId: "r", since: 0, limit: 10 });
    expect(result).toEqual({ events, roomId: "r" });
  });

  it("getRoomParticipants wraps result with roomId", async () => {
    const participants = { worker: { agent_id: "a", role: "worker" } as never };
    sharedMocks.getRoomParticipants.mockResolvedValueOnce(participants);
    const result = await store.getRoomParticipants("r");
    expect(result).toEqual({ participants, roomId: "r" });
  });

  it("getRoomContributions wraps result with roomId", async () => {
    const contributions = { worker: { body: {} } };
    sharedMocks.getRoomContributions.mockResolvedValueOnce(contributions);
    const result = await store.getRoomContributions("r");
    expect(result).toEqual({ contributions, roomId: "r" });
  });

  it("claimSynthesis returns {throughSequence, claimTtlSecs} on success", async () => {
    sharedMocks.claimSynthesis.mockResolvedValueOnce({
      throughSequence: 5,
      claimTtlSecs: 360,
    });
    const result = await store.claimSynthesis({
      roomId: "r",
      queenRunner: "vercel-queen.42",
    });
    expect(result).toEqual({ throughSequence: 5, claimTtlSecs: 360 });
  });

  // Each read-only delegating method has its own catch block that
  // routes errors through `rethrowAsApi`. The translation-table tests
  // exercise the catch paths via createRoom/appendRoomEvent/claim/close;
  // these four tests cover the paths in the read-only delegators
  // (RoomNotFoundError shape comes back the same way regardless of
  // which read primitive surfaced it).

  it("listRoomEvents propagates errors through rethrowAsApi", async () => {
    sharedMocks.listRoomEvents.mockRejectedValueOnce(new Error("redis down"));
    await expect(store.listRoomEvents({ roomId: "r" })).rejects.toThrow(
      "redis down",
    );
  });

  it("getRoomParticipants propagates errors through rethrowAsApi", async () => {
    sharedMocks.getRoomParticipants.mockRejectedValueOnce(
      new Error("redis down"),
    );
    await expect(store.getRoomParticipants("r")).rejects.toThrow("redis down");
  });

  it("getRoomContributions propagates errors through rethrowAsApi", async () => {
    sharedMocks.getRoomContributions.mockRejectedValueOnce(
      new Error("redis down"),
    );
    await expect(store.getRoomContributions("r")).rejects.toThrow("redis down");
  });

  it("listRooms propagates errors through rethrowAsApi", async () => {
    sharedMocks.listRooms.mockRejectedValueOnce(new Error("redis down"));
    await expect(store.listRooms()).rejects.toThrow("redis down");
  });
});

// ---------------------------------------------------------------------------
// closeRoom two-call sequence
// ---------------------------------------------------------------------------

describe("WarRoomStore.closeRoom — getRoomCore → closeRoomWithDecision sequence", () => {
  let store: WarRoomStore;

  beforeEach(() => {
    store = new WarRoomStore({ installationId: "12345", redis: fakeRedis });
  });

  it("fetches the room's subject from getRoomCore before calling closeRoomWithDecision", async () => {
    sharedMocks.getRoomCore.mockResolvedValueOnce({
      manager: "queen",
      subject_type: "pr_review",
      subject_ref: "hivemoot/hivemoot#42",
      status: "deciding",
      opened_at: new Date().toISOString(),
    });
    sharedMocks.closeRoomWithDecision.mockResolvedValueOnce(7);

    const result = await store.closeRoom({
      roomId: "room-id",
      expectedThroughSequence: 5,
      decision: {
        synthesized_at: new Date().toISOString(),
        synthesis_runner: "vercel-queen.42",
        content: "x",
        sequence_closed: 5,
      },
    });

    expect(result).toEqual({ closedSequence: 7 });
    expect(sharedMocks.getRoomCore).toHaveBeenCalledWith({
      installationId: "12345",
      roomId: "room-id",
      redis: fakeRedis,
    });
    // The subject from getRoomCore is threaded into closeRoomWithDecision
    // — pinning this contract so the next refactor doesn't accidentally
    // pass a stale or wrong subject.
    expect(sharedMocks.closeRoomWithDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "12345",
        roomId: "room-id",
        subject: { type: "pr_review", ref: "hivemoot/hivemoot#42" },
      }),
    );
  });

  it("propagates getRoomCore failure (RoomNotFoundError) without calling closeRoomWithDecision", async () => {
    sharedMocks.getRoomCore.mockRejectedValueOnce(
      new RoomNotFoundError("12345", "missing-room"),
    );
    await expect(
      store.closeRoom({
        roomId: "missing-room",
        expectedThroughSequence: 5,
        decision: {
          synthesized_at: new Date().toISOString(),
          synthesis_runner: "vercel-queen.42",
          content: "x",
          sequence_closed: 5,
        },
      }),
    ).rejects.toMatchObject({ code: "room_not_found", status: 404 });
    expect(sharedMocks.closeRoomWithDecision).not.toHaveBeenCalled();
  });
});
