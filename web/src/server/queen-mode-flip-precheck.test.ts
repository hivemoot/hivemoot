import { describe, it, expect, vi, beforeEach } from "vitest";
import { type Redis } from "@upstash/redis";
import { checkInFlightForFlip } from "./queen-mode-flip-precheck";

// ---------------------------------------------------------------------------
// Mock Redis with zrange + exists. The precheck does parallel reads:
//   ZRANGE deciding-status-index 0 -1
//   EXISTS queen-tick-lock-key
// No listRooms anymore (guard pass-1 G1 fix).
// ---------------------------------------------------------------------------

interface MockState {
  decidingIds: string[];
  tickLockHeld: boolean;
  errorOnZrange?: Error;
  errorOnExists?: Error;
}

function makeMockRedis(state: MockState): Redis {
  return {
    zrange: vi.fn(async () => {
      if (state.errorOnZrange) throw state.errorOnZrange;
      return state.decidingIds;
    }),
    exists: vi.fn(async () => {
      if (state.errorOnExists) throw state.errorOnExists;
      return state.tickLockHeld ? 1 : 0;
    }),
  } as unknown as Redis;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkInFlightForFlip", () => {
  it("returns null when no deciding rooms AND no tick lock held", async () => {
    const redis = makeMockRedis({ decidingIds: [], tickLockHeld: false });
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
    // rooms, the deciding-status sorted set only contains deciding
    // rooms — the precheck sees them all.
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
      decidingIds: [],
      tickLockHeld: false,
      errorOnZrange: new Error("redis down"),
    });
    await expect(
      checkInFlightForFlip({ installationId: "42", redis }),
    ).rejects.toThrow(/redis down/);
  });

  it("uses the right keys (status-index for deciding, tick-lock for installation)", async () => {
    const redis = makeMockRedis({ decidingIds: [], tickLockHeld: false });
    await checkInFlightForFlip({ installationId: "42", redis });
    expect(redis.zrange).toHaveBeenCalledWith(
      "hive:v1:idx:room:status:42:deciding",
      0,
      -1,
    );
    expect(redis.exists).toHaveBeenCalledWith("hive:v1:lock:queen-tick:42");
  });
});
