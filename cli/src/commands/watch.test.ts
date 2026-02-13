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
  buildMentionEvent: vi.fn(),
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
  buildMentionEvent,
} from "../github/notifications.js";
import { loadState, saveState, mergeAckJournal } from "../watch/state.js";

const mockedFetchUser = vi.mocked(fetchCurrentUser);
const mockedFetchMentions = vi.mocked(fetchMentionNotifications);
const mockedFetchComment = vi.mocked(fetchCommentBody);
const mockedBuildEvent = vi.mocked(buildMentionEvent);
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

  it("silently skips unparseable notification without marking it processed", async () => {
    const notification = makeNotification();
    mockedFetchMentions.mockResolvedValue([notification]);
    mockedFetchComment.mockResolvedValue(null);
    mockedBuildEvent.mockReturnValue(null); // can't parse

    await watchCommand({ repo: "owner/repo", once: true });

    // No event emitted to stdout
    expect(mockedBuildEvent).toHaveBeenCalled();
    const eventWrites = (stdoutSpy.mock.calls as [string][])
      .map(([s]) => s)
      .filter((s) => s.includes('"agent"'));
    expect(eventWrites).toHaveLength(0);

    // State saved but WITHOUT the unparseable key in processedThreadIds
    // (it will reappear next poll, which is fine — all=false drops it
    // once the thread gets new activity)
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
});
