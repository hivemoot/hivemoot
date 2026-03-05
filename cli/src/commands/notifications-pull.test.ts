import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("../github/fetch-notifications.js", () => ({
  fetchNotificationsPull: vi.fn(),
}));

import { fetchNotificationsPull } from "../github/fetch-notifications.js";
import { notificationsPullCommand } from "./notifications-pull.js";
import type { NotificationsPullResult } from "../github/fetch-notifications.js";

const mockedFetch = vi.mocked(fetchNotificationsPull);

function makeResult(overrides: Partial<NotificationsPullResult> = {}): NotificationsPullResult {
  return {
    schemaVersion: 1,
    kind: "notifications_pull",
    generatedAt: "2026-03-03T10:00:00.000Z",
    repo: "hivemoot/hivemoot",
    reasons: ["*"],
    notifications: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockedFetch.mockResolvedValue(makeResult());
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("notificationsPullCommand", () => {
  describe("input validation", () => {
    it("throws CliError when reason resolves to empty list", async () => {
      await expect(
        notificationsPullCommand({ repo: "hivemoot/hivemoot", reason: "  ,  " }),
      ).rejects.toMatchObject({
        code: "GH_ERROR",
        message: expect.stringContaining("At least one reason"),
      });
    });
  });

  describe("reason parsing", () => {
    it("passes * as single-element reasons array when no --reason flag", async () => {
      await notificationsPullCommand({ repo: "hivemoot/hivemoot" });
      expect(mockedFetch).toHaveBeenCalledWith("hivemoot/hivemoot", ["*"], undefined);
    });

    it("passes * reasons when --reason is *", async () => {
      await notificationsPullCommand({ repo: "hivemoot/hivemoot", reason: "*" });
      expect(mockedFetch).toHaveBeenCalledWith("hivemoot/hivemoot", ["*"], undefined);
    });

    it("splits comma-separated reasons", async () => {
      await notificationsPullCommand({ repo: "hivemoot/hivemoot", reason: "mention,author" });
      expect(mockedFetch).toHaveBeenCalledWith("hivemoot/hivemoot", ["mention", "author"], undefined);
    });

    it("trims whitespace from reasons", async () => {
      await notificationsPullCommand({ repo: "hivemoot/hivemoot", reason: " mention , author " });
      expect(mockedFetch).toHaveBeenCalledWith("hivemoot/hivemoot", ["mention", "author"], undefined);
    });
  });

  describe("state file", () => {
    it("passes stateFile to fetchNotificationsPull", async () => {
      await notificationsPullCommand({ repo: "hivemoot/hivemoot", stateFile: ".my-state.json" });
      expect(mockedFetch).toHaveBeenCalledWith("hivemoot/hivemoot", ["*"], ".my-state.json");
    });

    it("passes undefined stateFile when not specified", async () => {
      await notificationsPullCommand({ repo: "hivemoot/hivemoot" });
      expect(mockedFetch).toHaveBeenCalledWith("hivemoot/hivemoot", ["*"], undefined);
    });
  });

  describe("JSON output", () => {
    it("prints schemaVersion, kind, and repo in JSON mode", async () => {
      await notificationsPullCommand({ repo: "hivemoot/hivemoot", json: true });
      const output = JSON.parse(
        vi.mocked(console.log).mock.calls[0]![0] as string,
      ) as NotificationsPullResult;
      expect(output.schemaVersion).toBe(1);
      expect(output.kind).toBe("notifications_pull");
      expect(output.repo).toBe("hivemoot/hivemoot");
    });

    it("prints notifications array in JSON mode", async () => {
      mockedFetch.mockResolvedValue(makeResult({
        notifications: [
          {
            threadId: "t1",
            reason: "mention",
            updatedAt: "2026-03-03T10:00:00Z",
            title: "Test issue",
            url: "https://github.com/hivemoot/hivemoot/issues/42",
            itemType: "Issue",
            number: 42,
          },
        ],
      }));
      await notificationsPullCommand({ repo: "hivemoot/hivemoot", json: true });
      const output = JSON.parse(
        vi.mocked(console.log).mock.calls[0]![0] as string,
      ) as NotificationsPullResult;
      expect(output.notifications).toHaveLength(1);
      expect(output.notifications[0]!.threadId).toBe("t1");
    });
  });

  describe("text output", () => {
    it("shows repo and count in text mode", async () => {
      await notificationsPullCommand({ repo: "hivemoot/hivemoot" });
      const output = vi.mocked(console.log).mock.calls[0]![0] as string;
      expect(output).toContain("hivemoot/hivemoot");
      expect(output).toContain("count: 0");
    });

    it("shows notification details in text mode", async () => {
      mockedFetch.mockResolvedValue(makeResult({
        notifications: [
          {
            threadId: "t1",
            reason: "mention",
            updatedAt: "2026-03-03T10:00:00Z",
            title: "My PR",
            url: "https://github.com/hivemoot/hivemoot/pull/54",
            itemType: "PullRequest",
            number: 54,
          },
        ],
      }));
      await notificationsPullCommand({ repo: "hivemoot/hivemoot" });
      const output = vi.mocked(console.log).mock.calls[0]![0] as string;
      expect(output).toContain("mention");
      expect(output).toContain("My PR");
      expect(output).toContain("t1");
    });

    it("shows no-notifications message when list is empty", async () => {
      await notificationsPullCommand({ repo: "hivemoot/hivemoot" });
      const output = vi.mocked(console.log).mock.calls[0]![0] as string;
      expect(output).toContain("no unread notifications");
    });
  });

  describe("error handling", () => {
    it("escalates CliError exit code to at least 3", async () => {
      mockedFetch.mockRejectedValue(new CliError("API error", "GH_ERROR", 1));
      await expect(
        notificationsPullCommand({ repo: "hivemoot/hivemoot" }),
      ).rejects.toMatchObject({ exitCode: 3 });
    });

    it("wraps non-CliError as CliError with GH_ERROR code", async () => {
      mockedFetch.mockRejectedValue(new Error("network timeout"));
      await expect(
        notificationsPullCommand({ repo: "hivemoot/hivemoot" }),
      ).rejects.toMatchObject({ code: "GH_ERROR", exitCode: 3 });
    });
  });
});
