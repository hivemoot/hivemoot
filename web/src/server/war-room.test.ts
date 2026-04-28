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
  validateRoomId,
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
  RoomIdFormatError,
  RoomIdTakenError,
  type RoomCore,
  type RoomCoreData,
} from "./war-room";

// Three throwaway UUIDv4s for the test fixtures. Generated via
// crypto.randomUUID() and pinned here so tests are deterministic.
const RID_A = "01234567-89ab-4cde-9012-3456789abcde";
const RID_B = "fedcba98-7654-4321-89ab-fedcba987654";
const RID_C = "11111111-2222-4333-9444-555555555555";

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

function makeMockRedis() {
  const store = new Map<string, unknown>();
  const sortedSets = new Map<string, Array<{ member: string; score: number }>>();
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Map<string, unknown>>();

  function getHash(key: string): Map<string, unknown> {
    let h = hashes.get(key);
    if (!h) {
      h = new Map<string, unknown>();
      hashes.set(key, h);
    }
    return h;
  }

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
      // ROOM_OPEN_SCRIPT — 7 keys, 6 args (R2: HASH shape + initialStatus arg + EXISTS check)
      if (
        keys.length === 7 &&
        argv.length === 6 &&
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
        const [
          roomId,
          dataJson,
          initialStatus,
          openedEventJson,
          openedAtMs,
          _maxAgeSecs,
        ] = argv;
        const existing = store.get(subjIdxK);
        if (existing) return [0, "subject_taken", existing];
        // EXISTS check on roomKey (closes G3 second compounding issue)
        if (hashes.has(roomK)) return [0, "room_id_taken", roomId];
        store.set(subjIdxK, roomId);
        const h = getHash(roomK);
        h.set("data", dataJson);
        h.set("status", initialStatus);
        store.set(seqK, 1);
        getSortedSet(eventsK).push({ member: openedEventJson, score: 1 });
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
    hgetall: vi.fn(async (key: string) => {
      const h = hashes.get(key);
      if (!h) return null;
      const obj: Record<string, unknown> = {};
      for (const [k, v] of h) obj[k] = v;
      return obj;
    }),
    hset: vi.fn(async (key: string, fields: Record<string, unknown>) => {
      const h = getHash(key);
      let added = 0;
      for (const [k, v] of Object.entries(fields)) {
        if (!h.has(k)) added++;
        h.set(k, v);
      }
      return added;
    }),
    hget: vi.fn(async (key: string, field: string) => {
      const h = hashes.get(key);
      return h?.get(field) ?? null;
    }),
    del: vi.fn(async (key: string) => {
      const had =
        store.has(key) ||
        sortedSets.has(key) ||
        sets.has(key) ||
        hashes.has(key);
      store.delete(key);
      sortedSets.delete(key);
      sets.delete(key);
      hashes.delete(key);
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
    expect(roomKey("12345", RID_A)).toBe(`hive:v1:room:12345:${RID_A}`);
  });

  it("eventsKey appends :events suffix", () => {
    expect(eventsKey(RID_A)).toBe(`hive:v1:room:${RID_A}:events`);
  });

  it("participantsKey appends :participants suffix", () => {
    expect(participantsKey(RID_A)).toBe(
      `hive:v1:room:${RID_A}:participants`,
    );
  });

  it("contributionsKey appends :contributions suffix", () => {
    expect(contributionsKey(RID_A)).toBe(
      `hive:v1:room:${RID_A}:contributions`,
    );
  });

  it("seqKey appends :seq suffix", () => {
    expect(seqKey(RID_A)).toBe(`hive:v1:room:${RID_A}:seq`);
  });

  it("claimKey appends :claim suffix", () => {
    expect(claimKey(RID_A)).toBe(`hive:v1:room:${RID_A}:claim`);
  });

  it("idemKey embeds the idempotency token under :idem:", () => {
    expect(idemKey(RID_A, "abc123")).toBe(
      `hive:v1:room:${RID_A}:idem:abc123`,
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
    const lock = roomLockKey("12345", RID_A);
    const room = roomKey("12345", RID_A);
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
      roomId: RID_A,
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
      roomId: RID_A,
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
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    const indexed = redis._sortedSets.get(installationIndexKey("12345"));
    expect(indexed).toBeDefined();
    expect(indexed?.[0].member).toBe(RID_A);
  });

  it("registers the room in the status:awaiting_rsvp set", async () => {
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    const statusSet = redis._sets.get(
      statusIndexKey("12345", "awaiting_rsvp"),
    );
    expect(statusSet?.has(RID_A)).toBe(true);
  });

  it("registers the room in the per-repo index", async () => {
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    const repoSet = redis._sets.get(repoIndexKey("12345", "hivemoot/hivemoot"));
    expect(repoSet?.has(RID_A)).toBe(true);
  });

  it("seeds the event log with a room_opened event at seq=1", async () => {
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    const events = redis._sortedSets.get(eventsKey(RID_A));
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
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    expect(redis._store.get(seqKey(RID_A))).toBe(1);
  });

  it("subject-uniqueness: second room on same subject → RoomSubjectAlreadyOpenError", async () => {
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    try {
      await createRoom({
        installationId: "12345",
        roomId: RID_B,
        manager: "bot-queen",
        subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
        redis,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RoomSubjectAlreadyOpenError);
      if (err instanceof RoomSubjectAlreadyOpenError) {
        expect(err.existingRoomId).toBe(RID_A);
        expect(err.subjectType).toBe("pr_review");
      }
    }
  });

  it("roomId-uniqueness: same roomId twice in same installation → RoomIdTakenError (G3)", async () => {
    // Closes #509 guard R1 G3 (second compounding issue): the EXISTS
    // check on roomKey rejects a second open with the same roomId.
    // Previously the unconditional SET would silently overwrite.
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#1" },
      redis,
    });
    await expect(
      createRoom({
        installationId: "12345",
        roomId: RID_A, // same roomId, different subject
        manager: "bot-queen",
        subject: { type: "pr_review", ref: "hivemoot/hivemoot#2" },
        redis,
      }),
    ).rejects.toThrow(RoomIdTakenError);
  });

  it("different installation can have a room on the same subject_ref", async () => {
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    // Different installation — should NOT conflict
    await expect(
      createRoom({
        installationId: "67890",
        roomId: RID_B,
        manager: "bot-queen",
        subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
        redis,
      }),
    ).resolves.toBeDefined();
  });

  it("malformed roomId → RoomIdFormatError before any storage write (G3)", async () => {
    // Boundary validation: caller passing "1" or "room-A" is rejected
    // BEFORE the storage call. Sibling keys (events / participants /
    // contributions / seq / claim / idem) embed only roomId, so cross-
    // installation isolation hinges on UUIDv4 strength.
    await expect(
      createRoom({
        installationId: "12345",
        roomId: "1", // not a UUID
        manager: "bot-queen",
        subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
        redis,
      }),
    ).rejects.toThrow(RoomIdFormatError);
    expect(redis._store.size).toBe(0); // no storage write
  });

  it("malformed subject_ref → RoomSubjectRefError before any storage write", async () => {
    await expect(
      createRoom({
        installationId: "12345",
        roomId: RID_A,
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
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    const core = await getRoomCore({
      installationId: "12345",
      roomId: RID_A,
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

  it("decodes the data field as JSON when stored as string (Upstash variant)", async () => {
    // Direct hash write with data as a JSON STRING (one Upstash
    // client path — others auto-parse). The reader handles both.
    const data: RoomCoreData = {
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
    await redis.hset(roomKey("12345", RID_A), {
      data: JSON.stringify(data),
      status: "awaiting_rsvp",
    });
    const result = await getRoomCore({
      installationId: "12345",
      roomId: RID_A,
      redis,
    });
    expect(result.status).toBe("awaiting_rsvp");
    expect(result.subject_ref).toBe("hivemoot/hivemoot#508");
    expect(result.manager).toBe("bot-queen");
  });

  it("missing data field on the hash → RoomNotFoundError (defensive)", async () => {
    // A hash with only the status field (data sweep'd somehow) is
    // semantically "not a complete room" — surface as not-found.
    await redis.hset(roomKey("12345", RID_A), {
      status: "awaiting_rsvp",
    });
    await expect(
      getRoomCore({ installationId: "12345", roomId: RID_A, redis }),
    ).rejects.toThrow(RoomNotFoundError);
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
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#1" },
      redis,
      nowMs: now,
    });
    now += 1000;
    await createRoom({
      installationId: "12345",
      roomId: RID_B,
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
    // Five distinct UUIDv4-shape ids, deterministic for test stability.
    const RIDS = [
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      "30000000-0000-4000-8000-000000000003",
      "40000000-0000-4000-8000-000000000004",
      "50000000-0000-4000-8000-000000000005",
    ];
    let now = Date.now();
    for (let i = 0; i < 5; i++) {
      await createRoom({
        installationId: "12345",
        roomId: RIDS[i],
        manager: "bot-queen",
        subject: { type: "pr_review", ref: `hivemoot/hivemoot#${i + 1}` },
        redis,
        nowMs: now,
      });
      now += 1000;
    }
    const rooms = await listRooms({ installationId: "12345", redis, limit: 2 });
    expect(rooms).toHaveLength(2);
    // Newest two: room with ref #5 and #4
    expect(rooms[0].subject_ref).toBe("hivemoot/hivemoot#5");
    expect(rooms[1].subject_ref).toBe("hivemoot/hivemoot#4");
  });

  it("self-heals orphaned index entries (room hash TTL'd, index lingering)", async () => {
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#1" },
      redis,
    });
    // Simulate the room hash being TTL-swept while the index entry
    // lingers (the bug listRooms's self-heal addresses). Hash store
    // is internal to the mock — `del` clears it.
    await redis.del(roomKey("12345", RID_A));

    const rooms = await listRooms({ installationId: "12345", redis });
    expect(rooms).toEqual([]);
    // Self-heal: orphan ZREM'd from the installation index
    const indexed = redis._sortedSets.get(installationIndexKey("12345"));
    expect(indexed).toEqual([]);
  });

  it("isolates rooms across installations", async () => {
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#1" },
      redis,
    });
    await createRoom({
      installationId: "67890",
      roomId: RID_B,
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
    const writeIdx = lines.findIndex((l) =>
      l.includes('redis.call("hset", KEYS[2]'),
    );
    expect(getIdx).toBeGreaterThan(0);
    expect(writeIdx).toBeGreaterThan(getIdx);
  });

  it("TTLs the subject-uniqueness key (closes Queen R3 #3)", () => {
    expect(ROOM_OPEN_SCRIPT).toMatch(/redis\.call\("set", KEYS\[1\].*"EX"/);
  });

  it("initializes seq directly to 1 (matches design L303 — one fewer Redis call than SET 0 + INCR)", () => {
    expect(ROOM_OPEN_SCRIPT).toMatch(/redis\.call\("set", KEYS\[3\], 1\)/);
    // Defensive: ensure the old SET 0 + INCR pattern is gone
    expect(ROOM_OPEN_SCRIPT).not.toMatch(/redis\.call\("set", KEYS\[3\], "0"\)/);
  });

  it("uses HSET on the room hash (not SET) — closes #509 G2 storage shape", () => {
    expect(ROOM_OPEN_SCRIPT).toMatch(/redis\.call\("hset", KEYS\[2\], "data"/);
    expect(ROOM_OPEN_SCRIPT).toMatch(/redis\.call\("hset", KEYS\[2\], "status"/);
    // Defensive: pin that the old SET-as-string shape is gone
    expect(ROOM_OPEN_SCRIPT).not.toMatch(/redis\.call\("set", KEYS\[2\]/);
  });

  it("EXISTS check on roomKey precedes the write (closes #509 G3 second compounding issue)", () => {
    expect(ROOM_OPEN_SCRIPT).toMatch(
      /if redis\.call\("exists", KEYS\[2\]\) == 1 then/,
    );
    expect(ROOM_OPEN_SCRIPT).toMatch(/return \{0, "room_id_taken"/);
  });

  it("returns benign-conflict {0, 'subject_taken', existingRoomId} on duplicate", () => {
    expect(ROOM_OPEN_SCRIPT).toMatch(
      /return \{0, "subject_taken", existingRoomId\}/,
    );
  });
});

// ---------------------------------------------------------------------------
// validateRoomId (G3 boundary regex)
// ---------------------------------------------------------------------------

describe("validateRoomId", () => {
  it("accepts canonical UUIDv4 lowercase", () => {
    expect(() => validateRoomId(RID_A)).not.toThrow();
    expect(() => validateRoomId(RID_B)).not.toThrow();
    expect(() => validateRoomId(RID_C)).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateRoomId("")).toThrow(RoomIdFormatError);
  });

  it("rejects non-UUID 'room-A' style", () => {
    expect(() => validateRoomId("room-A")).toThrow(RoomIdFormatError);
    expect(() => validateRoomId("1")).toThrow(RoomIdFormatError);
    expect(() => validateRoomId("abc")).toThrow(RoomIdFormatError);
  });

  it("rejects uppercase hex (canonical crypto.randomUUID is lowercase)", () => {
    expect(() =>
      validateRoomId("01234567-89AB-4CDE-9012-3456789ABCDE"),
    ).toThrow(RoomIdFormatError);
  });

  it("rejects wrong version nibble (UUIDv1, UUIDv7, etc.)", () => {
    expect(() =>
      validateRoomId("01234567-89ab-1cde-9012-3456789abcde"), // version 1
    ).toThrow(RoomIdFormatError);
    expect(() =>
      validateRoomId("01234567-89ab-7cde-9012-3456789abcde"), // version 7
    ).toThrow(RoomIdFormatError);
  });

  it("rejects wrong variant bits", () => {
    expect(() =>
      validateRoomId("01234567-89ab-4cde-c012-3456789abcde"), // variant 'c' (not 8/9/a/b)
    ).toThrow(RoomIdFormatError);
  });

  it("RoomIdFormatError carries the offending value + recovery hint", () => {
    try {
      validateRoomId("garbage");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RoomIdFormatError);
      if (err instanceof RoomIdFormatError) {
        expect(err.roomId).toBe("garbage");
        expect(err.message).toMatch(/UUIDv4/);
        expect(err.message).toMatch(/crypto\.randomUUID/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Storage shape (HASH vs STRING regression — closes #509 G2)
// ---------------------------------------------------------------------------

describe("storage shape", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("createRoom writes the room as a HASH with 'data' + 'status' fields", async () => {
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    // The 'data' field exists and the JSON parse-roundtrips
    const dataField = await redis.hget(roomKey("12345", RID_A), "data");
    expect(dataField).toBeDefined();
    expect(typeof dataField).toBe("string");
    const parsed = JSON.parse(dataField as string) as RoomCoreData;
    expect(parsed.subject_ref).toBe("hivemoot/hivemoot#508");
    expect(parsed.manager).toBe("bot-queen");
    // The 'status' field is its own string (NOT inside the JSON blob)
    const statusField = await redis.hget(roomKey("12345", RID_A), "status");
    expect(statusField).toBe("awaiting_rsvp");
    // The plain GET shape is empty (room is a HASH, not a STRING)
    const rawGet = await redis.get(roomKey("12345", RID_A));
    expect(rawGet).toBeNull();
  });
});
