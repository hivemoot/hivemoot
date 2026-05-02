import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("../hivemoot/client.js", () => ({
  hivemootGet: vi.fn(),
}));

import { hivemootGet } from "../hivemoot/client.js";
import { formatRoom, roomsGetCommand } from "./rooms-get.js";
import type { RoomCore } from "../hivemoot/types.js";

const mockedGet = vi.mocked(hivemootGet);

const VALID_ID = "8d2bbb86-1f33-4d6a-9b3a-3ed1c0fbcdef";

function makeRoom(overrides: Partial<RoomCore> = {}): RoomCore {
  return {
    manager: "bot-queen",
    subject_type: "pr_review",
    subject_ref: "hivemoot/hivemoot#42",
    opened_at: "2026-04-29T18:00:00.000Z",
    timing_config: {
      max_age_secs: 7200,
      drop_threshold_secs: 600,
      quiet_period_secs: 600,
    },
    status: "awaiting_contributions",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatRoom", () => {
  it("includes core fields with the supplied roomId", () => {
    const out = formatRoom(VALID_ID, makeRoom());
    expect(out).toContain(`WAR ROOM ${VALID_ID}`);
    expect(out).toContain("status:  awaiting_contributions");
    expect(out).toContain("subject: pr_review hivemoot/hivemoot#42");
    expect(out).toContain("manager: bot-queen");
    expect(out).toContain("max_age=7200s");
  });

  it("renders mention_response subject as 'mention'", () => {
    const out = formatRoom(
      VALID_ID,
      makeRoom({ subject_type: "mention_response", subject_ref: "x/y#1" }),
    );
    expect(out).toContain("subject: mention x/y#1");
  });

  it("includes closed_at and reason on terminal rooms", () => {
    const out = formatRoom(
      VALID_ID,
      makeRoom({
        status: "closed",
        closed_at: "2026-04-29T19:00:00.000Z",
        closed_reason: "expired",
      }),
    );
    expect(out).toContain("closed:  2026-04-29T19:00:00.000Z (expired)");
  });

  it("omits closed line on active rooms", () => {
    const out = formatRoom(VALID_ID, makeRoom());
    expect(out).not.toContain("closed:");
  });

  it("includes deciding_through_seq when set", () => {
    const out = formatRoom(
      VALID_ID,
      makeRoom({ status: "deciding", deciding_through_sequence: 17 }),
    );
    expect(out).toContain("deciding_through_seq: 17");
  });

  it("includes decision summary when set", () => {
    const out = formatRoom(
      VALID_ID,
      makeRoom({
        status: "closed",
        closed_at: "2026-04-29T19:00:00.000Z",
        decision: {
          synthesized_at: "2026-04-29T18:55:00.000Z",
          synthesis_runner: "vercel.123",
          content: "LGTM with minor nits",
          sequence_closed: 12,
        },
      }),
    );
    expect(out).toContain("decision: synthesized 2026-04-29T18:55:00.000Z by vercel.123 at seq=12");
  });
});

describe("roomsGetCommand", () => {
  it("rejects malformed roomId without an API call", async () => {
    await expect(roomsGetCommand("not-a-uuid", {})).rejects.toMatchObject({
      code: "INVALID_OPTION",
      exitCode: 1,
    });
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("rejects empty roomId without an API call", async () => {
    await expect(roomsGetCommand("", {})).rejects.toBeInstanceOf(CliError);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("hits /api/rooms/<id> with the supplied id", async () => {
    mockedGet.mockResolvedValue(makeRoom());
    await roomsGetCommand(VALID_ID, {});
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(mockedGet.mock.calls[0][0].path).toBe(`/api/rooms/${VALID_ID}`);
  });

  it("forwards token + apiUrl to the client", async () => {
    mockedGet.mockResolvedValue(makeRoom());
    await roomsGetCommand(VALID_ID, {
      token: "tok-abc",
      apiUrl: "https://staging.example",
    });
    const call = mockedGet.mock.calls[0][0];
    expect(call.token).toBe("tok-abc");
    expect(call.apiUrl).toBe("https://staging.example");
  });

  it("emits `{ roomId, ...room }` JSON when --json", async () => {
    const room = makeRoom();
    mockedGet.mockResolvedValue(room);
    const logSpy = vi.spyOn(console, "log");
    await roomsGetCommand(VALID_ID, { json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
      roomId: VALID_ID,
      ...room,
    });
  });

  it("emits human format by default", async () => {
    mockedGet.mockResolvedValue(makeRoom());
    const logSpy = vi.spyOn(console, "log");
    await roomsGetCommand(VALID_ID, {});
    const out = logSpy.mock.calls[0][0] as string;
    expect(out).toContain(`WAR ROOM ${VALID_ID}`);
    expect(out).toContain("status:");
  });

  it("propagates CliError from the underlying client (404 on missing room)", async () => {
    mockedGet.mockRejectedValue(
      new CliError("404 Room not found (/api/rooms/...)", "room_not_found", 3),
    );
    await expect(roomsGetCommand(VALID_ID, {})).rejects.toMatchObject({
      code: "room_not_found",
      exitCode: 3,
    });
  });
});
