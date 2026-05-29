import { describe, it, expect, vi, beforeEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("./client.js", async (importActual) => {
  const actual = await importActual<typeof import("./client.js")>();
  return { ...actual, ghPaginatedList: vi.fn() };
});

vi.mock("../watch/state.js", () => ({
  loadState: vi.fn(),
  buildLatestProcessedByThread: vi.fn(),
}));

import { ghPaginatedList } from "./client.js";
import { loadState, buildLatestProcessedByThread } from "../watch/state.js";
import { fetchNotificationsPull } from "./fetch-notifications.js";

const mockedGhPaginatedList = vi.mocked(ghPaginatedList);
const mockedLoadState = vi.mocked(loadState);
const mockedBuildLatest = vi.mocked(buildLatestProcessedByThread);

function makeRawNotification(overrides: Partial<{
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  type: string;
  title: string;
  subjectUrl: string;
  repo: string;
}> = {}) {
  const type = overrides.type ?? "Issue";
  const number = "42";
  const repo = overrides.repo ?? "hivemoot/hivemoot";
  return {
    id: overrides.id ?? "thread-1",
    unread: overrides.unread ?? true,
    reason: overrides.reason ?? "mention",
    updated_at: overrides.updated_at ?? "2026-03-03T10:00:00Z",
    subject: {
      url: overrides.subjectUrl ?? `https://api.github.com/repos/${repo}/${type === "PullRequest" ? "pulls" : "issues"}/${number}`,
      type,
      title: overrides.title ?? "Test notification",
    },
    repository: { full_name: repo },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedBuildLatest.mockReturnValue(new Map());
});

describe("fetchNotificationsPull()", () => {
  describe("basic fetching", () => {
    it("calls ghPaginatedList with the notifications endpoint path", async () => {
      mockedGhPaginatedList.mockResolvedValue([]);
      mockedLoadState.mockResolvedValue({ lastChecked: "", processedThreadIds: [] });
      await fetchNotificationsPull("hivemoot/hivemoot", ["*"]);
      expect(mockedGhPaginatedList).toHaveBeenCalledWith(
        "/repos/hivemoot/hivemoot/notifications?all=false"
      );
    });

    it("returns schema-versioned result with kind notifications_pull", async () => {
      mockedGhPaginatedList.mockResolvedValue([]);
      const result = await fetchNotificationsPull("hivemoot/hivemoot", ["*"]);
      expect(result.schemaVersion).toBe(1);
      expect(result.kind).toBe("notifications_pull");
      expect(result.repo).toBe("hivemoot/hivemoot");
    });

    it("returns empty notifications array when no notifications", async () => {
      mockedGhPaginatedList.mockResolvedValue([]);
      const result = await fetchNotificationsPull("hivemoot/hivemoot", ["*"]);
      expect(result.notifications).toHaveLength(0);
    });

    it("handles multi-page responses (already flattened by ghPaginatedList)", async () => {
      const page1 = [makeRawNotification({ id: "thread-1" })];
      const page2 = [makeRawNotification({ id: "thread-2", updated_at: "2026-03-03T11:00:00Z" })];
      mockedGhPaginatedList.mockResolvedValue([...page1, ...page2]);
      const result = await fetchNotificationsPull("hivemoot/hivemoot", ["*"]);
      expect(result.notifications).toHaveLength(2);
    });
  });

  describe("filtering", () => {
    it("skips non-unread notifications", async () => {
      mockedGhPaginatedList.mockResolvedValue([
        makeRawNotification({ unread: false }),
      ]);
      const result = await fetchNotificationsPull("hivemoot/hivemoot", ["*"]);
      expect(result.notifications).toHaveLength(0);
    });

    it("skips non-Issue/PR notification types", async () => {
      const n = makeRawNotification({ type: "Release" });
      mockedGhPaginatedList.mockResolvedValue([n]);
      const result = await fetchNotificationsPull("hivemoot/hivemoot", ["*"]);
      expect(result.notifications).toHaveLength(0);
    });

    it("applies reason filter when reasons does not include *", async () => {
      const mention = makeRawNotification({ reason: "mention" });
      const author = makeRawNotification({ id: "thread-2", reason: "author" });
      mockedGhPaginatedList.mockResolvedValue([mention, author]);
      const result = await fetchNotificationsPull("hivemoot/hivemoot", ["mention"]);
      expect(result.notifications).toHaveLength(1);
      expect(result.notifications[0]!.reason).toBe("mention");
    });

    it("returns all reasons when reasons includes *", async () => {
      const mention = makeRawNotification({ reason: "mention" });
      const author = makeRawNotification({ id: "thread-2", reason: "author" });
      mockedGhPaginatedList.mockResolvedValue([mention, author]);
      const result = await fetchNotificationsPull("hivemoot/hivemoot", ["*"]);
      expect(result.notifications).toHaveLength(2);
    });

    it("sets reasons field to [*] when unfiltered", async () => {
      mockedGhPaginatedList.mockResolvedValue([]);
      const result = await fetchNotificationsPull("hivemoot/hivemoot", ["*"]);
      expect(result.reasons).toEqual(["*"]);
    });

    it("sets reasons field to applied filter when filtered", async () => {
      mockedGhPaginatedList.mockResolvedValue([]);
      const result = await fetchNotificationsPull("hivemoot/hivemoot", ["mention", "review_requested"]);
      expect(result.reasons).toEqual(["mention", "review_requested"]);
    });
  });

  describe("cursor integration", () => {
    it("skips notifications already processed at same updatedAt", async () => {
      const processedMap = new Map([["thread-1", "2026-03-03T10:00:00Z"]]);
      mockedBuildLatest.mockReturnValue(processedMap);
      mockedLoadState.mockResolvedValue({
        lastChecked: "2026-03-03T09:00:00Z",
        processedThreadIds: ["thread-1:2026-03-03T10:00:00Z"],
      });
      mockedGhPaginatedList.mockResolvedValue([
        makeRawNotification({ id: "thread-1", updated_at: "2026-03-03T10:00:00Z" }),
      ]);
      const result = await fetchNotificationsPull("hivemoot/hivemoot", ["*"], ".hivemoot-watch.json");
      expect(result.notifications).toHaveLength(0);
    });

    it("includes notifications with newer updatedAt than cursor", async () => {
      const processedMap = new Map([["thread-1", "2026-03-03T09:00:00Z"]]);
      mockedBuildLatest.mockReturnValue(processedMap);
      mockedLoadState.mockResolvedValue({
        lastChecked: "2026-03-03T09:00:00Z",
        processedThreadIds: ["thread-1:2026-03-03T09:00:00Z"],
      });
      mockedGhPaginatedList.mockResolvedValue([
        makeRawNotification({ id: "thread-1", updated_at: "2026-03-03T10:00:00Z" }),
      ]);
      const result = await fetchNotificationsPull("hivemoot/hivemoot", ["*"], ".hivemoot-watch.json");
      expect(result.notifications).toHaveLength(1);
    });

    it("proceeds without cursor when stateFilePath is not provided", async () => {
      mockedGhPaginatedList.mockResolvedValue([makeRawNotification()]);
      const result = await fetchNotificationsPull("hivemoot/hivemoot", ["*"]);
      expect(mockedLoadState).not.toHaveBeenCalled();
      expect(result.notifications).toHaveLength(1);
    });

    it("proceeds without cursor when state file load fails", async () => {
      mockedLoadState.mockRejectedValue(new Error("file not found"));
      mockedGhPaginatedList.mockResolvedValue([makeRawNotification()]);
      const result = await fetchNotificationsPull("hivemoot/hivemoot", ["*"], ".hivemoot-watch.json");
      expect(result.notifications).toHaveLength(1);
    });
  });

  describe("notification item shape", () => {
    it("includes correct fields for Issue notification", async () => {
      mockedGhPaginatedList.mockResolvedValue([
        makeRawNotification({ id: "t1", reason: "mention", type: "Issue", title: "My issue" }),
      ]);
      const result = await fetchNotificationsPull("hivemoot/hivemoot", ["*"]);
      const n = result.notifications[0]!;
      expect(n.threadId).toBe("t1");
      expect(n.reason).toBe("mention");
      expect(n.itemType).toBe("Issue");
      expect(n.number).toBe(42);
      expect(n.title).toBe("My issue");
      expect(n.url).toContain("/issues/42");
    });

    it("includes correct fields for PullRequest notification", async () => {
      mockedGhPaginatedList.mockResolvedValue([
        makeRawNotification({ type: "PullRequest" }),
      ]);
      const result = await fetchNotificationsPull("hivemoot/hivemoot", ["*"]);
      const n = result.notifications[0]!;
      expect(n.itemType).toBe("PullRequest");
      expect(n.url).toContain("/pull/");
    });

    it("sets number to null when subject URL has no parseable number", async () => {
      const n = makeRawNotification();
      n.subject.url = "https://api.github.com/repos/hivemoot/hivemoot/issues/not-a-number";
      mockedGhPaginatedList.mockResolvedValue([n]);
      const result = await fetchNotificationsPull("hivemoot/hivemoot", ["*"]);
      expect(result.notifications[0]!.number).toBeNull();
      expect(result.notifications[0]!.url).toBeNull();
    });
  });

  describe("error handling", () => {
    it("propagates CliError from ghPaginatedList (e.g. parse failure)", async () => {
      mockedGhPaginatedList.mockRejectedValue(
        new CliError("Failed to parse paginated response", "GH_ERROR", 1)
      );
      await expect(fetchNotificationsPull("hivemoot/hivemoot", ["*"])).rejects.toMatchObject({
        code: "GH_ERROR",
        message: expect.stringContaining("Failed to parse"),
      });
    });

    it("propagates CliError from ghPaginatedList (e.g. unexpected shape)", async () => {
      mockedGhPaginatedList.mockRejectedValue(
        new CliError("Unexpected paginated response shape", "GH_ERROR", 1)
      );
      await expect(fetchNotificationsPull("hivemoot/hivemoot", ["*"])).rejects.toMatchObject({
        code: "GH_ERROR",
        message: expect.stringContaining("Unexpected"),
      });
    });

    it("propagates gh CliError as-is", async () => {
      mockedGhPaginatedList.mockRejectedValue(new CliError("HTTP 403", "GH_ERROR", 1));
      await expect(fetchNotificationsPull("hivemoot/hivemoot", ["*"])).rejects.toMatchObject({
        code: "GH_ERROR",
        message: "HTTP 403",
      });
    });
  });
});
