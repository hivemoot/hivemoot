import { describe, it, expect, vi, beforeEach } from "vitest";
import { type Redis } from "@upstash/redis";
import { checkInFlightForFlip } from "./queen-mode-flip-precheck";

// ---------------------------------------------------------------------------
// Mock Redis with smembers + exists. The precheck does parallel reads:
//   SMEMBERS deciding-status-index   (status index is a SET, not ZSET)
//   EXISTS   queen-tick-lock-key
//
// Guard pass-2 G1: an earlier mock implemented .zrange and the
// implementation called .zrange — but `statusIndexKey` is a Redis SET
// in real war-room (SADD/SREM in war-room.ts:2269-2526). Real Redis
// returns WRONGTYPE for ZRANGE against a SET. The tests below pin
// SMEMBERS as the call so a future copy-paste back to ZRANGE fails
// loudly here before it ships.
// ---------------------------------------------------------------------------

interface MockState {
  decidingIds?: string[];
  decidedPendingIds?: string[];
  closedIds?: string[];
  roomHashes?: Record<string, Record<string, unknown> | null>;
  tickLockHeld: boolean;
  errorOnSmembers?: Error;
  errorOnExists?: Error;
  errorOnHgetall?: Error;
}

function makeMockRedis(state: MockState): Redis {
  return {
    smembers: vi.fn(async (key: string) => {
      if (state.errorOnSmembers) throw state.errorOnSmembers;
      if (key.endsWith(":deciding")) return state.decidingIds ?? [];
      if (key.endsWith(":decided_pending_action")) {
        return state.decidedPendingIds ?? [];
      }
      if (key.endsWith(":closed")) return state.closedIds ?? [];
      return [];
    }),
    // Intentionally NOT defined — if the implementation ever switches
    // back to ZRANGE, the call throws "redis.zrange is not a function"
    // and these tests blow up. Real Redis would return WRONGTYPE.
    exists: vi.fn(async () => {
      if (state.errorOnExists) throw state.errorOnExists;
      return state.tickLockHeld ? 1 : 0;
    }),
    hgetall: vi.fn(async (key: string) => {
      if (state.errorOnHgetall) throw state.errorOnHgetall;
      const roomId = key.split(":").at(-1);
      return roomId !== undefined ? (state.roomHashes?.[roomId] ?? null) : null;
    }),
  } as unknown as Redis;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkInFlightForFlip", () => {
  it("returns null when no deciding rooms AND no tick lock held", async () => {
    const redis = makeMockRedis({ tickLockHeld: false });
    const result = await checkInFlightForFlip({
      installationId: "42",
      redis,
    });
    expect(result).toBeNull();
  });

  it("blocks when at least one room is in deciding", async () => {
    const redis = makeMockRedis({ decidingIds: ["rm-2"], tickLockHeld: false });
    const result = await checkInFlightForFlip({
      installationId: "42",
      redis,
    });
    expect(result).not.toBeNull();
    expect(result?.blocked.reason).toBe("rooms_in_flight");
    expect(result?.blocked.counts.deciding).toBe(1);
    expect(result?.blocked.counts.decided_pending_action).toBe(0);
    expect(result?.blocked.counts.stranded_merge).toBe(0);
    expect(result?.blocked.counts.tick_running).toBe(0);
    expect(result?.blocked.sampleRoomIds).toEqual(["rm-2"]);
  });

  it("blocks when a room is waiting in decided_pending_action", async () => {
    const redis = makeMockRedis({
      decidedPendingIds: ["rm-pending"],
      tickLockHeld: false,
    });
    const result = await checkInFlightForFlip({
      installationId: "42",
      redis,
    });
    expect(result).not.toBeNull();
    expect(result?.blocked.counts.deciding).toBe(0);
    expect(result?.blocked.counts.decided_pending_action).toBe(1);
    expect(result?.blocked.counts.stranded_merge).toBe(0);
    expect(result?.blocked.counts.tick_running).toBe(0);
    expect(result?.blocked.sampleRoomIds).toEqual(["rm-pending"]);
  });

  it("blocks on closed merge-approved rooms still pending report-merge-result", async () => {
    const redis = makeMockRedis({
      closedIds: ["rm-closed"],
      roomHashes: {
        "rm-closed": {
          status: "closed",
          decision: JSON.stringify({
            decision_outcome: "merge_approved",
            github_merge_status: "pending",
          }),
        },
      },
      tickLockHeld: false,
    });
    const result = await checkInFlightForFlip({
      installationId: "42",
      redis,
    });
    expect(result).not.toBeNull();
    expect(result?.blocked.counts.deciding).toBe(0);
    expect(result?.blocked.counts.decided_pending_action).toBe(0);
    expect(result?.blocked.counts.stranded_merge).toBe(1);
    expect(result?.blocked.counts.tick_running).toBe(0);
    expect(result?.blocked.sampleRoomIds).toEqual(["rm-closed"]);
  });

  it("ignores closed rooms whose GitHub merge result is already final", async () => {
    const redis = makeMockRedis({
      closedIds: ["rm-done", "rm-downgraded", "rm-raced"],
      roomHashes: {
        "rm-done": {
          status: "closed",
          decision: {
            decision_outcome: "merge_approved",
            github_merge_status: "succeeded",
          },
        },
        "rm-downgraded": {
          status: "closed",
          decision: {
            decision_outcome: "merge_downgraded",
          },
        },
        "rm-raced": {
          status: "decided_pending_action",
          decision: {
            decision_outcome: "merge_approved",
            github_merge_status: "pending",
          },
        },
      },
      tickLockHeld: false,
    });
    const result = await checkInFlightForFlip({
      installationId: "42",
      redis,
    });
    expect(result).toBeNull();
  });

  it("counts multiple deciding rooms via the status-keyed scan (guard pass-1 G1)", async () => {
    const redis = makeMockRedis({
      decidingIds: ["rm-a", "rm-b", "rm-c"],
      tickLockHeld: false,
    });
    const result = await checkInFlightForFlip({
      installationId: "42",
      redis,
    });
    expect(result?.blocked.counts.deciding).toBe(3);
    expect(result?.blocked.sampleRoomIds).toEqual(["rm-a", "rm-b", "rm-c"]);
  });

  it("status-keyed scan can't be paged out by unrelated awaiting_contributions burst (G1 regression)", async () => {
    // Even if the installation has 1000+ recent awaiting_contributions
    // rooms, the deciding-status SET only contains deciding rooms —
    // the precheck sees them all.
    const redis = makeMockRedis({
      decidingIds: ["rm-old-deciding"],
      tickLockHeld: false,
    });
    const result = await checkInFlightForFlip({
      installationId: "42",
      redis,
    });
    expect(result?.blocked.counts.deciding).toBe(1);
    expect(result?.blocked.sampleRoomIds).toEqual(["rm-old-deciding"]);
  });

  it("caps sampleRoomIds at 5", async () => {
    const redis = makeMockRedis({
      decidingIds: Array.from({ length: 8 }, (_, i) => `rm-${i}`),
      tickLockHeld: false,
    });
    const result = await checkInFlightForFlip({
      installationId: "42",
      redis,
    });
    expect(result?.blocked.sampleRoomIds).toHaveLength(5);
    expect(result?.blocked.counts.deciding).toBe(8);
  });

  it("blocks when queen-tick lock is held even with no deciding rooms (guard pass-1 G2)", async () => {
    const redis = makeMockRedis({ decidingIds: [], tickLockHeld: true });
    const result = await checkInFlightForFlip({
      installationId: "42",
      redis,
    });
    expect(result).not.toBeNull();
    expect(result?.blocked.counts.deciding).toBe(0);
    expect(result?.blocked.counts.tick_running).toBe(1);
  });

  it("counts BOTH deciding AND tick_running when both true", async () => {
    const redis = makeMockRedis({
      decidingIds: ["rm-1", "rm-2"],
      tickLockHeld: true,
    });
    const result = await checkInFlightForFlip({
      installationId: "42",
      redis,
    });
    expect(result?.blocked.counts.deciding).toBe(2);
    expect(result?.blocked.counts.tick_running).toBe(1);
  });

  it("propagates Redis errors (caller surfaces 500)", async () => {
    const redis = makeMockRedis({
      tickLockHeld: false,
      errorOnSmembers: new Error("redis down"),
    });
    await expect(
      checkInFlightForFlip({ installationId: "42", redis }),
    ).rejects.toThrow(/redis down/);
  });

  it("propagates closed-room hydrate errors (caller surfaces 500)", async () => {
    const redis = makeMockRedis({
      closedIds: ["rm-closed"],
      tickLockHeld: false,
      errorOnHgetall: new Error("hgetall down"),
    });
    await expect(
      checkInFlightForFlip({ installationId: "42", redis }),
    ).rejects.toThrow(/hgetall down/);
  });

  it("uses SMEMBERS (not ZRANGE) against the status SET (guard pass-2 G1)", async () => {
    // Pin: the read MUST be SMEMBERS — statusIndexKey is a SET
    // (SADD/SREM in war-room.ts), and ZRANGE returns WRONGTYPE
    // against a SET in real Redis. If a future change switches back
    // to ZRANGE, this test fails loudly at the call boundary.
    const redis = makeMockRedis({ tickLockHeld: false });
    await checkInFlightForFlip({ installationId: "42", redis });
    expect(redis.smembers).toHaveBeenCalledWith(
      "hive:v1:idx:room:status:42:deciding",
    );
    expect(redis.smembers).toHaveBeenCalledWith(
      "hive:v1:idx:room:status:42:decided_pending_action",
    );
    expect(redis.smembers).toHaveBeenCalledWith(
      "hive:v1:idx:room:status:42:closed",
    );
    expect(redis.exists).toHaveBeenCalledWith("hive:v1:lock:queen-tick:42");
    // Belt-and-suspenders: confirm zrange was never reached.
    expect((redis as unknown as { zrange?: unknown }).zrange).toBeUndefined();
  });
});
