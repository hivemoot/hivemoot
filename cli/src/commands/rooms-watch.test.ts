import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../hivemoot/client.js", () => ({
  hivemootGet: vi.fn(),
}));

import { hivemootGet } from "../hivemoot/client.js";
import {
  formatNewRoom,
  formatRemovedRoom,
  pollWatchingOnce,
  roomsWatchCommand,
} from "./rooms-watch.js";
import type {
  WatchingRoom,
  WatchingRoomsResponse,
} from "../hivemoot/types.js";

const mockedGet = vi.mocked(hivemootGet);

function makeWatching(overrides: Partial<WatchingRoom> = {}): WatchingRoom {
  return {
    core: {
      roomId: "8d2bbb86-1f33-4d6a-9b3a-3ed1c0fbcdef",
      manager: "bot-queen",
      subject_type: "pr_review",
      subject_ref: "hivemoot/hivemoot#42",
      opened_at: "2026-04-29T18:00:00.000Z",
      timing_config: {
        max_age_secs: 7200,
        rsvp_deadline_secs: 600,
        contribution_deadline_secs: 1800,
      },
      status: "awaiting_contributions",
    },
    participants: {
      drone: {
        agent_id: "vercel.123",
        role: "drone",
        status: "pending",
        rsvp_at: "2026-04-29T18:00:30.000Z",
      },
    },
    currentSequence: 3,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatNewRoom", () => {
  it("renders status, subject label, ref, roomId, sequence, participants", () => {
    const out = formatNewRoom(makeWatching());
    expect(out).toContain("[NEW]");
    expect(out).toContain("[awaiting_contributions]");
    expect(out).toContain("pr_review hivemoot/hivemoot#42");
    expect(out).toContain("room=8d2bbb86-1f33-4d6a-9b3a-3ed1c0fbcdef");
    expect(out).toContain("seq=3");
    expect(out).toContain("participants=[drone:pending]");
  });

  it("renders mention_response subject as 'mention'", () => {
    const out = formatNewRoom(
      makeWatching({
        core: {
          ...makeWatching().core,
          subject_type: "mention_response",
          subject_ref: "x/y#1",
        },
      }),
    );
    expect(out).toContain("mention x/y#1");
  });

  it("omits participant block when empty", () => {
    const out = formatNewRoom(makeWatching({ participants: {} }));
    expect(out).not.toContain("participants=");
  });

  it("renders multiple participants sorted by role", () => {
    const out = formatNewRoom(
      makeWatching({
        participants: {
          guard: { agent_id: "g.1", role: "guard", status: "resolved" },
          drone: { agent_id: "d.1", role: "drone", status: "pending" },
          builder: { agent_id: "b.1", role: "builder", status: "pending" },
        },
      }),
    );
    // Sorted alphabetical by role
    expect(out).toContain("participants=[builder:pending,drone:pending,guard:resolved]");
  });
});

describe("formatRemovedRoom", () => {
  it("renders [REMOVED] tag with roomId", () => {
    const out = formatRemovedRoom(makeWatching({ core: { ...makeWatching().core, roomId: "abc" } }));
    expect(out).toBe("[REMOVED] room=abc");
  });
});

describe("pollWatchingOnce — diff logic", () => {
  it("emits each room as 'new' on first poll (empty seen set)", async () => {
    const emit = vi.fn();
    const fetcher = vi.fn().mockResolvedValue({
      rooms: [
        makeWatching({ core: { ...makeWatching().core, roomId: "r1" } }),
        makeWatching({ core: { ...makeWatching().core, roomId: "r2" } }),
      ],
    } as WatchingRoomsResponse);

    const seen = new Set<string>();
    await pollWatchingOnce({ seen, emit, fetcher, options: {} });

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0][1]).toBe("new");
    expect(emit.mock.calls[1][1]).toBe("new");
    expect(seen.has("r1")).toBe(true);
    expect(seen.has("r2")).toBe(true);
  });

  it("doesn't re-emit a room already seen on a subsequent poll", async () => {
    const emit = vi.fn();
    const fetcher = vi.fn().mockResolvedValue({
      rooms: [
        makeWatching({ core: { ...makeWatching().core, roomId: "r1" } }),
      ],
    } as WatchingRoomsResponse);
    const seen = new Set(["r1"]); // already seen

    await pollWatchingOnce({ seen, emit, fetcher, options: {} });

    expect(emit).not.toHaveBeenCalled();
    expect(seen.has("r1")).toBe(true);
  });

  it("emits 'removed' when a previously-seen room leaves the watching set", async () => {
    const emit = vi.fn();
    const fetcher = vi.fn().mockResolvedValue({
      rooms: [], // r1 is gone (RSVP'd-and-resolved by this role)
    } as WatchingRoomsResponse);
    const seen = new Set(["r1"]);

    await pollWatchingOnce({ seen, emit, fetcher, options: {} });

    expect(emit).toHaveBeenCalledTimes(1);
    const [, kind] = emit.mock.calls[0];
    expect(kind).toBe("removed");
    expect(seen.has("r1")).toBe(false); // pruned
  });

  it("re-emits as 'new' when a room re-enters watching set after removal (subject_updated)", async () => {
    const emit = vi.fn();
    const seen = new Set<string>();

    // Tick 1 — r1 appears
    let response: WatchingRoomsResponse = {
      rooms: [makeWatching({ core: { ...makeWatching().core, roomId: "r1" } })],
    };
    await pollWatchingOnce({
      seen, emit,
      fetcher: () => Promise.resolve(response),
      options: {},
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(seen.has("r1")).toBe(true);

    // Tick 2 — r1 disappears (worker resolved); pruned from seen
    response = { rooms: [] };
    await pollWatchingOnce({
      seen, emit,
      fetcher: () => Promise.resolve(response),
      options: {},
    });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][1]).toBe("removed");
    expect(seen.has("r1")).toBe(false);

    // Tick 3 — subject_updated brings r1 back into eligibility
    response = {
      rooms: [makeWatching({ core: { ...makeWatching().core, roomId: "r1" } })],
    };
    await pollWatchingOnce({
      seen, emit,
      fetcher: () => Promise.resolve(response),
      options: {},
    });
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit.mock.calls[2][1]).toBe("new"); // re-emitted
  });

  it("handles mixed new + removed on the same tick (removals first)", async () => {
    const emit = vi.fn();
    const fetcher = vi.fn().mockResolvedValue({
      rooms: [
        makeWatching({ core: { ...makeWatching().core, roomId: "r2" } }),
      ],
    } as WatchingRoomsResponse);
    const seen = new Set(["r1"]); // r1 was seen, r2 is new

    await pollWatchingOnce({ seen, emit, fetcher, options: {} });

    expect(emit).toHaveBeenCalledTimes(2);
    // Removals emitted first
    expect(emit.mock.calls[0][1]).toBe("removed");
    expect(emit.mock.calls[1][1]).toBe("new");
    expect(seen.has("r1")).toBe(false);
    expect(seen.has("r2")).toBe(true);
  });

  it("forwards token + apiUrl to the underlying fetcher", async () => {
    mockedGet.mockResolvedValue({ rooms: [] } as WatchingRoomsResponse);
    await pollWatchingOnce({
      seen: new Set(),
      emit: vi.fn(),
      options: { token: "tok-abc", apiUrl: "https://staging.example" },
    });
    const call = mockedGet.mock.calls[0][0];
    expect(call.path).toBe("/api/rooms/watching");
    expect(call.token).toBe("tok-abc");
    expect(call.apiUrl).toBe("https://staging.example");
  });
});

describe("roomsWatchCommand — output modes", () => {
  it("--once polls exactly once and exits", async () => {
    mockedGet.mockResolvedValue({
      rooms: [makeWatching({ core: { ...makeWatching().core, roomId: "r1" } })],
    } as WatchingRoomsResponse);
    await roomsWatchCommand({ once: true });
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("--json emits NDJSON with event=new + room shape", async () => {
    mockedGet.mockResolvedValue({
      rooms: [makeWatching({ core: { ...makeWatching().core, roomId: "r1" } })],
    } as WatchingRoomsResponse);
    const logSpy = vi.spyOn(console, "log");
    await roomsWatchCommand({ once: true, json: true });
    // One log call per emitted room (no header in --json mode)
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.event).toBe("new");
    expect(parsed.core.roomId).toBe("r1");
  });

  it("default (human, --once) emits header + one [NEW] line per room", async () => {
    mockedGet.mockResolvedValue({
      rooms: [
        makeWatching({ core: { ...makeWatching().core, roomId: "r1" } }),
        makeWatching({ core: { ...makeWatching().core, roomId: "r2" } }),
      ],
    } as WatchingRoomsResponse);
    const logSpy = vi.spyOn(console, "log");
    await roomsWatchCommand({ once: true });
    // No header in --once mode (header is only for the long loop)
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0][0]).toContain("[NEW]");
    expect(logSpy.mock.calls[0][0]).toContain("room=r1");
    expect(logSpy.mock.calls[1][0]).toContain("room=r2");
  });

  it("emits empty output for an empty watching set in --once mode", async () => {
    mockedGet.mockResolvedValue({ rooms: [] } as WatchingRoomsResponse);
    const logSpy = vi.spyOn(console, "log");
    await roomsWatchCommand({ once: true });
    expect(logSpy).not.toHaveBeenCalled();
  });
});
