/**
 * Tests for war-room storage layer (Phase D.1.a-i).
 *
 * Mirrors the agent-token-v1.test.ts pattern: a local mock Redis
 * with explicit Lua-script simulation, no live Redis dependency.
 * The mock decodes the Lua scripts' KEYS+ARGV shape and produces
 * the same return-tuple shape the real script does.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { type Redis } from "@upstash/redis";

import {
  ROOM_PREFIX,
  ROOM_OPEN_SCRIPT,
  DEFAULT_MAX_AGE_SECS,
  ROOM_RETENTION_AFTER_CLOSE_SECS,
  createRoom,
  getRoomCore,
  listRooms,
  validateSubjectRef,
  repoFromSubjectRef,
  roomKey,
  eventsKey,
  participantsKey,
  contributionsKey,
  seqKey,
  claimKey,
  idemKey,
  subjectIndexKey,
  installationIndexKey,
  statusIndexKey,
  repoIndexKey,
  roomLockKey,
  RoomSubjectAlreadyOpenError,
  RoomNotFoundError,
  RoomSubjectRefError,
  type RoomCore,
} from "./war-room";

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

function makeMockRedis() {
  const store = new Map<string, unknown>();
  const sortedSets = new Map<string, Array<{ member: string; score: number }>>();
  const sets = new Map<string, Set<string>>();

  function getSortedSet(key: string): Array<{ member: string; score: number }> {
    let s = sortedSets.get(key);
    if (!s) {
      s = [];
      sortedSets.set(key, s);
    }
    return s;
  }

  function getSet(key: string): Set<string> {
    let s = sets.get(key);
    if (!s) {
      s = new Set<string>();
      sets.set(key, s);
    }
    return s;
  }

  const luaSim = vi.fn(
    async (script: string, keys: string[], argv: string[]): Promise<unknown> => {
      // ROOM_OPEN_SCRIPT — 7 keys, 5 args
      if (
        keys.length === 7 &&
        argv.length === 5 &&
        script.includes("subject_taken")
      ) {
        const [
          subjIdxK,
          roomK,
          seqK,
          eventsK,
          statusK,
          installK,
          repoK,
        ] = keys;
        const [roomId, roomCoreJson, openedEventJson, openedAtMs, _maxAgeSecs] =
          argv;
        const existing = store.get(subjIdxK);
        if (existing) return [0, "subject_taken", existing];
        store.set(subjIdxK, roomId);
        store.set(roomK, JSON.parse(roomCoreJson));
        store.set(seqK, 1);
        getSortedSet(eventsK).push({
          member: openedEventJson,
          score: 1,
        });
        getSet(statusK).add(roomId);
        getSortedSet(installK).push({
          member: roomId,
          score: Number(openedAtMs),
        });
        getSet(repoK).add(roomId);
        return [1, roomId];
      }
      return null;
    },
  );

  const client = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(
      async (
        key: string,
        value: unknown,
        _opts?: { nx?: boolean; ex?: number },
      ) => {
        store.set(key, value);
        return "OK";
      },
    ),
    del: vi.fn(async (key: string) => {
      const had = store.has(key) || sortedSets.has(key) || sets.has(key);
      store.delete(key);
      sortedSets.delete(key);
      sets.delete(key);
      return had ? 1 : 0;
    }),
    zrange: vi.fn(
      async (
        key: string,
        start: number,
        stop: number,
        opts?: { rev?: boolean },
      ): Promise<string[]> => {
        const set = sortedSets.get(key) ?? [];
        const sorted = [...set].sort((a, b) => a.score - b.score);
        const ordered = opts?.rev ? sorted.reverse() : sorted;
        const end = stop === -1 ? ordered.length : stop + 1;
        return ordered.slice(start, end).map((e) => e.member);
      },
    ),
    zrem: vi.fn(async (key: string, ...members: string[]) => {
      const set = sortedSets.get(key);
      if (!set) return 0;
      let removed = 0;
      for (const m of members) {
        const idx = set.findIndex((e) => e.member === m);
        if (idx !== -1) {
          set.splice(idx, 1);
          removed++;
        }
      }
      return removed;
    }),
    eval: luaSim,
  };

  return Object.assign(client as unknown as Redis, {
    _store: store,
    _sortedSets: sortedSets,
    _sets: sets,
    _luaSim: luaSim,
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("DEFAULT_MAX_AGE_SECS is 3600 (1h, matching design doc default)", () => {
    expect(DEFAULT_MAX_AGE_SECS).toBe(3600);
  });

  it("ROOM_RETENTION_AFTER_CLOSE_SECS is 30 days", () => {
    expect(ROOM_RETENTION_AFTER_CLOSE_SECS).toBe(30 * 24 * 60 * 60);
  });

  it("ROOM_PREFIX matches the design doc convention", () => {
    expect(ROOM_PREFIX).toBe("hive:v1:room:");
  });
});

// ---------------------------------------------------------------------------
// Key construction
// ---------------------------------------------------------------------------

describe("key construction", () => {
  it("roomKey embeds installationId + roomId", () => {
    expect(roomKey("12345", "room-abc")).toBe("hive:v1:room:12345:room-abc");
  });

  it("eventsKey appends :events suffix", () => {
    expect(eventsKey("room-abc")).toBe("hive:v1:room:room-abc:events");
  });

  it("participantsKey appends :participants suffix", () => {
    expect(participantsKey("room-abc")).toBe(
      "hive:v1:room:room-abc:participants",
    );
  });

  it("contributionsKey appends :contributions suffix", () => {
    expect(contributionsKey("room-abc")).toBe(
      "hive:v1:room:room-abc:contributions",
    );
  });

  it("seqKey appends :seq suffix", () => {
    expect(seqKey("room-abc")).toBe("hive:v1:room:room-abc:seq");
  });

  it("claimKey appends :claim suffix", () => {
    expect(claimKey("room-abc")).toBe("hive:v1:room:room-abc:claim");
  });

  it("idemKey embeds the idempotency token under :idem:", () => {
    expect(idemKey("room-abc", "abc123")).toBe(
      "hive:v1:room:room-abc:idem:abc123",
    );
  });

  it("subjectIndexKey includes installationId + subject_type + subject_ref", () => {
    expect(
      subjectIndexKey("12345", "pr_review", "hivemoot/hivemoot#508"),
    ).toBe("hive:v1:idx:room:subject:12345:pr_review:hivemoot/hivemoot#508");
  });

  it("installationIndexKey includes installationId", () => {
    expect(installationIndexKey("12345")).toBe(
      "hive:v1:idx:room:installation:12345",
    );
  });

  it("statusIndexKey includes installationId + status", () => {
    expect(statusIndexKey("12345", "awaiting_rsvp")).toBe(
      "hive:v1:idx:room:status:12345:awaiting_rsvp",
    );
  });

  it("repoIndexKey includes installationId + owner/repo", () => {
    expect(repoIndexKey("12345", "hivemoot/hivemoot")).toBe(
      "hive:v1:idx:room:repo:12345:hivemoot/hivemoot",
    );
  });

  it("roomLockKey distinct from roomKey (lock prefix)", () => {
    const lock = roomLockKey("12345", "room-abc");
    const room = roomKey("12345", "room-abc");
    expect(lock).not.toBe(room);
    expect(lock).toMatch(/^hive:v1:lock:room:/);
  });
});

// ---------------------------------------------------------------------------
// validateSubjectRef
// ---------------------------------------------------------------------------

describe("validateSubjectRef", () => {
  it("accepts canonical pr_review form 'owner/repo#N'", () => {
    expect(() =>
      validateSubjectRef({
        type: "pr_review",
        ref: "hivemoot/hivemoot#508",
      }),
    ).not.toThrow();
  });

  it("accepts mention_response with same shape", () => {
    expect(() =>
      validateSubjectRef({
        type: "mention_response",
        ref: "hivemoot/colony#42",
      }),
    ).not.toThrow();
  });

  it("accepts issue_triage with same shape", () => {
    expect(() =>
      validateSubjectRef({
        type: "issue_triage",
        ref: "hivemoot/apiary#123",
      }),
    ).not.toThrow();
  });

  it("rejects missing # separator", () => {
    expect(() =>
      validateSubjectRef({
        type: "pr_review",
        ref: "hivemoot/hivemoot508",
      }),
    ).toThrow(RoomSubjectRefError);
  });

  it("rejects leading-zero issue numbers ('#0123' invalid)", () => {
    expect(() =>
      validateSubjectRef({
        type: "pr_review",
        ref: "hivemoot/hivemoot#0123",
      }),
    ).toThrow(RoomSubjectRefError);
  });

  it("rejects #0 (issue numbers are 1-indexed)", () => {
    expect(() =>
      validateSubjectRef({
        type: "pr_review",
        ref: "hivemoot/hivemoot#0",
      }),
    ).toThrow(RoomSubjectRefError);
  });

  it("rejects spaces in repo name", () => {
    expect(() =>
      validateSubjectRef({
        type: "pr_review",
        ref: "hivemoot/hive moot#42",
      }),
    ).toThrow(RoomSubjectRefError);
  });

  it("rejects empty owner ('/repo#42')", () => {
    expect(() =>
      validateSubjectRef({
        type: "pr_review",
        ref: "/hivemoot#42",
      }),
    ).toThrow(RoomSubjectRefError);
  });

  it("error message includes the offending ref + expected shape", () => {
    try {
      validateSubjectRef({ type: "pr_review", ref: "garbage" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RoomSubjectRefError);
      if (err instanceof RoomSubjectRefError) {
        expect(err.subjectType).toBe("pr_review");
        expect(err.subjectRef).toBe("garbage");
        expect(err.message).toMatch(/owner.*repo.*number/i);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// repoFromSubjectRef
// ---------------------------------------------------------------------------

describe("repoFromSubjectRef", () => {
  it("extracts owner/repo from canonical form", () => {
    expect(repoFromSubjectRef("hivemoot/hivemoot#508")).toBe("hivemoot/hivemoot");
  });

  it("returns empty string when # is missing (defensive)", () => {
    expect(repoFromSubjectRef("garbage")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// createRoom
// ---------------------------------------------------------------------------

describe("createRoom", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("creates a room with the awaiting_rsvp status + default timing", async () => {
    const core = await createRoom({
      installationId: "12345",
      roomId: "room-abc",
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    expect(core.status).toBe("awaiting_rsvp");
    expect(core.manager).toBe("bot-queen");
    expect(core.subject_type).toBe("pr_review");
    expect(core.subject_ref).toBe("hivemoot/hivemoot#508");
    expect(core.timing_config.max_age_secs).toBe(DEFAULT_MAX_AGE_SECS);
    expect(core.opened_at).toMatch(/T.*Z$/);
  });

  it("custom timing config overrides defaults selectively", async () => {
    const core = await createRoom({
      installationId: "12345",
      roomId: "room-abc",
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      timing: { max_age_secs: 7200 },
      redis,
    });
    expect(core.timing_config.max_age_secs).toBe(7200);
    // Other fields keep defaults
    expect(core.timing_config.rsvp_deadline_secs).toBe(600);
    expect(core.timing_config.contribution_deadline_secs).toBe(1200);
  });

  it("registers the room in the installation index sorted set", async () => {
    await createRoom({
      installationId: "12345",
      roomId: "room-abc",
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    const indexed = redis._sortedSets.get(installationIndexKey("12345"));
    expect(indexed).toBeDefined();
    expect(indexed?.[0].member).toBe("room-abc");
  });

  it("registers the room in the status:awaiting_rsvp set", async () => {
    await createRoom({
      installationId: "12345",
      roomId: "room-abc",
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    const statusSet = redis._sets.get(
      statusIndexKey("12345", "awaiting_rsvp"),
    );
    expect(statusSet?.has("room-abc")).toBe(true);
  });

  it("registers the room in the per-repo index", async () => {
    await createRoom({
      installationId: "12345",
      roomId: "room-abc",
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    const repoSet = redis._sets.get(repoIndexKey("12345", "hivemoot/hivemoot"));
    expect(repoSet?.has("room-abc")).toBe(true);
  });

  it("seeds the event log with a room_opened event at seq=1", async () => {
    await createRoom({
      installationId: "12345",
      roomId: "room-abc",
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    const events = redis._sortedSets.get(eventsKey("room-abc"));
    expect(events).toHaveLength(1);
    const evt = JSON.parse(events![0].member);
    expect(evt.event_type).toBe("room_opened");
    expect(evt.seq).toBe(1);
    expect(evt.actor_role).toBe("system");
    expect(evt.actor_id).toBe("bot-queen");
  });

  it("seq counter initialized at 1 (next event will INCR to 2)", async () => {
    await createRoom({
      installationId: "12345",
      roomId: "room-abc",
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    expect(redis._store.get(seqKey("room-abc"))).toBe(1);
  });

  it("subject-uniqueness: second room on same subject → RoomSubjectAlreadyOpenError", async () => {
    await createRoom({
      installationId: "12345",
      roomId: "room-1st",
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    try {
      await createRoom({
        installationId: "12345",
        roomId: "room-2nd",
        manager: "bot-queen",
        subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
        redis,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RoomSubjectAlreadyOpenError);
      if (err instanceof RoomSubjectAlreadyOpenError) {
        expect(err.existingRoomId).toBe("room-1st");
        expect(err.subjectType).toBe("pr_review");
      }
    }
  });

  it("different installation can have a room on the same subject_ref", async () => {
    await createRoom({
      installationId: "12345",
      roomId: "room-a",
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    // Different installation — should NOT conflict
    await expect(
      createRoom({
        installationId: "67890",
        roomId: "room-b",
        manager: "bot-queen",
        subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
        redis,
      }),
    ).resolves.toBeDefined();
  });

  it("malformed subject_ref → RoomSubjectRefError before any storage write", async () => {
    await expect(
      createRoom({
        installationId: "12345",
        roomId: "room-abc",
        manager: "bot-queen",
        subject: { type: "pr_review", ref: "garbage-no-hash" },
        redis,
      }),
    ).rejects.toThrow(RoomSubjectRefError);
    // No storage write happened
    expect(redis._store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getRoomCore
// ---------------------------------------------------------------------------

describe("getRoomCore", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("reads back the room core that createRoom wrote", async () => {
    await createRoom({
      installationId: "12345",
      roomId: "room-abc",
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    const core = await getRoomCore({
      installationId: "12345",
      roomId: "room-abc",
      redis,
    });
    expect(core.status).toBe("awaiting_rsvp");
    expect(core.subject_ref).toBe("hivemoot/hivemoot#508");
  });

  it("missing room → RoomNotFoundError", async () => {
    await expect(
      getRoomCore({
        installationId: "12345",
        roomId: "nonexistent",
        redis,
      }),
    ).rejects.toThrow(RoomNotFoundError);
  });

  it("decodes JSON-encoded room hash (defensive against client variant)", async () => {
    // Pre-populate as a JSON string (some Upstash client paths do this)
    const core: RoomCore = {
      status: "awaiting_rsvp",
      manager: "bot-queen",
      subject_type: "pr_review",
      subject_ref: "hivemoot/hivemoot#508",
      opened_at: "2026-04-27T00:00:00.000Z",
      timing_config: {
        max_age_secs: 3600,
        rsvp_deadline_secs: 600,
        contribution_deadline_secs: 1200,
      },
    };
    redis._store.set(roomKey("12345", "room-string"), JSON.stringify(core));
    const result = await getRoomCore({
      installationId: "12345",
      roomId: "room-string",
      redis,
    });
    expect(result).toEqual(core);
  });
});

// ---------------------------------------------------------------------------
// listRooms
// ---------------------------------------------------------------------------

describe("listRooms", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("empty installation → []", async () => {
    expect(await listRooms({ installationId: "12345", redis })).toEqual([]);
  });

  it("returns rooms newest-first by opened_at", async () => {
    let now = Date.now();
    await createRoom({
      installationId: "12345",
      roomId: "room-old",
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#1" },
      redis,
      nowMs: now,
    });
    now += 1000;
    await createRoom({
      installationId: "12345",
      roomId: "room-new",
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#2" },
      redis,
      nowMs: now,
    });
    const rooms = await listRooms({ installationId: "12345", redis });
    expect(rooms).toHaveLength(2);
    expect(rooms[0].subject_ref).toBe("hivemoot/hivemoot#2"); // newest first
    expect(rooms[1].subject_ref).toBe("hivemoot/hivemoot#1");
  });

  it("limit parameter caps the result count", async () => {
    let now = Date.now();
    for (let i = 1; i <= 5; i++) {
      await createRoom({
        installationId: "12345",
        roomId: `room-${i}`,
        manager: "bot-queen",
        subject: { type: "pr_review", ref: `hivemoot/hivemoot#${i}` },
        redis,
        nowMs: now,
      });
      now += 1000;
    }
    const rooms = await listRooms({ installationId: "12345", redis, limit: 2 });
    expect(rooms).toHaveLength(2);
    // Newest two: room-5 and room-4
    expect(rooms[0].subject_ref).toBe("hivemoot/hivemoot#5");
    expect(rooms[1].subject_ref).toBe("hivemoot/hivemoot#4");
  });

  it("self-heals orphaned index entries (room hash TTL'd, index lingering)", async () => {
    await createRoom({
      installationId: "12345",
      roomId: "room-orphan",
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#1" },
      redis,
    });
    // Simulate the room hash being TTL-swept while the index entry
    // lingers (the bug listRooms's self-heal addresses).
    redis._store.delete(roomKey("12345", "room-orphan"));

    const rooms = await listRooms({ installationId: "12345", redis });
    expect(rooms).toEqual([]);
    // Self-heal: orphan ZREM'd from the installation index
    const indexed = redis._sortedSets.get(installationIndexKey("12345"));
    expect(indexed).toEqual([]);
  });

  it("isolates rooms across installations", async () => {
    await createRoom({
      installationId: "12345",
      roomId: "room-a",
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#1" },
      redis,
    });
    await createRoom({
      installationId: "67890",
      roomId: "room-b",
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#1" }, // same subject, different installation
      redis,
    });
    const rooms12345 = await listRooms({ installationId: "12345", redis });
    const rooms67890 = await listRooms({ installationId: "67890", redis });
    expect(rooms12345).toHaveLength(1);
    expect(rooms67890).toHaveLength(1);
    expect(rooms12345[0].manager).toBe("bot-queen");
  });
});

// ---------------------------------------------------------------------------
// Lua script source (defensive — pin the script doesn't drift)
// ---------------------------------------------------------------------------

describe("ROOM_OPEN_SCRIPT source", () => {
  it("performs the subject-uniqueness check FIRST (before any writes)", () => {
    const lines = ROOM_OPEN_SCRIPT.split("\n");
    const getIdx = lines.findIndex((l) => l.includes('redis.call("get", KEYS[1])'));
    const setRoomIdx = lines.findIndex((l) => l.includes("KEYS[2]"));
    expect(getIdx).toBeGreaterThan(0);
    expect(setRoomIdx).toBeGreaterThan(getIdx);
  });

  it("TTLs the subject-uniqueness key (closes Queen R3 #3)", () => {
    expect(ROOM_OPEN_SCRIPT).toMatch(/redis\.call\("set", KEYS\[1\].*"EX"/);
  });

  it("initializes seq to 0 then INCRs to 1 (so first event lands at seq=1)", () => {
    expect(ROOM_OPEN_SCRIPT).toMatch(/redis\.call\("set", KEYS\[3\], "0"\)/);
    expect(ROOM_OPEN_SCRIPT).toMatch(/redis\.call\("incr", KEYS\[3\]\)/);
  });

  it("returns benign-conflict {0, 'subject_taken', existingRoomId} on duplicate", () => {
    expect(ROOM_OPEN_SCRIPT).toMatch(
      /return \{0, "subject_taken", existingRoomId\}/,
    );
  });
});
