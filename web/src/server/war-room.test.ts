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

      // ROOM_PARTICIPANT_TRANSITION_SCRIPT — 6 keys, 13 args (D.1.a-ii R4)
      if (
        keys.length === 6 &&
        argv.length === 13 &&
        script.includes("no_participant")
      ) {
        const [seqK, eventsK, idemK, roomK, participantsK, contributionsK] = keys;
        const [
          eventTemplate,
          idempotencyKey,
          _eventType,
          role,
          ownerRequired,
          ownerExpected,
          allowedRoomStatuses,
          _roomId,
          _idemTtlSecs,
          transform,
          nowIso,
          contributionFieldJson,
          allowedParticipantStatuses,
        ] = argv;

        // 1. Idempotency
        if (idempotencyKey !== "") {
          const existing = store.get(idemK);
          if (existing !== undefined) return [-1, Number(existing)];
        }
        // 2. Room exists + status check
        const roomHash = hashes.get(roomK);
        const currStatus = roomHash?.get("status") as string | undefined;
        if (currStatus === undefined) return [-3, "room_not_found"];
        if (allowedRoomStatuses !== "") {
          const allowed = allowedRoomStatuses.split(",");
          if (!allowed.includes(currStatus)) return [-2, currStatus];
        }
        // 3. Participant slot must exist
        const existingP = hashes.get(participantsK)?.get(role) as
          | string
          | undefined;
        if (existingP === undefined) return [-5, "no_participant"];
        const p = JSON.parse(existingP) as {
          agent_id: string;
          status: string;
          rsvp_at: string;
          role: string;
        };
        // 4. Owner check (when required)
        if (ownerRequired === "1" && p.agent_id !== ownerExpected) {
          return [-4, "owner_conflict", p.agent_id];
        }
        // 4b. Participant-state precondition (R4 closes builder R3)
        if (allowedParticipantStatuses !== "") {
          const allowed = allowedParticipantStatuses.split(",");
          if (!allowed.includes(p.status)) {
            return [-6, "participant_state_precondition", p.status];
          }
        }
        // 5. INCR + ZADD + idem
        const oldSeq = (store.get(seqK) as number | undefined) ?? 0;
        const seq = oldSeq + 1;
        store.set(seqK, seq);
        const eventJson = eventTemplate.replace("__SEQ__", String(seq));
        getSortedSet(eventsK).push({ member: eventJson, score: seq });
        if (idempotencyKey !== "") {
          store.set(idemK, String(seq));
        }
        // 6. Apply transformation
        if (transform === "resolve") {
          const updated = {
            ...p,
            status: "resolved",
            resolved_at: nowIso,
            withdrew_at_sequence: undefined,
          };
          delete (updated as { withdrew_at_sequence?: unknown })
            .withdrew_at_sequence;
          getHash(participantsK).set(role, JSON.stringify(updated));
        } else if (transform === "withdraw") {
          const updated = {
            ...p,
            status: "withdrew",
            resolved_at: nowIso,
            withdrew_at_sequence: seq,
          };
          getHash(participantsK).set(role, JSON.stringify(updated));
        } else if (transform === "timeout") {
          const updated = { ...p, status: "timed_out", resolved_at: nowIso };
          getHash(participantsK).set(role, JSON.stringify(updated));
        }
        // "noop" leaves slot unchanged
        // 7. Optional contribution write
        if (contributionFieldJson !== "") {
          getHash(contributionsK).set(role, contributionFieldJson);
        }
        return [seq];
      }

      // ROOM_APPEND_EVENT_SCRIPT R2 — 9 keys, 15 args (D.1.a-ii R2)
      if (
        keys.length === 9 &&
        argv.length === 15 &&
        script.includes("__SEQ__")
      ) {
        const [
          seqK,
          eventsK,
          idemK,
          roomK,
          ownerCheckK,
          materializedK1,
          statusFromK,
          statusToK,
          materializedK2,
        ] = keys;
        const [
          eventTemplate,
          idempotencyKey,
          _eventType,
          ownerCheckRole,
          ownerExpected,
          materializedFieldName1,
          materializedFieldJson1,
          allowedStatuses,
          statusTo,
          roomId,
          _idemTtlSecs,
          materializedFieldName2,
          materializedFieldJson2,
          substituteSeq1,
          substituteSeq2,
        ] = argv;

        // 1. Idempotency check
        if (idempotencyKey !== "") {
          const existing = store.get(idemK);
          if (existing !== undefined) {
            return [-1, Number(existing)];
          }
        }

        // 2. Room existence check (Lua's HGET status returns nil for missing room)
        const roomHash = hashes.get(roomK);
        const currStatus = roomHash?.get("status") as string | undefined;
        if (currStatus === undefined) {
          return [-3, "room_not_found"];
        }

        // 3. Allowed-statuses gate
        if (allowedStatuses !== "") {
          const allowed = allowedStatuses.split(",");
          if (!allowed.includes(currStatus)) {
            return [-2, currStatus];
          }
        }

        // 4. Owner check
        if (ownerCheckRole !== "") {
          const existingMatRaw = hashes.get(ownerCheckK)?.get(ownerCheckRole);
          if (existingMatRaw !== undefined) {
            const parsed = JSON.parse(existingMatRaw as string) as {
              agent_id: string;
              status: string;
            };
            if (
              parsed.agent_id !== ownerExpected &&
              parsed.status !== "withdrew"
            ) {
              return [-4, "owner_conflict", parsed.agent_id];
            }
          }
        }

        // 5. INCR seq
        const oldSeq = (store.get(seqK) as number | undefined) ?? 0;
        const seq = oldSeq + 1;
        store.set(seqK, seq);

        // 6. ZADD event (FIRST-MATCH gsub __SEQ__ to seq — closes guard B1)
        const eventJson = eventTemplate.replace("__SEQ__", String(seq));
        getSortedSet(eventsK).push({ member: eventJson, score: seq });

        // 7. SET idempotency reverse index
        if (idempotencyKey !== "") {
          store.set(idemK, String(seq));
        }

        // 8. HSET materialized 1 (opt-in __SEQ__ substitution)
        if (materializedFieldName1 !== "") {
          const mat1 =
            substituteSeq1 === "1"
              ? materializedFieldJson1.replace("__SEQ__", String(seq))
              : materializedFieldJson1;
          getHash(materializedK1).set(materializedFieldName1, mat1);
        }

        // 9. HSET materialized 2 (dual-update for submitContribution)
        if (materializedFieldName2 !== "") {
          const mat2 =
            substituteSeq2 === "1"
              ? materializedFieldJson2.replace("__SEQ__", String(seq))
              : materializedFieldJson2;
          getHash(materializedK2).set(materializedFieldName2, mat2);
        }

        // 10. Status transition
        if (statusTo !== "") {
          getHash(roomK).set("status", statusTo);
          if (currStatus !== statusTo) {
            getSet(statusFromK).delete(roomId);
            getSet(statusToK).add(roomId);
          }
        }

        return [seq];
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
        start: number | string,
        stop: number | string,
        opts?: { rev?: boolean; byScore?: boolean; offset?: number; count?: number },
      ): Promise<string[]> => {
        const set = sortedSets.get(key) ?? [];
        const sorted = [...set].sort((a, b) => a.score - b.score);
        if (opts?.byScore) {
          // BYSCORE mode: start/stop are scores; "+inf" / "-inf" supported.
          const minScore = start === "-inf" ? -Infinity : Number(start);
          const maxScore = stop === "+inf" ? Infinity : Number(stop);
          const filtered = sorted.filter(
            (e) => e.score >= minScore && e.score <= maxScore,
          );
          const offset = opts.offset ?? 0;
          const end = opts.count !== undefined ? offset + opts.count : filtered.length;
          return filtered.slice(offset, end).map((e) => e.member);
        }
        const ordered = opts?.rev ? sorted.reverse() : sorted;
        const startN = Number(start);
        const stopN = Number(stop);
        const end = stopN === -1 ? ordered.length : stopN + 1;
        return ordered.slice(startN, end).map((e) => e.member);
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

// ===========================================================================
// D.1.a-ii — event appending + RSVP / contribute primitives
// ===========================================================================

import {
  ROOM_APPEND_EVENT_SCRIPT,
  ROOM_EVENT_BODY_MAX_BYTES,
  ROOM_CONTRIBUTION_RAW_MD_MAX_BYTES,
  IDEM_TTL_MULTIPLIER,
  CONTRIBUTION_SUMMARY_MAX_CHARS,
  CONTRIBUTION_FINDINGS_MAX_COUNT,
  deriveIdempotencyKey,
  validateContributionBody,
  appendRoomEvent,
  presentParticipant,
  withdrawParticipant,
  submitContribution,
  withdrawContribution,
  timeoutParticipant,
  listRoomEvents,
  getRoomParticipants,
  getRoomContributions,
  RoomEventStatusPreconditionError,
  RoomEventIdempotencyReplayError,
  RoomEventBodyTooLargeError,
  RoomContributionTooLargeError,
  RoomParticipantOwnerConflictError,
  RoomParticipantNotFoundError,
  RoomParticipantStatePreconditionError,
  ContributionValidationError,
} from "./war-room";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("D.1.a-ii constants", () => {
  it("ROOM_EVENT_BODY_MAX_BYTES = 8 KiB (design cap)", () => {
    expect(ROOM_EVENT_BODY_MAX_BYTES).toBe(8 * 1024);
  });

  it("ROOM_CONTRIBUTION_RAW_MD_MAX_BYTES = 32 KiB (design cap)", () => {
    expect(ROOM_CONTRIBUTION_RAW_MD_MAX_BYTES).toBe(32 * 1024);
  });

  it("IDEM_TTL_MULTIPLIER = 2 (idem TTL = 2 × max_age_secs per design)", () => {
    expect(IDEM_TTL_MULTIPLIER).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// deriveIdempotencyKey
// ---------------------------------------------------------------------------

describe("deriveIdempotencyKey", () => {
  it("produces a 64-char SHA-256 hex string", () => {
    const k = deriveIdempotencyKey({
      roomId: RID_A,
      role: "drone",
      action: "present",
      sequenceObservedByClient: 5,
    });
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it("identical inputs → identical key (replay-safe)", () => {
    const a = deriveIdempotencyKey({
      roomId: RID_A,
      role: "drone",
      action: "present",
      sequenceObservedByClient: 5,
    });
    const b = deriveIdempotencyKey({
      roomId: RID_A,
      role: "drone",
      action: "present",
      sequenceObservedByClient: 5,
    });
    expect(a).toBe(b);
  });

  it("different role → different key (cross-role isolation)", () => {
    const a = deriveIdempotencyKey({
      roomId: RID_A,
      role: "drone",
      action: "present",
      sequenceObservedByClient: 5,
    });
    const b = deriveIdempotencyKey({
      roomId: RID_A,
      role: "builder",
      action: "present",
      sequenceObservedByClient: 5,
    });
    expect(a).not.toBe(b);
  });

  it("different action lane → different key (present vs withdraw don't dedupe)", () => {
    const a = deriveIdempotencyKey({
      roomId: RID_A,
      role: "drone",
      action: "present",
      sequenceObservedByClient: 5,
    });
    const b = deriveIdempotencyKey({
      roomId: RID_A,
      role: "drone",
      action: "withdraw_participant",
      sequenceObservedByClient: 5,
    });
    expect(a).not.toBe(b);
  });

  it("different observed sequence → different key (caller's progress key)", () => {
    const a = deriveIdempotencyKey({
      roomId: RID_A,
      role: "drone",
      action: "present",
      sequenceObservedByClient: 5,
    });
    const b = deriveIdempotencyKey({
      roomId: RID_A,
      role: "drone",
      action: "present",
      sequenceObservedByClient: 6,
    });
    expect(a).not.toBe(b);
  });

  it("different roomId → different key (room isolation)", () => {
    const a = deriveIdempotencyKey({
      roomId: RID_A,
      role: "drone",
      action: "present",
      sequenceObservedByClient: 5,
    });
    const b = deriveIdempotencyKey({
      roomId: RID_B,
      role: "drone",
      action: "present",
      sequenceObservedByClient: 5,
    });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// appendRoomEvent — low-level
// ---------------------------------------------------------------------------

describe("appendRoomEvent", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(async () => {
    redis = makeMockRedis();
    // Establish a room for events to land into
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
  });

  it("returns the new sequence (room_opened was 1, next event is 2)", async () => {
    const seq = await appendRoomEvent({
      installationId: "12345",
      roomId: RID_A,
      event: {
        timestamp: "2026-04-28T00:00:00.000Z",
        event_type: "participant_presented",
        actor_role: "drone",
        actor_id: "worker-drone",
        body: {},
      },
      idempotencyKey: "",
      redis,
    });
    expect(seq).toBe(2);
  });

  it("sequence numbers are monotonic across appends", async () => {
    const s1 = await appendRoomEvent({
      installationId: "12345",
      roomId: RID_A,
      event: {
        timestamp: "2026-04-28T00:00:00.000Z",
        event_type: "participant_presented",
        actor_role: "drone",
        actor_id: "worker-drone",
        body: {},
      },
      idempotencyKey: "",
      redis,
    });
    const s2 = await appendRoomEvent({
      installationId: "12345",
      roomId: RID_A,
      event: {
        timestamp: "2026-04-28T00:00:01.000Z",
        event_type: "participant_presented",
        actor_role: "builder",
        actor_id: "worker-builder",
        body: {},
      },
      idempotencyKey: "",
      redis,
    });
    expect(s2).toBeGreaterThan(s1);
  });

  it("encodes the event JSON with the actual sequence (not __SEQ__)", async () => {
    await appendRoomEvent({
      installationId: "12345",
      roomId: RID_A,
      event: {
        timestamp: "2026-04-28T00:00:00.000Z",
        event_type: "participant_presented",
        actor_role: "drone",
        actor_id: "worker-drone",
        body: {},
      },
      idempotencyKey: "",
      redis,
    });
    const events = redis._sortedSets.get(eventsKey(RID_A));
    expect(events).toHaveLength(2); // room_opened + participant_presented
    const presentedJson = events![1].member;
    expect(presentedJson).not.toContain("__SEQ__"); // gsub'd by Lua
    const parsed = JSON.parse(presentedJson);
    expect(parsed.seq).toBe(2);
    expect(parsed.event_type).toBe("participant_presented");
  });

  it("idempotency replay returns the prior sequence via RoomEventIdempotencyReplayError", async () => {
    const idemKey = "abcd1234";
    await appendRoomEvent({
      installationId: "12345",
      roomId: RID_A,
      event: {
        timestamp: "2026-04-28T00:00:00.000Z",
        event_type: "participant_presented",
        actor_role: "drone",
        actor_id: "worker-drone",
        body: {},
      },
      idempotencyKey: idemKey,
      redis,
    });
    // Same idempotency key → replay
    try {
      await appendRoomEvent({
        installationId: "12345",
        roomId: RID_A,
        event: {
          timestamp: "2026-04-28T00:00:00.000Z",
          event_type: "participant_presented",
          actor_role: "drone",
          actor_id: "worker-drone",
          body: {},
        },
        idempotencyKey: idemKey,
        redis,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RoomEventIdempotencyReplayError);
      if (err instanceof RoomEventIdempotencyReplayError) {
        expect(err.existingSequence).toBe(2);
      }
    }
    // Verify the second call didn't add a new event
    expect(redis._sortedSets.get(eventsKey(RID_A))).toHaveLength(2);
  });

  it("status precondition mismatch → RoomEventStatusPreconditionError", async () => {
    // Room is in awaiting_rsvp; try to append with allowedStatuses
    // = [awaiting_contributions]
    try {
      await appendRoomEvent({
        installationId: "12345",
        roomId: RID_A,
        event: {
          timestamp: "2026-04-28T00:00:00.000Z",
          event_type: "participant_timed_out",
          actor_role: "manager",
          actor_id: "bot-queen",
          body: {},
        },
        idempotencyKey: "",
        allowedStatuses: ["awaiting_contributions"],
        redis,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RoomEventStatusPreconditionError);
      if (err instanceof RoomEventStatusPreconditionError) {
        expect(err.expectedFrom).toBe("awaiting_contributions");
        expect(err.actualStatus).toBe("awaiting_rsvp");
      }
    }
  });

  it("room missing → RoomNotFoundError (closes #510 builder B1 + guard N1)", async () => {
    // Append to a roomId that was never created — script returns -3.
    const fakeRoomId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    try {
      await appendRoomEvent({
        installationId: "12345",
        roomId: fakeRoomId,
        event: {
          timestamp: "2026-04-28T00:00:00.000Z",
          event_type: "participant_presented",
          actor_role: "drone",
          actor_id: "drone-1",
          body: {},
        },
        idempotencyKey: "",
        // No allowedStatuses or statusTransition — this is the
        // "soft event" path that was broken in R1.
        redis,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RoomNotFoundError);
    }
    // Verify NO orphan keys were created against the fake room
    expect(redis._sortedSets.get(eventsKey(fakeRoomId))).toBeUndefined();
    expect(redis._store.get(seqKey(fakeRoomId))).toBeUndefined();
    expect(redis._store.get(idemKey(fakeRoomId, ""))).toBeUndefined();
  });

  it("body > 8 KiB → RoomEventBodyTooLargeError BEFORE storage call", async () => {
    const huge = { payload: "x".repeat(10 * 1024) };
    try {
      await appendRoomEvent({
        installationId: "12345",
        roomId: RID_A,
        event: {
          timestamp: "2026-04-28T00:00:00.000Z",
          event_type: "participant_presented",
          actor_role: "drone",
          actor_id: "worker-drone",
          body: huge,
        },
        idempotencyKey: "",
        redis,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RoomEventBodyTooLargeError);
      if (err instanceof RoomEventBodyTooLargeError) {
        expect(err.sizeBytes).toBeGreaterThan(ROOM_EVENT_BODY_MAX_BYTES);
      }
    }
    // Verify no storage write happened
    expect(redis._sortedSets.get(eventsKey(RID_A))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// presentParticipant
// ---------------------------------------------------------------------------

describe("presentParticipant", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(async () => {
    redis = makeMockRedis();
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
  });

  it("appends a participant_presented event + writes the participants hash", async () => {
    const seq = await presentParticipant({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      redis,
    });
    expect(seq).toBe(2);

    const participants = await getRoomParticipants({ roomId: RID_A, redis });
    expect(participants.drone).toBeDefined();
    expect(participants.drone.role).toBe("drone");
    expect(participants.drone.agent_id).toBe("drone-1");
    expect(participants.drone.status).toBe("pending");
  });

  it("idempotency: same observed sequence → replay error with prior seq", async () => {
    await presentParticipant({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      redis,
    });
    await expect(
      presentParticipant({
        installationId: "12345",
        roomId: RID_A,
        role: "drone",
        agentId: "drone-1",
        sequenceObservedByClient: 1,
        redis,
      }),
    ).rejects.toThrow(RoomEventIdempotencyReplayError);
  });

  it("two roles can present concurrently — both get distinct sequences", async () => {
    const [s1, s2] = await Promise.all([
      presentParticipant({
        installationId: "12345",
        roomId: RID_A,
        role: "drone",
        agentId: "drone-1",
        sequenceObservedByClient: 1,
        redis,
      }),
      presentParticipant({
        installationId: "12345",
        roomId: RID_A,
        role: "builder",
        agentId: "builder-1",
        sequenceObservedByClient: 1,
        redis,
      }),
    ]);
    expect(s1).not.toBe(s2);
    const participants = await getRoomParticipants({ roomId: RID_A, redis });
    expect(participants.drone).toBeDefined();
    expect(participants.builder).toBeDefined();
  });

  it("intentHint is included in the event body when provided", async () => {
    await presentParticipant({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      intentHint: "review for security regressions",
      redis,
    });
    const events = await listRoomEvents({ roomId: RID_A, since: 1, redis });
    expect(events[0].body.intent_hint).toBe("review for security regressions");
  });
});

// ---------------------------------------------------------------------------
// withdrawParticipant
// ---------------------------------------------------------------------------

describe("withdrawParticipant", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(async () => {
    redis = makeMockRedis();
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    await presentParticipant({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      redis,
    });
  });

  it("updates participant status to 'withdrawn' with resolved_at timestamp", async () => {
    await withdrawParticipant({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 2,
      reason: "out of capacity",
      redis,
    });
    const participants = await getRoomParticipants({ roomId: RID_A, redis });
    expect(participants.drone.status).toBe("withdrew");
    expect(participants.drone.resolved_at).toBeDefined();
  });

  it("emits participant_withdrawn event with the reason in body", async () => {
    await withdrawParticipant({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 2,
      reason: "out of capacity",
      redis,
    });
    const events = await listRoomEvents({ roomId: RID_A, since: 2, redis });
    expect(events[0].event_type).toBe("participant_withdrawn");
    expect(events[0].body.reason).toBe("out of capacity");
  });
});

// ---------------------------------------------------------------------------
// submitContribution
// ---------------------------------------------------------------------------

describe("submitContribution", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(async () => {
    redis = makeMockRedis();
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    // submitContribution requires awaiting_contributions; bump status
    // for the suite (test setup, not a real lifecycle transition).
    await redis.hset(roomKey("12345", RID_A), { status: "awaiting_contributions" });
    // Pre-populate participant slot so the owner check passes for "drone"
    await redis.hset(participantsKey(RID_A), {
      drone: JSON.stringify({
        agent_id: "drone-1",
        role: "drone",
        status: "pending",
        rsvp_at: "2026-04-28T00:00:00.000Z",
      }),
    });
  });

  it("writes the contribution to the contributions hash + emits event", async () => {
    await submitContribution({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      body: { verdict: "APPROVE", summary: "looks good" },
      rawMd: "# Verdict\n\nApprove.",
      redis,
    });
    const contributions = await getRoomContributions({ roomId: RID_A, redis });
    expect(contributions.drone).toBeDefined();
    expect(contributions.drone.body).toEqual({
      verdict: "APPROVE",
      summary: "looks good",
    });
    expect(contributions.drone.raw_md).toBe("# Verdict\n\nApprove.");
  });

  it("re-submit overwrites prior contribution (latest-wins per role)", async () => {
    await submitContribution({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      body: { verdict: "APPROVE", summary: "first cut" },
      rawMd: "first",
      redis,
    });
    await submitContribution({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 2, // different observed seq → different idem key
      body: { verdict: "REQUEST_CHANGES", summary: "needs work" },
      rawMd: "second",
      redis,
    });
    const contributions = await getRoomContributions({ roomId: RID_A, redis });
    expect(contributions.drone.body.verdict).toBe("REQUEST_CHANGES");
    expect(contributions.drone.raw_md).toBe("second");
  });

  it("rawMd > 32 KiB → RoomContributionTooLargeError BEFORE storage call", async () => {
    const huge = "x".repeat(35 * 1024);
    await expect(
      submitContribution({
        installationId: "12345",
        roomId: RID_A,
        role: "drone",
        agentId: "drone-1",
        sequenceObservedByClient: 1,
        body: { verdict: "APPROVE", summary: "ok" },
        rawMd: huge,
        redis,
      }),
    ).rejects.toThrow(RoomContributionTooLargeError);
    // No event landed
    expect(await getRoomContributions({ roomId: RID_A, redis })).toEqual({});
  });

  it("rawMd is NOT in the event body (event body is bounded at 8 KiB; rawMd lives only in materialized hash)", async () => {
    await submitContribution({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      body: { verdict: "APPROVE", summary: "ok" },
      rawMd: "x".repeat(20 * 1024), // 20 KiB — would blow event 8 KiB cap if included
      redis,
    });
    const events = await listRoomEvents({ roomId: RID_A, since: 1, redis });
    expect(events[0].event_type).toBe("contribution_submitted");
    expect(events[0].body.body).toEqual({ verdict: "APPROVE", summary: "ok" });
    expect((events[0].body as Record<string, unknown>).raw_md).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// timeoutParticipant — watchdog path with status precondition
// ---------------------------------------------------------------------------

describe("timeoutParticipant", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(async () => {
    redis = makeMockRedis();
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    // Manually transition to awaiting_contributions so the watchdog
    // path is gated correctly.
    redis._sets.delete(statusIndexKey("12345", "awaiting_rsvp"));
    redis._sets.set(
      statusIndexKey("12345", "awaiting_contributions"),
      new Set([RID_A]),
    );
    await redis.hset(roomKey("12345", RID_A), { status: "awaiting_contributions" });
    // Pre-populate the participant slot so the new transition script's
    // existence check passes (per design L746, /present is required
    // before any non-create action like /timeout).
    await redis.hset(participantsKey(RID_A), {
      drone: JSON.stringify({
        agent_id: "drone-original",
        role: "drone",
        status: "pending",
        rsvp_at: "2026-04-28T00:00:00.000Z",
      }),
    });
  });

  it("times out a participant in awaiting_contributions → status 'timed_out'", async () => {
    await timeoutParticipant({
      installationId: "12345",
      roomId: RID_A,
      subjectRole: "drone",
      watchdogRole: "manager",
      watchdogAgentId: "bot-queen",
      sequenceObservedByClient: 1,
      redis,
    });
    const participants = await getRoomParticipants({ roomId: RID_A, redis });
    expect(participants.drone.status).toBe("timed_out");
    expect(participants.drone.resolved_at).toBeDefined();
  });

  it("status precondition: room moved to deciding → RoomEventStatusPreconditionError (G7)", async () => {
    // Simulate the queen claiming synthesis — status now 'deciding'
    await redis.hset(roomKey("12345", RID_A), { status: "deciding" });
    await expect(
      timeoutParticipant({
        installationId: "12345",
        roomId: RID_A,
        subjectRole: "drone",
        watchdogRole: "manager",
        watchdogAgentId: "bot-queen",
        sequenceObservedByClient: 1,
        redis,
      }),
    ).rejects.toThrow(RoomEventStatusPreconditionError);
  });

  it("event actor is the watchdog, NOT the timed-out participant", async () => {
    await timeoutParticipant({
      installationId: "12345",
      roomId: RID_A,
      subjectRole: "drone",
      watchdogRole: "manager",
      watchdogAgentId: "bot-queen",
      sequenceObservedByClient: 1,
      redis,
    });
    const events = await listRoomEvents({ roomId: RID_A, since: 1, redis });
    expect(events[0].event_type).toBe("participant_timed_out");
    expect(events[0].actor_role).toBe("manager");
    expect(events[0].actor_id).toBe("bot-queen");
    expect(events[0].body.subject_role).toBe("drone");
  });

  it("preserves the original agent_id + rsvp_at on the timed_out participant (R2 G N2)", async () => {
    // The transition script reads the existing slot via cjson.decode
    // and modifies just status + resolved_at — agent_id, role, rsvp_at
    // are preserved. Operators reading participants.drone now see the
    // original participant, not the watchdog's identity.
    await timeoutParticipant({
      installationId: "12345",
      roomId: RID_A,
      subjectRole: "drone",
      watchdogRole: "manager",
      watchdogAgentId: "bot-queen",
      sequenceObservedByClient: 1,
      redis,
    });
    const participants = await getRoomParticipants({ roomId: RID_A, redis });
    expect(participants.drone.agent_id).toBe("drone-original");
    expect(participants.drone.rsvp_at).toBe("2026-04-28T00:00:00.000Z");
    expect(participants.drone.status).toBe("timed_out");
  });
});

// ===========================================================================
// D.1.a-ii R3 — additional builder R2 closures (B5 + B6)
// ===========================================================================

describe("D.1.a-ii R3 / B5 — submitContribution allows awaiting_rsvp (early contribution path)", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(async () => {
    redis = makeMockRedis();
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    // Pre-populate participant slot — caller must /present first
    await redis.hset(participantsKey(RID_A), {
      drone: JSON.stringify({
        agent_id: "drone-1",
        role: "drone",
        status: "pending",
        rsvp_at: "2026-04-28T00:00:00.000Z",
      }),
    });
    // Room is in awaiting_rsvp (NOT awaiting_contributions) — early-
    // contribution path per design L201.
  });

  it("contribute during awaiting_rsvp succeeds (no status precondition error)", async () => {
    const seq = await submitContribution({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      body: { verdict: "APPROVE", summary: "early submission" },
      rawMd: "ok",
      redis,
    });
    expect(seq).toBeGreaterThan(0);
    const contributions = await getRoomContributions({ roomId: RID_A, redis });
    expect(contributions.drone.body.verdict).toBe("APPROVE");
    // Participant is now resolved (atomic dual-update)
    const participants = await getRoomParticipants({ roomId: RID_A, redis });
    expect(participants.drone.status).toBe("resolved");
  });

  it("preserves the original rsvp_at across the early contribute (R2 R2 #2)", async () => {
    // Original rsvp_at was "2026-04-28T00:00:00.000Z" (set in beforeEach).
    // The transition script reads the slot via cjson.decode, modifies
    // only status + resolved_at, re-encodes — rsvp_at is preserved
    // atomically inside the lock.
    await submitContribution({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      body: { verdict: "APPROVE", summary: "ok" },
      rawMd: "ok",
      redis,
    });
    const participants = await getRoomParticipants({ roomId: RID_A, redis });
    expect(participants.drone.rsvp_at).toBe("2026-04-28T00:00:00.000Z");
    expect(participants.drone.status).toBe("resolved");
    expect(participants.drone.resolved_at).toBeDefined();
    // resolved_at is later than rsvp_at
    expect(
      new Date(participants.drone.resolved_at!).getTime(),
    ).toBeGreaterThan(new Date(participants.drone.rsvp_at).getTime());
  });
});

describe("D.1.a-ii R3 / B6 — non-create actions require existing participant slot", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(async () => {
    redis = makeMockRedis();
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    await redis.hset(roomKey("12345", RID_A), { status: "awaiting_contributions" });
    // Note: NO participant slot pre-populated — caller hasn't /present'd
  });

  it("submitContribution without prior /present → RoomParticipantNotFoundError", async () => {
    await expect(
      submitContribution({
        installationId: "12345",
        roomId: RID_A,
        role: "drone",
        agentId: "drone-1",
        sequenceObservedByClient: 1,
        body: { verdict: "APPROVE", summary: "ok" },
        rawMd: "ok",
        redis,
      }),
    ).rejects.toThrow(RoomParticipantNotFoundError);
    // No phantom contribution landed
    expect(await getRoomContributions({ roomId: RID_A, redis })).toEqual({});
  });

  it("withdrawParticipant without prior /present → RoomParticipantNotFoundError", async () => {
    await expect(
      withdrawParticipant({
        installationId: "12345",
        roomId: RID_A,
        role: "drone",
        agentId: "drone-1",
        sequenceObservedByClient: 1,
        redis,
      }),
    ).rejects.toThrow(RoomParticipantNotFoundError);
    expect(await getRoomParticipants({ roomId: RID_A, redis })).toEqual({});
  });

  it("withdrawContribution without prior /present → RoomParticipantNotFoundError", async () => {
    await expect(
      withdrawContribution({
        installationId: "12345",
        roomId: RID_A,
        role: "drone",
        agentId: "drone-1",
        sequenceObservedByClient: 1,
        redis,
      }),
    ).rejects.toThrow(RoomParticipantNotFoundError);
  });

  it("timeoutParticipant without prior /present → RoomParticipantNotFoundError", async () => {
    await expect(
      timeoutParticipant({
        installationId: "12345",
        roomId: RID_A,
        subjectRole: "drone",
        watchdogRole: "manager",
        watchdogAgentId: "bot-queen",
        sequenceObservedByClient: 1,
        redis,
      }),
    ).rejects.toThrow(RoomParticipantNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// listRoomEvents — read with since cursor
// ---------------------------------------------------------------------------

describe("listRoomEvents", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(async () => {
    redis = makeMockRedis();
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
  });

  it("returns all events when since is omitted (or 0)", async () => {
    await presentParticipant({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      redis,
    });
    const events = await listRoomEvents({ roomId: RID_A, redis });
    expect(events).toHaveLength(2); // room_opened + participant_presented
    expect(events[0].event_type).toBe("room_opened");
    expect(events[1].event_type).toBe("participant_presented");
  });

  it("since=1 excludes seq=1 (room_opened); returns events strictly after", async () => {
    await presentParticipant({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      redis,
    });
    const events = await listRoomEvents({ roomId: RID_A, since: 1, redis });
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("participant_presented");
    expect(events[0].seq).toBe(2);
  });
});

// ===========================================================================
// D.1.a-ii R2 — regression tests for builder/guard/drone R1 blockers
// ===========================================================================

// ---------------------------------------------------------------------------
// B2 — per-(room, role) first-wins gate
// ---------------------------------------------------------------------------

describe("D.1.a-ii R2 / B2 — per-(room, role) first-wins gate", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(async () => {
    redis = makeMockRedis();
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
  });

  it("second runner same role different agent → RoomParticipantOwnerConflictError", async () => {
    await presentParticipant({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-runner-1",
      sequenceObservedByClient: 1,
      redis,
    });
    // Different agent_id, same role
    try {
      await presentParticipant({
        installationId: "12345",
        roomId: RID_A,
        role: "drone",
        agentId: "drone-runner-2",
        sequenceObservedByClient: 2,
        redis,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RoomParticipantOwnerConflictError);
      if (err instanceof RoomParticipantOwnerConflictError) {
        expect(err.existingAgentId).toBe("drone-runner-1");
        expect(err.attemptedAgentId).toBe("drone-runner-2");
        expect(err.role).toBe("drone");
      }
    }
    // Verify the original RSVP wasn't overwritten
    const participants = await getRoomParticipants({ roomId: RID_A, redis });
    expect(participants.drone.agent_id).toBe("drone-runner-1");
  });

  it("same agent re-RSVPing is allowed (idempotent ownership)", async () => {
    await presentParticipant({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-runner-1",
      sequenceObservedByClient: 1,
      redis,
    });
    // Same agent_id, different observed seq → fresh idem key but
    // owner check passes because agent_id matches
    await expect(
      presentParticipant({
        installationId: "12345",
        roomId: RID_A,
        role: "drone",
        agentId: "drone-runner-1",
        sequenceObservedByClient: 2,
        redis,
      }),
    ).resolves.toBeGreaterThan(0);
  });

  it("re-RSVP from withdrew is allowed even with a different agent_id", async () => {
    await presentParticipant({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-runner-1",
      sequenceObservedByClient: 1,
      redis,
    });
    await withdrawParticipant({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-runner-1",
      sequenceObservedByClient: 2,
      redis,
    });
    // Different runner re-RSVPs the now-withdrew slot — allowed
    await expect(
      presentParticipant({
        installationId: "12345",
        roomId: RID_A,
        role: "drone",
        agentId: "drone-runner-2", // different agent
        sequenceObservedByClient: 3,
        redis,
      }),
    ).resolves.toBeGreaterThan(0);
    // New agent now owns the slot, status flipped back to pending
    const participants = await getRoomParticipants({ roomId: RID_A, redis });
    expect(participants.drone.agent_id).toBe("drone-runner-2");
    expect(participants.drone.status).toBe("pending");
    // withdrew_at_sequence cleared on re-RSVP
    expect(participants.drone.withdrew_at_sequence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B3 — participant state shape (pending → resolved/withdrew, withdrew_at_sequence)
// ---------------------------------------------------------------------------

describe("D.1.a-ii R2 / B3 — participant lifecycle (pending/resolved/withdrew)", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(async () => {
    redis = makeMockRedis();
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    // Advance to awaiting_contributions for the contribute path
    await redis.hset(roomKey("12345", RID_A), { status: "awaiting_contributions" });
  });

  it("withdrawParticipant sets withdrew_at_sequence to the event seq (via __SEQ__)", async () => {
    // Reset to awaiting_rsvp for the RSVP+withdraw flow
    await redis.hset(roomKey("12345", RID_A), { status: "awaiting_rsvp" });
    const presentSeq = await presentParticipant({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      redis,
    });
    const withdrawSeq = await withdrawParticipant({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: presentSeq,
      redis,
    });
    const participants = await getRoomParticipants({ roomId: RID_A, redis });
    expect(participants.drone.status).toBe("withdrew");
    // Lua substituted __SEQ__ with the actual sequence
    expect(participants.drone.withdrew_at_sequence).toBe(withdrawSeq);
    // It's a number, not the literal "__SEQ__" placeholder
    expect(typeof participants.drone.withdrew_at_sequence).toBe("number");
  });

  it("submitContribution flips participant status pending → resolved (atomic dual-update)", async () => {
    // Set up: RSVP first (awaiting_rsvp → pending)
    await redis.hset(roomKey("12345", RID_A), { status: "awaiting_rsvp" });
    await presentParticipant({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      redis,
    });
    // Move to awaiting_contributions for contribute
    await redis.hset(roomKey("12345", RID_A), { status: "awaiting_contributions" });
    // Verify pending
    let participants = await getRoomParticipants({ roomId: RID_A, redis });
    expect(participants.drone.status).toBe("pending");

    await submitContribution({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 2,
      body: { verdict: "APPROVE", summary: "looks good" },
      rawMd: "approved",
      redis,
    });
    // Verify resolved
    participants = await getRoomParticipants({ roomId: RID_A, redis });
    expect(participants.drone.status).toBe("resolved");
    expect(participants.drone.resolved_at).toBeDefined();
    // AND the contribution landed
    const contributions = await getRoomContributions({ roomId: RID_A, redis });
    expect(contributions.drone.body.verdict).toBe("APPROVE");
  });
});

// ---------------------------------------------------------------------------
// B4 — ContributionBody schema validation
// ---------------------------------------------------------------------------

describe("D.1.a-ii R2 / B4 — validateContributionBody", () => {
  it("accepts a minimal valid body (verdict + summary)", () => {
    expect(() =>
      validateContributionBody({ verdict: "APPROVE", summary: "ok" }),
    ).not.toThrow();
  });

  it("accepts all four UPPERCASE verdict values", () => {
    for (const v of ["APPROVE", "COMMENT", "CONCERNS", "REQUEST_CHANGES"] as const) {
      expect(() =>
        validateContributionBody({ verdict: v, summary: "ok" }),
      ).not.toThrow();
    }
  });

  it("rejects lowercase verdict (silent-downgrade trap)", () => {
    try {
      // Intentionally bypass TS for the runtime test
      validateContributionBody({
        verdict: "approve" as unknown as "APPROVE",
        summary: "ok",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ContributionValidationError);
      if (err instanceof ContributionValidationError) {
        expect(err.field).toBe("verdict");
      }
    }
  });

  it("rejects invalid verdict typo", () => {
    expect(() =>
      validateContributionBody({
        verdict: "APPROVES" as unknown as "APPROVE",
        summary: "ok",
      }),
    ).toThrow(ContributionValidationError);
  });

  it("rejects empty summary", () => {
    expect(() =>
      validateContributionBody({ verdict: "APPROVE", summary: "" }),
    ).toThrow(ContributionValidationError);
  });

  it("rejects summary > 500 chars", () => {
    expect(() =>
      validateContributionBody({
        verdict: "APPROVE",
        summary: "x".repeat(CONTRIBUTION_SUMMARY_MAX_CHARS + 1),
      }),
    ).toThrow(ContributionValidationError);
  });

  it("rejects too many findings (>20)", () => {
    const findings = Array.from(
      { length: CONTRIBUTION_FINDINGS_MAX_COUNT + 1 },
      () => ({ area: "a", severity: "info" as const, detail: "d" }),
    );
    expect(() =>
      validateContributionBody({
        verdict: "APPROVE",
        summary: "ok",
        findings,
      }),
    ).toThrow(ContributionValidationError);
  });

  it("rejects finding with invalid severity", () => {
    expect(() =>
      validateContributionBody({
        verdict: "APPROVE",
        summary: "ok",
        findings: [
          { area: "a", severity: "critical" as unknown as "blocker", detail: "d" },
        ],
      }),
    ).toThrow(ContributionValidationError);
  });

  it("rejects severity_counts with negative number", () => {
    expect(() =>
      validateContributionBody({
        verdict: "APPROVE",
        summary: "ok",
        severity_counts: { blocker: -1 },
      }),
    ).toThrow(ContributionValidationError);
  });

  it("submitContribution rejects malformed body BEFORE storage write", async () => {
    const redis = makeMockRedis();
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    await redis.hset(roomKey("12345", RID_A), { status: "awaiting_contributions" });
    await expect(
      submitContribution({
        installationId: "12345",
        roomId: RID_A,
        role: "drone",
        agentId: "drone-1",
        sequenceObservedByClient: 1,
        body: { verdict: "approve" as unknown as "APPROVE", summary: "ok" },
        rawMd: "test",
        redis,
      }),
    ).rejects.toThrow(ContributionValidationError);
    // No event landed
    expect(await getRoomContributions({ roomId: RID_A, redis })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Guard B1 — __SEQ__ substitution preserves user content
// ---------------------------------------------------------------------------

describe("D.1.a-ii R2 / Guard B1 — __SEQ__ first-match gsub preserves user content", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(async () => {
    redis = makeMockRedis();
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
  });

  it("intentHint containing literal '__SEQ__' is preserved verbatim in the event", async () => {
    // This was guard's reproducer: feeding "__SEQ__" through user
    // content would have been silently substituted by the unbounded
    // gsub. Now it's preserved.
    await presentParticipant({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      intentHint: "review for __SEQ__ regression",
      redis,
    });
    const events = await listRoomEvents({ roomId: RID_A, since: 1, redis });
    expect(events[0].body.intent_hint).toBe("review for __SEQ__ regression");
    // The seq field on the event was substituted correctly though
    expect(events[0].seq).toBe(2);
  });

  it("contribution body summary containing '__SEQ__' is preserved verbatim", async () => {
    await redis.hset(roomKey("12345", RID_A), { status: "awaiting_contributions" });
    // submitContribution requires existing participant slot
    await redis.hset(participantsKey(RID_A), {
      drone: JSON.stringify({
        agent_id: "drone-1",
        role: "drone",
        status: "pending",
        rsvp_at: "2026-04-28T00:00:00.000Z",
      }),
    });
    await submitContribution({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      body: { verdict: "APPROVE", summary: "approved __SEQ__" },
      rawMd: "ok",
      redis,
    });
    const contributions = await getRoomContributions({ roomId: RID_A, redis });
    expect(contributions.drone.body.summary).toBe("approved __SEQ__");
  });
});

// ---------------------------------------------------------------------------
// N4 — withdrawContribution dedicated tests
// ---------------------------------------------------------------------------

describe("withdrawContribution (R2 N4)", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(async () => {
    redis = makeMockRedis();
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    await redis.hset(roomKey("12345", RID_A), { status: "awaiting_contributions" });
    // withdrawContribution requires participant.status === "resolved"
    // (per R4 — only resolved participants have a contribution to withdraw).
    await redis.hset(participantsKey(RID_A), {
      drone: JSON.stringify({
        agent_id: "drone-1",
        role: "drone",
        status: "resolved",
        rsvp_at: "2026-04-28T00:00:00.000Z",
        resolved_at: "2026-04-28T00:01:00.000Z",
      }),
    });
  });

  it("writes a tombstone to the contributions hash with withdrawn=true", async () => {
    await withdrawContribution({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      reason: "data was incomplete",
      redis,
    });
    const contributions = await getRoomContributions({ roomId: RID_A, redis });
    expect(contributions.drone.withdrawn).toBe(true);
    expect(contributions.drone.contributed_at).toBeDefined();
  });

  it("emits contribution_withdrawn event with reason in body", async () => {
    await withdrawContribution({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      reason: "data was incomplete",
      redis,
    });
    const events = await listRoomEvents({ roomId: RID_A, since: 1, redis });
    expect(events[0].event_type).toBe("contribution_withdrawn");
    expect(events[0].body.reason).toBe("data was incomplete");
  });

  it("idempotent — same observed seq → replay error", async () => {
    await withdrawContribution({
      installationId: "12345",
      roomId: RID_A,
      role: "drone",
      agentId: "drone-1",
      sequenceObservedByClient: 1,
      redis,
    });
    await expect(
      withdrawContribution({
        installationId: "12345",
        roomId: RID_A,
        role: "drone",
        agentId: "drone-1",
        sequenceObservedByClient: 1,
        redis,
      }),
    ).rejects.toThrow(RoomEventIdempotencyReplayError);
  });
});

// ---------------------------------------------------------------------------
// N5 — ROOM_APPEND_EVENT_SCRIPT source pins
// ---------------------------------------------------------------------------

describe("ROOM_APPEND_EVENT_SCRIPT source (R2 N5)", () => {
  it("idempotency check is FIRST (before any state read)", () => {
    const idemIdx = ROOM_APPEND_EVENT_SCRIPT.indexOf('redis.call("get", KEYS[3])');
    const statusIdx = ROOM_APPEND_EVENT_SCRIPT.indexOf(
      'redis.call("hget", KEYS[4]',
    );
    expect(idemIdx).toBeGreaterThan(0);
    expect(statusIdx).toBeGreaterThan(idemIdx);
  });

  it("room-existence check returns -3 when status is nil (B1 closure)", () => {
    expect(ROOM_APPEND_EVENT_SCRIPT).toMatch(
      /if not currStatus then return \{-3, "room_not_found"\} end/,
    );
  });

  it("__SEQ__ gsub on event template is capped at FIRST match (Guard B1 closure)", () => {
    // Lua's gsub takes an optional 4th arg = max replacements.
    // The event template uses `1` to preserve user content
    // containing the literal `__SEQ__` sentinel (e.g. intentHint
    // or contribution body summary text containing the substring).
    expect(ROOM_APPEND_EVENT_SCRIPT).toMatch(
      /string\.gsub\(ARGV\[1\], "__SEQ__", tostring\(seq\), 1\)/,
    );
  });

  it("materialized __SEQ__ substitution is OPT-IN (Guard B1 closure, ARGV[14]/[15] gates)", () => {
    // Materialized writes only do gsub when caller explicitly opts in
    // (ARGV[14]=="1" for slot 1, ARGV[15]=="1" for slot 2). Off-by-
    // default so user-controlled materialized content (e.g. contribution
    // body summary that legitimately contains "__SEQ__") is preserved
    // verbatim. Only withdrawParticipant opts in (it needs the script
    // to substitute the actual sequence into the withdrew_at_sequence
    // field of the participant JSON).
    expect(ROOM_APPEND_EVENT_SCRIPT).toMatch(/if ARGV\[14\] == "1" then/);
    expect(ROOM_APPEND_EVENT_SCRIPT).toMatch(/if ARGV\[15\] == "1" then/);
    expect(ROOM_APPEND_EVENT_SCRIPT).toMatch(
      /string\.gsub\(mat1, "__SEQ__", tostring\(seq\), 1\)/,
    );
    expect(ROOM_APPEND_EVENT_SCRIPT).toMatch(
      /string\.gsub\(mat2, "__SEQ__", tostring\(seq\), 1\)/,
    );
  });

  it("owner check uses cjson.decode + agent_id comparison + withdrew exception (B2)", () => {
    expect(ROOM_APPEND_EVENT_SCRIPT).toMatch(/cjson\.decode\(existingMat\)/);
    expect(ROOM_APPEND_EVENT_SCRIPT).toMatch(
      /parsed\.agent_id ~= ARGV\[5\] and parsed\.status ~= "withdrew"/,
    );
    expect(ROOM_APPEND_EVENT_SCRIPT).toMatch(
      /return \{-4, "owner_conflict", parsed\.agent_id\}/,
    );
  });

  it("dual-materialized writes (KEYS[6] + KEYS[9]) for submitContribution atomic resolved-flip", () => {
    expect(ROOM_APPEND_EVENT_SCRIPT).toMatch(
      /redis\.call\("hset", KEYS\[6\]/,
    );
    expect(ROOM_APPEND_EVENT_SCRIPT).toMatch(
      /redis\.call\("hset", KEYS\[9\]/,
    );
  });
});

// ===========================================================================
// D.1.a-ii R4 — participant-state precondition (closes builder R3)
// ===========================================================================

describe("D.1.a-ii R4 — participant-state precondition (manager-loop race protection)", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(async () => {
    redis = makeMockRedis();
    await createRoom({
      installationId: "12345",
      roomId: RID_A,
      manager: "bot-queen",
      subject: { type: "pr_review", ref: "hivemoot/hivemoot#508" },
      redis,
    });
    await redis.hset(roomKey("12345", RID_A), { status: "awaiting_contributions" });
  });

  it("watchdog timeout loses race against worker resolve (resolved → timeout rejected)", async () => {
    // Setup: worker presented + contributed → status = "resolved"
    await redis.hset(participantsKey(RID_A), {
      drone: JSON.stringify({
        agent_id: "drone-1",
        role: "drone",
        status: "resolved",
        rsvp_at: "2026-04-28T00:00:00.000Z",
        resolved_at: "2026-04-28T00:01:00.000Z",
      }),
    });
    // Stale watchdog scan tries to time out the now-resolved slot
    try {
      await timeoutParticipant({
        installationId: "12345",
        roomId: RID_A,
        subjectRole: "drone",
        watchdogRole: "manager",
        watchdogAgentId: "bot-queen",
        sequenceObservedByClient: 1,
        redis,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RoomParticipantStatePreconditionError);
      if (err instanceof RoomParticipantStatePreconditionError) {
        expect(err.actualState).toBe("resolved");
        expect(err.allowedStates).toEqual(["pending"]);
      }
    }
    // Verify the resolved slot wasn't overwritten
    const participants = await getRoomParticipants({ roomId: RID_A, redis });
    expect(participants.drone.status).toBe("resolved");
  });

  it("submitContribution rejected on withdrew slot (must /present again first)", async () => {
    await redis.hset(participantsKey(RID_A), {
      drone: JSON.stringify({
        agent_id: "drone-1",
        role: "drone",
        status: "withdrew",
        rsvp_at: "2026-04-28T00:00:00.000Z",
        resolved_at: "2026-04-28T00:01:00.000Z",
        withdrew_at_sequence: 5,
      }),
    });
    await expect(
      submitContribution({
        installationId: "12345",
        roomId: RID_A,
        role: "drone",
        agentId: "drone-1",
        sequenceObservedByClient: 1,
        body: { verdict: "APPROVE", summary: "ok" },
        rawMd: "ok",
        redis,
      }),
    ).rejects.toThrow(RoomParticipantStatePreconditionError);
    expect(await getRoomContributions({ roomId: RID_A, redis })).toEqual({});
    const participants = await getRoomParticipants({ roomId: RID_A, redis });
    expect(participants.drone.status).toBe("withdrew");
  });

  it("submitContribution rejected on timed_out slot", async () => {
    await redis.hset(participantsKey(RID_A), {
      drone: JSON.stringify({
        agent_id: "drone-1",
        role: "drone",
        status: "timed_out",
        rsvp_at: "2026-04-28T00:00:00.000Z",
        resolved_at: "2026-04-28T00:01:00.000Z",
      }),
    });
    await expect(
      submitContribution({
        installationId: "12345",
        roomId: RID_A,
        role: "drone",
        agentId: "drone-1",
        sequenceObservedByClient: 1,
        body: { verdict: "APPROVE", summary: "ok" },
        rawMd: "ok",
        redis,
      }),
    ).rejects.toThrow(RoomParticipantStatePreconditionError);
  });

  it("withdrawParticipant rejected on already-withdrew slot", async () => {
    await redis.hset(participantsKey(RID_A), {
      drone: JSON.stringify({
        agent_id: "drone-1",
        role: "drone",
        status: "withdrew",
        rsvp_at: "2026-04-28T00:00:00.000Z",
        resolved_at: "2026-04-28T00:01:00.000Z",
      }),
    });
    await expect(
      withdrawParticipant({
        installationId: "12345",
        roomId: RID_A,
        role: "drone",
        agentId: "drone-1",
        sequenceObservedByClient: 1,
        redis,
      }),
    ).rejects.toThrow(RoomParticipantStatePreconditionError);
  });

  it("withdrawContribution rejected on pending slot (no contribution to withdraw)", async () => {
    await redis.hset(participantsKey(RID_A), {
      drone: JSON.stringify({
        agent_id: "drone-1",
        role: "drone",
        status: "pending",
        rsvp_at: "2026-04-28T00:00:00.000Z",
      }),
    });
    await expect(
      withdrawContribution({
        installationId: "12345",
        roomId: RID_A,
        role: "drone",
        agentId: "drone-1",
        sequenceObservedByClient: 1,
        redis,
      }),
    ).rejects.toThrow(RoomParticipantStatePreconditionError);
  });

  it("submitContribution from resolved (re-submit) IS allowed", async () => {
    await redis.hset(participantsKey(RID_A), {
      drone: JSON.stringify({
        agent_id: "drone-1",
        role: "drone",
        status: "resolved",
        rsvp_at: "2026-04-28T00:00:00.000Z",
        resolved_at: "2026-04-28T00:01:00.000Z",
      }),
    });
    await expect(
      submitContribution({
        installationId: "12345",
        roomId: RID_A,
        role: "drone",
        agentId: "drone-1",
        sequenceObservedByClient: 1,
        body: { verdict: "REQUEST_CHANGES", summary: "found a regression" },
        rawMd: "updated",
        redis,
      }),
    ).resolves.toBeGreaterThan(0);
  });
});
