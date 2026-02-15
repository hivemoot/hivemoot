import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./client.js", () => ({
  gh: vi.fn(),
}));

import { gh } from "./client.js";
import {
  fetchNotifications,
  fetchMentionNotifications,
  markNotificationRead,
  fetchCommentBody,
  buildMentionEvent,
  parseSubjectNumber,
  isAgentMentioned,
} from "./notifications.js";
import type { RawNotification, CommentDetail } from "./notifications.js";

const mockedGh = vi.mocked(gh);
const repo = { owner: "hivemoot", repo: "colony" };

beforeEach(() => {
  vi.clearAllMocks();
});

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: "1001",
    unread: true,
    reason: "comment",
    updated_at: "2025-06-15T10:00:00Z",
    subject: {
      url: "https://api.github.com/repos/hivemoot/colony/issues/42",
      type: "Issue",
      title: "Fix layout",
      latest_comment_url: "https://api.github.com/repos/hivemoot/colony/issues/comments/999",
    },
    repository: {
      full_name: "hivemoot/colony",
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
      threadId: "1001",
      reason: "mention",
      updatedAt: "2025-06-15T10:00:00Z",
      title: "Fix layout",
      url: "https://github.com/hivemoot/colony/issues/42",
      itemType: "Issue",
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
        subject: { url: "https://api.github.com/repos/hivemoot/colony/pulls/99", type: "PullRequest", title: "Add search", latest_comment_url: null },
        reason: "review_requested",
      }),
    ]));

    const result = await fetchNotifications(repo);
    expect(result.size).toBe(1);
    expect(result.get(99)).toEqual({
      threadId: "1001",
      reason: "review_requested",
      updatedAt: "2025-06-15T10:00:00Z",
      title: "Add search",
      url: "https://github.com/hivemoot/colony/pull/99",
      itemType: "PullRequest",
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
      threadId: "1001",
      reason: "mention",
      updatedAt: "2025-06-15T12:00:00Z",
      title: "Fix layout",
      url: "https://github.com/hivemoot/colony/issues/42",
      itemType: "Issue",
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
        subject: { url: "https://api.github.com/repos/hivemoot/colony/issues/10", type: "Issue", title: "Bug report", latest_comment_url: null },
        reason: "comment",
      }),
      makeNotification({
        subject: { url: "https://api.github.com/repos/hivemoot/colony/pulls/20", type: "PullRequest", title: "Refactor", latest_comment_url: null },
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

describe("fetchMentionNotifications()", () => {
  it("calls gh with repo and all=false (no since by default)", async () => {
    mockedGh.mockResolvedValue("[]");

    await fetchMentionNotifications("hivemoot/colony", ["mention"]);

    expect(mockedGh).toHaveBeenCalledWith([
      "api",
      "--paginate",
      "/repos/hivemoot/colony/notifications?all=false",
    ]);
  });

  it("includes since param when provided", async () => {
    mockedGh.mockResolvedValue("[]");

    await fetchMentionNotifications("hivemoot/colony", ["mention"], "2026-01-15T00:00:00Z");

    expect(mockedGh).toHaveBeenCalledWith([
      "api",
      "--paginate",
      "/repos/hivemoot/colony/notifications?all=false&since=2026-01-15T00%3A00%3A00Z",
    ]);
  });

  it("embeds params as URL query string, not as -f body fields", async () => {
    mockedGh.mockResolvedValue("[]");

    await fetchMentionNotifications("hivemoot/colony", ["mention"]);

    const args = mockedGh.mock.calls[0][0];
    // Must NOT contain -f flags (which send body fields and cause 404 on GET)
    expect(args).not.toContain("-f");
    // URL must contain query string
    expect(args[2]).toMatch(/\?all=false/);
  });

  it("URL-encodes since timestamps with colons correctly", async () => {
    mockedGh.mockResolvedValue("[]");

    await fetchMentionNotifications("hivemoot/colony", ["mention"], "2026-02-13T02:11:08.000Z");

    const url = mockedGh.mock.calls[0][0][2];
    // Colons in ISO timestamps must be percent-encoded in the query string
    expect(url).toContain("since=2026-02-13T02%3A11%3A08.000Z");
    expect(url).not.toContain("-f");
  });

  it("omits since param when not provided", async () => {
    mockedGh.mockResolvedValue("[]");

    await fetchMentionNotifications("hivemoot/colony", ["mention"]);

    const url = mockedGh.mock.calls[0][0][2];
    expect(url).not.toContain("since");
    expect(url).toBe("/repos/hivemoot/colony/notifications?all=false");
  });

  it("filters by specified reasons", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([
      makeNotification({ reason: "mention" }),
      makeNotification({ id: "1002", reason: "comment" }),
      makeNotification({ id: "1003", reason: "author" }),
    ]));

    const result = await fetchMentionNotifications("hivemoot/colony", ["mention"]);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe("mention");
  });

  it("supports multiple reasons", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([
      makeNotification({ reason: "mention" }),
      makeNotification({ id: "1002", reason: "comment" }),
    ]));

    const result = await fetchMentionNotifications("hivemoot/colony", ["mention", "comment"]);
    expect(result).toHaveLength(2);
  });

  it("filters out read notifications", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([
      makeNotification({ reason: "mention", unread: false }),
    ]));

    const result = await fetchMentionNotifications("hivemoot/colony", ["mention"]);
    expect(result).toHaveLength(0);
  });

  it("filters out non-Issue/PR types", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([
      makeNotification({
        reason: "mention",
        subject: { url: "https://api.github.com/repos/hivemoot/colony/releases/5", type: "Release", title: "v1", latest_comment_url: null },
      }),
    ]));

    const result = await fetchMentionNotifications("hivemoot/colony", ["mention"]);
    expect(result).toHaveLength(0);
  });
});

describe("markNotificationRead()", () => {
  it("calls PATCH on the thread endpoint", async () => {
    mockedGh.mockResolvedValue("");

    await markNotificationRead("12345");

    expect(mockedGh).toHaveBeenCalledWith([
      "api",
      "--method", "PATCH",
      "/notifications/threads/12345",
    ]);
  });
});

describe("fetchCommentBody()", () => {
  it("returns comment detail for a valid URL", async () => {
    mockedGh.mockResolvedValue(JSON.stringify({
      body: "Hello world",
      author: "dmitry",
      htmlUrl: "https://github.com/hivemoot/colony/issues/42#issuecomment-999",
    }));

    const result = await fetchCommentBody("https://api.github.com/repos/hivemoot/colony/issues/comments/999");
    expect(result).toEqual({
      body: "Hello world",
      author: "dmitry",
      htmlUrl: "https://github.com/hivemoot/colony/issues/42#issuecomment-999",
    });
  });

  it("returns null for empty URL", async () => {
    const result = await fetchCommentBody("");
    expect(result).toBeNull();
    expect(mockedGh).not.toHaveBeenCalled();
  });

  it("returns null when gh call fails", async () => {
    mockedGh.mockRejectedValue(new Error("API error"));

    const result = await fetchCommentBody("https://api.github.com/repos/hivemoot/colony/issues/comments/999");
    expect(result).toBeNull();
  });
});

describe("buildMentionEvent()", () => {
  const baseNotification: RawNotification = {
    id: "5001",
    unread: true,
    reason: "mention",
    updated_at: "2026-02-12T15:30:00Z",
    subject: {
      url: "https://api.github.com/repos/hivemoot/colony/issues/42",
      type: "Issue",
      title: "Fix layout",
      latest_comment_url: "https://api.github.com/repos/hivemoot/colony/issues/comments/999",
    },
    repository: {
      full_name: "hivemoot/colony",
    },
  };

  const baseComment: CommentDetail = {
    body: "@hivemoot-worker please look at this",
    author: "dmitry",
    htmlUrl: "https://github.com/hivemoot/colony/issues/42#issuecomment-999",
  };

  it("builds a complete MentionEvent from notification + comment", () => {
    const event = buildMentionEvent(baseNotification, baseComment, "hivemoot-worker");

    expect(event).toEqual({
      agent: "hivemoot-worker",
      repo: "hivemoot/colony",
      number: 42,
      type: "Issue",
      title: "Fix layout",
      author: "dmitry",
      body: "@hivemoot-worker please look at this",
      url: "https://github.com/hivemoot/colony/issues/42#issuecomment-999",
      threadId: "5001",
      timestamp: "2026-02-12T15:30:00Z",
    });
  });

  it("handles null comment gracefully", () => {
    const event = buildMentionEvent(baseNotification, null, "hivemoot-worker");

    expect(event).not.toBeNull();
    expect(event!.author).toBe("unknown");
    expect(event!.body).toBe("");
    expect(event!.url).toBe("");
  });

  it("returns null when subject URL has no number", () => {
    const bad: RawNotification = {
      ...baseNotification,
      subject: {
        ...baseNotification.subject,
        url: "https://api.github.com/repos/hivemoot/colony",
      },
    };

    expect(buildMentionEvent(bad, baseComment, "agent")).toBeNull();
  });

  it("handles PullRequest type", () => {
    const prNotification: RawNotification = {
      ...baseNotification,
      subject: {
        ...baseNotification.subject,
        url: "https://api.github.com/repos/hivemoot/colony/pulls/99",
        type: "PullRequest",
      },
    };

    const event = buildMentionEvent(prNotification, baseComment, "hivemoot-worker");
    expect(event!.type).toBe("PullRequest");
    expect(event!.number).toBe(99);
  });
});

describe("isAgentMentioned()", () => {
  it("matches exact @mention", () => {
    expect(isAgentMentioned("@hivemoot-worker look at this", "hivemoot-worker")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isAgentMentioned("@Hivemoot-Worker look at this", "hivemoot-worker")).toBe(true);
  });

  it("does not match suffix username (boundary check)", () => {
    expect(isAgentMentioned("@hivemoot-worker-extra", "hivemoot-worker")).toBe(false);
  });

  it("matches at end of string", () => {
    expect(isAgentMentioned("cc @hivemoot-worker", "hivemoot-worker")).toBe(true);
  });

  it("matches when followed by punctuation", () => {
    expect(isAgentMentioned("@hivemoot-worker, thanks", "hivemoot-worker")).toBe(true);
  });

  it("matches when followed by newline", () => {
    expect(isAgentMentioned("@hivemoot-worker\nplease review", "hivemoot-worker")).toBe(true);
  });

  it("does not match different username", () => {
    expect(isAgentMentioned("@hivemoot-scout review this", "hivemoot-worker")).toBe(false);
  });

  it("does not match email addresses containing the username", () => {
    expect(isAgentMentioned("contact foo@hivemoot-worker.com for details", "hivemoot-worker")).toBe(false);
  });

  it("returns false for empty body", () => {
    expect(isAgentMentioned("", "hivemoot-worker")).toBe(false);
  });
});
