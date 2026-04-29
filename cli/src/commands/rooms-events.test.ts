import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("../hivemoot/client.js", () => ({
  hivemootGet: vi.fn(),
}));

import { hivemootGet } from "../hivemoot/client.js";
import { formatEvents, roomsEventsCommand } from "./rooms-events.js";
import type { RoomEvent, RoomEventsResponse } from "../hivemoot/types.js";

const mockedGet = vi.mocked(hivemootGet);

const VALID_ID = "8d2bbb86-1f33-4d6a-9b3a-3ed1c0fbcdef";

function makeEvent(overrides: Partial<RoomEvent> = {}): RoomEvent {
  return {
    seq: 1,
    timestamp: "2026-04-29T18:00:00.000Z",
    event_type: "room_opened",
    actor_role: "manager",
    actor_id: "bot-queen",
    body: {},
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

describe("formatEvents", () => {
  it("renders empty-list footer when no events", () => {
    const out = formatEvents(VALID_ID, []);
    expect(out).toContain(`WAR ROOM EVENTS ${VALID_ID} — 0 events`);
    expect(out).toContain("(no events in range)");
  });

  it("uses singular 'event' for exactly one", () => {
    const out = formatEvents(VALID_ID, [makeEvent()]);
    expect(out).toMatch(/— 1 event$/m);
  });

  it("renders seq, timestamp, event_type per event", () => {
    const out = formatEvents(VALID_ID, [
      makeEvent({ seq: 5, event_type: "participant_presented" }),
    ]);
    expect(out).toContain("#5  2026-04-29T18:00:00.000Z  participant_presented");
  });

  it("renders actor_role/actor_id on every event (always present per server)", () => {
    const out = formatEvents(VALID_ID, [
      makeEvent({
        event_type: "participant_presented",
        actor_role: "drone",
        actor_id: "vercel.123",
      }),
    ]);
    expect(out).toContain("by drone/vercel.123");
  });

  it("renders system-sentinel actors verbatim (manager/watchdog, system/vercel-cron)", () => {
    const out = formatEvents(VALID_ID, [
      makeEvent({
        seq: 9,
        event_type: "room_recovered",
        actor_role: "manager",
        actor_id: "watchdog",
      }),
      makeEvent({
        seq: 10,
        event_type: "room_terminated",
        actor_role: "system",
        actor_id: "vercel-cron",
      }),
    ]);
    expect(out).toContain("room_recovered  by manager/watchdog");
    expect(out).toContain("room_terminated  by system/vercel-cron");
  });

  it("renders body as compact JSON on a continuation line when non-empty", () => {
    const out = formatEvents(VALID_ID, [
      makeEvent({
        event_type: "subject_updated",
        actor_role: "queen",
        actor_id: "bot-queen",
        body: { from_subject_ref: "x/y#1", to_subject_ref: "x/y#1@v2" },
      }),
    ]);
    expect(out).toContain('body: {"from_subject_ref":"x/y#1","to_subject_ref":"x/y#1@v2"}');
  });

  it("omits body line when body is empty {}", () => {
    const out = formatEvents(VALID_ID, [makeEvent({ body: {} })]);
    expect(out).not.toContain("body:");
  });

  it("renders room_decided event_type with synthesis body", () => {
    const out = formatEvents(VALID_ID, [
      makeEvent({
        event_type: "room_decided",
        actor_role: "queen",
        actor_id: "bot-queen",
        body: { sequence_closed: 12 },
      }),
    ]);
    expect(out).toContain("room_decided  by queen/bot-queen");
    expect(out).toContain('body: {"sequence_closed":12}');
  });
});

describe("roomsEventsCommand", () => {
  it("rejects malformed roomId without an API call", async () => {
    await expect(roomsEventsCommand("not-a-uuid", {})).rejects.toMatchObject({
      code: "INVALID_OPTION",
      exitCode: 1,
    });
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("rejects negative --since without an API call", async () => {
    await expect(
      roomsEventsCommand(VALID_ID, { since: -1 }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("rejects --limit below 1", async () => {
    await expect(
      roomsEventsCommand(VALID_ID, { limit: 0 }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });

  it("rejects --limit above 500 (server cap)", async () => {
    await expect(
      roomsEventsCommand(VALID_ID, { limit: 501 }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });

  it("hits /api/rooms/<id>/events without query when no flags", async () => {
    mockedGet.mockResolvedValue({
      roomId: VALID_ID,
      events: [],
    } as RoomEventsResponse);
    await roomsEventsCommand(VALID_ID, {});
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(mockedGet.mock.calls[0][0].path).toBe(`/api/rooms/${VALID_ID}/events`);
    expect(mockedGet.mock.calls[0][0].query).toEqual({
      since: undefined,
      limit: undefined,
    });
  });

  it("forwards --since and --limit", async () => {
    mockedGet.mockResolvedValue({
      roomId: VALID_ID,
      events: [],
    } as RoomEventsResponse);
    await roomsEventsCommand(VALID_ID, { since: 10, limit: 100 });
    expect(mockedGet.mock.calls[0][0].query).toEqual({ since: 10, limit: 100 });
  });

  it("accepts --since=0 (read from beginning)", async () => {
    mockedGet.mockResolvedValue({
      roomId: VALID_ID,
      events: [],
    } as RoomEventsResponse);
    await roomsEventsCommand(VALID_ID, { since: 0 });
    expect(mockedGet.mock.calls[0][0].query).toEqual({
      since: 0,
      limit: undefined,
    });
  });

  it("emits raw JSON wire response when --json", async () => {
    const payload = {
      roomId: VALID_ID,
      events: [makeEvent({ seq: 1 }), makeEvent({ seq: 2, event_type: "participant_presented" })],
    } satisfies RoomEventsResponse;
    mockedGet.mockResolvedValue(payload);
    const logSpy = vi.spyOn(console, "log");
    await roomsEventsCommand(VALID_ID, { json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual(payload);
  });

  it("emits human format by default", async () => {
    mockedGet.mockResolvedValue({
      roomId: VALID_ID,
      events: [makeEvent()],
    } as RoomEventsResponse);
    const logSpy = vi.spyOn(console, "log");
    await roomsEventsCommand(VALID_ID, {});
    const out = logSpy.mock.calls[0][0] as string;
    expect(out).toContain(`WAR ROOM EVENTS ${VALID_ID} — 1 event`);
  });

  it("propagates CliError from the underlying client", async () => {
    mockedGet.mockRejectedValue(
      new CliError("404 not found", "room_not_found", 3),
    );
    await expect(roomsEventsCommand(VALID_ID, {})).rejects.toMatchObject({
      code: "room_not_found",
      exitCode: 3,
    });
  });
});
