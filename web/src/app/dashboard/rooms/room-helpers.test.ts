import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  countRoomsByFilter,
  isActiveStatus,
  isRoomStuck,
  participantStatusCounts,
  relativeTime,
  relevantDeadlineSecs,
  roomMatchesFilter,
  sortRoomsByStuckness,
  statusLabel,
  statusPillClass,
  STUCK_THRESHOLD,
  stucknessRatio,
  subjectGithubUrl,
  subjectLabel,
} from "./room-helpers";
import type { RoomCoreWithId, RoomParticipant, RoomStatus } from "./types";

describe("statusLabel", () => {
  it.each([
    ["awaiting_contributions", "Awaiting contributions"],
    ["deciding", "Synthesizing"],
    ["closed", "Closed"],
    ["expired", "Expired"],
  ] as const)("%s → %s", (status, expected) => {
    expect(statusLabel(status)).toBe(expected);
  });
});

describe("statusPillClass", () => {
  it("returns class strings for every known status", () => {
    for (const s of [
      "awaiting_contributions",
      "deciding",
      "closed",
      "expired",
    ] as const) {
      expect(statusPillClass(s).length).toBeGreaterThan(0);
    }
  });
});

describe("subjectLabel", () => {
  it.each([
    ["pr_review", "PR review"],
    ["mention_response", "Mention"],
    ["issue_triage", "Issue triage"],
  ] as const)("%s → %s", (type, expected) => {
    expect(subjectLabel(type)).toBe(expected);
  });
});

describe("subjectGithubUrl", () => {
  it("builds a URL from owner/repo#N", () => {
    expect(subjectGithubUrl("hivemoot/hivemoot#42")).toBe(
      "https://github.com/hivemoot/hivemoot/issues/42",
    );
  });

  it("supports owner/repo with hyphens + dots + underscores", () => {
    expect(subjectGithubUrl("my-org/my.repo_test#1")).toBe(
      "https://github.com/my-org/my.repo_test/issues/1",
    );
  });

  it("returns null for malformed refs", () => {
    expect(subjectGithubUrl("not-a-ref")).toBeNull();
    expect(subjectGithubUrl("owner/repo")).toBeNull();
    expect(subjectGithubUrl("owner/repo#")).toBeNull();
    expect(subjectGithubUrl("owner/repo#0")).toBeNull(); // no leading zero / zero
  });
});

describe("participantStatusCounts", () => {
  function p(status: RoomParticipant["status"]): RoomParticipant {
    return {
      agent_id: "x",
      role: "x",
      status,
      rsvp_at: "2026-04-28T20:00:00Z",
    };
  }

  it("returns all-zeros for empty hash", () => {
    expect(participantStatusCounts({})).toEqual({
      pending: 0,
      resolved: 0,
      withdrew: 0,
      timed_out: 0,
      total: 0,
    });
  });

  it("counts by status", () => {
    expect(
      participantStatusCounts({
        guard: p("resolved"),
        builder: p("pending"),
        drone: p("withdrew"),
        scout: p("timed_out"),
        nurse: p("resolved"),
      }),
    ).toEqual({
      pending: 1,
      resolved: 2,
      withdrew: 1,
      timed_out: 1,
      total: 5,
    });
  });
});

describe("relativeTime", () => {
  const NOW = Date.parse("2026-04-28T12:00:00Z");

  it.each([
    ["just now (< 5s)", "2026-04-28T11:59:58Z", "just now"],
    ["seconds (5-59)", "2026-04-28T11:59:30Z", "30s ago"],
    ["minutes (1-59)", "2026-04-28T11:30:00Z", "30m ago"],
    ["hours (1-23)", "2026-04-28T08:00:00Z", "4h ago"],
    ["days (1-6)", "2026-04-26T12:00:00Z", "2d ago"],
    ["7+ days → absolute date", "2026-04-15T12:00:00Z", "2026-04-15"],
  ])("%s", (_label, iso, expected) => {
    expect(relativeTime(iso, NOW)).toBe(expected);
  });

  it("returns input unchanged on unparseable timestamp", () => {
    expect(relativeTime("not-a-date", NOW)).toBe("not-a-date");
  });

  it("clamps negative deltas (future timestamp) to 'just now'", () => {
    expect(relativeTime("2026-04-28T13:00:00Z", NOW)).toBe("just now");
  });
});

// ---------------------------------------------------------------------------
// Stuckness — closes #553 builder R1 (WAR_ROOM_DESIGN.md L1247-1248)
// ---------------------------------------------------------------------------

describe("isActiveStatus + ACTIVE_STATUSES", () => {
  it.each(["awaiting_contributions", "deciding"] as const)(
    "%s is active",
    (s) => {
      expect(isActiveStatus(s)).toBe(true);
      expect(ACTIVE_STATUSES.has(s)).toBe(true);
    },
  );
  it.each(["closed", "expired"] as const)("%s is NOT active", (s) => {
    expect(isActiveStatus(s)).toBe(false);
    expect(ACTIVE_STATUSES.has(s)).toBe(false);
  });
});

describe("relevantDeadlineSecs", () => {
  it("awaiting_contributions uses quiet_period_secs", () => {
    expect(
      relevantDeadlineSecs("awaiting_contributions", {
        quiet_period_secs: 1200,
        drop_threshold_secs: 600,
      }),
    ).toBe(1200);
  });

  it("deciding uses quiet_period_secs", () => {
    expect(
      relevantDeadlineSecs("deciding", {
        quiet_period_secs: 1200,
        drop_threshold_secs: 600,
      }),
    ).toBe(1200);
  });

  it("returns null for terminal statuses", () => {
    expect(
      relevantDeadlineSecs("closed", { quiet_period_secs: 600 }),
    ).toBeNull();
    expect(
      relevantDeadlineSecs("expired", { quiet_period_secs: 600 }),
    ).toBeNull();
  });

  it("returns null when timing_config is undefined", () => {
    expect(relevantDeadlineSecs("awaiting_contributions", undefined)).toBeNull();
  });
});

describe("stucknessRatio", () => {
  const NOW = Date.parse("2026-04-28T12:00:00Z");

  it("0 for terminal rooms", () => {
    expect(
      stucknessRatio(
        "2026-04-28T11:00:00Z",
        "closed",
        { quiet_period_secs: 1200 },
        NOW,
      ),
    ).toBe(0);
  });

  it("0 when timing_config missing", () => {
    expect(
      stucknessRatio("2026-04-28T11:00:00Z", "awaiting_contributions", undefined, NOW),
    ).toBe(0);
  });

  it("0 when relevant deadline is 0 or negative (defensive)", () => {
    expect(
      stucknessRatio(
        "2026-04-28T11:00:00Z",
        "awaiting_contributions",
        { quiet_period_secs: 0 },
        NOW,
      ),
    ).toBe(0);
  });

  it("computes ratio as (now - opened) / deadline_secs", () => {
    // 30 minutes elapsed, deadline=3600s (1h) → ratio=0.5
    expect(
      stucknessRatio(
        "2026-04-28T11:30:00Z",
        "awaiting_contributions",
        { quiet_period_secs: 3600 },
        NOW,
      ),
    ).toBeCloseTo(0.5);
  });

  it("returns >1 when past deadline", () => {
    expect(
      stucknessRatio(
        "2026-04-28T10:00:00Z",
        "awaiting_contributions",
        { quiet_period_secs: 600 }, // 10m deadline, 2h elapsed
        NOW,
      ),
    ).toBeCloseTo(12);
  });

  it("0 on unparseable opened_at (defensive)", () => {
    expect(
      stucknessRatio(
        "not-a-date",
        "awaiting_contributions",
        { quiet_period_secs: 600 },
        NOW,
      ),
    ).toBe(0);
  });
});

describe("isRoomStuck", () => {
  const NOW = Date.parse("2026-04-28T12:00:00Z");

  it("STUCK_THRESHOLD is 0.8 per WAR_ROOM_DESIGN.md L1248", () => {
    expect(STUCK_THRESHOLD).toBe(0.8);
  });

  it("true when ratio >= 0.8", () => {
    // 8m elapsed of 10m deadline = 0.8
    expect(
      isRoomStuck(
        "2026-04-28T11:52:00Z",
        "awaiting_contributions",
        { quiet_period_secs: 600 },
        NOW,
      ),
    ).toBe(true);
  });

  it("false when ratio < 0.8", () => {
    // 7m elapsed of 10m deadline = 0.7
    expect(
      isRoomStuck(
        "2026-04-28T11:53:00Z",
        "awaiting_contributions",
        { quiet_period_secs: 600 },
        NOW,
      ),
    ).toBe(false);
  });

  it("false for terminal rooms regardless of age", () => {
    expect(
      isRoomStuck(
        "2026-01-01T00:00:00Z", // ancient
        "closed",
        { quiet_period_secs: 600 },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("sortRoomsByStuckness", () => {
  const NOW = Date.parse("2026-04-28T12:00:00Z");

  function r(
    id: string,
    status:
      | "awaiting_contributions"
      | "deciding"
      | "closed"
      | "expired",
    opened_at: string,
    quietPeriod = 1200,
    dropThreshold = 600,
  ): RoomCoreWithId {
    return {
      roomId: id,
      manager: "x",
      subject_type: "pr_review",
      subject_ref: `o/r#${id.length}`,
      status,
      opened_at,
      timing_config: {
        quiet_period_secs: quietPeriod,
        drop_threshold_secs: dropThreshold,
      },
    };
  }

  it("active rooms before terminal rooms", () => {
    const sorted = sortRoomsByStuckness(
      [
        r("a", "closed", "2026-04-28T11:59:00Z"),
        r("b", "awaiting_contributions", "2026-04-28T11:55:00Z"),
        r("c", "expired", "2026-04-28T11:50:00Z"),
        r("d", "deciding", "2026-04-28T11:30:00Z"),
      ],
      NOW,
    );
    // First two should be the active rooms.
    expect(sorted.slice(0, 2).map((r) => r.roomId).sort()).toEqual(["b", "d"]);
    // Last two terminal.
    expect(sorted.slice(2).map((r) => r.roomId).sort()).toEqual(["a", "c"]);
  });

  it("active rooms sorted by stuckness DESC (most-stuck first)", () => {
    const sorted = sortRoomsByStuckness(
      [
        r("low", "awaiting_contributions", "2026-04-28T11:58:00Z"), // 2m / 10m = 0.2
        r("high", "awaiting_contributions", "2026-04-28T11:51:00Z"), // 9m / 10m = 0.9
        r("mid", "awaiting_contributions", "2026-04-28T11:54:00Z"), // 6m / 10m = 0.6
      ],
      NOW,
    );
    expect(sorted.map((r) => r.roomId)).toEqual(["high", "mid", "low"]);
  });

  it("terminal rooms sorted by opened_at DESC (most-recent first)", () => {
    const sorted = sortRoomsByStuckness(
      [
        r("old", "closed", "2026-04-28T10:00:00Z"),
        r("new", "closed", "2026-04-28T11:30:00Z"),
        r("mid", "expired", "2026-04-28T11:00:00Z"),
      ],
      NOW,
    );
    expect(sorted.map((r) => r.roomId)).toEqual(["new", "mid", "old"]);
  });

  it("ties between active rooms with no deadline configured fall back to opened_at ASC", () => {
    const noTimingA: RoomCoreWithId = {
      roomId: "a",
      manager: "x",
      subject_type: "pr_review",
      subject_ref: "o/r#1",
      status: "awaiting_contributions",
      opened_at: "2026-04-28T11:00:00Z",
      // no timing_config
    };
    const noTimingB: RoomCoreWithId = {
      ...noTimingA,
      roomId: "b",
      opened_at: "2026-04-28T11:30:00Z",
    };
    const sorted = sortRoomsByStuckness([noTimingB, noTimingA], NOW);
    // Without deadline both have stuckness 0; sorted by opened_at ASC
    // (oldest first) so 'a' comes before 'b'.
    expect(sorted.map((r) => r.roomId)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const original = [
      r("a", "closed", "2026-04-28T11:59:00Z"),
      r("b", "awaiting_contributions", "2026-04-28T11:55:00Z"),
    ];
    const beforeIds = original.map((r) => r.roomId);
    sortRoomsByStuckness(original, NOW);
    expect(original.map((r) => r.roomId)).toEqual(beforeIds);
  });
});

describe("roomMatchesFilter", () => {
  const r = (status: RoomStatus) => ({ status });

  it("'all' matches every status", () => {
    for (const s of [
      "awaiting_contributions",
      "deciding",
      "closed",
      "expired",
    ] as const) {
      expect(roomMatchesFilter(r(s), "all")).toBe(true);
    }
  });

  it("'active' matches only awaiting_contributions and deciding", () => {
    expect(roomMatchesFilter(r("awaiting_contributions"), "active")).toBe(true);
    expect(roomMatchesFilter(r("deciding"), "active")).toBe(true);
    expect(roomMatchesFilter(r("closed"), "active")).toBe(false);
    expect(roomMatchesFilter(r("expired"), "active")).toBe(false);
  });

  it("'closed' matches only the closed status (not expired)", () => {
    expect(roomMatchesFilter(r("closed"), "closed")).toBe(true);
    expect(roomMatchesFilter(r("expired"), "closed")).toBe(false);
    expect(roomMatchesFilter(r("awaiting_contributions"), "closed")).toBe(false);
  });

  it("'expired' matches only the expired status", () => {
    expect(roomMatchesFilter(r("expired"), "expired")).toBe(true);
    expect(roomMatchesFilter(r("closed"), "expired")).toBe(false);
    expect(roomMatchesFilter(r("deciding"), "expired")).toBe(false);
  });
});

describe("countRoomsByFilter", () => {
  const r = (status: RoomStatus) => ({ status });

  it("returns all-zero counts for an empty list", () => {
    expect(countRoomsByFilter([])).toEqual({
      all: 0,
      active: 0,
      closed: 0,
      expired: 0,
    });
  });

  it("counts each filter bucket independently", () => {
    const counts = countRoomsByFilter([
      r("awaiting_contributions"),
      r("awaiting_contributions"),
      r("deciding"),
      r("closed"),
      r("closed"),
      r("closed"),
      r("expired"),
    ]);
    expect(counts).toEqual({
      all: 7,
      active: 3,    // awaiting_contributions × 2 + deciding
      closed: 3,
      expired: 1,
    });
  });

  it("active + closed + expired sums to all (no double-counting)", () => {
    const rooms = [
      r("awaiting_contributions"),
      r("deciding"),
      r("closed"),
      r("expired"),
    ];
    const counts = countRoomsByFilter(rooms);
    expect(counts.active + counts.closed + counts.expired).toBe(counts.all);
  });
});
