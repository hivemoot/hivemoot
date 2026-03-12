import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WatchState } from "../watch/state.js";
import type { RawNotification, CommentDetail } from "../github/notifications.js";
import type { MentionEvent } from "../config/types.js";
import { CliError } from "../config/types.js";

vi.mock("../github/user.js", () => ({
  fetchCurrentUser: vi.fn(),
}));

vi.mock("../github/notifications.js", () => ({
  fetchMentionNotifications: vi.fn(),
  fetchCommentBody: vi.fn(),
  fetchRecentSubjectComments: vi.fn(),
  fetchLatestReviewRequestEvent: vi.fn(),
  fetchReviewRequestState: vi.fn(),
  fetchSubjectBodyResult: vi.fn(),
  buildMentionEvent: vi.fn(),
  isAgentMentioned: vi.fn(),
  parseSubjectNumber: vi.fn(),
}));

vi.mock("../watch/state.js", async (importOriginal) => {
  const original = await importOriginal() as typeof import("../watch/state.js");
  return {
    ...original,
    loadState: vi.fn(),
    saveState: vi.fn(),
    mergeAckJournal: vi.fn(),
  };
});

import { watchCommand } from "./watch.js";
import { fetchCurrentUser } from "../github/user.js";
import {
  fetchMentionNotifications,
  fetchCommentBody,
  fetchRecentSubjectComments,
  fetchLatestReviewRequestEvent,
  fetchReviewRequestState,
  fetchSubjectBodyResult,
  buildMentionEvent,
  isAgentMentioned,
  parseSubjectNumber,
} from "../github/notifications.js";
import { loadState, saveState, mergeAckJournal } from "../watch/state.js";

const mockedFetchUser = vi.mocked(fetchCurrentUser);
const mockedFetchMentions = vi.mocked(fetchMentionNotifications);
const mockedFetchComment = vi.mocked(fetchCommentBody);
const mockedFetchRecentComments = vi.mocked(fetchRecentSubjectComments);
const mockedFetchLatestReviewRequestEvent = vi.mocked(fetchLatestReviewRequestEvent);
const mockedFetchReviewRequestState = vi.mocked(fetchReviewRequestState);
const mockedFetchSubjectResult = vi.mocked(fetchSubjectBodyResult);
const mockedBuildEvent = vi.mocked(buildMentionEvent);
const mockedIsAgentMentioned = vi.mocked(isAgentMentioned);
const mockedParseSubjectNumber = vi.mocked(parseSubjectNumber);
const mockedLoadState = vi.mocked(loadState);
const mockedSaveState = vi.mocked(saveState);
const mockedMergeAckJournal = vi.mocked(mergeAckJournal);

function makeNotification(overrides: Partial<RawNotification> = {}): RawNotification {
  return {
    id: "1001",
    unread: true,
    reason: "mention",
    updated_at: "2026-02-01T11:30:00.000Z",
    subject: {
      url: "https://api.github.com/repos/owner/repo/issues/42",
      type: "Issue",
      title: "Test issue",
      latest_comment_url: "https://api.github.com/repos/owner/repo/issues/comments/999",
    },
    repository: {
      full_name: "owner/repo",
    },
    ...overrides,
  };
}

function makeEvent(overrides: Partial<MentionEvent> = {}): MentionEvent {
  return {
    agent: "test-agent",
    repo: "owner/repo",
    number: 42,
    type: "Issue",
    title: "Test issue",
    author: "someone",
    body: "@test-agent look at this",
    url: "https://github.com/owner/repo/issues/42#issuecomment-999",
    threadId: "1001",
    timestamp: "2026-02-01T11:30:00.000Z",
    ...overrides,
  };
}

function defaultState(overrides: Partial<WatchState> = {}): WatchState {
  return {
    lastChecked: "2026-02-01T10:00:00.000Z",
    processedThreadIds: [],
    ...overrides,
  };
}

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  // Default happy-path mocks
  mockedFetchUser.mockResolvedValue("test-agent");
  mockedLoadState.mockResolvedValue(defaultState());
  mockedSaveState.mockResolvedValue(undefined);
  mockedFetchMentions.mockResolvedValue([]);
  mockedIsAgentMentioned.mockReturnValue(true);
  mockedFetchRecentComments.mockResolvedValue({
    comments: [],
    permanentFailure: false,
  });
  mockedFetchLatestReviewRequestEvent.mockResolvedValue({
    eventId: "7001",
    requester: "maintainer",
    reviewer: "test-agent",
    permanentFailure: false,
    transientFailure: false,
  });
  mockedFetchReviewRequestState.mockResolvedValue({
    pending: true,
    requestId: "9001",
    permanentFailure: false,
    transientFailure: false,
  });
  mockedFetchSubjectResult.mockResolvedValue({
    detail: {
      body: "@test-agent issue body mention",
      author: "owner",
      htmlUrl: "https://github.com/owner/repo/issues/42",
    },
    permanentFailure: false,
  });
  mockedParseSubjectNumber.mockImplementation((url: string) => {
    const match = url.match(/\/(\d+)$/);
    return match ? Number(match[1]) : undefined;
  });
  // mergeAckJournal returns the state unchanged by default
  mockedMergeAckJournal.mockImplementation(async (_path, state) => state);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  vi.useRealTimers();
});

describe("watchCommand (--once mode)", () => {
  it("emits event to stdout without marking notification as read", async () => {
    const notification = makeNotification();
    const comment: CommentDetail = {
      body: "@test-agent look at this",
      author: "someone",
      htmlUrl: "https://github.com/owner/repo/issues/42#issuecomment-999",
    };
    const event = makeEvent();

    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchComment.mockResolvedValue(comment);
    mockedBuildEvent.mockReturnValue(event);

    await watchCommand({ repo: "owner/repo", once: true });

    expect(mockedFetchMentions).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).toHaveBeenCalledWith(JSON.stringify(event) + "\n");
    // Notification should NOT be marked read — that's the ack command's job
    expect(mockedSaveState).toHaveBeenCalled();
  });

  it("calls fetchMentionNotifications without since parameter", async () => {
    await watchCommand({ repo: "owner/repo", once: true });

    expect(mockedFetchMentions).toHaveBeenCalledWith(
      "owner/repo",
      ["mention"],
    );
  });

  it("merges ack journal at start of poll", async () => {
    // Simulate ack journal returning state with a processed key
    mockedMergeAckJournal.mockImplementation(async (_path, state) => ({
      ...state,
      processedThreadIds: [...state.processedThreadIds, "1001:2026-02-01T11:30:00.000Z"],
    }));

    // This notification matches the acked key — should be skipped
    const notification = makeNotification();
    mockedFetchMentions.mockResolvedValue([notification]);

    await watchCommand({ repo: "owner/repo", once: true });

    expect(mockedMergeAckJournal).toHaveBeenCalledWith(
      ".hivemoot-watch.json",
      expect.objectContaining({ processedThreadIds: [] }),
    );
    // Should skip — no comment fetch, no event build
    expect(mockedFetchComment).not.toHaveBeenCalled();
    expect(mockedBuildEvent).not.toHaveBeenCalled();
  });

  it("re-emits un-acked notification on next poll", async () => {
    // No ack journal entries — mergeAckJournal returns state unchanged
    mockedMergeAckJournal.mockImplementation(async (_path, state) => state);

    const notification = makeNotification();
    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchComment.mockResolvedValue({
      body: "test",
      author: "user",
      htmlUrl: "http://example.com",
    });
    mockedBuildEvent.mockReturnValue(makeEvent());

    await watchCommand({ repo: "owner/repo", once: true });

    // Event should be emitted since nothing was acked
    expect(mockedBuildEvent).toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('"agent"'));
  });

  it("uses composite key (threadId:updated_at) — new activity on same thread is processed", async () => {
    // State already has this thread processed with an older updated_at
    mockedLoadState.mockResolvedValue(
      defaultState({ processedThreadIds: ["1001:2026-02-01T09:00:00.000Z"] }),
    );

    // Same thread ID, but newer updated_at — should be treated as new event
    const notification = makeNotification({ updated_at: "2026-02-01T11:30:00.000Z" });
    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchComment.mockResolvedValue({
      body: "new mention",
      author: "someone",
      htmlUrl: "https://github.com/owner/repo/issues/42#issuecomment-1000",
    });
    mockedBuildEvent.mockReturnValue(makeEvent());

    await watchCommand({ repo: "owner/repo", once: true });

    // Should have processed the notification (not skipped it)
    expect(mockedBuildEvent).toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('"agent"'));
  });

  it("sets lastChecked to pre-fetch time, not post-processing time", async () => {
    vi.useFakeTimers({ now: new Date("2026-02-01T12:00:00.000Z") });

    mockedLoadState.mockResolvedValue(defaultState());

    mockedFetchMentions.mockImplementation(async () => {
      // Simulate 5 seconds of network latency
      vi.advanceTimersByTime(5000);
      return [makeNotification()];
    });
    mockedFetchComment.mockImplementation(async () => {
      // Simulate 3 seconds of comment-fetch latency
      vi.advanceTimersByTime(3000);
      return { body: "test", author: "user", htmlUrl: "http://example.com" };
    });
    mockedBuildEvent.mockReturnValue(makeEvent());

    await watchCommand({ repo: "owner/repo", once: true });

    // lastChecked should be 12:00:00 (captured before fetch),
    // not 12:00:08 (after all processing completed)
    expect(mockedSaveState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        lastChecked: "2026-02-01T12:00:00.000Z",
      }),
    );
  });

  it("throws CliError when poll fails in --once mode", async () => {
    mockedFetchMentions.mockRejectedValue(new Error("API timeout"));

    try {
      await watchCommand({ repo: "owner/repo", once: true });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toBe("Poll failed: API timeout");
      expect((err as CliError).exitCode).toBe(1);
    }
  });

  it("preserves CliError code and exitCode when poll throws CliError", async () => {
    mockedFetchMentions.mockRejectedValue(
      new CliError("Rate limited", "RATE_LIMITED", 3),
    );

    try {
      await watchCommand({ repo: "owner/repo", once: true });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe("RATE_LIMITED");
      expect((err as CliError).exitCode).toBe(3);
    }
  });

  it("retries when comment fetch returns null (does not mark processed)", async () => {
    const notification = makeNotification();
    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchComment.mockResolvedValue(null);

    await watchCommand({ repo: "owner/repo", once: true });

    // Null-comment gate catches it before buildMentionEvent
    expect(mockedBuildEvent).not.toHaveBeenCalled();
    const eventWrites = (stdoutSpy.mock.calls as [string][])
      .map(([s]) => s)
      .filter((s) => s.includes('"agent"'));
    expect(eventWrites).toHaveLength(0);

    // Not marked processed — will retry next poll (transient API failure)
    expect(mockedSaveState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        processedThreadIds: [],
      }),
    );
  });

  it("rejects invalid --repo format", async () => {
    await expect(
      watchCommand({ repo: "invalid-repo-format" }),
    ).rejects.toThrow(CliError);
  });

  it("rejects when fetchCurrentUser fails", async () => {
    mockedFetchUser.mockRejectedValue(new Error("not authenticated"));

    await expect(
      watchCommand({ repo: "owner/repo", once: true }),
    ).rejects.toThrow("Could not determine GitHub user");
  });

  it("skips stale-thread mention (agent not in comment body)", async () => {
    const notification = makeNotification({ reason: "mention" });
    const comment: CommentDetail = {
      body: "@hivemoot-scout please review",
      author: "someone",
      htmlUrl: "https://github.com/owner/repo/issues/42#issuecomment-999",
    };

    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchComment.mockResolvedValue(comment);
    mockedIsAgentMentioned.mockReturnValue(false);

    await watchCommand({ repo: "owner/repo", once: true });

    // Should NOT build or emit an event
    expect(mockedBuildEvent).not.toHaveBeenCalled();
    const eventWrites = (stdoutSpy.mock.calls as [string][])
      .map(([s]) => s)
      .filter((s) => s.includes('"agent"'));
    expect(eventWrites).toHaveLength(0);

    // Stale mention is marked processed (won't retry)
    expect(mockedSaveState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        processedThreadIds: ["1001:2026-02-01T11:30:00.000Z"],
      }),
    );
  });

  it("emits event when agent is actually mentioned", async () => {
    const notification = makeNotification({ reason: "mention" });
    const comment: CommentDetail = {
      body: "@test-agent look at this",
      author: "someone",
      htmlUrl: "https://github.com/owner/repo/issues/42#issuecomment-999",
    };
    const event = makeEvent();

    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchComment.mockResolvedValue(comment);
    mockedIsAgentMentioned.mockReturnValue(true);
    mockedBuildEvent.mockReturnValue(event);

    await watchCommand({ repo: "owner/repo", once: true });

    expect(mockedIsAgentMentioned).toHaveBeenCalledWith(comment.body, "test-agent");
    expect(stdoutSpy).toHaveBeenCalledWith(JSON.stringify(event) + "\n");
  });

  it("bypasses mention check for non-mention reasons", async () => {
    const notification = makeNotification({ reason: "comment" });
    const comment: CommentDetail = {
      body: "some comment that does NOT mention agent",
      author: "someone",
      htmlUrl: "https://github.com/owner/repo/issues/42#issuecomment-999",
    };
    const event = makeEvent();

    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchComment.mockResolvedValue(comment);
    mockedBuildEvent.mockReturnValue(event);

    await watchCommand({ repo: "owner/repo", once: true, reasons: "comment" });

    // isAgentMentioned should NOT be called for reason="comment"
    expect(mockedIsAgentMentioned).not.toHaveBeenCalled();
    // Event should still be emitted
    expect(stdoutSpy).toHaveBeenCalledWith(JSON.stringify(event) + "\n");
  });

  it("finds a matching mention in recent comments when latest comment targets another agent", async () => {
    const notification = makeNotification({ reason: "mention" });
    const latestComment: CommentDetail = {
      body: "@agent-b do this",
      author: "someone",
      htmlUrl: "https://github.com/owner/repo/issues/42#issuecomment-1000",
    };
    const matchingComment: CommentDetail = {
      body: "@test-agent do that",
      author: "someone",
      htmlUrl: "https://github.com/owner/repo/issues/42#issuecomment-999",
    };
    const event = makeEvent({ body: matchingComment.body, url: matchingComment.htmlUrl });

    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchComment.mockResolvedValue(latestComment);
    mockedFetchRecentComments.mockResolvedValue({
      comments: [matchingComment],
      permanentFailure: false,
    });
    mockedIsAgentMentioned.mockImplementation((body, agent) => body.includes(`@${agent}`));
    mockedBuildEvent.mockReturnValue(event);

    await watchCommand({ repo: "owner/repo", once: true });

    expect(mockedFetchRecentComments).toHaveBeenCalledWith(
      notification.subject.url,
      notification.subject.type,
      undefined,
    );
    expect(mockedBuildEvent).toHaveBeenCalledWith(notification, matchingComment, "test-agent");
    expect(stdoutSpy).toHaveBeenCalledWith(JSON.stringify(event) + "\n");
  });

  it("bounds fallback scan using the last processed timestamp for the thread", async () => {
    mockedLoadState.mockResolvedValue(
      defaultState({ processedThreadIds: ["1001:2026-02-01T11:30:00.000Z"] }),
    );

    const notification = makeNotification({ updated_at: "2026-02-01T12:30:00.000Z" });
    const latestComment: CommentDetail = {
      body: "@agent-b do this",
      author: "someone",
      htmlUrl: "https://github.com/owner/repo/issues/42#issuecomment-1000",
    };

    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchComment.mockResolvedValue(latestComment);
    // Simulates fetchRecentSubjectComments filtering out older historical mentions.
    mockedFetchRecentComments.mockResolvedValue({
      comments: [],
      permanentFailure: false,
    });
    mockedIsAgentMentioned.mockImplementation((body, agent) => body.includes(`@${agent}`));

    await watchCommand({ repo: "owner/repo", once: true });

    expect(mockedFetchRecentComments).toHaveBeenCalledWith(
      notification.subject.url,
      notification.subject.type,
      "2026-02-01T11:30:00.000Z",
    );
    expect(mockedBuildEvent).not.toHaveBeenCalled();
    expect(mockedSaveState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        processedThreadIds: [
          "1001:2026-02-01T11:30:00.000Z",
          "1001:2026-02-01T12:30:00.000Z",
        ],
      }),
    );
  });

  it("emits event when no comment URL exists and issue body mentions agent", async () => {
    const notification = makeNotification({
      subject: {
        url: "https://api.github.com/repos/owner/repo/issues/42",
        type: "Issue",
        title: "Test issue",
        latest_comment_url: null,
      },
    });
    const event = makeEvent();
    const subjectBody: CommentDetail = {
      body: "@test-agent please check",
      author: "owner",
      htmlUrl: "https://github.com/owner/repo/issues/42",
    };

    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchSubjectResult.mockResolvedValue({
      detail: subjectBody,
      permanentFailure: false,
    });
    mockedIsAgentMentioned.mockReturnValue(true);
    mockedBuildEvent.mockReturnValue(event);

    await watchCommand({ repo: "owner/repo", once: true });

    // No comment fetch when there's no URL
    expect(mockedFetchComment).not.toHaveBeenCalled();
    expect(mockedFetchSubjectResult).toHaveBeenCalledWith(notification.subject.url);
    expect(mockedIsAgentMentioned).toHaveBeenCalledWith(subjectBody.body, "test-agent");
    expect(mockedBuildEvent).toHaveBeenCalledWith(notification, subjectBody, "test-agent");
    expect(stdoutSpy).toHaveBeenCalledWith(JSON.stringify(event) + "\n");
  });

  it("skips stale mention when no comment URL exists and issue body does not mention agent", async () => {
    const notification = makeNotification({
      subject: {
        url: "https://api.github.com/repos/owner/repo/issues/42",
        type: "Issue",
        title: "Test issue",
        latest_comment_url: null,
      },
    });
    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchSubjectResult.mockResolvedValue({
      detail: {
        body: "@someone-else check this",
        author: "owner",
        htmlUrl: "https://github.com/owner/repo/issues/42",
      },
      permanentFailure: false,
    });
    mockedIsAgentMentioned.mockReturnValue(false);

    await watchCommand({ repo: "owner/repo", once: true });

    expect(mockedBuildEvent).not.toHaveBeenCalled();
    const eventWrites = (stdoutSpy.mock.calls as [string][])
      .map(([s]) => s)
      .filter((s) => s.includes('"agent"'));
    expect(eventWrites).toHaveLength(0);
    expect(mockedSaveState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        processedThreadIds: ["1001:2026-02-01T11:30:00.000Z"],
      }),
    );
  });

  it("finds mention in thread comment when latest_comment_url is null and body does not mention agent", async () => {
    const notification = makeNotification({
      subject: {
        url: "https://api.github.com/repos/owner/repo/pulls/67",
        type: "PullRequest",
        title: "Test PR",
        latest_comment_url: null,
      },
    });
    const matchingComment: CommentDetail = {
      body: "@test-agent deep research and review",
      author: "someone",
      htmlUrl: "https://github.com/owner/repo/pull/67#issuecomment-999",
      createdAt: "2026-02-01T11:29:00.000Z",
      updatedAt: "2026-02-01T11:29:00.000Z",
    };
    const event = makeEvent({ body: matchingComment.body, url: matchingComment.htmlUrl });

    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchSubjectResult.mockResolvedValue({
      detail: {
        body: "PR description without any mention",
        author: "owner",
        htmlUrl: "https://github.com/owner/repo/pull/67",
      },
      permanentFailure: false,
    });
    mockedIsAgentMentioned.mockImplementation((body, agent) => body.includes(`@${agent}`));
    mockedFetchRecentComments.mockResolvedValue({
      comments: [matchingComment],
      permanentFailure: false,
    });
    mockedBuildEvent.mockReturnValue(event);

    await watchCommand({ repo: "owner/repo", once: true });

    // Should fall through body check → scan thread comments → find mention
    expect(mockedFetchSubjectResult).toHaveBeenCalledWith(notification.subject.url);
    expect(mockedFetchRecentComments).toHaveBeenCalledWith(
      notification.subject.url,
      notification.subject.type,
      undefined,
    );
    expect(mockedBuildEvent).toHaveBeenCalledWith(notification, matchingComment, "test-agent");
    expect(stdoutSpy).toHaveBeenCalledWith(JSON.stringify(event) + "\n");
  });

  it("retries when issue/PR body fetch fails for no-comment mention event", async () => {
    const notification = makeNotification({
      subject: {
        url: "https://api.github.com/repos/owner/repo/issues/42",
        type: "Issue",
        title: "Test issue",
        latest_comment_url: null,
      },
    });
    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchSubjectResult.mockResolvedValue({
      detail: null,
      permanentFailure: false,
    });

    await watchCommand({ repo: "owner/repo", once: true });

    expect(mockedBuildEvent).not.toHaveBeenCalled();
    expect(mockedSaveState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        processedThreadIds: [],
      }),
    );
  });

  it("marks processed when issue/PR body fetch fails permanently", async () => {
    const notification = makeNotification({
      subject: {
        url: "https://api.github.com/repos/owner/repo/issues/42",
        type: "Issue",
        title: "Test issue",
        latest_comment_url: null,
      },
    });
    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchSubjectResult.mockResolvedValue({
      detail: null,
      permanentFailure: true,
    });

    await watchCommand({ repo: "owner/repo", once: true });

    expect(mockedBuildEvent).not.toHaveBeenCalled();
    expect(mockedSaveState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        processedThreadIds: ["1001:2026-02-01T11:30:00.000Z"],
      }),
    );
  });
});

describe("watchCommand (review_requested)", () => {
  function makePrNotification(overrides: Partial<RawNotification> = {}): RawNotification {
    return makeNotification({
      reason: "review_requested",
      subject: {
        url: "https://api.github.com/repos/owner/repo/pulls/99",
        type: "PullRequest",
        title: "Add feature X",
        latest_comment_url: null,
      },
      ...overrides,
    });
  }

  it("emits an event when the authenticated user has a new active review request", async () => {
    const notification = makePrNotification();
    const event = makeEvent({
      number: 99,
      type: "PullRequest",
      title: "Add feature X",
      author: "unknown",
      body: "",
      url: "",
      trigger: "review_requested",
    });

    mockedFetchMentions.mockResolvedValue([notification]);
    mockedBuildEvent.mockReturnValue(event);
    mockedFetchReviewRequestState.mockResolvedValue({
      pending: true,
      requestId: "9001",
      permanentFailure: false,
      transientFailure: false,
    });

    await watchCommand({ repo: "owner/repo", once: true, reasons: "review_requested" });

    expect(mockedFetchReviewRequestState).toHaveBeenCalledWith("owner", "repo", 99, "test-agent");
    expect(mockedFetchLatestReviewRequestEvent).toHaveBeenCalledWith("owner", "repo", 99, "test-agent");
    expect(mockedBuildEvent).toHaveBeenCalledWith(notification, null, "test-agent", {
      trigger: "review_requested",
      requester: "maintainer",
      reviewer: "test-agent",
    });
    expect(stdoutSpy).toHaveBeenCalledWith(JSON.stringify(event) + "\n");
    expect(mockedSaveState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        reviewRequestIds: ["1001:9001"],
      }),
    );
  });

  it("suppresses plain PR activity when the active review-request id has not changed", async () => {
    const notification = makePrNotification({ updated_at: "2026-02-01T12:30:00.000Z" });

    mockedLoadState.mockResolvedValue(defaultState({
      reviewRequestIds: ["1001:9001"],
    }));
    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchReviewRequestState.mockResolvedValue({
      pending: true,
      requestId: "9001",
      permanentFailure: false,
      transientFailure: false,
    });

    await watchCommand({ repo: "owner/repo", once: true, reasons: "review_requested" });

    expect(mockedBuildEvent).not.toHaveBeenCalled();
    expect(mockedFetchLatestReviewRequestEvent).not.toHaveBeenCalled();
    const eventWrites = (stdoutSpy.mock.calls as [string][])
      .map(([s]) => s)
      .filter((s) => s.includes('"agent"'));
    expect(eventWrites).toHaveLength(0);
  });

  it("re-emits when GitHub exposes a new review-request id on the same thread", async () => {
    const notification = makePrNotification({ updated_at: "2026-02-01T12:30:00.000Z" });
    const event = makeEvent({
      number: 99,
      type: "PullRequest",
      title: "Add feature X",
      author: "unknown",
      body: "",
      url: "",
      trigger: "review_requested",
      timestamp: "2026-02-01T12:30:00.000Z",
    });

    mockedLoadState.mockResolvedValue(defaultState({
      reviewRequestIds: ["1001:9001"],
      processedThreadIds: ["1001:2026-02-01T11:30:00.000Z"],
    }));
    mockedFetchMentions.mockResolvedValue([notification]);
    mockedBuildEvent.mockReturnValue(event);
    mockedFetchReviewRequestState.mockResolvedValue({
      pending: true,
      requestId: "9002",
      permanentFailure: false,
      transientFailure: false,
    });

    await watchCommand({ repo: "owner/repo", once: true, reasons: "review_requested" });

    expect(mockedFetchLatestReviewRequestEvent).toHaveBeenCalledWith("owner", "repo", 99, "test-agent");
    expect(stdoutSpy).toHaveBeenCalledWith(JSON.stringify(event) + "\n");
    expect(mockedSaveState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        reviewRequestIds: ["1001:9002"],
      }),
    );
  });

  it("marks processed when the reviewer is no longer actively requested", async () => {
    const notification = makePrNotification();

    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchReviewRequestState.mockResolvedValue({
      pending: false,
      permanentFailure: false,
      transientFailure: false,
    });

    await watchCommand({ repo: "owner/repo", once: true, reasons: "review_requested" });

    expect(mockedBuildEvent).not.toHaveBeenCalled();
    expect(mockedSaveState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        processedThreadIds: ["1001:2026-02-01T11:30:00.000Z"],
      }),
    );
  });

  it("retries when the review-request fetch fails transiently", async () => {
    const notification = makePrNotification();

    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchReviewRequestState.mockResolvedValue({
      pending: false,
      permanentFailure: false,
      transientFailure: true,
    });

    await watchCommand({ repo: "owner/repo", once: true, reasons: "review_requested" });

    expect(mockedBuildEvent).not.toHaveBeenCalled();
    expect(mockedSaveState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        processedThreadIds: [],
      }),
    );
  });

  it("retries when the review-request event lookup fails transiently", async () => {
    const notification = makePrNotification();

    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchLatestReviewRequestEvent.mockResolvedValue({
      permanentFailure: false,
      transientFailure: true,
    });

    await watchCommand({ repo: "owner/repo", once: true, reasons: "review_requested" });

    expect(mockedBuildEvent).not.toHaveBeenCalled();
    expect(mockedSaveState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        processedThreadIds: [],
      }),
    );
  });

  it("emits with reviewer metadata when no matching review_requested event is available", async () => {
    const notification = makePrNotification();
    const event = makeEvent({
      number: 99,
      type: "PullRequest",
      title: "Add feature X",
      author: "unknown",
      body: "",
      url: "",
      trigger: "review_requested",
      reviewer: "test-agent",
    });

    mockedFetchMentions.mockResolvedValue([notification]);
    mockedBuildEvent.mockReturnValue(event);
    mockedFetchLatestReviewRequestEvent.mockResolvedValue({
      permanentFailure: false,
      transientFailure: false,
    });

    await watchCommand({ repo: "owner/repo", once: true, reasons: "review_requested" });

    expect(mockedBuildEvent).toHaveBeenCalledWith(notification, null, "test-agent", {
      trigger: "review_requested",
      reviewer: "test-agent",
    });
    expect(stdoutSpy).toHaveBeenCalledWith(JSON.stringify(event) + "\n");
  });

  it("logs and marks processed when the review_requested event cannot be built", async () => {
    const notification = makePrNotification();

    mockedFetchMentions.mockResolvedValue([notification]);
    mockedBuildEvent.mockReturnValue(null);

    await watchCommand({ repo: "owner/repo", once: true, reasons: "review_requested" });

    expect(stdoutSpy).not.toHaveBeenCalledWith(expect.stringContaining("\"trigger\":\"review_requested\""));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining(
      "Skipping 1001: could not build review_requested event, marking processed",
    ));
    expect(mockedSaveState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        processedThreadIds: ["1001:2026-02-01T11:30:00.000Z"],
      }),
    );
  });

  it("marks processed when the review-request fetch fails permanently", async () => {
    const notification = makePrNotification();

    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchReviewRequestState.mockResolvedValue({
      pending: false,
      permanentFailure: true,
      transientFailure: false,
    });

    await watchCommand({ repo: "owner/repo", once: true, reasons: "review_requested" });

    expect(mockedBuildEvent).not.toHaveBeenCalled();
    expect(mockedSaveState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        processedThreadIds: ["1001:2026-02-01T11:30:00.000Z"],
      }),
    );
  });

  it("marks processed when review_requested appears on a non-PR subject", async () => {
    const notification = makeNotification({ reason: "review_requested" });

    mockedFetchMentions.mockResolvedValue([notification]);

    await watchCommand({ repo: "owner/repo", once: true, reasons: "review_requested" });

    expect(mockedFetchReviewRequestState).not.toHaveBeenCalled();
    expect(mockedBuildEvent).not.toHaveBeenCalled();
    expect(mockedSaveState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        processedThreadIds: ["1001:2026-02-01T11:30:00.000Z"],
      }),
    );
  });
});
