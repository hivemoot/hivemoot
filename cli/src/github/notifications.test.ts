import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./client.js", () => ({
  gh: vi.fn(),
  ghWithHeaders: vi.fn(),
}));

import { gh, ghWithHeaders } from "./client.js";
import {
  fetchNotifications,
  fetchMentionNotifications,
  fetchMentionNotificationsConditional,
  markNotificationRead,
  fetchCommentBody,
  fetchRecentSubjectComments,
  fetchLatestReviewRequestEvent,
  fetchReviewRequestState,
  fetchSubjectBody,
  fetchSubjectBodyResult,
  buildMentionEvent,
  parseSubjectNumber,
  isAgentMentioned,
} from "./notifications.js";
import type { RawNotification, CommentDetail } from "./notifications.js";
import { CliError } from "../config/types.js";

const mockedGh = vi.mocked(gh);
const mockedGhWithHeaders = vi.mocked(ghWithHeaders);
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
    mockedGh.mockResolvedValue(JSON.stringify([[
      makeNotification({ reason: "mention", updated_at: "2025-06-15T10:00:00Z" }),
    ]]));

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

  it("calls gh with --paginate --slurp and correct API path", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[]]));

    await fetchNotifications(repo);

    expect(mockedGh).toHaveBeenCalledWith([
      "api",
      "--paginate",
      "--slurp",
      "/repos/hivemoot/colony/notifications",
    ]);
  });

  it("filters out read notifications", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[
      makeNotification({ unread: false }),
    ]]));

    const result = await fetchNotifications(repo);
    expect(result.size).toBe(0);
  });

  it("filters out non-issue/PR subject types", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[
      makeNotification({ subject: { url: "https://api.github.com/repos/hivemoot/colony/releases/5", type: "Release" } }),
    ]]));

    const result = await fetchNotifications(repo);
    expect(result.size).toBe(0);
  });

  it("handles PullRequest subject type", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[
      makeNotification({
        subject: { url: "https://api.github.com/repos/hivemoot/colony/pulls/99", type: "PullRequest", title: "Add search", latest_comment_url: null },
        reason: "review_requested",
      }),
    ]]));

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
    mockedGh.mockResolvedValue(JSON.stringify([[
      makeNotification({ reason: "comment", updated_at: "2025-06-15T08:00:00Z" }),
      makeNotification({ reason: "mention", updated_at: "2025-06-15T12:00:00Z" }),
    ]]));

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
    mockedGh.mockResolvedValue(JSON.stringify([[
      makeNotification({ reason: "mention", updated_at: "2025-06-15T12:00:00Z" }),
      makeNotification({ reason: "comment", updated_at: "2025-06-15T08:00:00Z" }),
    ]]));

    const result = await fetchNotifications(repo);
    expect(result.get(42)?.reason).toBe("mention");
  });

  it("handles multiple different items", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[
      makeNotification({
        subject: { url: "https://api.github.com/repos/hivemoot/colony/issues/10", type: "Issue", title: "Bug report", latest_comment_url: null },
        reason: "comment",
      }),
      makeNotification({
        subject: { url: "https://api.github.com/repos/hivemoot/colony/pulls/20", type: "PullRequest", title: "Refactor", latest_comment_url: null },
        reason: "author",
      }),
    ]]));

    const result = await fetchNotifications(repo);
    expect(result.size).toBe(2);
    expect(result.get(10)?.reason).toBe("comment");
    expect(result.get(20)?.reason).toBe("author");
  });

  it("handles multi-page responses (array of arrays)", async () => {
    const page1 = [makeNotification({ reason: "mention" })];
    const page2 = [
      makeNotification({
        id: "1002",
        subject: { url: "https://api.github.com/repos/hivemoot/colony/issues/43", type: "Issue", title: "Another issue", latest_comment_url: null },
      }),
    ];
    mockedGh.mockResolvedValue(JSON.stringify([page1, page2]));

    const result = await fetchNotifications(repo);
    expect(result.size).toBe(2);
    expect(result.get(42)?.reason).toBe("mention");
    expect(result.get(43)?.title).toBe("Another issue");
  });

  it("returns empty map when API returns empty array", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[]]));

    const result = await fetchNotifications(repo);
    expect(result.size).toBe(0);
  });

  it("skips notifications with unparseable subject URLs", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[
      makeNotification({
        subject: { url: "https://api.github.com/repos/hivemoot/colony", type: "Issue" },
      }),
    ]]));

    const result = await fetchNotifications(repo);
    expect(result.size).toBe(0);
  });
});

describe("fetchMentionNotifications()", () => {
  it("calls gh with --paginate --slurp and repo and all=false (no since by default)", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[]]));

    await fetchMentionNotifications("hivemoot/colony", ["mention"]);

    expect(mockedGh).toHaveBeenCalledWith([
      "api",
      "--paginate",
      "--slurp",
      "/repos/hivemoot/colony/notifications?all=false",
    ]);
  });

  it("includes since param when provided", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[]]));

    await fetchMentionNotifications("hivemoot/colony", ["mention"], "2026-01-15T00:00:00Z");

    expect(mockedGh).toHaveBeenCalledWith([
      "api",
      "--paginate",
      "--slurp",
      "/repos/hivemoot/colony/notifications?all=false&since=2026-01-15T00%3A00%3A00Z",
    ]);
  });

  it("embeds params as URL query string, not as -f body fields", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[]]));

    await fetchMentionNotifications("hivemoot/colony", ["mention"]);

    const args = mockedGh.mock.calls[0][0];
    // Must NOT contain -f flags (which send body fields and cause 404 on GET)
    expect(args).not.toContain("-f");
    // URL must contain query string
    expect(args[3]).toMatch(/\?all=false/);
  });

  it("URL-encodes since timestamps with colons correctly", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[]]));

    await fetchMentionNotifications("hivemoot/colony", ["mention"], "2026-02-13T02:11:08.000Z");

    const url = mockedGh.mock.calls[0][0][3];
    // Colons in ISO timestamps must be percent-encoded in the query string
    expect(url).toContain("since=2026-02-13T02%3A11%3A08.000Z");
    expect(url).not.toContain("-f");
  });

  it("omits since param when not provided", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[]]));

    await fetchMentionNotifications("hivemoot/colony", ["mention"]);

    const url = mockedGh.mock.calls[0][0][3];
    expect(url).not.toContain("since");
    expect(url).toBe("/repos/hivemoot/colony/notifications?all=false");
  });

  it("filters by specified reasons", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[
      makeNotification({ reason: "mention" }),
      makeNotification({ id: "1002", reason: "comment" }),
      makeNotification({ id: "1003", reason: "author" }),
    ]]));

    const result = await fetchMentionNotifications("hivemoot/colony", ["mention"]);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe("mention");
  });

  it("supports multiple reasons", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[
      makeNotification({ reason: "mention" }),
      makeNotification({ id: "1002", reason: "comment" }),
    ]]));

    const result = await fetchMentionNotifications("hivemoot/colony", ["mention", "comment"]);
    expect(result).toHaveLength(2);
  });

  it("filters out read notifications", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[
      makeNotification({ reason: "mention", unread: false }),
    ]]));

    const result = await fetchMentionNotifications("hivemoot/colony", ["mention"]);
    expect(result).toHaveLength(0);
  });

  it("filters out non-Issue/PR types", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[
      makeNotification({
        reason: "mention",
        subject: { url: "https://api.github.com/repos/hivemoot/colony/releases/5", type: "Release", title: "v1", latest_comment_url: null },
      }),
    ]]));

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

describe("fetchSubjectBody()", () => {
  it("returns subject detail for a valid issue URL", async () => {
    mockedGh.mockResolvedValue(JSON.stringify({
      body: "@hivemoot-worker please help",
      author: "dmitry",
      htmlUrl: "https://github.com/hivemoot/colony/issues/42",
    }));

    const result = await fetchSubjectBody("https://api.github.com/repos/hivemoot/colony/issues/42");
    expect(result).toEqual({
      body: "@hivemoot-worker please help",
      author: "dmitry",
      htmlUrl: "https://github.com/hivemoot/colony/issues/42",
    });
  });

  it("returns null for empty URL", async () => {
    const result = await fetchSubjectBody("");
    expect(result).toBeNull();
    expect(mockedGh).not.toHaveBeenCalled();
  });

  it("returns null when gh call fails", async () => {
    mockedGh.mockRejectedValue(new Error("API error"));

    const result = await fetchSubjectBody("https://api.github.com/repos/hivemoot/colony/issues/42");
    expect(result).toBeNull();
  });
});

describe("fetchSubjectBodyResult()", () => {
  it("returns detail and non-permanent status for success", async () => {
    mockedGh.mockResolvedValue(JSON.stringify({
      body: "@hivemoot-worker please help",
      author: "dmitry",
      htmlUrl: "https://github.com/hivemoot/colony/issues/42",
    }));

    const result = await fetchSubjectBodyResult("https://api.github.com/repos/hivemoot/colony/issues/42");
    expect(result).toEqual({
      detail: {
        body: "@hivemoot-worker please help",
        author: "dmitry",
        htmlUrl: "https://github.com/hivemoot/colony/issues/42",
      },
      permanentFailure: false,
    });
  });

  it("classifies 404 as permanent", async () => {
    mockedGh.mockRejectedValue(new CliError("gh: Not Found (HTTP 404)", "GH_ERROR", 1));

    const result = await fetchSubjectBodyResult("https://api.github.com/repos/hivemoot/colony/issues/42");
    expect(result).toEqual({
      detail: null,
      permanentFailure: true,
    });
  });

  it("classifies non-HTTP errors as retryable", async () => {
    mockedGh.mockRejectedValue(new Error("network timeout"));

    const result = await fetchSubjectBodyResult("https://api.github.com/repos/hivemoot/colony/issues/42");
    expect(result).toEqual({
      detail: null,
      permanentFailure: false,
    });
  });
});

describe("fetchRecentSubjectComments()", () => {
  it("fetches recent issue comments for issues", async () => {
    mockedGh.mockResolvedValueOnce(JSON.stringify([
      {
        body: "@hivemoot-worker one",
        author: "dmitry",
        htmlUrl: "https://github.com/hivemoot/colony/issues/42#issuecomment-1",
      },
    ]));

    const result = await fetchRecentSubjectComments(
      "https://api.github.com/repos/hivemoot/colony/issues/42",
      "Issue",
    );

    expect(result).toEqual({
      comments: [
        {
          body: "@hivemoot-worker one",
          author: "dmitry",
          htmlUrl: "https://github.com/hivemoot/colony/issues/42#issuecomment-1",
        },
      ],
      permanentFailure: false,
    });
    expect(mockedGh).toHaveBeenCalledTimes(1);
  });

  it("fetches and merges issue + review comments for pull requests", async () => {
    mockedGh.mockResolvedValueOnce(JSON.stringify([
      {
        body: "@hivemoot-worker issue comment",
        author: "dmitry",
        htmlUrl: "https://github.com/hivemoot/colony/pull/42#issuecomment-1",
      },
    ]));
    mockedGh.mockResolvedValueOnce(JSON.stringify([
      {
        body: "@hivemoot-worker review comment",
        author: "alice",
        htmlUrl: "https://github.com/hivemoot/colony/pull/42#discussion_r1",
      },
    ]));

    const result = await fetchRecentSubjectComments(
      "https://api.github.com/repos/hivemoot/colony/pulls/42",
      "PullRequest",
    );

    expect(result.comments).toHaveLength(2);
    expect(result.permanentFailure).toBe(false);
    expect(mockedGh).toHaveBeenCalledTimes(2);
  });

  it("applies a lower-bound timestamp when provided", async () => {
    mockedGh.mockResolvedValueOnce(JSON.stringify([
      {
        body: "@hivemoot-worker old mention",
        author: "dmitry",
        htmlUrl: "https://github.com/hivemoot/colony/issues/42#issuecomment-1",
        createdAt: "2026-02-01T10:00:00.000Z",
        updatedAt: "2026-02-01T10:00:00.000Z",
      },
      {
        body: "@hivemoot-worker new mention",
        author: "dmitry",
        htmlUrl: "https://github.com/hivemoot/colony/issues/42#issuecomment-2",
        createdAt: "2026-02-01T12:00:00.000Z",
        updatedAt: "2026-02-01T12:00:00.000Z",
      },
    ]));

    const since = "2026-02-01T11:00:00.000Z";
    const result = await fetchRecentSubjectComments(
      "https://api.github.com/repos/hivemoot/colony/issues/42",
      "Issue",
      since,
    );

    expect(result).toEqual({
      comments: [
        {
          body: "@hivemoot-worker new mention",
          author: "dmitry",
          htmlUrl: "https://github.com/hivemoot/colony/issues/42#issuecomment-2",
          createdAt: "2026-02-01T12:00:00.000Z",
          updatedAt: "2026-02-01T12:00:00.000Z",
        },
      ],
      permanentFailure: false,
    });

    const firstCall = mockedGh.mock.calls[0]?.[0] ?? [];
    expect(firstCall[1]).toContain("since=2026-02-01T11%3A00%3A00.000Z");
  });

  it("returns permanent failure for invalid subject URL", async () => {
    const result = await fetchRecentSubjectComments("not-a-url", "Issue");
    expect(result).toEqual({
      comments: null,
      permanentFailure: true,
    });
    expect(mockedGh).not.toHaveBeenCalled();
  });

  it("classifies 403 as permanent failure", async () => {
    mockedGh.mockRejectedValue(new CliError("gh: Forbidden (HTTP 403)", "GH_ERROR", 1));

    const result = await fetchRecentSubjectComments(
      "https://api.github.com/repos/hivemoot/colony/issues/42",
      "Issue",
    );

    expect(result).toEqual({
      comments: null,
      permanentFailure: true,
    });
  });
});

describe("fetchReviewRequestState()", () => {
  it("returns pending with a stable request id for the matching reviewer", async () => {
    mockedGh.mockResolvedValue(JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewRequests: {
              nodes: [
                {
                  id: "RR_node_1",
                  databaseId: 9001,
                  requestedReviewer: {
                    __typename: "User",
                    login: "hivemoot-worker",
                  },
                },
              ],
            },
          },
        },
      },
    }));

    const result = await fetchReviewRequestState("hivemoot", "colony", 42, "hivemoot-worker");

    expect(result).toEqual({
      pending: true,
      requestId: "9001",
      permanentFailure: false,
      transientFailure: false,
    });
    expect(mockedGh).toHaveBeenCalledWith([
      "api",
      "graphql",
      "-F", "owner=hivemoot",
      "-F", "repo=colony",
      "-F", "pullNumber=42",
      "-f", expect.stringContaining("reviewRequests(first: 100)"),
    ]);
  });

  it("matches reviewer login case-insensitively", async () => {
    mockedGh.mockResolvedValue(JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewRequests: {
              nodes: [
                {
                  id: "RR_node_1",
                  databaseId: 9001,
                  requestedReviewer: {
                    __typename: "User",
                    login: "Hivemoot-Worker",
                  },
                },
              ],
            },
          },
        },
      },
    }));

    const result = await fetchReviewRequestState("hivemoot", "colony", 42, "hivemoot-worker");
    expect(result.pending).toBe(true);
    expect(result.requestId).toBe("9001");
  });

  it("falls back to the GraphQL node id when databaseId is absent", async () => {
    mockedGh.mockResolvedValue(JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewRequests: {
              nodes: [
                {
                  id: "RR_node_1",
                  databaseId: null,
                  requestedReviewer: {
                    __typename: "User",
                    login: "hivemoot-worker",
                  },
                },
              ],
            },
          },
        },
      },
    }));

    const result = await fetchReviewRequestState("hivemoot", "colony", 42, "hivemoot-worker");
    expect(result.requestId).toBe("RR_node_1");
  });

  it("returns not pending when the reviewer is not currently requested", async () => {
    mockedGh.mockResolvedValue(JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewRequests: {
              nodes: [
                {
                  id: "RR_node_1",
                  databaseId: 9001,
                  requestedReviewer: {
                    __typename: "User",
                    login: "someone-else",
                  },
                },
              ],
            },
          },
        },
      },
    }));

    const result = await fetchReviewRequestState("hivemoot", "colony", 42, "hivemoot-worker");

    expect(result).toEqual({
      pending: false,
      permanentFailure: false,
      transientFailure: false,
    });
  });

  it("returns permanent failure when the pull request cannot be resolved", async () => {
    mockedGh.mockResolvedValue(JSON.stringify({
      data: {
        repository: {
          pullRequest: null,
        },
      },
    }));

    const result = await fetchReviewRequestState("hivemoot", "colony", 42, "hivemoot-worker");

    expect(result).toEqual({
      pending: false,
      permanentFailure: true,
      transientFailure: false,
    });
  });

  it("classifies 404 as permanent failure", async () => {
    mockedGh.mockRejectedValue(new CliError("gh: Not Found (HTTP 404)", "GH_ERROR", 1));

    const result = await fetchReviewRequestState("hivemoot", "colony", 42, "hivemoot-worker");

    expect(result).toEqual({
      pending: false,
      permanentFailure: true,
      transientFailure: false,
    });
  });

  it("classifies other fetch failures as transient", async () => {
    mockedGh.mockRejectedValue(new Error("network timeout"));

    const result = await fetchReviewRequestState("hivemoot", "colony", 42, "hivemoot-worker");

    expect(result).toEqual({
      pending: false,
      permanentFailure: false,
      transientFailure: true,
    });
  });
});

describe("fetchLatestReviewRequestEvent()", () => {
  it("returns the newest matching review_requested event with requester metadata", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[
      {
        id: 7001,
        event: "review_requested",
        created_at: "2026-03-10T12:00:00Z",
        review_requester: { login: "maintainer-a" },
        requested_reviewer: { login: "hivemoot-worker" },
      },
      {
        id: 7002,
        event: "review_requested",
        created_at: "2026-03-10T12:05:00Z",
        review_requester: { login: "maintainer-b" },
        requested_reviewer: { login: "hivemoot-worker" },
      },
      {
        id: 7003,
        event: "review_requested",
        created_at: "2026-03-10T12:06:00Z",
        review_requester: { login: "maintainer-c" },
        requested_reviewer: { login: "someone-else" },
      },
    ]]));

    const result = await fetchLatestReviewRequestEvent("hivemoot", "colony", 42, "hivemoot-worker");

    expect(result).toEqual({
      eventId: "7002",
      requester: "maintainer-b",
      reviewer: "hivemoot-worker",
      permanentFailure: false,
      transientFailure: false,
    });
    expect(mockedGh).toHaveBeenCalledWith([
      "api",
      "--paginate",
      "--slurp",
      "/repos/hivemoot/colony/issues/42/events?per_page=100",
    ]);
  });

  it("matches reviewer login case-insensitively and falls back to actor when review_requester is absent", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[
      {
        id: 7001,
        event: "review_requested",
        created_at: "2026-03-10T12:05:00Z",
        actor: { login: "maintainer-a" },
        requested_reviewer: { login: "Hivemoot-Worker" },
      },
    ]]));

    const result = await fetchLatestReviewRequestEvent("hivemoot", "colony", 42, "hivemoot-worker");

    expect(result).toEqual({
      eventId: "7001",
      requester: "maintainer-a",
      reviewer: "Hivemoot-Worker",
      permanentFailure: false,
      transientFailure: false,
    });
  });

  it("returns empty metadata when no matching review_requested event is present", async () => {
    mockedGh.mockResolvedValue(JSON.stringify([[
      {
        id: 7001,
        event: "review_request_removed",
        created_at: "2026-03-10T12:05:00Z",
        review_requester: { login: "maintainer-a" },
        requested_reviewer: { login: "hivemoot-worker" },
      },
    ]]));

    const result = await fetchLatestReviewRequestEvent("hivemoot", "colony", 42, "hivemoot-worker");

    expect(result).toEqual({
      permanentFailure: false,
      transientFailure: false,
    });
  });

  it("classifies 404 as permanent failure", async () => {
    mockedGh.mockRejectedValue(new CliError("gh: Not Found (HTTP 404)", "GH_ERROR", 1));

    const result = await fetchLatestReviewRequestEvent("hivemoot", "colony", 42, "hivemoot-worker");

    expect(result).toEqual({
      permanentFailure: true,
      transientFailure: false,
    });
  });

  it("classifies other fetch failures as transient", async () => {
    mockedGh.mockRejectedValue(new Error("network timeout"));

    const result = await fetchLatestReviewRequestEvent("hivemoot", "colony", 42, "hivemoot-worker");

    expect(result).toEqual({
      permanentFailure: false,
      transientFailure: true,
    });
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

  it("includes trigger metadata when provided", () => {
    const event = buildMentionEvent(baseNotification, null, "hivemoot-worker", {
      trigger: "review_requested",
      requester: "maintainer",
      reviewer: "hivemoot-worker",
    });

    expect(event?.trigger).toBe("review_requested");
    expect(event?.requester).toBe("maintainer");
    expect(event?.reviewer).toBe("hivemoot-worker");
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

describe("fetchMentionNotificationsConditional()", () => {
  function makeRawNotification(overrides: Partial<RawNotification> = {}): RawNotification {
    return {
      id: "101",
      unread: true,
      reason: "mention",
      updated_at: "2026-03-10T12:00:00Z",
      subject: {
        url: "https://api.github.com/repos/hivemoot/colony/issues/42",
        type: "Issue",
        title: "Test issue",
        latest_comment_url: "https://api.github.com/repos/hivemoot/colony/issues/comments/99",
      },
      repository: { full_name: "hivemoot/colony" },
      ...overrides,
    };
  }

  // Probe response: only headers matter; probe body is ignored.
  function makeProbeResponse(extraHeaders: Record<string, string> = {}) {
    return {
      notModified: false as const,
      headers: {
        "content-type": "application/json",
        ...extraHeaders,
      },
      body: "[]",
    };
  }

  // Mock both the conditional probe (ghWithHeaders) and the paginated fetch (gh).
  function mockSuccessfulFetch(
    notifications: RawNotification[],
    extraHeaders: Record<string, string> = {},
  ) {
    mockedGhWithHeaders.mockResolvedValue(makeProbeResponse(extraHeaders));
    // --paginate --slurp wraps each page in an outer array
    mockedGh.mockResolvedValue(JSON.stringify([notifications]));
  }

  it("returns notModified: false with filtered notifications on success", async () => {
    const notification = makeRawNotification();
    mockSuccessfulFetch([notification]);

    const result = await fetchMentionNotificationsConditional("hivemoot/colony", ["mention"]);

    expect(result.notModified).toBe(false);
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].id).toBe("101");
  });

  it("passes If-Modified-Since header to probe when lastModified is provided", async () => {
    mockSuccessfulFetch([]);

    await fetchMentionNotificationsConditional("hivemoot/colony", ["mention"], "Mon, 10 Mar 2026 10:00:00 GMT");

    expect(mockedGhWithHeaders).toHaveBeenCalledWith(
      expect.arrayContaining([
        "-H",
        "If-Modified-Since: Mon, 10 Mar 2026 10:00:00 GMT",
      ]),
    );
  });

  it("does not pass If-Modified-Since when lastModified is absent", async () => {
    mockSuccessfulFetch([]);

    await fetchMentionNotificationsConditional("hivemoot/colony", ["mention"]);

    const callArgs = mockedGhWithHeaders.mock.calls[0][0] as string[];
    expect(callArgs).not.toContain("If-Modified-Since:");
    expect(callArgs).not.toContain("-H");
  });

  it("returns notModified: true immediately on 304 without making paginated fetch", async () => {
    mockedGhWithHeaders.mockResolvedValue({ notModified: true });

    const result = await fetchMentionNotificationsConditional(
      "hivemoot/colony",
      ["mention"],
      "Mon, 10 Mar 2026 10:00:00 GMT",
    );

    expect(result.notModified).toBe(true);
    expect(result.notifications).toHaveLength(0);
    expect(mockedGh).not.toHaveBeenCalled();
  });

  it("extracts Last-Modified from probe response headers", async () => {
    mockSuccessfulFetch([], { "last-modified": "Mon, 10 Mar 2026 12:00:00 GMT" });

    const result = await fetchMentionNotificationsConditional("hivemoot/colony", ["mention"]);

    expect(result.lastModified).toBe("Mon, 10 Mar 2026 12:00:00 GMT");
  });

  it("extracts X-Poll-Interval from probe response headers", async () => {
    mockSuccessfulFetch([], { "x-poll-interval": "60" });

    const result = await fetchMentionNotificationsConditional("hivemoot/colony", ["mention"]);

    expect(result.pollInterval).toBe(60);
  });

  it("leaves pollInterval undefined when X-Poll-Interval header is absent", async () => {
    mockSuccessfulFetch([]);

    const result = await fetchMentionNotificationsConditional("hivemoot/colony", ["mention"]);

    expect(result.pollInterval).toBeUndefined();
  });

  it("makes paginated fetch with --paginate --slurp after 200 probe", async () => {
    mockSuccessfulFetch([]);

    await fetchMentionNotificationsConditional("hivemoot/colony", ["mention"]);

    expect(mockedGh).toHaveBeenCalledWith(
      expect.arrayContaining(["--paginate", "--slurp"]),
    );
    // Paginated fetch must NOT send If-Modified-Since (it's unconditional)
    const paginatedArgs = mockedGh.mock.calls[0][0] as string[];
    expect(paginatedArgs.join(" ")).not.toContain("If-Modified-Since");
  });

  it("flattens multiple pages from paginated fetch, returning all notifications", async () => {
    const page1 = [makeRawNotification({ id: "101" })];
    const page2 = [makeRawNotification({ id: "102" })];
    mockedGhWithHeaders.mockResolvedValue(makeProbeResponse());
    // --paginate --slurp produces an array of page-arrays
    mockedGh.mockResolvedValue(JSON.stringify([page1, page2]));

    const result = await fetchMentionNotificationsConditional("hivemoot/colony", ["mention"]);

    expect(result.notifications).toHaveLength(2);
    expect(result.notifications.map((n) => n.id)).toEqual(["101", "102"]);
  });

  it("filters out read notifications", async () => {
    const unread = makeRawNotification({ id: "101", unread: true });
    const read = makeRawNotification({ id: "102", unread: false });
    mockSuccessfulFetch([unread, read]);

    const result = await fetchMentionNotificationsConditional("hivemoot/colony", ["mention"]);

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].id).toBe("101");
  });

  it("filters by reason", async () => {
    const mention = makeRawNotification({ id: "101", reason: "mention" });
    const comment = makeRawNotification({ id: "102", reason: "comment" });
    mockSuccessfulFetch([mention, comment]);

    const result = await fetchMentionNotificationsConditional("hivemoot/colony", ["mention"]);

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].id).toBe("101");
  });

  it("throws on paginated body parse failure so caller does not advance lastModified", async () => {
    mockedGhWithHeaders.mockResolvedValue(makeProbeResponse());
    mockedGh.mockResolvedValue("not valid json");

    await expect(
      fetchMentionNotificationsConditional("hivemoot/colony", ["mention"]),
    ).rejects.toMatchObject({ code: "GH_ERROR" });
  });

  it("throws when paginated response is valid JSON but not an array", async () => {
    mockedGhWithHeaders.mockResolvedValue(makeProbeResponse());
    mockedGh.mockResolvedValue(JSON.stringify({ error: "oops" }));

    await expect(
      fetchMentionNotificationsConditional("hivemoot/colony", ["mention"]),
    ).rejects.toMatchObject({ code: "GH_ERROR" });
  });
});
