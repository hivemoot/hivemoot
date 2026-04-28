/**
 * Tests for `runQueenManagerLoop` (G'.2). Uses a hand-rolled
 * `FakeWarRoomClient` rather than vitest mocks so behavior contracts
 * stay legible (the queen's invariants — claim-then-close, sequence
 * pinning, error fan-out — are subtle enough that mock-method-call
 * trees obscure intent).
 */

import { describe, expect, it } from "vitest";
import { runQueenManagerLoop } from "./manager-loop.js";
import { StubSynthesizer, type Synthesizer } from "./synthesizer.js";
import {
  WarRoomApiError,
  type RoomContribution,
  type RoomListEntry,
  type RoomParticipant,
  type WarRoomClient,
} from "../war-room-client.js";

const ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";
const RUNNER_ID = "queen-test-runner";

function makeRoom(overrides: Partial<RoomListEntry> = {}): RoomListEntry {
  return {
    roomId: ROOM_ID,
    manager: "bot-queen",
    subject_type: "pr_review",
    subject_ref: "owner/repo#42",
    status: "awaiting_contributions",
    opened_at: "2026-04-28T20:00:00Z",
    ...overrides,
  };
}

function resolvedParticipant(role: string): RoomParticipant {
  return {
    agent_id: `${role}-runner-1`,
    role,
    status: "resolved",
    rsvp_at: "2026-04-28T20:01:00Z",
    resolved_at: "2026-04-28T20:05:00Z",
  };
}

function pendingParticipant(role: string): RoomParticipant {
  return {
    agent_id: `${role}-runner-1`,
    role,
    status: "pending",
    rsvp_at: "2026-04-28T20:01:00Z",
  };
}

function presentContribution(): RoomContribution {
  return { raw_md: "LGTM", contributed_at: "2026-04-28T20:05:00Z" };
}

interface FakeOptions {
  rooms?: RoomListEntry[];
  listRoomsThrows?: unknown;
  participants?: Record<string, Record<string, RoomParticipant>>;
  contributions?: Record<string, Record<string, RoomContribution>>;
  claimThrowsByRoomId?: Record<string, unknown>;
  closeThrowsByRoomId?: Record<string, unknown>;
  claimThroughSequence?: number;
}

interface FakeCalls {
  listRoomsCalls: { limit?: number }[];
  claimCalls: { roomId: string; queenRunner: string }[];
  closeCalls: {
    roomId: string;
    expectedThroughSequence: number;
    decisionContent: string;
    synthesisRunner: string;
    synthesizedAt: string;
  }[];
}

function makeFakeClient(opts: FakeOptions): {
  client: WarRoomClient;
  calls: FakeCalls;
} {
  const calls: FakeCalls = {
    listRoomsCalls: [],
    claimCalls: [],
    closeCalls: [],
  };
  const claimSeq = opts.claimThroughSequence ?? 7;

  const client = {
    async listRooms(args: { limit?: number } = {}) {
      calls.listRoomsCalls.push(args);
      if (opts.listRoomsThrows) throw opts.listRoomsThrows;
      return opts.rooms ?? [];
    },
    async getRoomParticipants(roomId: string) {
      return {
        roomId,
        participants: opts.participants?.[roomId] ?? {},
      };
    },
    async getRoomContributions(roomId: string) {
      return {
        roomId,
        contributions: opts.contributions?.[roomId] ?? {},
      };
    },
    async claimSynthesis(args: { roomId: string; queenRunner: string }) {
      calls.claimCalls.push(args);
      const t = opts.claimThrowsByRoomId?.[args.roomId];
      if (t) throw t;
      return { throughSequence: claimSeq, claimTtlSecs: 300 };
    },
    async closeRoom(args: {
      roomId: string;
      expectedThroughSequence: number;
      decision: {
        content: string;
        synthesis_runner: string;
        synthesized_at: string;
        sequence_closed: number;
      };
    }) {
      calls.closeCalls.push({
        roomId: args.roomId,
        expectedThroughSequence: args.expectedThroughSequence,
        decisionContent: args.decision.content,
        synthesisRunner: args.decision.synthesis_runner,
        synthesizedAt: args.decision.synthesized_at,
      });
      const t = opts.closeThrowsByRoomId?.[args.roomId];
      if (t) throw t;
      return { closedSequence: args.expectedThroughSequence };
    },
  } as unknown as WarRoomClient;

  return { client, calls };
}

describe("runQueenManagerLoop — listing & filtering", () => {
  it("returns all-zero counters when listRooms returns empty", async () => {
    const { client, calls } = makeFakeClient({ rooms: [] });
    const result = await runQueenManagerLoop({
      client,
      synthesizer: new StubSynthesizer(),
      runnerId: RUNNER_ID,
    });
    expect(result.totalRoomsScanned).toBe(0);
    expect(result.scannedAwaitingContributions).toBe(0);
    expect(result.eligible).toBe(0);
    expect(result.claimed).toBe(0);
    expect(result.closed).toBe(0);
    expect(result.conflicts).toBe(0);
    expect(result.errors).toBe(0);
    expect(calls.listRoomsCalls).toHaveLength(1);
  });

  it("listRooms failure increments errors and returns early", async () => {
    const { client } = makeFakeClient({
      listRoomsThrows: new Error("upstream 502"),
    });
    const result = await runQueenManagerLoop({
      client,
      synthesizer: new StubSynthesizer(),
      runnerId: RUNNER_ID,
    });
    expect(result.errors).toBe(1);
    expect(result.totalRoomsScanned).toBe(0);
  });

  it("ignores rooms not in awaiting_contributions", async () => {
    const { client, calls } = makeFakeClient({
      rooms: [
        makeRoom({ roomId: "a", status: "awaiting_rsvp" }),
        makeRoom({ roomId: "b", status: "deciding" }),
        makeRoom({ roomId: "c", status: "closed" }),
        makeRoom({ roomId: "d", status: "expired" }),
      ],
    });
    const result = await runQueenManagerLoop({
      client,
      synthesizer: new StubSynthesizer(),
      runnerId: RUNNER_ID,
    });
    expect(result.totalRoomsScanned).toBe(4);
    expect(result.scannedAwaitingContributions).toBe(0);
    expect(calls.claimCalls).toEqual([]);
    expect(calls.closeCalls).toEqual([]);
  });

  it("forwards maxRoomsPerTick to listRooms", async () => {
    const { client, calls } = makeFakeClient({ rooms: [] });
    await runQueenManagerLoop({
      client,
      synthesizer: new StubSynthesizer(),
      runnerId: RUNNER_ID,
      maxRoomsPerTick: 25,
    });
    expect(calls.listRoomsCalls[0]).toEqual({ limit: 25 });
  });

  it("default maxRoomsPerTick is 100", async () => {
    const { client, calls } = makeFakeClient({ rooms: [] });
    await runQueenManagerLoop({
      client,
      synthesizer: new StubSynthesizer(),
      runnerId: RUNNER_ID,
    });
    expect(calls.listRoomsCalls[0]).toEqual({ limit: 100 });
  });
});

describe("runQueenManagerLoop — eligibility check", () => {
  it("skips rooms with any pending participant", async () => {
    const { client, calls } = makeFakeClient({
      rooms: [makeRoom()],
      participants: {
        [ROOM_ID]: {
          guard: resolvedParticipant("guard"),
          builder: pendingParticipant("builder"),
        },
      },
    });
    const result = await runQueenManagerLoop({
      client,
      synthesizer: new StubSynthesizer(),
      runnerId: RUNNER_ID,
    });
    expect(result.scannedAwaitingContributions).toBe(1);
    expect(result.eligible).toBe(0);
    expect(calls.claimCalls).toEqual([]);
  });

  it("treats rooms with empty participants as not eligible", async () => {
    // Defensive: an awaiting_contributions room with no RSVPs is a
    // bug or race. Don't claim it — let the watchdog expire it.
    const { client, calls } = makeFakeClient({
      rooms: [makeRoom()],
      participants: { [ROOM_ID]: {} },
    });
    const result = await runQueenManagerLoop({
      client,
      synthesizer: new StubSynthesizer(),
      runnerId: RUNNER_ID,
    });
    expect(result.eligible).toBe(0);
    expect(calls.claimCalls).toEqual([]);
  });

  it("treats withdrew/timed_out as eligible (only pending blocks)", async () => {
    const { client, calls } = makeFakeClient({
      rooms: [makeRoom()],
      participants: {
        [ROOM_ID]: {
          guard: resolvedParticipant("guard"),
          builder: { ...resolvedParticipant("builder"), status: "withdrew" },
          drone: { ...resolvedParticipant("drone"), status: "timed_out" },
        },
      },
      contributions: { [ROOM_ID]: { guard: presentContribution() } },
    });
    const result = await runQueenManagerLoop({
      client,
      synthesizer: new StubSynthesizer(),
      runnerId: RUNNER_ID,
    });
    expect(result.eligible).toBe(1);
    expect(result.claimed).toBe(1);
    expect(result.closed).toBe(1);
    expect(calls.claimCalls).toHaveLength(1);
    expect(calls.closeCalls).toHaveLength(1);
  });
});

describe("runQueenManagerLoop — happy path", () => {
  it("claims, synthesizes, closes one room", async () => {
    const { client, calls } = makeFakeClient({
      rooms: [makeRoom()],
      participants: { [ROOM_ID]: { guard: resolvedParticipant("guard") } },
      contributions: { [ROOM_ID]: { guard: presentContribution() } },
      claimThroughSequence: 12,
    });
    const result = await runQueenManagerLoop({
      client,
      synthesizer: new StubSynthesizer(),
      runnerId: RUNNER_ID,
      nowMs: Date.parse("2026-04-28T20:30:00Z"),
    });
    expect(result.eligible).toBe(1);
    expect(result.claimed).toBe(1);
    expect(result.closed).toBe(1);
    expect(result.conflicts).toBe(0);
    expect(result.errors).toBe(0);
    expect(calls.claimCalls).toEqual([
      { roomId: ROOM_ID, queenRunner: RUNNER_ID },
    ]);
    expect(calls.closeCalls).toHaveLength(1);
    const closed = calls.closeCalls[0];
    expect(closed.roomId).toBe(ROOM_ID);
    expect(closed.expectedThroughSequence).toBe(12);
    expect(closed.synthesisRunner).toBe(RUNNER_ID);
    expect(closed.synthesizedAt).toBe("2026-04-28T20:30:00.000Z");
    expect(closed.decisionContent).toContain(ROOM_ID);
  });

  it("processes multiple eligible rooms in one tick", async () => {
    const room2 = makeRoom({ roomId: "room-2" });
    const room3 = makeRoom({ roomId: "room-3" });
    const { client, calls } = makeFakeClient({
      rooms: [makeRoom(), room2, room3],
      participants: {
        [ROOM_ID]: { guard: resolvedParticipant("guard") },
        "room-2": { builder: resolvedParticipant("builder") },
        "room-3": { drone: resolvedParticipant("drone") },
      },
      contributions: {
        [ROOM_ID]: { guard: presentContribution() },
        "room-2": { builder: presentContribution() },
        "room-3": { drone: presentContribution() },
      },
    });
    const result = await runQueenManagerLoop({
      client,
      synthesizer: new StubSynthesizer(),
      runnerId: RUNNER_ID,
    });
    expect(result.scannedAwaitingContributions).toBe(3);
    expect(result.eligible).toBe(3);
    expect(result.closed).toBe(3);
    expect(calls.claimCalls).toHaveLength(3);
    expect(calls.closeCalls).toHaveLength(3);
  });
});

describe("runQueenManagerLoop — claim conflicts", () => {
  function claimFails(code: string, status = 409): WarRoomApiError {
    return new WarRoomApiError(status, code, `claim ${code}`, {});
  }

  it("claim_already_held → conflicts++ (no synthesis, no close)", async () => {
    const { client, calls } = makeFakeClient({
      rooms: [makeRoom()],
      participants: { [ROOM_ID]: { guard: resolvedParticipant("guard") } },
      claimThrowsByRoomId: { [ROOM_ID]: claimFails("claim_already_held") },
    });
    const result = await runQueenManagerLoop({
      client,
      synthesizer: new StubSynthesizer(),
      runnerId: RUNNER_ID,
    });
    expect(result.eligible).toBe(1);
    expect(result.claimed).toBe(0);
    expect(result.conflicts).toBe(1);
    expect(result.closed).toBe(0);
    expect(result.errors).toBe(0);
    expect(calls.closeCalls).toEqual([]);
  });

  it("non-benign claim error → errors++", async () => {
    const { client, calls } = makeFakeClient({
      rooms: [makeRoom()],
      participants: { [ROOM_ID]: { guard: resolvedParticipant("guard") } },
      claimThrowsByRoomId: {
        [ROOM_ID]: new WarRoomApiError(500, "internal", "boom", {}),
      },
    });
    const result = await runQueenManagerLoop({
      client,
      synthesizer: new StubSynthesizer(),
      runnerId: RUNNER_ID,
    });
    expect(result.errors).toBe(1);
    expect(result.conflicts).toBe(0);
    expect(calls.closeCalls).toEqual([]);
  });

  it("non-WarRoomApiError thrown by claim → errors++", async () => {
    const { client } = makeFakeClient({
      rooms: [makeRoom()],
      participants: { [ROOM_ID]: { guard: resolvedParticipant("guard") } },
      claimThrowsByRoomId: { [ROOM_ID]: new Error("network down") },
    });
    const result = await runQueenManagerLoop({
      client,
      synthesizer: new StubSynthesizer(),
      runnerId: RUNNER_ID,
    });
    expect(result.errors).toBe(1);
    expect(result.conflicts).toBe(0);
  });
});

describe("runQueenManagerLoop — synthesizer failure", () => {
  it("synthesizer throws → errors++, no close call", async () => {
    const failing: Synthesizer = {
      async synthesize() {
        throw new Error("LLM upstream timeout");
      },
    };
    const { client, calls } = makeFakeClient({
      rooms: [makeRoom()],
      participants: { [ROOM_ID]: { guard: resolvedParticipant("guard") } },
      contributions: { [ROOM_ID]: { guard: presentContribution() } },
    });
    const result = await runQueenManagerLoop({
      client,
      synthesizer: failing,
      runnerId: RUNNER_ID,
    });
    expect(result.claimed).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.closed).toBe(0);
    expect(calls.closeCalls).toEqual([]);
  });
});

describe("runQueenManagerLoop — close conflicts", () => {
  function closeFails(code: string, status = 409): WarRoomApiError {
    return new WarRoomApiError(status, code, `close ${code}`, {});
  }

  for (const code of [
    "sequence_drift",
    "claim_lost",
    "claim_through_seq_mismatch",
  ]) {
    it(`closeRoom 409 ${code} → conflicts++`, async () => {
      const { client } = makeFakeClient({
        rooms: [makeRoom()],
        participants: { [ROOM_ID]: { guard: resolvedParticipant("guard") } },
        contributions: { [ROOM_ID]: { guard: presentContribution() } },
        closeThrowsByRoomId: { [ROOM_ID]: closeFails(code) },
      });
      const result = await runQueenManagerLoop({
        client,
        synthesizer: new StubSynthesizer(),
        runnerId: RUNNER_ID,
      });
      expect(result.claimed).toBe(1);
      expect(result.conflicts).toBe(1);
      expect(result.closed).toBe(0);
      expect(result.errors).toBe(0);
    });
  }

  it("closeRoom 400 decision_too_large → errors++ (NOT a conflict)", async () => {
    // 400 is a different status; the loop treats only 409+benign-code
    // as a conflict. decision_too_large is a synthesizer/storage
    // boundary error — alert ops, don't silently swallow.
    const { client } = makeFakeClient({
      rooms: [makeRoom()],
      participants: { [ROOM_ID]: { guard: resolvedParticipant("guard") } },
      contributions: { [ROOM_ID]: { guard: presentContribution() } },
      closeThrowsByRoomId: {
        [ROOM_ID]: new WarRoomApiError(
          400,
          "decision_too_large",
          "decision exceeds 64 KiB",
          { sizeBytes: 70_000 },
        ),
      },
    });
    const result = await runQueenManagerLoop({
      client,
      synthesizer: new StubSynthesizer(),
      runnerId: RUNNER_ID,
    });
    expect(result.errors).toBe(1);
    expect(result.conflicts).toBe(0);
  });

  it("close 409 with unfamiliar code → errors++ (closed conflict set)", async () => {
    // Defensive: only the four documented benign codes count as
    // conflicts. A new 409 code introduced server-side without
    // updating the loop should fail loud, not silent.
    const { client } = makeFakeClient({
      rooms: [makeRoom()],
      participants: { [ROOM_ID]: { guard: resolvedParticipant("guard") } },
      contributions: { [ROOM_ID]: { guard: presentContribution() } },
      closeThrowsByRoomId: {
        [ROOM_ID]: new WarRoomApiError(409, "unknown_new_code", "?", {}),
      },
    });
    const result = await runQueenManagerLoop({
      client,
      synthesizer: new StubSynthesizer(),
      runnerId: RUNNER_ID,
    });
    expect(result.errors).toBe(1);
    expect(result.conflicts).toBe(0);
  });
});

describe("runQueenManagerLoop — mixed outcomes", () => {
  it("counts each room's outcome independently in one tick", async () => {
    // Three rooms: one happy, one claim-conflict, one synthesizer-error.
    const happyId = "happy-room";
    const conflictId = "conflict-room";
    const errorId = "error-room";

    let synthCallCount = 0;
    const conditionalSynth: Synthesizer = {
      async synthesize(input) {
        synthCallCount += 1;
        if (input.roomId === errorId) throw new Error("LLM down");
        return new StubSynthesizer().synthesize(input);
      },
    };

    const { client } = makeFakeClient({
      rooms: [
        makeRoom({ roomId: happyId }),
        makeRoom({ roomId: conflictId }),
        makeRoom({ roomId: errorId }),
      ],
      participants: {
        [happyId]: { guard: resolvedParticipant("guard") },
        [conflictId]: { guard: resolvedParticipant("guard") },
        [errorId]: { guard: resolvedParticipant("guard") },
      },
      contributions: {
        [happyId]: { guard: presentContribution() },
        [conflictId]: { guard: presentContribution() },
        [errorId]: { guard: presentContribution() },
      },
      claimThrowsByRoomId: {
        [conflictId]: new WarRoomApiError(
          409,
          "claim_already_held",
          "race",
          {},
        ),
      },
    });
    const result = await runQueenManagerLoop({
      client,
      synthesizer: conditionalSynth,
      runnerId: RUNNER_ID,
    });
    expect(result.totalRoomsScanned).toBe(3);
    expect(result.eligible).toBe(3);
    expect(result.claimed).toBe(2); // happy + error (NOT the conflict)
    expect(result.closed).toBe(1); // happy only
    expect(result.conflicts).toBe(1); // conflict-room
    expect(result.errors).toBe(1); // error-room (synthesizer threw)
    expect(synthCallCount).toBe(2); // happy + error (NOT the conflict)
  });
});

describe("runQueenManagerLoop — decision payload shape", () => {
  it("uses runnerId as synthesis_runner and nowMs as synthesized_at", async () => {
    const fixedNow = Date.parse("2026-04-28T22:00:00Z");
    const { client, calls } = makeFakeClient({
      rooms: [makeRoom()],
      participants: { [ROOM_ID]: { guard: resolvedParticipant("guard") } },
      contributions: { [ROOM_ID]: { guard: presentContribution() } },
      claimThroughSequence: 99,
    });
    await runQueenManagerLoop({
      client,
      synthesizer: new StubSynthesizer(),
      runnerId: "queen-prod-deploy-abc",
      nowMs: fixedNow,
    });
    expect(calls.closeCalls[0].synthesisRunner).toBe("queen-prod-deploy-abc");
    expect(calls.closeCalls[0].synthesizedAt).toBe("2026-04-28T22:00:00.000Z");
    expect(calls.closeCalls[0].expectedThroughSequence).toBe(99);
  });
});
