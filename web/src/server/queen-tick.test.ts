/**
 * Tests for queen-tick — the war-room watchdog body.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runQueenTick,
  queenTickLockKey,
  QUEEN_TICK_LOCK_RELEASE_SCRIPT,
  QUEEN_TICK_LOCK_TTL_SECS,
  WATCHDOG_TERMINATE_ACTOR,
  WATCHDOG_TIMEOUT_ACTOR,
} from "./queen-tick";

vi.mock("@hivemoot/war-room", async () => {
  const real = await vi.importActual<typeof import("@hivemoot/war-room")>(
    "@hivemoot/war-room",
  );
  return {
    ...real,
    listRooms: vi.fn(),
    getRoomParticipants: vi.fn(),
    recoverDeciding: vi.fn(),
    terminateRoom: vi.fn(),
    timeoutParticipant: vi.fn(),
  };
});

import {
  listRooms,
  getRoomParticipants,
  recoverDeciding,
  terminateRoom,
  timeoutParticipant,
  RoomTransitionInvalidStatusError,
  RoomAlreadyClosedError,
  RoomParticipantStatePreconditionError,
  type RoomCoreWithId,
  type RoomParticipant,
} from "@hivemoot/war-room";

const mockedList = vi.mocked(listRooms);
const mockedParticipants = vi.mocked(getRoomParticipants);
const mockedRecover = vi.mocked(recoverDeciding);
const mockedTerm = vi.mocked(terminateRoom);
const mockedTimeout = vi.mocked(timeoutParticipant);

const RID_A = "01234567-89ab-4cde-9012-3456789abcde";
const RID_B = "fedcba98-7654-4321-89ab-fedcba987654";
const RID_C = "11111111-2222-4333-9444-555555555555";

const NOW = 1735574400000; // 2025-12-30T16:00:00Z

function room(
  roomId: string,
  status: "awaiting_contributions" | "deciding" | "closed",
  options?: {
    openedAtSecondsAgo?: number;
    maxAgeSecs?: number;
    dropThresholdSecs?: number;
    quietPeriodSecs?: number;
  },
): RoomCoreWithId {
  const opts = options ?? {};
  const openedAtMs = NOW - (opts.openedAtSecondsAgo ?? 0) * 1000;
  return {
    roomId,
    manager: "bot-queen",
    subject_type: "pr_review",
    subject_ref: `hivemoot/hivemoot#${roomId.slice(-3)}`,
    opened_at: new Date(openedAtMs).toISOString(),
    timing_config: {
      max_age_secs: opts.maxAgeSecs ?? 3600,
      drop_threshold_secs: opts.dropThresholdSecs ?? 600,
      quiet_period_secs: opts.quietPeriodSecs ?? 600,
    },
    status,
  };
}

function participant(
  role: string,
  status: RoomParticipant["status"],
  rsvpAtSecondsAgo: number,
): RoomParticipant {
  return {
    agent_id: `${role}-1`,
    role,
    status,
    rsvp_at: new Date(NOW - rsvpAtSecondsAgo * 1000).toISOString(),
  };
}

const fakeRedis = {
  get: vi.fn(async () => 5),
  zcard: vi.fn(async () => 0),
};
const fakeRedisAsRedis = fakeRedis as never;

describe("runQueenTick — recovery scan", () => {
  beforeEach(() => {
    mockedList.mockReset();
    mockedRecover.mockReset();
    mockedTerm.mockReset();
    mockedTimeout.mockReset();
    mockedParticipants.mockReset();
  });

  it("scans deciding rooms and counts recoveries", async () => {
    mockedList.mockResolvedValue([
      room(RID_A, "deciding"),
      room(RID_B, "deciding"),
      room(RID_C, "awaiting_contributions"), // Not deciding — skip
    ]);
    mockedParticipants.mockResolvedValue({});
    mockedRecover
      .mockResolvedValueOnce({ recovered: true, sequence: 7 })
      .mockResolvedValueOnce({ recovered: false, reason: "claim_active" });

    const result = await runQueenTick({
      installationId: "12345",
      redis: fakeRedisAsRedis,
      nowMs: NOW,
    });
    expect(result.scannedDeciding).toBe(2);
    expect(result.recovered).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("RoomTransitionInvalidStatusError is benign skip (status moved mid-tick)", async () => {
    mockedList.mockResolvedValue([room(RID_A, "deciding")]);
    mockedParticipants.mockResolvedValue({});
    mockedRecover.mockRejectedValue(
      new RoomTransitionInvalidStatusError(
        RID_A,
        "recover_deciding",
        ["deciding"],
        "closed",
      ),
    );
    const result = await runQueenTick({
      installationId: "12345",
      redis: fakeRedisAsRedis,
      nowMs: NOW,
    });
    expect(result.scannedDeciding).toBe(1);
    expect(result.recovered).toBe(0);
    expect(result.errors).toBe(0);
  });
});

describe("runQueenTick — expire scan", () => {
  beforeEach(() => {
    mockedList.mockReset();
    mockedRecover.mockReset();
    mockedTerm.mockReset();
    mockedTimeout.mockReset();
    mockedParticipants.mockReset();
  });

  it("terminates rooms past max_age_secs as `expired` with watchdog actor", async () => {
    // Room opened 4000s ago, max_age 3600s → 400s past expiry.
    mockedList.mockResolvedValue([
      room(RID_A, "awaiting_contributions", { openedAtSecondsAgo: 4000, maxAgeSecs: 3600 }),
    ]);
    mockedParticipants.mockResolvedValue({});
    mockedTerm.mockResolvedValue(7);

    const result = await runQueenTick({
      installationId: "12345",
      redis: fakeRedisAsRedis,
      nowMs: NOW,
    });
    expect(result.expired).toBe(1);
    expect(mockedTerm).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: RID_A,
        reason: "expired",
        // Watchdog terminate uses the SYSTEM/vercel-cron pair per
        // RoomEvent JSDoc spec — closes #524 guard B1.
        actorRole: "system",
        actorId: "vercel-cron",
        subject: { type: "pr_review", ref: `hivemoot/hivemoot#${RID_A.slice(-3)}` },
      }),
    );
  });

  it("does NOT terminate rooms within max_age", async () => {
    mockedList.mockResolvedValue([
      room(RID_A, "awaiting_contributions", { openedAtSecondsAgo: 100, maxAgeSecs: 3600 }),
    ]);
    mockedParticipants.mockResolvedValue({});
    const result = await runQueenTick({
      installationId: "12345",
      redis: fakeRedisAsRedis,
      nowMs: NOW,
    });
    expect(result.expired).toBe(0);
    expect(mockedTerm).not.toHaveBeenCalled();
  });

  it("expires DECIDING rooms past max_age (claim DEL'd, queen aborts)", async () => {
    // Stuck-deciding room past max_age. Recover would also fire but
    // claim is active → recover skips, expire fires.
    mockedList.mockResolvedValue([
      room(RID_A, "deciding", { openedAtSecondsAgo: 4000, maxAgeSecs: 3600 }),
    ]);
    mockedParticipants.mockResolvedValue({});
    mockedRecover.mockResolvedValue({ recovered: false, reason: "claim_active" });
    mockedTerm.mockResolvedValue(8);

    const result = await runQueenTick({
      installationId: "12345",
      redis: fakeRedisAsRedis,
      nowMs: NOW,
    });
    expect(result.expired).toBe(1);
    expect(result.scannedDeciding).toBe(1);
  });

  it("RoomAlreadyClosedError on terminate is benign (race with operator force-close)", async () => {
    mockedList.mockResolvedValue([
      room(RID_A, "awaiting_contributions", { openedAtSecondsAgo: 4000, maxAgeSecs: 3600 }),
    ]);
    mockedParticipants.mockResolvedValue({});
    mockedTerm.mockRejectedValue(new RoomAlreadyClosedError(RID_A, "closed"));

    const result = await runQueenTick({
      installationId: "12345",
      redis: fakeRedisAsRedis,
      nowMs: NOW,
    });
    expect(result.errors).toBe(0); // benign race
  });

  it("skips closed rooms entirely (status filter)", async () => {
    mockedList.mockResolvedValue([
      room(RID_A, "closed", { openedAtSecondsAgo: 9999, maxAgeSecs: 60 }),
    ]);
    const result = await runQueenTick({
      installationId: "12345",
      redis: fakeRedisAsRedis,
      nowMs: NOW,
    });
    expect(result.scannedOpen).toBe(0);
    expect(result.expired).toBe(0);
  });
});

describe("runQueenTick — timeout scan", () => {
  beforeEach(() => {
    mockedList.mockReset();
    mockedRecover.mockReset();
    mockedTerm.mockReset();
    mockedTimeout.mockReset();
    mockedParticipants.mockReset();
  });

  it("times out pending participants past contribution_deadline", async () => {
    mockedList.mockResolvedValue([
      room(RID_A, "awaiting_contributions", {
        openedAtSecondsAgo: 1500,
        maxAgeSecs: 3600,
        dropThresholdSecs: 1200,
      }),
    ]);
    mockedParticipants.mockResolvedValue({
      drone: participant("drone", "pending", 1300), // 100s past 1200s deadline
      builder: participant("builder", "pending", 100), // well within
      guard: participant("guard", "resolved", 1300), // not pending — skip
    });
    mockedTimeout.mockResolvedValue(7);

    const result = await runQueenTick({
      installationId: "12345",
      redis: fakeRedisAsRedis,
      nowMs: NOW,
    });
    expect(result.scannedAwaitingContributions).toBe(1);
    expect(result.timedOutParticipants).toBe(1);
    expect(mockedTimeout).toHaveBeenCalledTimes(1);
    expect(mockedTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: RID_A,
        subjectRole: "drone",
        // Watchdog timeout uses the MANAGER/watchdog pair per
        // RoomEvent JSDoc spec — closes #524 guard B1. Distinct
        // from terminate's SYSTEM/vercel-cron pair.
        watchdogRole: "manager",
        watchdogAgentId: "watchdog",
      }),
    );
  });

  it("RoomParticipantStatePreconditionError on timeout is benign (worker resolved between scan and EVAL)", async () => {
    mockedList.mockResolvedValue([
      room(RID_A, "awaiting_contributions", {
        openedAtSecondsAgo: 1500,
        dropThresholdSecs: 1200,
      }),
    ]);
    mockedParticipants.mockResolvedValue({
      drone: participant("drone", "pending", 1300),
    });
    mockedTimeout.mockRejectedValue(
      new RoomParticipantStatePreconditionError(
        RID_A,
        "drone",
        ["pending"],
        "resolved",
      ),
    );
    const result = await runQueenTick({
      installationId: "12345",
      redis: fakeRedisAsRedis,
      nowMs: NOW,
    });
    expect(result.timedOutParticipants).toBe(0);
    expect(result.errors).toBe(0); // race is benign, not an error
  });

  it("does NOT run timeout scan on a just-expired room (continue after expire)", async () => {
    mockedList.mockResolvedValue([
      room(RID_A, "awaiting_contributions", {
        openedAtSecondsAgo: 4000,
        maxAgeSecs: 3600,
      }),
    ]);
    mockedTerm.mockResolvedValue(8);
    mockedParticipants.mockResolvedValue({
      drone: participant("drone", "pending", 1300),
    });
    const result = await runQueenTick({
      installationId: "12345",
      redis: fakeRedisAsRedis,
      nowMs: NOW,
    });
    expect(result.expired).toBe(1);
    // After expiring the room, the timeout scan should NOT have
    // run on this room (continue after expire).
    expect(mockedParticipants).not.toHaveBeenCalled();
    expect(mockedTimeout).not.toHaveBeenCalled();
    expect(result.timedOutParticipants).toBe(0);
  });
});

describe("runQueenTick — orchestration + bounds", () => {
  beforeEach(() => {
    mockedList.mockReset();
    mockedRecover.mockReset();
    mockedTerm.mockReset();
    mockedTimeout.mockReset();
    mockedParticipants.mockReset();
  });

  it("returns full counter shape", async () => {
    mockedList.mockResolvedValue([]);
    const result = await runQueenTick({
      installationId: "12345",
      redis: fakeRedisAsRedis,
      nowMs: NOW,
    });
    expect(result).toEqual({
      scannedDeciding: 0,
      recovered: 0,
      scannedOpen: 0,
      expired: 0,
      scannedAwaitingContributions: 0,
      timedOutParticipants: 0,
      errors: 0,
      roomsUnscanned: 0,
    });
  });

  it("respects maxRoomsPerTick cap (passed to listRooms)", async () => {
    mockedList.mockResolvedValue([]);
    await runQueenTick({
      installationId: "12345",
      redis: fakeRedisAsRedis,
      nowMs: NOW,
      maxRoomsPerTick: 25,
    });
    expect(mockedList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25 }),
    );
  });

  it("default cap is 100", async () => {
    mockedList.mockResolvedValue([]);
    await runQueenTick({
      installationId: "12345",
      redis: fakeRedisAsRedis,
      nowMs: NOW,
    });
    expect(mockedList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it("end-to-end: deciding+recovery + awaiting+timeout + expire — all three counters advance", async () => {
    mockedList.mockResolvedValue([
      room(RID_A, "deciding"), // recovery
      room(RID_B, "awaiting_contributions", {
        openedAtSecondsAgo: 1500,
        dropThresholdSecs: 1200,
      }), // timeout
      room(RID_C, "awaiting_contributions", { openedAtSecondsAgo: 4000, maxAgeSecs: 3600 }), // expire
    ]);
    mockedParticipants.mockResolvedValue({
      drone: participant("drone", "pending", 1300),
    });
    mockedRecover.mockResolvedValue({ recovered: true, sequence: 7 });
    mockedTerm.mockResolvedValue(8);
    mockedTimeout.mockResolvedValue(9);

    const result = await runQueenTick({
      installationId: "12345",
      redis: fakeRedisAsRedis,
      nowMs: NOW,
    });
    expect(result.scannedDeciding).toBe(1);
    expect(result.recovered).toBe(1);
    expect(result.expired).toBe(1);
    expect(result.timedOutParticipants).toBe(1);
    expect(result.scannedOpen).toBe(3); // all 3 are open status
    expect(result.errors).toBe(0);
  });
});

describe("runQueenTick — roomsUnscanned counter (closes #524 guard N2 + builder backlog)", () => {
  beforeEach(() => {
    mockedList.mockReset();
    mockedRecover.mockReset();
    mockedTerm.mockReset();
    mockedTimeout.mockReset();
    mockedParticipants.mockReset();
    fakeRedis.zcard.mockReset();
  });

  it("roomsUnscanned=0 when total fits within cap (steady state)", async () => {
    mockedList.mockResolvedValue([room(RID_A, "awaiting_contributions")]);
    fakeRedis.zcard.mockResolvedValue(1);
    mockedParticipants.mockResolvedValue({});
    const result = await runQueenTick({
      installationId: "12345",
      redis: fakeRedisAsRedis,
      nowMs: NOW,
    });
    expect(result.roomsUnscanned).toBe(0);
  });

  it("roomsUnscanned=N when index has more rooms than cap (backlog visible)", async () => {
    // listRooms returns 100 (capped); index has 250 → 150 unscanned
    const slice = Array.from({ length: 100 }, (_, i) =>
      room(`${i}`.padStart(8, "0") + "-89ab-4cde-9012-3456789abcde", "awaiting_contributions"),
    );
    mockedList.mockResolvedValue(slice);
    fakeRedis.zcard.mockResolvedValue(250);
    mockedParticipants.mockResolvedValue({});
    const result = await runQueenTick({
      installationId: "12345",
      redis: fakeRedisAsRedis,
      nowMs: NOW,
    });
    expect(result.roomsUnscanned).toBe(150);
  });

  it("roomsUnscanned=0 when zcard fails (defensive — never negative)", async () => {
    mockedList.mockResolvedValue([room(RID_A, "awaiting_contributions")]);
    fakeRedis.zcard.mockRejectedValue(new Error("Redis hiccup"));
    mockedParticipants.mockResolvedValue({});
    const result = await runQueenTick({
      installationId: "12345",
      redis: fakeRedisAsRedis,
      nowMs: NOW,
    });
    // Caught by .catch(() => 0) → 0 - 1 = -1 → max(0, -1) = 0
    expect(result.roomsUnscanned).toBe(0);
  });
});

describe("queen-tick lock primitives", () => {
  it("queenTickLockKey is per-installation scoped", () => {
    expect(queenTickLockKey("12345")).toBe("hive:v1:lock:queen-tick:12345");
    expect(queenTickLockKey("99999")).toBe("hive:v1:lock:queen-tick:99999");
  });

  it("LOCK_TTL is 55s — just under the 60s cron interval (design L1016)", () => {
    expect(QUEEN_TICK_LOCK_TTL_SECS).toBe(55);
  });

  it("RELEASE_SCRIPT is compare-and-DEL (closes design R3 B6: SET NX returns OK/null, not stored value)", () => {
    expect(QUEEN_TICK_LOCK_RELEASE_SCRIPT).toContain("redis.call");
    expect(QUEEN_TICK_LOCK_RELEASE_SCRIPT).toContain("get");
    expect(QUEEN_TICK_LOCK_RELEASE_SCRIPT).toContain("del");
    expect(QUEEN_TICK_LOCK_RELEASE_SCRIPT).toContain("KEYS[1]");
    expect(QUEEN_TICK_LOCK_RELEASE_SCRIPT).toContain("ARGV[1]");
  });
});
