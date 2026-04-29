import { describe, expect, it } from "vitest";
import {
  participantStatusCounts,
  relativeTime,
  statusLabel,
  statusPillClass,
  subjectGithubUrl,
  subjectLabel,
} from "./room-helpers";
import type { RoomParticipant } from "./types";

describe("statusLabel", () => {
  it.each([
    ["awaiting_rsvp", "Awaiting RSVPs"],
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
      "awaiting_rsvp",
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
