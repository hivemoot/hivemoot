/**
 * Tests for war-room-routing helpers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { maybeCreatePrReviewRoom } from "./war-room-routing.js";
import { WarRoomApiError } from "./war-room-client.js";

vi.mock("./war-room-client.js", async () => {
  const real = await vi.importActual<typeof import("./war-room-client.js")>(
    "./war-room-client.js",
  );
  return {
    ...real,
    WarRoomClient: vi.fn(),
  };
});

import { WarRoomClient } from "./war-room-client.js";

const mockedClientCtor = vi.mocked(WarRoomClient);

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

  it("skips with `no_token` reason when env var is unset", async () => {
    const result = await maybeCreatePrReviewRoom({
      owner: "hivemoot",
      repo: "hivemoot",
      prNumber: 42,
      log,
    });
    expect(result).toEqual({ roomId: null, skipped: "no_token" });
    expect(mockedClientCtor).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ pr: 42 }),
      expect.stringContaining("HIVEMOOT_BOT_AGENT_TOKEN unset"),
    );
  });

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
      } as unknown as typeof WarRoomClient,
    );

    const result = await maybeCreatePrReviewRoom({
      owner: "hivemoot",
      repo: "hivemoot",
      prNumber: 42,
      log,
    });

    // Round-trip equality: the roomId returned by the helper must
    // be the same UUIDv4 it passed into createRoom. If a future
    // refactor breaks this thread-through, this test catches it.
    expect(typeof result.roomId).toBe("string");
    expect(result.roomId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(createRoom).toHaveBeenCalledWith({
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#42" },
      roomId: result.roomId,
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
      } as unknown as typeof WarRoomClient,
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
      } as unknown as typeof WarRoomClient,
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
      } as unknown as typeof WarRoomClient,
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

  it("client construction error → skipped:'api_error', non-fatal", async () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "hmt_x";
    mockedClientCtor.mockImplementation(() => {
      throw new Error("invalid baseUrl");
    });

    const result = await maybeCreatePrReviewRoom({
      owner: "hivemoot",
      repo: "hivemoot",
      prNumber: 42,
      log,
    });
    expect(result).toEqual({ roomId: null, skipped: "api_error" });
    expect(log.error).toHaveBeenCalled();
  });

  it("never throws — webhook handler relies on this for non-fatal contract", async () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = "hmt_x";
    const createRoom = vi.fn(async () => {
      throw new TypeError("totally unexpected");
    });
    mockedClientCtor.mockImplementation(
      function (this: { createRoom: typeof createRoom }) {
        this.createRoom = createRoom;
      } as unknown as typeof WarRoomClient,
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
