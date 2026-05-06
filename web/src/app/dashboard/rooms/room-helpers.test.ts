import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  countRoomsByFilter,
  extractDecisionVerdict,
  hasDiffDriftedPostVerdict,
  heartbeatFreshnessDotClass,
  heartbeatFreshnessTitle,
  isActiveStatus,
  isRoomStuck,
  participantHeartbeatFreshness,
  participantStatusCounts,
  relativeTime,
  relevantDeadlineSecs,
  roomMatchesFilter,
  roomMatchesSubjectQuery,
  sortRoomsByStuckness,
  statusLabel,
  statusPillClass,
  STUCK_THRESHOLD,
  stucknessRatio,
  subjectGithubUrl,
  subjectLabel,
  timeUntilDeadline,
  verdictPillClass,
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
  it("awaiting_contributions uses max_age_secs (room expiration)", () => {
    expect(
      relevantDeadlineSecs("awaiting_contributions", {
        max_age_secs: 3600,
        quiet_period_secs: 180,
        drop_threshold_secs: 1200,
      }),
    ).toBe(3600);
  });

  it("deciding uses max_age_secs", () => {
    expect(
      relevantDeadlineSecs("deciding", {
        max_age_secs: 3600,
        quiet_period_secs: 180,
      }),
    ).toBe(3600);
  });

  it("returns null for terminal statuses", () => {
    expect(
      relevantDeadlineSecs("closed", { max_age_secs: 3600 }),
    ).toBeNull();
    expect(
      relevantDeadlineSecs("expired", { max_age_secs: 3600 }),
    ).toBeNull();
  });

  it("returns null when timing_config is undefined", () => {
    expect(relevantDeadlineSecs("awaiting_contributions", undefined)).toBeNull();
  });

  it("returns null when max_age_secs is missing (older rooms / fixtures)", () => {
    // quiet_period_secs alone is NOT a fallback — it's the gate
    // before claim, not the room expiration.  Stuckness is anchored
    // to the actual expiration deadline only.
    expect(
      relevantDeadlineSecs("awaiting_contributions", {
        quiet_period_secs: 180,
      }),
    ).toBeNull();
  });
});

describe("stucknessRatio", () => {
  const NOW = Date.parse("2026-04-28T12:00:00Z");

  it("0 for terminal rooms", () => {
    expect(
      stucknessRatio(
        "2026-04-28T11:00:00Z",
        "closed",
        { max_age_secs: 3600 },
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
        { max_age_secs: 0 },
        NOW,
      ),
    ).toBe(0);
  });

  it("computes ratio as (now - opened) / max_age_secs", () => {
    // 30 minutes elapsed, max_age=3600s (1h) → ratio=0.5
    expect(
      stucknessRatio(
        "2026-04-28T11:30:00Z",
        "awaiting_contributions",
        { max_age_secs: 3600 },
        NOW,
      ),
    ).toBeCloseTo(0.5);
  });

  it("returns >1 when past max_age (overdue for expiration)", () => {
    expect(
      stucknessRatio(
        "2026-04-28T10:00:00Z",
        "awaiting_contributions",
        { max_age_secs: 600 }, // 10m max_age, 2h elapsed
        NOW,
      ),
    ).toBeCloseTo(12);
  });

  it("0 on unparseable opened_at (defensive)", () => {
    expect(
      stucknessRatio(
        "not-a-date",
        "awaiting_contributions",
        { max_age_secs: 3600 },
        NOW,
      ),
    ).toBe(0);
  });

  it("a fresh room with default 1h max_age + 180s quiet_period is NOT stuck", () => {
    // Regression case for the previous bug where stuckness was
    // computed against quiet_period_secs (180s).  A 4-min-old room
    // mid-triage would have rated 4*60/180 = 1.33 → flagged as stuck.
    // Anchored to max_age_secs (3600), it's 0.067 → not stuck.
    expect(
      stucknessRatio(
        "2026-04-28T11:56:00Z", // 4 minutes old
        "awaiting_contributions",
        { max_age_secs: 3600, quiet_period_secs: 180 },
        NOW,
      ),
    ).toBeCloseTo(0.067, 2);
  });
});

describe("isRoomStuck", () => {
  const NOW = Date.parse("2026-04-28T12:00:00Z");

  it("STUCK_THRESHOLD is 0.8 per WAR_ROOM_DESIGN.md L1248", () => {
    expect(STUCK_THRESHOLD).toBe(0.8);
  });

  it("true when ratio >= 0.8", () => {
    // 8m elapsed of 10m max_age = 0.8
    expect(
      isRoomStuck(
        "2026-04-28T11:52:00Z",
        "awaiting_contributions",
        { max_age_secs: 600 },
        NOW,
      ),
    ).toBe(true);
  });

  it("false when ratio < 0.8", () => {
    // 7m elapsed of 10m max_age = 0.7
    expect(
      isRoomStuck(
        "2026-04-28T11:53:00Z",
        "awaiting_contributions",
        { max_age_secs: 600 },
        NOW,
      ),
    ).toBe(false);
  });

  it("false for terminal rooms regardless of age", () => {
    expect(
      isRoomStuck(
        "2026-01-01T00:00:00Z", // ancient
        "closed",
        { max_age_secs: 3600 },
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
    maxAge = 600,
    quietPeriod = 180,
  ): RoomCoreWithId {
    return {
      roomId: id,
      manager: "x",
      subject_type: "pr_review",
      subject_ref: `o/r#${id.length}`,
      status,
      opened_at,
      timing_config: {
        max_age_secs: maxAge,
        quiet_period_secs: quietPeriod,
        drop_threshold_secs: 1200,
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

describe("roomMatchesSubjectQuery", () => {
  const r = (subject_ref: string) => ({ subject_ref });

  it("empty query matches every room", () => {
    expect(roomMatchesSubjectQuery(r("hivemoot/hivemoot#42"), "")).toBe(true);
    expect(roomMatchesSubjectQuery(r("any/repo#1"), "")).toBe(true);
  });

  it("whitespace-only query matches every room", () => {
    expect(roomMatchesSubjectQuery(r("hivemoot/hivemoot#42"), "   ")).toBe(true);
    expect(roomMatchesSubjectQuery(r("hivemoot/hivemoot#42"), "\t\n")).toBe(true);
  });

  it("substring match against subject_ref", () => {
    expect(roomMatchesSubjectQuery(r("hivemoot/hivemoot#42"), "hivemoot")).toBe(true);
    expect(roomMatchesSubjectQuery(r("hivemoot/hivemoot#42"), "#42")).toBe(true);
    expect(roomMatchesSubjectQuery(r("hivemoot/hivemoot#42"), "42")).toBe(true);
    expect(roomMatchesSubjectQuery(r("hivemoot/hivemoot#42"), "/hivemoot#")).toBe(true);
  });

  it("case-insensitive on both sides", () => {
    expect(roomMatchesSubjectQuery(r("hivemoot/hivemoot#42"), "HIVEMOOT")).toBe(true);
    expect(roomMatchesSubjectQuery(r("HiveMoot/Hivemoot#42"), "hivemoot")).toBe(true);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(roomMatchesSubjectQuery(r("owner/repo#7"), "  repo#7  ")).toBe(true);
  });

  it("returns false on no match", () => {
    expect(roomMatchesSubjectQuery(r("owner/repo#1"), "999")).toBe(false);
    expect(roomMatchesSubjectQuery(r("owner/repo#1"), "different")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasDiffDriftedPostVerdict — closes hivemoot/hivemoot#605 (Option A)
// ---------------------------------------------------------------------------

describe("hasDiffDriftedPostVerdict", () => {
  const ATTEMPTED = "2026-05-03T10:00:00.000Z";

  it("true for closed room with drift marker set", () => {
    expect(
      hasDiffDriftedPostVerdict({
        status: "closed",
        last_post_close_drift_at: ATTEMPTED,
      }),
    ).toBe(true);
  });

  it("false for closed room without drift marker", () => {
    expect(
      hasDiffDriftedPostVerdict({
        status: "closed",
      }),
    ).toBe(false);
  });

  it("false for closed room with empty-string drift marker (treat as cleared)", () => {
    // Defensive: HSET stores nothing as `""` rather than DELing — same
    // sentinel pattern as `deciding_through_sequence`. The badge
    // shouldn't render for a cleared marker.
    expect(
      hasDiffDriftedPostVerdict({
        status: "closed",
        last_post_close_drift_at: "",
      }),
    ).toBe(false);
  });

  it.each([
    ["awaiting_contributions"],
    ["deciding"],
    ["expired"],
  ] as const)(
    "false for non-closed status %s even when drift marker is set",
    (status) => {
      expect(
        hasDiffDriftedPostVerdict({
          status,
          last_post_close_drift_at: ATTEMPTED,
        }),
      ).toBe(false);
    },
  );
});

// ── participantHeartbeatFreshness (PR E of the
//    JOB_LIFECYCLE_UNIFICATION RFC) ──────────────────────────────────

describe("participantHeartbeatFreshness", () => {
  // Anchor: pretend it's exactly noon UTC so the boundary tests
  // produce stable, readable timestamps. The function is pure on
  // (rsvp_at, status, nowMs) so tests don't need time mocking.
  const NOW = Date.parse("2026-05-06T12:00:00.000Z");

  function rsvpAt(secondsAgo: number): string {
    return new Date(NOW - secondsAgo * 1000).toISOString();
  }

  it("returns inactive for any non-pending status", () => {
    // Resolved / withdrew / timed_out: heartbeats no longer fire
    // and rsvp_at is frozen — no liveness signal to derive.
    for (const status of ["resolved", "withdrew", "timed_out"]) {
      expect(
        participantHeartbeatFreshness(
          { status, rsvp_at: rsvpAt(1) },
          NOW,
        ),
      ).toBe("inactive");
    }
  });

  it("returns fresh for pending participant within 90s", () => {
    // 45s is the default heartbeat interval; just-bumped is fresh.
    expect(
      participantHeartbeatFreshness(
        { status: "pending", rsvp_at: rsvpAt(10) },
        NOW,
      ),
    ).toBe("fresh");
    // Right under the 90s threshold.
    expect(
      participantHeartbeatFreshness(
        { status: "pending", rsvp_at: rsvpAt(89) },
        NOW,
      ),
    ).toBe("fresh");
  });

  it("returns stale at the 90s boundary", () => {
    // 90s is "missed at most one heartbeat" — flips to stale.
    expect(
      participantHeartbeatFreshness(
        { status: "pending", rsvp_at: rsvpAt(90) },
        NOW,
      ),
    ).toBe("stale");
    // Right under the 5min dead threshold.
    expect(
      participantHeartbeatFreshness(
        { status: "pending", rsvp_at: rsvpAt(299) },
        NOW,
      ),
    ).toBe("stale");
  });

  it("returns dead at and beyond the 5min boundary", () => {
    // 5min: several missed heartbeats. The watchdog times out
    // around this window too; the dot turning red is meant to
    // pre-warn an operator before the slot itself goes terminal.
    expect(
      participantHeartbeatFreshness(
        { status: "pending", rsvp_at: rsvpAt(300) },
        NOW,
      ),
    ).toBe("dead");
    expect(
      participantHeartbeatFreshness(
        { status: "pending", rsvp_at: rsvpAt(3600) },
        NOW,
      ),
    ).toBe("dead");
  });

  it("returns dead for unparseable rsvp_at on a pending participant", () => {
    // Defensive: malformed timestamps shouldn't render as
    // "fresh" by accident. Surface as dead so an operator
    // notices the data corruption.
    expect(
      participantHeartbeatFreshness(
        { status: "pending", rsvp_at: "not-a-date" },
        NOW,
      ),
    ).toBe("dead");
  });
});

describe("heartbeatFreshnessDotClass", () => {
  it("returns a distinct Tailwind color class per freshness level", () => {
    // The dot is the at-a-glance liveness signal — the four levels
    // must map to four visually distinct colors. Exact classes
    // pinned so a Tailwind upgrade or a typo can't silently fall
    // through to a default.
    expect(heartbeatFreshnessDotClass("fresh")).toBe("bg-emerald-400");
    expect(heartbeatFreshnessDotClass("stale")).toBe("bg-amber-400");
    expect(heartbeatFreshnessDotClass("dead")).toBe("bg-rose-500");
    expect(heartbeatFreshnessDotClass("inactive")).toBe("bg-zinc-600");
  });
});

describe("heartbeatFreshnessTitle", () => {
  it("returns a non-empty actionable description for each level", () => {
    // The title attribute is the operator's tooltip. Empty
    // strings would render no tooltip at all — pin that every
    // level has user-facing text.
    for (const level of ["fresh", "stale", "dead", "inactive"] as const) {
      const title = heartbeatFreshnessTitle(level);
      expect(title.length).toBeGreaterThan(10);
      // Sanity: each tooltip references the underlying mechanism
      // ("heartbeat" or non-pending status) so the operator
      // understands WHY the dot is that color.
      expect(title.toLowerCase()).toMatch(/heartbeat|pending/);
    }
  });
});


// ── timeUntilDeadline + extractDecisionVerdict + verdictPillClass
//    (rooms-list richer signals) ─────────────────────────────────────

describe("timeUntilDeadline", () => {
  const NOW = Date.parse("2026-04-28T12:00:00Z");

  it("returns null for terminal statuses", () => {
    expect(
      timeUntilDeadline("2026-04-28T11:00:00Z", "closed",
        { max_age_secs: 3600 }, NOW),
    ).toBeNull();
    expect(
      timeUntilDeadline("2026-04-28T11:00:00Z", "expired",
        { max_age_secs: 3600 }, NOW),
    ).toBeNull();
  });

  it("returns null when timing_config is missing or has no max_age", () => {
    expect(
      timeUntilDeadline("2026-04-28T11:00:00Z",
        "awaiting_contributions", undefined, NOW),
    ).toBeNull();
    expect(
      timeUntilDeadline("2026-04-28T11:00:00Z",
        "awaiting_contributions", { quiet_period_secs: 60 }, NOW),
    ).toBeNull();
  });

  it("formats remaining seconds correctly across thresholds", () => {
    // 30 min elapsed of a 60 min deadline → 30 min left
    expect(
      timeUntilDeadline("2026-04-28T11:30:00Z",
        "awaiting_contributions", { max_age_secs: 3600 }, NOW),
    ).toBe("30m left");
    // 50 min elapsed of a 1h deadline → 10 min left
    expect(
      timeUntilDeadline("2026-04-28T11:10:00Z",
        "awaiting_contributions", { max_age_secs: 3600 }, NOW),
    ).toBe("10m left");
    // 5 hours of a 24h deadline → 19h left
    expect(
      timeUntilDeadline("2026-04-28T07:00:00Z",
        "awaiting_contributions", { max_age_secs: 24 * 3600 }, NOW),
    ).toBe("19h left");
  });

  it("returns \"expired\" for rooms past their deadline", () => {
    // 2h elapsed, 1h deadline — overdue. The watchdog has not yet
    // swept; the marker is the bridge state.
    expect(
      timeUntilDeadline("2026-04-28T10:00:00Z",
        "awaiting_contributions", { max_age_secs: 3600 }, NOW),
    ).toBe("expired");
  });

  it("returns null on unparseable opened_at (defensive)", () => {
    expect(
      timeUntilDeadline("not-a-date", "awaiting_contributions",
        { max_age_secs: 3600 }, NOW),
    ).toBeNull();
  });
});

describe("extractDecisionVerdict", () => {
  it("extracts the verdict from the standard synthesis template", () => {
    const content =
      "## Synthesis — owner/repo#42\n\n" +
      "**Verdict:** `APPROVE` _(LLM-derived from 2 contributions)_\n";
    expect(extractDecisionVerdict(content)).toBe("APPROVE");
  });

  it("handles all four enum values", () => {
    for (const v of ["APPROVE", "COMMENT", "CONCERNS", "REQUEST_CHANGES"] as const) {
      expect(
        extractDecisionVerdict("**Verdict:** `" + v + "` etc"),
      ).toBe(v);
    }
  });

  it("tolerates missing backticks (looser synth output)", () => {
    expect(extractDecisionVerdict("**Verdict:** APPROVE")).toBe("APPROVE");
  });

  it("returns null for content without the template", () => {
    expect(extractDecisionVerdict("plain old prose")).toBeNull();
    expect(extractDecisionVerdict("")).toBeNull();
  });

  it("returns null for unrecognized verdict values (avoid garbage pills)", () => {
    // Custom synthesizer might emit something off-enum — caller
    // falls back to a plain "decided" badge instead of rendering
    // the unknown string as a pill.
    expect(
      extractDecisionVerdict("**Verdict:** `MAYBE_LATER`"),
    ).toBeNull();
  });
});

describe("verdictPillClass", () => {
  it("returns a distinct color class per verdict", () => {
    // The four verdicts must map to four visually distinct hues.
    // Pin the exact classes so a Tailwind upgrade or typo cant
    // silently fall through to a default.
    expect(verdictPillClass("APPROVE")).toContain("emerald");
    expect(verdictPillClass("COMMENT")).toContain("zinc");
    expect(verdictPillClass("CONCERNS")).toContain("amber");
    expect(verdictPillClass("REQUEST_CHANGES")).toContain("rose");
  });
});
