import { describe, it, expect, vi } from "vitest";
import {
  QUEEN_OBSERVER_THRESHOLDS,
  runQueenObserverPass,
} from "./observer.js";
import type { RoomCoreWithId } from "@hivemoot/war-room";

function makeRoom(overrides: Partial<RoomCoreWithId>): RoomCoreWithId {
  return {
    roomId: "rm-1",
    manager: "bot-queen",
    subject_type: "pr_review",
    subject_ref: "owner/repo#1",
    opened_at: "2026-05-08T00:00:00Z",
    status: "awaiting_contributions",
    timing_config: {
      max_age_secs: 86400,
      drop_threshold_secs: 600,
      quiet_period_secs: 60,
    },
    last_transition_at: "2026-05-08T00:00:00Z",
    last_post_close_drift_count: 0,
    ...overrides,
  } as unknown as RoomCoreWithId;
}

describe("runQueenObserverPass", () => {
  it("returns zeros when no rooms exist", () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const result = runQueenObserverPass({
      installationId: "42",
      rooms: [],
      log,
    });
    expect(result.totalOpen).toBe(0);
    expect(result.stuckWarn).toBe(0);
    expect(result.stuckAlarm).toBe(0);
    expect(result.oldestOpenedAtMs).toBeNull();
    // info is always emitted (heartbeat cadence)
    expect(log.info).toHaveBeenCalledWith(
      "queen.observer.stuck_rooms",
      expect.objectContaining({ totalOpen: 0 }),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("counts awaiting_contributions rooms past warn threshold", () => {
    const nowMs = Date.parse("2026-05-08T00:10:00Z");
    const rooms = [
      makeRoom({ roomId: "rm-fresh", opened_at: "2026-05-08T00:09:00Z" }), // 1 min
      makeRoom({ roomId: "rm-warn", opened_at: "2026-05-08T00:04:00Z" }), // 6 min
      makeRoom({ roomId: "rm-also-warn", opened_at: "2026-05-08T00:02:00Z" }), // 8 min
    ];
    const result = runQueenObserverPass({ installationId: "42", rooms, nowMs });
    expect(result.totalOpen).toBe(3);
    expect(result.stuckWarn).toBe(2);
    expect(result.stuckAlarm).toBe(0);
  });

  it("counts past alarm threshold AND warn (alarm is a subset of warn)", () => {
    const nowMs = Date.parse("2026-05-08T00:30:00Z");
    const rooms = [
      makeRoom({ roomId: "rm-alarm", opened_at: "2026-05-08T00:10:00Z" }), // 20 min
    ];
    const result = runQueenObserverPass({ installationId: "42", rooms, nowMs });
    expect(result.stuckWarn).toBe(1);
    expect(result.stuckAlarm).toBe(1);
  });

  it("escalates to warn-level log when alarm count > 0", () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const nowMs = Date.parse("2026-05-08T00:30:00Z");
    runQueenObserverPass({
      installationId: "42",
      rooms: [makeRoom({ opened_at: "2026-05-08T00:10:00Z" })],
      nowMs,
      log,
    });
    expect(log.warn).toHaveBeenCalledWith(
      "queen.observer.stuck_rooms_alarm",
      expect.objectContaining({ stuckAlarm: 1 }),
    );
  });

  it("does not emit warn-level log when only warn-threshold breached", () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const nowMs = Date.parse("2026-05-08T00:10:00Z");
    runQueenObserverPass({
      installationId: "42",
      rooms: [makeRoom({ opened_at: "2026-05-08T00:04:00Z" })], // 6 min
      nowMs,
      log,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("ignores rooms outside open statuses", () => {
    const nowMs = Date.parse("2026-05-08T00:30:00Z");
    const rooms = [
      makeRoom({ status: "closed", opened_at: "2026-05-08T00:00:00Z" }),
      makeRoom({ status: "expired", opened_at: "2026-05-08T00:00:00Z" }),
    ];
    const result = runQueenObserverPass({ installationId: "42", rooms, nowMs });
    expect(result.totalOpen).toBe(0);
  });

  it("counts deciding rooms toward totalOpen but not stuck-room metric", () => {
    const nowMs = Date.parse("2026-05-08T00:30:00Z");
    const rooms = [
      makeRoom({ status: "deciding", opened_at: "2026-05-08T00:05:00Z" }),
    ];
    const result = runQueenObserverPass({ installationId: "42", rooms, nowMs });
    expect(result.totalOpen).toBe(1);
    expect(result.stuckWarn).toBe(0);
    expect(result.stuckAlarm).toBe(0);
  });

  it("returns oldest opened_at across all awaiting_contributions rooms", () => {
    const rooms = [
      makeRoom({ opened_at: "2026-05-08T00:10:00Z" }),
      makeRoom({ opened_at: "2026-05-08T00:00:00Z" }), // oldest
      makeRoom({ opened_at: "2026-05-08T00:05:00Z" }),
    ];
    const result = runQueenObserverPass({
      installationId: "42",
      rooms,
      nowMs: Date.parse("2026-05-08T00:30:00Z"),
    });
    expect(result.oldestOpenedAtMs).toBe(Date.parse("2026-05-08T00:00:00Z"));
  });

  it("uses G5 thresholds: warn at 5min, alarm at 15min", () => {
    expect(QUEEN_OBSERVER_THRESHOLDS.warnMs).toBe(5 * 60 * 1000);
    expect(QUEEN_OBSERVER_THRESHOLDS.alarmMs).toBe(15 * 60 * 1000);
  });

  it("never reports claimed/postsSucceeded > 0 (observer is read-only by design)", () => {
    const result = runQueenObserverPass({
      installationId: "42",
      rooms: [makeRoom({})],
    });
    expect(result.claimed).toBe(0);
    expect(result.postsSucceeded).toBe(0);
  });

  it("handles malformed opened_at gracefully (skips, no NaN escape)", () => {
    const rooms = [
      makeRoom({ opened_at: "not-a-date" }),
    ];
    const result = runQueenObserverPass({
      installationId: "42",
      rooms,
      nowMs: Date.parse("2026-05-08T00:30:00Z"),
    });
    expect(result.totalOpen).toBe(1); // counted as open
    expect(result.stuckWarn).toBe(0); // but not as stuck (date unparseable)
  });
});
