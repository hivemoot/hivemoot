import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./client.js", () => ({
  gh: vi.fn(),
}));

import { gh } from "./client.js";
import { fetchNotifications, parseSubjectNumber } from "./notifications.js";

const mockedGh = vi.mocked(gh);
const repo = { owner: "hivemoot", repo: "colony" };

beforeEach(() => {
  vi.clearAllMocks();
});

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    unread: true,
    reason: "comment",
    updated_at: "2025-06-15T10:00:00Z",
    subject: {
      url: "https://api.github.com/repos/hivemoot/colony/issues/42",
      type: "Issue",
    },
    ...overrides,
  };
}

describe("parseSubjectNumber()", () => {
  it("extracts number from issue URL", () => {
    expect(parseSubjectNumber("https://api.github.com/repos/hivemoot/colony/issues/42")).toBe(42);
  });

  it("extracts number from pull request URL", () => {
    expect(parseSubjectNumber("https://api.github.com/repos/hivemoot/colony/pulls/99")).toBe(99);
  });

  it("returns undefined for URL without trailing number", () => {
    expect(parseSubjectNumber("https://api.github.com/repos/hivemoot/colony")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseSubjectNumber("")).toBeUndefined();
  });
});

describe("fetchNotifications()", () => {
  it("returns map of unread notifications keyed by issue number", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([
      makeNotification({ reason: "mention", updated_at: "2025-06-15T10:00:00Z" }),
    ]));

    const result = await fetchNotifications(repo);
    expect(result.size).toBe(1);
    expect(result.get(42)).toEqual({
      reason: "mention",
      updatedAt: "2025-06-15T10:00:00Z",
    });
  });

  it("calls gh with correct API path", async () => {
    mockedGh.mockResolvedValue("[]");

    await fetchNotifications(repo);

    expect(mockedGh).toHaveBeenCalledWith([
      "api",
      "/repos/hivemoot/colony/notifications",
    ]);
  });

  it("filters out read notifications", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([
      makeNotification({ unread: false }),
    ]));

    const result = await fetchNotifications(repo);
    expect(result.size).toBe(0);
  });

  it("filters out non-issue/PR subject types", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([
      makeNotification({ subject: { url: "https://api.github.com/repos/hivemoot/colony/releases/5", type: "Release" } }),
    ]));

    const result = await fetchNotifications(repo);
    expect(result.size).toBe(0);
  });

  it("handles PullRequest subject type", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([
      makeNotification({
        subject: { url: "https://api.github.com/repos/hivemoot/colony/pulls/99", type: "PullRequest" },
        reason: "review_requested",
      }),
    ]));

    const result = await fetchNotifications(repo);
    expect(result.size).toBe(1);
    expect(result.get(99)).toEqual({
      reason: "review_requested",
      updatedAt: "2025-06-15T10:00:00Z",
    });
  });

  it("keeps most recent notification when duplicates exist for same item", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([
      makeNotification({ reason: "comment", updated_at: "2025-06-15T08:00:00Z" }),
      makeNotification({ reason: "mention", updated_at: "2025-06-15T12:00:00Z" }),
    ]));

    const result = await fetchNotifications(repo);
    expect(result.size).toBe(1);
    expect(result.get(42)).toEqual({
      reason: "mention",
      updatedAt: "2025-06-15T12:00:00Z",
    });
  });

  it("keeps earlier notification when it appears after a later one", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([
      makeNotification({ reason: "mention", updated_at: "2025-06-15T12:00:00Z" }),
      makeNotification({ reason: "comment", updated_at: "2025-06-15T08:00:00Z" }),
    ]));

    const result = await fetchNotifications(repo);
    expect(result.get(42)?.reason).toBe("mention");
  });

  it("handles multiple different items", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([
      makeNotification({
        subject: { url: "https://api.github.com/repos/hivemoot/colony/issues/10", type: "Issue" },
        reason: "comment",
      }),
      makeNotification({
        subject: { url: "https://api.github.com/repos/hivemoot/colony/pulls/20", type: "PullRequest" },
        reason: "author",
      }),
    ]));

    const result = await fetchNotifications(repo);
    expect(result.size).toBe(2);
    expect(result.get(10)?.reason).toBe("comment");
    expect(result.get(20)?.reason).toBe("author");
  });

  it("returns empty map when API returns empty array", async () => {
    mockedGh.mockResolvedValue("[]");

    const result = await fetchNotifications(repo);
    expect(result.size).toBe(0);
  });

  it("skips notifications with unparseable subject URLs", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([
      makeNotification({
        subject: { url: "https://api.github.com/repos/hivemoot/colony", type: "Issue" },
      }),
    ]));

    const result = await fetchNotifications(repo);
    expect(result.size).toBe(0);
  });
});
