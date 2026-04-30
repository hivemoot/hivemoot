/**
 * Tests for war-room-routing helpers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  commentHasHivemootMention,
  deriveMentionRoomId,
  derivePrRoomId,
  maybeCreateMentionRoom,
  maybeCreatePrReviewRoom,
  maybeEmitSubjectUpdated,
} from "./war-room-routing.js";
import { WarRoomApiError } from "./war-room-store.js";

vi.mock("./war-room-store.js", async () => {
  const real = await vi.importActual<typeof import("./war-room-store.js")>(
    "./war-room-store.js",
  );
  return {
    ...real,
    WarRoomStore: vi.fn(),
  };
});

import { WarRoomStore } from "./war-room-store.js";

const mockedClientCtor = vi.mocked(WarRoomStore);

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";

describe("maybeCreatePrReviewRoom", () => {
  beforeEach(() => {
    delete process.env.HIVEMOOT_BOT_AGENT_TOKEN;
    log.info.mockReset();
    log.warn.mockReset();
    log.error.mockReset();
    mockedClientCtor.mockReset();
  });

  // The pre-direct-Redis WarRoomClient skipped with `no_token` when
  // HIVEMOOT_BOT_AGENT_TOKEN was unset; that env var (and the entire
  // bearer requirement) was removed in the multi-tenant migration —
  // the routing layer now uses the bot's GitHub App identity scoped
  // by webhook installationId. The test that previously asserted the
  // skip path was deleted with the behavior it covered.

  it("happy path: 201 — bot mints roomId + threads it through (closes #526 B1)", async () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "hmt_x";
    // CRITICAL: server's POST /api/rooms 201 response serializes
    // RoomCore (NOT RoomCoreWithId), so the body has NO roomId
    // field. The bot mints the roomId and passes it as args.roomId;
    // the round-trip identity check is what we pin here so the next
    // contract drift is caught.
    const createRoom = vi.fn(async () => ({
      manager: "bot-queen",
      subject_type: "pr_review",
      subject_ref: "hivemoot/hivemoot#42",
      status: "awaiting_rsvp",
      opened_at: "2026-04-28T10:00:00.000Z",
      // NOTE: no `roomId` here — pinning the actual server contract.
    }));
    // Class-mock pattern: prototype-chain a fake class that returns
    // an object with createRoom. The naive `mockImplementation`
    // path makes `new` return undefined when the implementation is
    // arrow-fn'd → object-spread-new doesn't bind properly.
    mockedClientCtor.mockImplementation(
      function (this: { createRoom: typeof createRoom }) {
        this.createRoom = createRoom;
      } as unknown as typeof WarRoomStore,
    );

    const result = await maybeCreatePrReviewRoom({
      owner: "hivemoot",
      repo: "hivemoot",
      prNumber: 42,
      log,
    });

    // Round-trip equality: the roomId returned by the helper must
    // be the same UUIDv4-shaped value it passed into createRoom.
    // E.2 changed the source from randomUUID() to the deterministic
    // derivePrRoomId helper — same PR identity always maps to the
    // same roomId across opened/synchronize/closed events.
    expect(typeof result.roomId).toBe("string");
    expect(result.roomId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const expectedRoomId = derivePrRoomId({
      owner: "hivemoot",
      repo: "hivemoot",
      prNumber: 42,
    });
    expect(result.roomId).toBe(expectedRoomId);
    expect(createRoom).toHaveBeenCalledWith({
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#42" },
      roomId: expectedRoomId,
    });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: result.roomId }),
      expect.stringContaining("created pr_review room"),
    );
  });

  it("subject_already_open 409 → reuses existingRoomId (idempotent on webhook re-delivery)", async () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "hmt_x";
    const createRoom = vi.fn(async () => {
      throw new WarRoomApiError(
        409,
        "subject_already_open",
        "Already open",
        { existingRoomId: ROOM_ID },
      );
    });
    mockedClientCtor.mockImplementation(
      function (this: { createRoom: typeof createRoom }) {
        this.createRoom = createRoom;
      } as unknown as typeof WarRoomStore,
    );

    const result = await maybeCreatePrReviewRoom({
      owner: "hivemoot",
      repo: "hivemoot",
      prNumber: 42,
      log,
    });
    expect(result.roomId).toBe(ROOM_ID);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ existingRoomId: ROOM_ID }),
      expect.stringContaining("subject_already_open"),
    );
  });

  it("4xx (validation error) → returns skipped:'api_error', logs error", async () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "hmt_x";
    const createRoom = vi.fn(async () => {
      throw new WarRoomApiError(400, "invalid_subject", "bad", {});
    });
    mockedClientCtor.mockImplementation(
      function (this: { createRoom: typeof createRoom }) {
        this.createRoom = createRoom;
      } as unknown as typeof WarRoomStore,
    );

    const result = await maybeCreatePrReviewRoom({
      owner: "hivemoot",
      repo: "hivemoot",
      prNumber: 42,
      log,
    });
    expect(result).toEqual({ roomId: null, skipped: "api_error" });
    expect(log.error).toHaveBeenCalled();
  });

  it("network/5xx error → returns skipped:'api_error', logs warn (transient)", async () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "hmt_x";
    const createRoom = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    mockedClientCtor.mockImplementation(
      function (this: { createRoom: typeof createRoom }) {
        this.createRoom = createRoom;
      } as unknown as typeof WarRoomStore,
    );

    const result = await maybeCreatePrReviewRoom({
      owner: "hivemoot",
      repo: "hivemoot",
      prNumber: 42,
      log,
    });
    expect(result).toEqual({ roomId: null, skipped: "api_error" });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pr: 42 }),
      expect.stringContaining("transient error"),
    );
  });

  it("never throws — webhook handler relies on this for non-fatal contract", async () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "hmt_x";
    const createRoom = vi.fn(async () => {
      throw new TypeError("totally unexpected");
    });
    mockedClientCtor.mockImplementation(
      function (this: { createRoom: typeof createRoom }) {
        this.createRoom = createRoom;
      } as unknown as typeof WarRoomStore,
    );

    await expect(
      maybeCreatePrReviewRoom({
        owner: "hivemoot",
        repo: "hivemoot",
        prNumber: 42,
        log,
      }),
    ).resolves.toEqual({ roomId: null, skipped: "api_error" });
  });
});

describe("derivePrRoomId (E.2 deterministic helper)", () => {
  it("same PR identity → same roomId across calls", () => {
    const a = derivePrRoomId({ owner: "hivemoot", repo: "hivemoot", prNumber: 42 });
    const b = derivePrRoomId({ owner: "hivemoot", repo: "hivemoot", prNumber: 42 });
    expect(a).toBe(b);
  });

  it("different PRs → different roomIds", () => {
    const a = derivePrRoomId({ owner: "hivemoot", repo: "hivemoot", prNumber: 42 });
    const b = derivePrRoomId({ owner: "hivemoot", repo: "hivemoot", prNumber: 43 });
    const c = derivePrRoomId({ owner: "hivemoot", repo: "colony", prNumber: 42 });
    const d = derivePrRoomId({ owner: "other", repo: "hivemoot", prNumber: 42 });
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it("output matches storage layer's UUIDv4 regex (so rooms.create accepts it)", () => {
    const id = derivePrRoomId({ owner: "x", repo: "y", prNumber: 1 });
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("maybeEmitSubjectUpdated", () => {
  beforeEach(() => {
    delete process.env.HIVEMOOT_BOT_AGENT_TOKEN;
    log.info.mockReset();
    log.warn.mockReset();
    log.error.mockReset();
    mockedClientCtor.mockReset();
  });

  it("happy path: sends subject_updated with deterministic roomId + idempotencyKey", async () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "hmt_x";
    const appendEvent = vi.fn(async () => ({ sequence: 5, replay: false }));
    mockedClientCtor.mockImplementation(
      function (this: { appendEvent: typeof appendEvent }) {
        this.appendEvent = appendEvent;
      } as unknown as typeof WarRoomStore,
    );

    const result = await maybeEmitSubjectUpdated({
      owner: "hivemoot",
      repo: "hivemoot",
      prNumber: 42,
      changeKind: "synchronize",
      headSha: "abc123def",
      log,
    });
    expect(result.sequence).toBe(5);

    const expectedRoomId = derivePrRoomId({
      owner: "hivemoot",
      repo: "hivemoot",
      prNumber: 42,
    });
    expect(appendEvent).toHaveBeenCalledWith({
      roomId: expectedRoomId,
      eventType: "subject_updated",
      body: { change_kind: "synchronize", head_sha: "abc123def" },
      idempotencyKey: `bot.subject_updated.${expectedRoomId}.synchronize.abc123def`,
    });
  });

  it("idempotency key derives from headSha — same sha twice = same key (re-delivery dedupe)", async () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "hmt_x";
    const appendEvent = vi.fn(async () => ({ sequence: 5 }));
    mockedClientCtor.mockImplementation(
      function (this: { appendEvent: typeof appendEvent }) {
        this.appendEvent = appendEvent;
      } as unknown as typeof WarRoomStore,
    );

    await maybeEmitSubjectUpdated({
      owner: "hivemoot", repo: "hivemoot", prNumber: 42,
      changeKind: "synchronize", headSha: "sha-A", log,
    });
    await maybeEmitSubjectUpdated({
      owner: "hivemoot", repo: "hivemoot", prNumber: 42,
      changeKind: "synchronize", headSha: "sha-A", log,
    });
    await maybeEmitSubjectUpdated({
      owner: "hivemoot", repo: "hivemoot", prNumber: 42,
      changeKind: "synchronize", headSha: "sha-B", log,
    });

    const calls = appendEvent.mock.calls;
    expect(calls[0][0].idempotencyKey).toBe(calls[1][0].idempotencyKey);
    expect(calls[0][0].idempotencyKey).not.toBe(calls[2][0].idempotencyKey);
  });

  it("room_not_found 404 → returns skipped:'no_room' (PR opened pre-war-room)", async () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "hmt_x";
    const appendEvent = vi.fn(async () => {
      throw new WarRoomApiError(404, "room_not_found", "missing", {});
    });
    mockedClientCtor.mockImplementation(
      function (this: { appendEvent: typeof appendEvent }) {
        this.appendEvent = appendEvent;
      } as unknown as typeof WarRoomStore,
    );

    const result = await maybeEmitSubjectUpdated({
      owner: "hivemoot", repo: "hivemoot", prNumber: 42,
      changeKind: "synchronize", log,
    });
    expect(result).toEqual({ sequence: null, skipped: "no_room" });
  });

  it("status_precondition_failed (queen claimed) → skipped:'api_error', logged warn", async () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "hmt_x";
    const appendEvent = vi.fn(async () => {
      throw new WarRoomApiError(
        409,
        "status_precondition_failed",
        "deciding",
        { actualStatus: "deciding" },
      );
    });
    mockedClientCtor.mockImplementation(
      function (this: { appendEvent: typeof appendEvent }) {
        this.appendEvent = appendEvent;
      } as unknown as typeof WarRoomStore,
    );

    const result = await maybeEmitSubjectUpdated({
      owner: "hivemoot", repo: "hivemoot", prNumber: 42,
      changeKind: "synchronize", log,
    });
    expect(result).toEqual({ sequence: null, skipped: "api_error" });
    expect(log.warn).toHaveBeenCalled();
  });

  it("changeKind 'closed' (no headSha) is supported", async () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "hmt_x";
    const appendEvent = vi.fn(async () => ({ sequence: 7 }));
    mockedClientCtor.mockImplementation(
      function (this: { appendEvent: typeof appendEvent }) {
        this.appendEvent = appendEvent;
      } as unknown as typeof WarRoomStore,
    );

    const result = await maybeEmitSubjectUpdated({
      owner: "hivemoot", repo: "hivemoot", prNumber: 42,
      changeKind: "closed", log,
    });
    expect(result.sequence).toBe(7);
    const callArgs = appendEvent.mock.calls[0][0];
    expect(callArgs.body).toEqual({ change_kind: "closed" });
    expect(callArgs.idempotencyKey).toContain("no-sha");
  });

  it("never throws — webhook handler relies on this for non-fatal contract", async () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "hmt_x";
    const appendEvent = vi.fn(async () => {
      throw new TypeError("totally unexpected");
    });
    mockedClientCtor.mockImplementation(
      function (this: { appendEvent: typeof appendEvent }) {
        this.appendEvent = appendEvent;
      } as unknown as typeof WarRoomStore,
    );

    await expect(
      maybeEmitSubjectUpdated({
        owner: "hivemoot", repo: "hivemoot", prNumber: 42,
        changeKind: "synchronize", log,
      }),
    ).resolves.toEqual({ sequence: null, skipped: "api_error" });
  });
});

// ---------------------------------------------------------------------------
// E.3 — mention_response rooms
// ---------------------------------------------------------------------------

describe("commentHasHivemootMention", () => {
  it.each([
    ["@hivemoot can you take a look?", true],
    ["Hi @hivemoot, please review.", true],
    ["@hivemoot,", true], // comma is non-word/dash
    ["@hivemoot.", true], // period
    ["@hivemoot!", true], // bang
    ["@hivemoot\nnewline after", true],
    ["@HiveMoot mixed case", true], // case-insensitive
    ["@hivemoot at end of comment @hivemoot", true],
    ["text @hivemoot more text", true],
  ])("matches %j → %s", (body, expected) => {
    expect(commentHasHivemootMention(body)).toBe(expected);
  });

  it.each([
    ["", false],
    ["plain text with no mention", false],
    ["@hivemoot-builder is a different identity", false],
    ["@hivemoot-bot also distinct", false],
    ["@hivemoot_test underscored", false],
    ["@hivemoot42 alphanumeric continuation", false],
    ["/gather followed by @hivemoot in body", false], // /command guard
    [" /timeout some text with @hivemoot", false], // leading whitespace + /command
  ])("non-match %j → %s", (body, expected) => {
    expect(commentHasHivemootMention(body)).toBe(expected);
  });

  it("matches even when comment starts with @hivemoot at position 0", () => {
    expect(commentHasHivemootMention("@hivemoot please")).toBe(true);
  });

  it("does NOT match when whole comment is a /command", () => {
    expect(commentHasHivemootMention("/gather @hivemoot please")).toBe(false);
  });

  it("matches when /-prefix appears mid-comment but body doesn't start with /", () => {
    // Defense check: only the /-prefix at start of comment skips,
    // mid-comment / is allowed.
    expect(
      commentHasHivemootMention("hello @hivemoot use /timeout if needed"),
    ).toBe(true);
  });
});

describe("deriveMentionRoomId", () => {
  it("same identity (incl. commentId) → same roomId across calls (idempotent webhook redelivery)", () => {
    const a = deriveMentionRoomId({
      owner: "hivemoot",
      repo: "hivemoot",
      issueOrPrNumber: 42,
      commentId: 1001,
    });
    const b = deriveMentionRoomId({
      owner: "hivemoot",
      repo: "hivemoot",
      issueOrPrNumber: 42,
      commentId: 1001,
    });
    expect(a).toBe(b);
  });

  it("different commentId on same issue → different roomIds (post-close safety, #549 builder R1 #2)", () => {
    // Storage retains room hashes for ~30 days after close. Without
    // commentId in the derivation, a mention 31+ days after the
    // previous mention's room closed would hit room_id_taken. Each
    // mention now derives a fresh roomId.
    const a = deriveMentionRoomId({
      owner: "hivemoot",
      repo: "hivemoot",
      issueOrPrNumber: 42,
      commentId: 1001,
    });
    const b = deriveMentionRoomId({
      owner: "hivemoot",
      repo: "hivemoot",
      issueOrPrNumber: 42,
      commentId: 1002,
    });
    expect(a).not.toBe(b);
  });

  it("different issue/PR → different roomIds", () => {
    const a = deriveMentionRoomId({
      owner: "hivemoot",
      repo: "hivemoot",
      issueOrPrNumber: 42,
      commentId: 1001,
    });
    const b = deriveMentionRoomId({
      owner: "hivemoot",
      repo: "hivemoot",
      issueOrPrNumber: 43,
      commentId: 1001,
    });
    expect(a).not.toBe(b);
  });

  it("distinct namespace from derivePrRoomId", () => {
    // Critical invariant: a PR can have BOTH a pr_review room AND
    // a mention_response room simultaneously. The deterministic
    // derivations MUST produce different ids.
    const prId = derivePrRoomId({
      owner: "hivemoot",
      repo: "hivemoot",
      prNumber: 42,
    });
    const mentionId = deriveMentionRoomId({
      owner: "hivemoot",
      repo: "hivemoot",
      issueOrPrNumber: 42,
      commentId: 1001,
    });
    expect(prId).not.toBe(mentionId);
  });

  it("output matches storage's UUIDv4 regex", () => {
    const id = deriveMentionRoomId({
      owner: "x",
      repo: "y",
      issueOrPrNumber: 1,
      commentId: 99,
    });
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("maybeCreateMentionRoom", () => {
  beforeEach(() => {
    delete process.env.HIVEMOOT_BOT_AGENT_TOKEN;
    log.info.mockReset();
    log.warn.mockReset();
    log.error.mockReset();
    mockedClientCtor.mockReset();
  });

  function setupCreateRoomMock(
    createRoom: ReturnType<typeof vi.fn>,
    appendEvent?: ReturnType<typeof vi.fn>,
  ): void {
    mockedClientCtor.mockImplementation(
      function (this: {
        createRoom: typeof createRoom;
        appendEvent?: typeof appendEvent;
      }) {
        this.createRoom = createRoom;
        if (appendEvent) this.appendEvent = appendEvent;
      } as unknown as typeof WarRoomStore,
    );
  }

  it("happy path — calls createRoom with mention_response subject + comment-stable roomId", async () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "tk";
    const createRoom = vi.fn().mockResolvedValue({});
    setupCreateRoomMock(createRoom);
    const result = await maybeCreateMentionRoom({
      owner: "hivemoot",
      repo: "hivemoot",
      issueOrPrNumber: 42,
      commentId: 1001,
      commentAuthor: "alice",
      log,
    });
    expect(result.roomId).toMatch(/^[0-9a-f-]+$/);
    expect(result.reusedExistingRoom).toBe(false);
    const expectedRoomId = deriveMentionRoomId({
      owner: "hivemoot",
      repo: "hivemoot",
      issueOrPrNumber: 42,
      commentId: 1001,
    });
    expect(result.roomId).toBe(expectedRoomId);
    expect(createRoom).toHaveBeenCalledWith({
      subject: { type: "mention_response", ref: "hivemoot/hivemoot#42" },
      roomId: expectedRoomId,
    });
  });

  it("subject_already_open 409 → emits subject_updated on existing room (re-mention safety, #549 builder R1 #2)", async () => {
    // A prior @hivemoot's room is still open for this issue. The
    // create attempt fails with subject_already_open (subject_ref
    // is per-issue). The handler then emits subject_updated on the
    // existing room so workers re-engage (per /watching contract,
    // a new sequence past withdrew_at_sequence makes withdrawn
    // workers re-eligible).
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "tk";
    const createRoom = vi.fn().mockRejectedValue(
      new WarRoomApiError(409, "subject_already_open", "open", {
        existingRoomId: ROOM_ID,
      }),
    );
    const appendEvent = vi.fn().mockResolvedValue({ sequence: 5 });
    setupCreateRoomMock(createRoom, appendEvent);
    const result = await maybeCreateMentionRoom({
      owner: "hivemoot",
      repo: "hivemoot",
      issueOrPrNumber: 42,
      commentId: 1001,
      commentAuthor: "alice",
      log,
    });
    expect(result).toEqual({
      roomId: ROOM_ID,
      reusedExistingRoom: true,
    });
    expect(appendEvent).toHaveBeenCalledWith({
      roomId: ROOM_ID,
      eventType: "subject_updated",
      body: {
        change_kind: "mention",
        comment_id: 1001,
        comment_author: "alice",
      },
      // Idempotency key includes commentId so re-deliveries
      // resolve to the same event (no double-emit on retry).
      idempotencyKey: `bot.subject_updated.${ROOM_ID}.mention.1001`,
    });
  });

  it("same-comment webhook redelivery (existingRoomId === derived) → idempotent replay, NO subject_updated emit (#549 builder R2)", async () => {
    // Same-comment webhook delivery hits subject_already_open
    // because OUR previous delivery created the room. Without this
    // guard, the redelivery would emit a spurious subject_updated
    // and re-dispatch workers for a non-event.
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "tk";
    const ourDerivedRoomId = deriveMentionRoomId({
      owner: "hivemoot",
      repo: "hivemoot",
      issueOrPrNumber: 42,
      commentId: 1001,
    });
    const createRoom = vi.fn().mockRejectedValue(
      new WarRoomApiError(409, "subject_already_open", "open", {
        existingRoomId: ourDerivedRoomId, // SAME as derived → replay
      }),
    );
    const appendEvent = vi.fn(); // SHOULD NOT be called
    setupCreateRoomMock(createRoom, appendEvent);
    const result = await maybeCreateMentionRoom({
      owner: "hivemoot",
      repo: "hivemoot",
      issueOrPrNumber: 42,
      commentId: 1001,
      commentAuthor: "alice",
      log,
    });
    expect(result).toEqual({
      roomId: ourDerivedRoomId,
      reusedExistingRoom: false,
    });
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it("subject_already_open 409 → subject_updated emit fails → returns existing roomId with api_error (no throw)", async () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "tk";
    const createRoom = vi.fn().mockRejectedValue(
      new WarRoomApiError(409, "subject_already_open", "open", {
        existingRoomId: ROOM_ID,
      }),
    );
    const appendEvent = vi.fn().mockRejectedValue(
      new WarRoomApiError(409, "status_precondition_failed", "room closing", {}),
    );
    setupCreateRoomMock(createRoom, appendEvent);
    const result = await maybeCreateMentionRoom({
      owner: "hivemoot",
      repo: "hivemoot",
      issueOrPrNumber: 42,
      commentId: 1001,
      commentAuthor: "alice",
      log,
    });
    // Returns existing roomId (caller may want to log it) + api_error
    // marker. Webhook handler shouldn't crash either way.
    expect(result.roomId).toBe(ROOM_ID);
    expect(result.skipped).toBe("api_error");
  });

  it("non-409 4xx → logs error + returns api_error", async () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "tk";
    const createRoom = vi.fn().mockRejectedValue(
      new WarRoomApiError(403, "forbidden", "missing rooms.create", {}),
    );
    setupCreateRoomMock(createRoom);
    const result = await maybeCreateMentionRoom({
      owner: "hivemoot",
      repo: "hivemoot",
      issueOrPrNumber: 42,
      commentId: 1001,
      commentAuthor: "alice",
      log,
    });
    expect(result).toEqual({ roomId: null, skipped: "api_error" });
    expect(log.error).toHaveBeenCalled();
  });

  it("transient 5xx / network error → logs warn + returns api_error (no throw)", async () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "tk";
    const createRoom = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    setupCreateRoomMock(createRoom);
    const result = await maybeCreateMentionRoom({
      owner: "hivemoot",
      repo: "hivemoot",
      issueOrPrNumber: 42,
      commentId: 1001,
      commentAuthor: "alice",
      log,
    });
    expect(result).toEqual({ roomId: null, skipped: "api_error" });
    expect(log.warn).toHaveBeenCalled();
  });

  it("never throws — pin the non-throwing contract for webhook safety (drone #549 N1)", async () => {
    // Webhook handler relies on this: a war-room failure must NOT
    // bubble out and disrupt the existing intake / governance flow.
    // Mirror maybeCreatePrReviewRoom's existing contract test.
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "tk";
    const createRoom = vi.fn().mockRejectedValue(
      new Error("totally unexpected"),
    );
    setupCreateRoomMock(createRoom);
    await expect(
      maybeCreateMentionRoom({
        owner: "hivemoot",
        repo: "hivemoot",
        issueOrPrNumber: 42,
        commentAuthor: "alice",
        log,
      }),
    ).resolves.toEqual({ roomId: null, skipped: "api_error" });
  });
});
