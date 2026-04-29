import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("../hivemoot/client.js", () => ({
  hivemootGet: vi.fn(),
}));

import { hivemootGet } from "../hivemoot/client.js";
import { formatRoomsList, roomsListCommand } from "./rooms-list.js";
import type { ListedRoom, ListRoomsResponse } from "../hivemoot/types.js";

const mockedGet = vi.mocked(hivemootGet);

function makeRoom(overrides: Partial<ListedRoom> = {}): ListedRoom {
  return {
    roomId: "8d2bbb86-1f33-4d6a-9b3a-3ed1c0fbcdef",
    manager: "bot-queen",
    subject_type: "pr_review",
    subject_ref: "hivemoot/hivemoot#42",
    opened_at: "2026-04-29T18:00:00.000Z",
    timing_config: {
      rsvp_quiet_period_secs: 60,
      rsvp_deadline_secs: 600,
      contribution_deadline_secs: 1800,
      rsvp_contribution_timeout_secs: 1800,
      max_age_secs: 7200,
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

describe("formatRoomsList", () => {
  it("emits an empty-list footer when there are no rooms", () => {
    const out = formatRoomsList([]);
    expect(out).toContain("WAR ROOMS — 0 rooms");
    expect(out).toContain("(no rooms in this installation)");
  });

  it("uses singular 'room' for exactly one", () => {
    const out = formatRoomsList([makeRoom()]);
    expect(out).toMatch(/WAR ROOMS — 1 room$/m);
  });

  it("includes status, subject label, ref, opened time, roomId, manager per room", () => {
    const out = formatRoomsList([makeRoom()]);
    expect(out).toContain("[awaiting_contributions]");
    expect(out).toContain("pr_review hivemoot/hivemoot#42");
    expect(out).toContain("roomId: 8d2bbb86-1f33-4d6a-9b3a-3ed1c0fbcdef");
    expect(out).toContain("manager: bot-queen");
  });

  it("renders mention_response subject as 'mention'", () => {
    const out = formatRoomsList([
      makeRoom({ subject_type: "mention_response", subject_ref: "hivemoot/colony#17" }),
    ]);
    expect(out).toContain("mention hivemoot/colony#17");
  });

  it("includes closed_at and closed_reason on terminal rooms", () => {
    const out = formatRoomsList([
      makeRoom({
        status: "expired",
        closed_at: "2026-04-29T12:00:00.000Z",
        closed_reason: "expired",
      }),
    ]);
    expect(out).toContain("[expired]");
    expect(out).toContain(", closed");
    expect(out).toContain("(expired)");
  });

  it("omits closed segment when room is still active", () => {
    const out = formatRoomsList([makeRoom()]);
    expect(out).not.toContain(", closed");
  });
});

describe("roomsListCommand", () => {
  it("calls /api/rooms with no query when no limit", async () => {
    mockedGet.mockResolvedValue({ rooms: [] } as ListRoomsResponse);
    await roomsListCommand({});
    expect(mockedGet).toHaveBeenCalledTimes(1);
    const call = mockedGet.mock.calls[0][0];
    expect(call.path).toBe("/api/rooms");
    expect(call.query).toEqual({ limit: undefined });
  });

  it("forwards --limit to the query", async () => {
    mockedGet.mockResolvedValue({ rooms: [] } as ListRoomsResponse);
    await roomsListCommand({ limit: 25 });
    expect(mockedGet.mock.calls[0][0].query).toEqual({ limit: 25 });
  });

  it("forwards --token and --api-url to the client", async () => {
    mockedGet.mockResolvedValue({ rooms: [] } as ListRoomsResponse);
    await roomsListCommand({ token: "tok-abc", apiUrl: "https://staging.example" });
    const call = mockedGet.mock.calls[0][0];
    expect(call.token).toBe("tok-abc");
    expect(call.apiUrl).toBe("https://staging.example");
  });

  it("rejects --limit=0 with INVALID_OPTION exit 1 (no API call)", async () => {
    await expect(roomsListCommand({ limit: 0 })).rejects.toMatchObject({
      code: "INVALID_OPTION",
      exitCode: 1,
    });
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("rejects --limit=201 with INVALID_OPTION (server caps at 200)", async () => {
    await expect(roomsListCommand({ limit: 201 })).rejects.toBeInstanceOf(
      CliError,
    );
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("emits JSON exactly as returned when --json", async () => {
    const payload = { rooms: [makeRoom()] } satisfies ListRoomsResponse;
    mockedGet.mockResolvedValue(payload);
    const logSpy = vi.spyOn(console, "log");
    await roomsListCommand({ json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual(payload);
  });

  it("emits the human formatter (not JSON) by default", async () => {
    const payload = { rooms: [makeRoom()] } satisfies ListRoomsResponse;
    mockedGet.mockResolvedValue(payload);
    const logSpy = vi.spyOn(console, "log");
    await roomsListCommand({});
    const out = logSpy.mock.calls[0][0] as string;
    expect(out).toContain("WAR ROOMS — 1 room");
    expect(out).toContain("[awaiting_contributions]");
  });

  it("propagates CliError from the underlying client unchanged", async () => {
    mockedGet.mockRejectedValue(
      new CliError("401 unauthorized", "unauthorized", 2),
    );
    await expect(roomsListCommand({})).rejects.toMatchObject({
      code: "unauthorized",
      exitCode: 2,
    });
  });
});
