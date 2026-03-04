import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { relativeTimeUntil, shouldShowNextRun } from "./agent-health-time";

const NOW = Date.UTC(2026, 2, 4, 0, 0, 0);

describe("relativeTimeUntil", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when next run timestamp is missing", () => {
    expect(relativeTimeUntil(undefined)).toBeNull();
  });

  it("returns <1m for sub-minute future windows", () => {
    const inThirtySeconds = new Date(NOW + 30_000).toISOString();
    expect(relativeTimeUntil(inThirtySeconds)).toBe("<1m");
  });

  it("returns minutes for 1-59 minute windows", () => {
    const inEightMinutes = new Date(NOW + 8 * 60_000).toISOString();
    expect(relativeTimeUntil(inEightMinutes)).toBe("8m");
  });

  it("returns now for late timestamps", () => {
    const oneSecondAgo = new Date(NOW - 1_000).toISOString();
    expect(relativeTimeUntil(oneSecondAgo)).toBe("now");
  });
});

describe("shouldShowNextRun", () => {
  it("hides next-run text for late status", () => {
    expect(shouldShowNextRun("late", "now")).toBe(false);
  });

  it("shows next-run text for non-late status when next run exists", () => {
    expect(shouldShowNextRun("ok", "<1m")).toBe(true);
  });

  it("hides next-run text when there is no next-run value", () => {
    expect(shouldShowNextRun("ok", null)).toBe(false);
  });
});
