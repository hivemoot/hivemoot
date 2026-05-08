import { describe, it, expect, vi, beforeEach } from "vitest";
import { type Redis } from "@upstash/redis";

vi.mock("@hivemoot/war-room", async () => {
  const real = await vi.importActual<typeof import("@hivemoot/war-room")>(
    "@hivemoot/war-room",
  );
  return { ...real, listRooms: vi.fn() };
});

import { listRooms } from "@hivemoot/war-room";
import { checkInFlightForFlip } from "./queen-mode-flip-precheck";

const mockedList = vi.mocked(listRooms);

function room(roomId: string, status: string, opened_at = "2026-05-08T00:00:00Z") {
  return {
    roomId,
    manager: "bot-queen",
    subject_type: "pr_review",
    subject_ref: "owner/repo#1",
    opened_at,
    status,
    timing_config: {
      max_age_secs: 86400,
      drop_threshold_secs: 600,
      quiet_period_secs: 60,
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkInFlightForFlip", () => {
  it("returns null when no rooms exist", async () => {
    mockedList.mockResolvedValue([]);
    const result = await checkInFlightForFlip({
      installationId: "42",
      redis: {} as Redis,
    });
    expect(result).toBeNull();
  });

  it("returns null when all rooms are closed/expired (none in flight)", async () => {
    mockedList.mockResolvedValue([
      room("rm-1", "closed"),
      room("rm-2", "expired"),
      room("rm-3", "awaiting_contributions"),
    ]);
    const result = await checkInFlightForFlip({
      installationId: "42",
      redis: {} as Redis,
    });
    expect(result).toBeNull();
  });

  it("blocks when at least one room is in deciding", async () => {
    mockedList.mockResolvedValue([
      room("rm-1", "awaiting_contributions"),
      room("rm-2", "deciding"),
    ]);
    const result = await checkInFlightForFlip({
      installationId: "42",
      redis: {} as Redis,
    });
    expect(result).not.toBeNull();
    expect(result?.blocked.reason).toBe("rooms_in_flight");
    expect(result?.blocked.counts.deciding).toBe(1);
    expect(result?.blocked.counts.decided_pending_action).toBe(0);
    expect(result?.blocked.counts.stranded_merge).toBe(0);
    expect(result?.blocked.sampleRoomIds).toEqual(["rm-2"]);
  });

  it("counts multiple deciding rooms correctly", async () => {
    mockedList.mockResolvedValue([
      room("rm-a", "deciding"),
      room("rm-b", "deciding"),
      room("rm-c", "deciding"),
    ]);
    const result = await checkInFlightForFlip({
      installationId: "42",
      redis: {} as Redis,
    });
    expect(result?.blocked.counts.deciding).toBe(3);
    expect(result?.blocked.sampleRoomIds).toEqual(["rm-a", "rm-b", "rm-c"]);
  });

  it("caps sampleRoomIds at 5", async () => {
    mockedList.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => room(`rm-${i}`, "deciding")),
    );
    const result = await checkInFlightForFlip({
      installationId: "42",
      redis: {} as Redis,
    });
    expect(result?.blocked.sampleRoomIds).toHaveLength(5);
    expect(result?.blocked.counts.deciding).toBe(8);
  });

  it("propagates listRooms errors (caller surfaces 500)", async () => {
    mockedList.mockRejectedValue(new Error("redis down"));
    await expect(
      checkInFlightForFlip({ installationId: "42", redis: {} as Redis }),
    ).rejects.toThrow(/redis down/);
  });
});
