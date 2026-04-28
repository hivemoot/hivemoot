/**
 * War room storage layer (Phase D.1.a-i).
 *
 * A "war room" is a real-time coordination space around a single
 * subject (PR review, mention response, issue triage). Workers RSVP,
 * contribute analyses, and the bot-as-queen synthesizes a decision.
 * See `docs/architecture/WAR_ROOM_DESIGN.md` for the full design.
 *
 * This file is the foundation slice — types, key helpers, and the
 * room-creation + read primitives. Subsequent slices add:
 *   - D.1.a-ii: event appending + materialized RSVP/contribution views
 *   - D.1.a-iii: synthesis claim + recovery + termination/close
 *   - D.1.b: HTTP API endpoints over `/api/rooms/*`
 *   - D.1.c: watchdog driver
 *
 * **Storage backend**: Upstash Redis. No SQL. Multi-key atomicity
 * via Lua scripts (mirrors the agent-token V1 pattern).
 *
 * **Key convention** (per `docs/architecture/REDIS_KEY_CONVENTION.md`):
 *   - `hive:v1:room:{installationId}:{roomId}` for primary records
 *   - `hive:v1:idx:room:<lookup>:<value>` for secondary indexes
 *   - `hive:v1:lock:room:{installationId}:{roomId}` for locks
 */

import { type Redis } from "@upstash/redis";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ROOM_PREFIX = "hive:v1:room:";
const SUBJECT_INDEX_PREFIX = "hive:v1:idx:room:subject:";
const INSTALLATION_INDEX_PREFIX = "hive:v1:idx:room:installation:";
const STATUS_INDEX_PREFIX = "hive:v1:idx:room:status:";
const REPO_INDEX_PREFIX = "hive:v1:idx:room:repo:";
const LOCK_PREFIX = "hive:v1:lock:room:";

const EVENTS_SUFFIX = ":events";
const PARTICIPANTS_SUFFIX = ":participants";
const CONTRIBUTIONS_SUFFIX = ":contributions";
const SEQ_SUFFIX = ":seq";
const CLAIM_SUFFIX = ":claim";
const IDEM_PREFIX = ":idem:";

/**
 * Default room lifetime before auto-expiry. The subject-uniqueness
 * index TTL matches this so a stalled-recovery scenario can't
 * permanently block new rooms (Queen R3 #3).
 */
export const DEFAULT_MAX_AGE_SECS = 3600;

/**
 * Retention window after a room closes. The room hash + sibling keys
 * are TTL'd to this; secondary indexes are explicitly cleaned (see
 * Queen R2 #2 — closed rooms must be ZREM'd from the installation
 * index, not just removed from the status set).
 */
export const ROOM_RETENTION_AFTER_CLOSE_SECS = 30 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Key construction
// ---------------------------------------------------------------------------

export function roomKey(installationId: string, roomId: string): string {
  return `${ROOM_PREFIX}${installationId}:${roomId}`;
}

export function eventsKey(roomId: string): string {
  return `${ROOM_PREFIX}${roomId}${EVENTS_SUFFIX}`;
}

export function participantsKey(roomId: string): string {
  return `${ROOM_PREFIX}${roomId}${PARTICIPANTS_SUFFIX}`;
}

export function contributionsKey(roomId: string): string {
  return `${ROOM_PREFIX}${roomId}${CONTRIBUTIONS_SUFFIX}`;
}

export function seqKey(roomId: string): string {
  return `${ROOM_PREFIX}${roomId}${SEQ_SUFFIX}`;
}

export function claimKey(roomId: string): string {
  return `${ROOM_PREFIX}${roomId}${CLAIM_SUFFIX}`;
}

export function idemKey(roomId: string, idempotencyKey: string): string {
  return `${ROOM_PREFIX}${roomId}${IDEM_PREFIX}${idempotencyKey}`;
}

export function subjectIndexKey(
  installationId: string,
  subjectType: SubjectType,
  subjectRef: string,
): string {
  return `${SUBJECT_INDEX_PREFIX}${installationId}:${subjectType}:${subjectRef}`;
}

export function installationIndexKey(installationId: string): string {
  return `${INSTALLATION_INDEX_PREFIX}${installationId}`;
}

export function statusIndexKey(
  installationId: string,
  status: RoomStatus,
): string {
  return `${STATUS_INDEX_PREFIX}${installationId}:${status}`;
}

export function repoIndexKey(installationId: string, repo: string): string {
  return `${REPO_INDEX_PREFIX}${installationId}:${repo}`;
}

export function roomLockKey(installationId: string, roomId: string): string {
  return `${LOCK_PREFIX}${installationId}:${roomId}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Status state machine:
 *
 *   awaiting_rsvp
 *     ├─ [timeout @ max_age_secs] → expired
 *     └─ [all roles present] → awaiting_contributions
 *                ↓
 *     awaiting_contributions
 *     ├─ [timeout @ max_age_secs] → expired
 *     ├─ [synthesis failures ≥ 3] → closed (failed_synthesis)
 *     └─ [manager claim] → deciding
 *                ↓
 *     deciding
 *     ├─ [claim TTL expired + recovery] → awaiting_contributions
 *     ├─ [force_close] → closed (force_close)
 *     └─ [queen `/close` with decision] → closed (decision recorded)
 *
 *     closed | expired (terminal, no further transitions)
 */
export type RoomStatus =
  | "awaiting_rsvp"
  | "awaiting_contributions"
  | "deciding"
  | "closed"
  | "expired";

/** Subject classes V1 supports. New types require backend
 * regex validation per `subject_ref` shape. */
export type SubjectType = "pr_review" | "mention_response" | "issue_triage";

/** Reason a room reached a terminal state via the
 * `ROOM_TERMINATE_SCRIPT` path (vs the queen's happy-path close). */
export type TerminalReason =
  | "expired"
  | "failed_synthesis"
  | "force_close"
  | "manual";

/**
 * Subject reference — the GitHub-side identity the room is
 * coordinating around. `ref` shape depends on `type`:
 *   - pr_review: `{owner}/{repo}#{prNumber}`
 *   - mention_response: `{owner}/{repo}#{issueOrPrNumber}` (event-driven)
 *   - issue_triage: `{owner}/{repo}#{issueNumber}`
 *
 * Validated at room-open time; format violations rejected with
 * `RoomSubjectRefError` rather than landing in storage.
 */
export interface SubjectRef {
  type: SubjectType;
  ref: string;
}

/**
 * Per-room timing knobs. Caller supplies; defaults applied at
 * `createRoom` time. All values are seconds.
 */
export interface TimingConfig {
  /** Hard cap on room lifetime before auto-expiry. Default 3600 (1h).
   * Mirrors the subject-uniqueness index TTL so stalled rooms
   * don't permanently block new rooms on the same subject. */
  max_age_secs: number;
  /** Soft deadline for all expected roles to RSVP. Past this, the
   * watchdog may drop unresponsive participants. Default 600 (10m). */
  rsvp_deadline_secs: number;
  /** Soft deadline for contributions after RSVP completion.
   * Default 1200 (20m). */
  contribution_deadline_secs: number;
}

/**
 * Stable bulk fields of a room core (everything EXCEPT `status`).
 * Stored as a JSON string in the room hash's `"data"` field per the
 * design's HSET shape (WAR_ROOM_DESIGN.md L303-304). `status` lives
 * in a separate hash field so transitions can `HSET status` without
 * marshaling/unmarshaling the whole record on the hot path.
 *
 * Field naming uses snake_case to match the storage shape across
 * other modules (agent-token-v1 envelope, audit entries) —
 * wire-shape translation to camelCase happens at the API boundary.
 *
 * `closed_*` and `decision` fields are absent until the room
 * terminates; their presence is the close marker.
 */
export interface RoomCoreData {
  /** Actor-id of whoever opened the room — typically the bot's
   * queen module ("bot-queen") for V1 since the bot is the only
   * room creator. Future: dispatcher tokens may open rooms too. */
  manager: string;
  subject_type: SubjectType;
  subject_ref: string;
  opened_at: string; // ISO 8601
  timing_config: TimingConfig;

  // Post-close fields (absent while open)
  closed_at?: string;
  closed_reason?: TerminalReason;
  /** Sequence the queen synthesized through (set by claim script,
   * verified at close to detect mid-synthesis drift). */
  deciding_through_sequence?: number;
  /** Decision payload — set by `ROOM_CLOSE_SCRIPT` on the
   * happy path. JSON-serialized at storage time; decoded in
   * `getRoomCore` for caller convenience. */
  decision?: RoomDecision;
}

/**
 * Room core view returned by `getRoomCore` — `RoomCoreData` plus
 * the live `status`. Reconstructed from two hash fields at read
 * time; the underlying storage uses the split layout so status
 * transitions are single-field HSETs (per design L346, L382).
 */
export interface RoomCore extends RoomCoreData {
  status: RoomStatus;
}

/**
 * Decision metadata captured at queen-close time. Body content is
 * the synthesis (markdown) the queen produced; runner identifies
 * which queen instance ran the synthesis (for forensic correlation
 * with the auth-events stream).
 */
export interface RoomDecision {
  synthesized_at: string; // ISO 8601
  synthesis_runner: string;
  /** The synthesized body (markdown). ≤ 64 KiB per design. */
  content: string;
  /** Sequence number this synthesis was based on. Caller compares
   * against the live `seq` at close time to detect drift. */
  sequence_closed: number;
}

/**
 * Append-only event log entry. Stored as JSON in the
 * `:events` sorted set with `score = seq`.
 */
export interface RoomEvent {
  seq: number;
  timestamp: string; // ISO 8601
  event_type: RoomEventType;
  /** Server-derived from the bearer envelope's `agent_role` —
   * NEVER from request body. Lets investigators map an event to
   * a role even if the actor's bearer is later rotated/revoked. */
  actor_role: string;
  /** Server-derived: the bearer's `name` field. Same caveat as
   * `actor_role` — never accepts a body-supplied identity. */
  actor_id: string;
  /** Action-specific payload. Bounded ≤ 8 KiB serialized; events
   * exceeding the cap are rejected at append time. */
  body: Record<string, unknown>;
}

/** Event classes the room state machine recognizes. */
export type RoomEventType =
  | "room_opened"
  | "participant_presented"
  | "participant_timed_out"
  | "participant_withdrawn"
  | "contribution_submitted"
  | "contribution_withdrawn"
  | "room_decided"
  | "room_recovered"
  | "room_terminated";

/** Materialized RSVP entry per role (latest-state-wins). Stored as
 * JSON in the `:participants` hash, keyed by role. */
export interface RoomParticipant {
  agent_id: string;
  role: string;
  status: "present" | "withdrawn" | "timed_out";
  rsvp_at: string;
  resolved_at?: string;
}

/** Materialized contribution per role (latest-wins). Stored as JSON
 * in the `:contributions` hash, keyed by role. */
export interface RoomContribution {
  body: Record<string, unknown>;
  /** Markdown body the contributor submitted. ≤ 32 KiB UTF-8 per design. */
  raw_md: string;
  contributed_at: string;
  withdrawn?: boolean;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class RoomSubjectAlreadyOpenError extends Error {
  public readonly installationId: string;
  public readonly subjectType: SubjectType;
  public readonly subjectRef: string;
  public readonly existingRoomId: string;
  constructor(
    installationId: string,
    subjectType: SubjectType,
    subjectRef: string,
    existingRoomId: string,
  ) {
    super(
      `An open war room already exists for installation ${installationId} subject ${subjectType}:${subjectRef} (roomId=${existingRoomId}). Close the existing room before opening a new one.`,
    );
    this.name = "RoomSubjectAlreadyOpenError";
    this.installationId = installationId;
    this.subjectType = subjectType;
    this.subjectRef = subjectRef;
    this.existingRoomId = existingRoomId;
  }
}

export class RoomNotFoundError extends Error {
  public readonly installationId: string;
  public readonly roomId: string;
  constructor(installationId: string, roomId: string) {
    super(
      `No war room found for installation ${installationId} roomId ${roomId}`,
    );
    this.name = "RoomNotFoundError";
    this.installationId = installationId;
    this.roomId = roomId;
  }
}

export class RoomSubjectRefError extends Error {
  public readonly subjectType: SubjectType;
  public readonly subjectRef: string;
  constructor(subjectType: SubjectType, subjectRef: string, expected: string) {
    super(
      `Invalid subject_ref ${JSON.stringify(subjectRef)} for type '${subjectType}': expected ${expected}.`,
    );
    this.name = "RoomSubjectRefError";
    this.subjectType = subjectType;
    this.subjectRef = subjectRef;
  }
}

/**
 * Thrown when caller passes a malformed roomId. Closes #509 guard
 * R1 G3: the sibling keys (events / participants / contributions /
 * seq / claim / idem) embed only `roomId` (per WAR_ROOM_DESIGN.md
 * L240-244), so cross-installation isolation hinges on roomId being
 * globally unique. UUIDv4 strength is enforced at the boundary so
 * a caller passing `"1"` or `"room-A"` can't silently overlay another
 * installation's room data.
 */
export class RoomIdFormatError extends Error {
  public readonly roomId: string;
  constructor(roomId: string) {
    super(
      `Invalid roomId ${JSON.stringify(roomId)}: expected RFC 4122 UUIDv4 (e.g. '01ec0d9a-7c1c-4f8b-9f25-9bdb38f0e1a2'). Mint via crypto.randomUUID() at the route layer.`,
    );
    this.name = "RoomIdFormatError";
    this.roomId = roomId;
  }
}

/**
 * Thrown when ROOM_OPEN finds the roomKey already populated. Distinct
 * from RoomSubjectAlreadyOpenError (which fires on the subject-uniqueness
 * index) — this catches the rare-but-possible UUIDv4 reuse, OR a
 * roomId being submitted twice for different subjects. Closes #509
 * guard R1 G3 (second compounding issue: no EXISTS check on roomKey).
 */
export class RoomIdTakenError extends Error {
  public readonly installationId: string;
  public readonly roomId: string;
  constructor(installationId: string, roomId: string) {
    super(
      `Room id '${roomId}' is already in use for installation ${installationId}. Mint a fresh roomId via crypto.randomUUID().`,
    );
    this.name = "RoomIdTakenError";
    this.installationId = installationId;
    this.roomId = roomId;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * `subject_ref` shape per `subject_type`. All three V1 types use the
 * GitHub `{owner}/{repo}#{number}` canonical form so dashboard /
 * search can construct the GitHub URL from the ref alone.
 */
const SUBJECT_REF_REGEX: Record<SubjectType, RegExp> = {
  // GitHub repo names: 1-100 chars, alphanumeric + `_`/`-`/`.`, no
  // leading dot. Owner: 1-39 chars, alphanumeric + `-`, no consecutive
  // hyphens. PR number: 1+ digits.
  pr_review:
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}[a-zA-Z0-9])?\/[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}#[1-9][0-9]*$/,
  mention_response:
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}[a-zA-Z0-9])?\/[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}#[1-9][0-9]*$/,
  issue_triage:
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}[a-zA-Z0-9])?\/[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}#[1-9][0-9]*$/,
};

const SUBJECT_REF_DESCRIPTION =
  "'{owner}/{repo}#{number}' (e.g. 'hivemoot/hivemoot#508')";

export function validateSubjectRef(subject: SubjectRef): void {
  const pattern = SUBJECT_REF_REGEX[subject.type];
  if (!pattern.test(subject.ref)) {
    throw new RoomSubjectRefError(
      subject.type,
      subject.ref,
      SUBJECT_REF_DESCRIPTION,
    );
  }
}

/** Extract the `{owner}/{repo}` prefix from a subject_ref so callers
 * can populate the per-repo index. Assumes `validateSubjectRef` has
 * already run; falls back to empty string if format is unexpected. */
export function repoFromSubjectRef(ref: string): string {
  const hashIndex = ref.indexOf("#");
  if (hashIndex === -1) return "";
  return ref.substring(0, hashIndex);
}

/**
 * RFC 4122 UUIDv4 — 8-4-4-4-12 hex with the version nibble (`4`) and
 * variant bits (`8`/`9`/`a`/`b`) pinned. `crypto.randomUUID()`
 * produces this shape on Node 18+ and modern browsers, so the route
 * layer can mint with no extra dependency.
 *
 * Lowercase only — the canonical output of `crypto.randomUUID()` —
 * to avoid the case-collision surprise where `Foo` and `foo` map
 * to different Redis keys. Operators with mixed-case external
 * sources should normalize before calling.
 */
const ROOM_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validateRoomId(roomId: string): void {
  if (!ROOM_ID_REGEX.test(roomId)) {
    throw new RoomIdFormatError(roomId);
  }
}

// ---------------------------------------------------------------------------
// Lua scripts
// ---------------------------------------------------------------------------

/**
 * ROOM_OPEN_SCRIPT — atomic room creation.
 *
 * Establishes TWO uniqueness invariants:
 *   1. **Subject uniqueness** (per-installation): a single
 *      `(installationId, subject_type, subject_ref)` tuple has AT
 *      MOST one room in `awaiting_rsvp | awaiting_contributions |
 *      deciding` status. The subject-index key doubles as the lock.
 *   2. **RoomId uniqueness** (per-installation): EXISTS check on the
 *      room hash key prevents a second caller from overlaying an
 *      existing room's data with a different subject. Closes
 *      #509 guard R1 G3 (second compounding issue: original SET
 *      was unconditional and would silently overwrite).
 *
 * Storage shape per WAR_ROOM_DESIGN.md L303-304: room hash with
 *   - `data` field — JSON blob with everything except status
 *   - `status` field — separate string for hot-path transitions
 *
 * Also bootstraps:
 *   - `:seq` counter set directly to 1 (matches design L303 — one
 *     fewer Redis call than the SET 0 + INCR pattern)
 *   - Initial `room_opened` event in `:events` (seq=1)
 *   - Membership in installation index (sorted set, score=opened_at_ms)
 *   - Membership in status:awaiting_rsvp set
 *   - Membership in repo index (set)
 *
 * KEYS:
 *   [1] subjectIndexKey         — subject-uniqueness lock
 *   [2] roomKey                 — room hash (data + status fields)
 *   [3] seqKey                  — sequence counter
 *   [4] eventsKey               — event log sorted set
 *   [5] statusSetAwaitingRsvpKey — status:awaiting_rsvp index
 *   [6] installationIndexKey    — all-rooms-for-installation sorted set
 *   [7] repoIndexKey            — per-repo index
 *
 * ARGV:
 *   [1] roomId                  — for index values + error payload
 *   [2] roomCoreDataJson        — RoomCoreData (everything except status) as JSON
 *   [3] initialStatus           — "awaiting_rsvp"
 *   [4] roomOpenedEventJson     — initial event payload (already encodes seq=1)
 *   [5] openedAtMs              — for installation-index sort score
 *   [6] maxAgeSecs              — TTL for the subject-uniqueness lock
 *
 * Returns:
 *   {1, roomId}                              success
 *   {0, "subject_taken", existingRoomId}     subject already has an open room
 *   {0, "room_id_taken", roomId}             roomKey already exists (UUID reuse)
 */
export const ROOM_OPEN_SCRIPT = `
local existingRoomId = redis.call("get", KEYS[1])
if existingRoomId then
  return {0, "subject_taken", existingRoomId}
end

if redis.call("exists", KEYS[2]) == 1 then
  return {0, "room_id_taken", ARGV[1]}
end

-- Reserve the subject-uniqueness slot first (TTL'd so a stalled
-- recovery can't permanently block new rooms — closes Queen R3 #3).
redis.call("set", KEYS[1], ARGV[1], "EX", tonumber(ARGV[6]))

-- Write the room hash: data field (JSON blob) + status field
-- (separate string, mutated by transition scripts via single-field
-- HSET per design L346).
redis.call("hset", KEYS[2], "data", ARGV[2])
redis.call("hset", KEYS[2], "status", ARGV[3])

-- Initialize the sequence counter directly to 1 (matches design L303;
-- one fewer Redis call than SET 0 + INCR).
redis.call("set", KEYS[3], 1)

-- The opening event lands at seq=1 with score matching the sequence
-- so ZRANGE returns events in order.
redis.call("zadd", KEYS[4], 1, ARGV[4])

-- Status + installation + repo indexes. Updated on every transition;
-- the close path SREM/ZREM cleans them all (see ROOM_CLOSE_SCRIPT).
redis.call("sadd", KEYS[5], ARGV[1])
redis.call("zadd", KEYS[6], tonumber(ARGV[5]), ARGV[1])
redis.call("sadd", KEYS[7], ARGV[1])

return {1, ARGV[1]}
`;

// ---------------------------------------------------------------------------
// Script result dispatch
// ---------------------------------------------------------------------------

/**
 * Generic dispatch shape for Lua scripts that return
 * `{tag, ...slots}`. Slot naming uses neutral `tag1`/`tag2` rather
 * than `reason`/`payload` so success-shape returns (where the
 * second element is a roomId, not a reason string) don't read as
 * "the success had a reason of <roomId>" — closes #509 drone R1 N5.
 *
 * Caller branches on `ok`:
 *   ok ===  1  → success                  (tag1/tag2 are success-shape: roomId, etc.)
 *   ok ===  0  → benign conflict          (tag1 = reason string)
 *   ok === -1  → precondition fail        (tag1 = reason string, tag2 = optional context)
 *   ok === -2  → sequence drift           (tag1 = lastSeq)
 *   ok === -3  → unrecoverable error      (tag1 = reason string)
 */
interface ScriptResult {
  ok: number;
  tag1?: unknown;
  tag2?: unknown;
}

function dispatchScriptResult(raw: unknown): ScriptResult {
  if (!Array.isArray(raw)) {
    throw new Error(
      `Lua script returned non-array: ${JSON.stringify(raw)}`,
    );
  }
  const [tag, ...rest] = raw;
  if (typeof tag !== "number") {
    throw new Error(
      `Lua script returned non-numeric tag: ${JSON.stringify(raw)}`,
    );
  }
  return { ok: tag, tag1: rest[0], tag2: rest[1] };
}

// ---------------------------------------------------------------------------
// Storage primitives
// ---------------------------------------------------------------------------

/**
 * Open a new war room. Atomic at the Redis layer via
 * `ROOM_OPEN_SCRIPT` — establishes both the subject-uniqueness AND
 * roomId-uniqueness invariants, bootstraps the event log, and
 * registers the room in all secondary indexes in a single EVAL.
 *
 * The caller supplies a pre-generated `roomId` (RFC 4122 UUIDv4
 * lowercase — typically minted via `crypto.randomUUID()` at the
 * route layer). Letting the caller mint the ID means the room
 * creator can include it in the subject's GitHub comment up-front
 * for traceability. Format is enforced at the boundary so a caller
 * passing `"1"` or `"room-A"` can't silently overlay another
 * installation's room data via the sibling-key sharing.
 *
 * Throws:
 *   - `RoomIdFormatError` on malformed roomId (boundary check —
 *     no storage write happens)
 *   - `RoomSubjectRefError` on malformed subject_ref
 *   - `RoomSubjectAlreadyOpenError` when the subject already has an
 *     open room (error carries the existing roomId)
 *   - `RoomIdTakenError` on the rare-but-possible UUIDv4 reuse OR
 *     same-roomId-twice-different-subject within an installation
 */
export async function createRoom(args: {
  installationId: string;
  roomId: string;
  manager: string;
  subject: SubjectRef;
  timing?: Partial<TimingConfig>;
  redis: Redis;
  nowMs?: number;
}): Promise<RoomCore> {
  validateRoomId(args.roomId);
  validateSubjectRef(args.subject);

  const nowMs = args.nowMs ?? Date.now();
  const openedAtIso = new Date(nowMs).toISOString();

  const timing: TimingConfig = {
    max_age_secs: args.timing?.max_age_secs ?? DEFAULT_MAX_AGE_SECS,
    rsvp_deadline_secs: args.timing?.rsvp_deadline_secs ?? 600,
    contribution_deadline_secs: args.timing?.contribution_deadline_secs ?? 1200,
  };

  const data: RoomCoreData = {
    manager: args.manager,
    subject_type: args.subject.type,
    subject_ref: args.subject.ref,
    opened_at: openedAtIso,
    timing_config: timing,
  };

  const openedEvent: RoomEvent = {
    seq: 1,
    timestamp: openedAtIso,
    event_type: "room_opened",
    actor_role: "system",
    actor_id: args.manager,
    body: {
      subject_type: args.subject.type,
      subject_ref: args.subject.ref,
      timing_config: timing,
    },
  };

  const repo = repoFromSubjectRef(args.subject.ref);

  const result = dispatchScriptResult(
    await args.redis.eval(
      ROOM_OPEN_SCRIPT,
      [
        subjectIndexKey(args.installationId, args.subject.type, args.subject.ref),
        roomKey(args.installationId, args.roomId),
        seqKey(args.roomId),
        eventsKey(args.roomId),
        statusIndexKey(args.installationId, "awaiting_rsvp"),
        installationIndexKey(args.installationId),
        repoIndexKey(args.installationId, repo),
      ],
      [
        args.roomId,
        JSON.stringify(data),
        "awaiting_rsvp",
        JSON.stringify(openedEvent),
        String(nowMs),
        String(timing.max_age_secs),
      ],
    ),
  );

  if (result.ok === 0 && result.tag1 === "subject_taken") {
    const existing =
      typeof result.tag2 === "string" ? result.tag2 : "<unknown>";
    throw new RoomSubjectAlreadyOpenError(
      args.installationId,
      args.subject.type,
      args.subject.ref,
      existing,
    );
  }
  if (result.ok === 0 && result.tag1 === "room_id_taken") {
    throw new RoomIdTakenError(args.installationId, args.roomId);
  }
  if (result.ok !== 1) {
    throw new Error(
      `ROOM_OPEN_SCRIPT returned unexpected result: ${JSON.stringify(result)}`,
    );
  }
  return { ...data, status: "awaiting_rsvp" };
}

/**
 * Read the room core. Throws `RoomNotFoundError` when the room hash
 * is absent (closed-and-TTL'd, never existed, or installation mismatch).
 *
 * Reconstructs `RoomCore` from the two hash fields the storage shape
 * uses: `data` (JSON blob with everything except status) + `status`
 * (separate field for transition hot-path). See ROOM_OPEN_SCRIPT
 * docstring + WAR_ROOM_DESIGN.md L303-304 for the rationale.
 */
export async function getRoomCore(args: {
  installationId: string;
  roomId: string;
  redis: Redis;
}): Promise<RoomCore> {
  const fields = await args.redis.hgetall<{
    data?: string | RoomCoreData;
    status?: string;
  }>(roomKey(args.installationId, args.roomId));
  // Upstash returns null for missing-key OR an empty object hash;
  // both cases are "room not found" from the caller's perspective.
  if (
    fields === null ||
    fields.data === undefined ||
    fields.status === undefined
  ) {
    throw new RoomNotFoundError(args.installationId, args.roomId);
  }
  // Upstash auto-parses JSON when the stored value is a JSON string
  // and the type generic is non-string. Defensive: accept both shapes
  // (string from raw HSET, object after auto-parse).
  const data =
    typeof fields.data === "string"
      ? (JSON.parse(fields.data) as RoomCoreData)
      : fields.data;
  return { ...data, status: fields.status as RoomStatus };
}

/**
 * List rooms for an installation, newest-first by `opened_at`.
 *
 * Self-healing: opportunistically prunes orphaned index entries
 * whose room hashes have been TTL'd by Redis (mirrors the agent-token
 * V1 list path). Keeps `tokens list` accurate without requiring a
 * separate sweep.
 *
 * `limit` defaults to 50 (sane operator-facing default for the CLI
 * + dashboard surface). Pass `Infinity` for "all rooms"; the caller
 * is responsible for not blowing up on unbounded scans.
 */
export async function listRooms(args: {
  installationId: string;
  redis: Redis;
  limit?: number;
}): Promise<RoomCore[]> {
  const limit = args.limit ?? 50;
  const indexKey = installationIndexKey(args.installationId);

  // ZREVRANGE for newest-first; bounded by limit-1 (inclusive end).
  const stop = limit === Infinity ? -1 : Math.max(0, limit - 1);
  const roomIds = await args.redis.zrange<string[]>(indexKey, 0, stop, {
    rev: true,
  });
  if (roomIds.length === 0) return [];

  const fanout = await Promise.all(
    roomIds.map((id) =>
      args.redis.hgetall<{ data?: string | RoomCoreData; status?: string }>(
        roomKey(args.installationId, id),
      ),
    ),
  );

  const out: RoomCore[] = [];
  const orphans: string[] = [];
  for (let i = 0; i < fanout.length; i++) {
    const f = fanout[i];
    if (f === null || f.data === undefined || f.status === undefined) {
      orphans.push(roomIds[i]);
      continue;
    }
    const data =
      typeof f.data === "string"
        ? (JSON.parse(f.data) as RoomCoreData)
        : f.data;
    out.push({ ...data, status: f.status as RoomStatus });
  }

  // Best-effort cleanup of orphaned installation-index entries.
  // **Note for D.1.a-iii**: this only sweeps the installation index;
  // a TTL'd-without-close room can also leak entries in the status
  // set, repo set, and (potentially) subject index. The terminate /
  // close scripts in the next slice should sweep across all four
  // secondary indexes (closes guard R1 N2 carry-forward).
  if (orphans.length > 0) {
    await Promise.all(
      orphans.map((id) =>
        args.redis.zrem(indexKey, id).catch((err: unknown) => {
          console.warn(
            `[war-room] failed to ZREM orphaned index entry ${args.installationId}:${id}`,
            err,
          );
        }),
      ),
    );
  }

  return out;
}

// ===========================================================================
// Phase D.1.a-ii — event appending + materialized RSVP/contribution views
// ===========================================================================

// ---------------------------------------------------------------------------
// Constants (D.1.a-ii)
// ---------------------------------------------------------------------------

/** Per WAR_ROOM_DESIGN.md: event body bounded ≤ 8 KiB serialized.
 * Larger payloads belong in the contribution `raw_md` (32 KiB) or
 * external storage with a reference. Enforced at append time so a
 * runaway event can't fill the per-room sorted set. */
export const ROOM_EVENT_BODY_MAX_BYTES = 8 * 1024;

/** Per WAR_ROOM_DESIGN.md: contribution `raw_md` bounded ≤ 32 KiB.
 * Markdown that exceeds belongs in a gist or attached file with the
 * URL in the contribution body. */
export const ROOM_CONTRIBUTION_RAW_MD_MAX_BYTES = 32 * 1024;

/** Multiplier for idempotency-reverse-index TTL relative to the room's
 * `max_age_secs`. The idem TTL must outlive any reasonable client
 * retry window but expire well before the room's 30-day post-close
 * retention so a stale replay can't resolve months later.
 *   max_age_secs default 3600 → idem TTL default 7200 (2 h). */
export const IDEM_TTL_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// Errors (D.1.a-ii)
// ---------------------------------------------------------------------------

/**
 * Thrown when `ROOM_APPEND_EVENT_SCRIPT` returns `{-2, currentStatus}` —
 * the event's `status_from` precondition didn't match the room's
 * actual status at the moment the script ran. Closes the
 * watchdog-vs-/decide race: a `participant_timed_out` watchdog firing
 * while the queen is in mid-claim will see status drift from
 * `awaiting_contributions` to `deciding` and bail without writing.
 *
 * Caller handling depends on context: watchdog should re-scan on
 * the next tick; an explicit `/present` from a worker should surface
 * a 409 to the worker so they know the room moved on.
 */
export class RoomEventStatusPreconditionError extends Error {
  public readonly roomId: string;
  public readonly expectedFrom: string;
  public readonly actualStatus: string;
  constructor(roomId: string, expectedFrom: string, actualStatus: string) {
    super(
      `Event for room ${roomId} expected status_from=${JSON.stringify(expectedFrom)} but room is currently ${JSON.stringify(actualStatus)}. Re-read room state and retry if appropriate.`,
    );
    this.name = "RoomEventStatusPreconditionError";
    this.roomId = roomId;
    this.expectedFrom = expectedFrom;
    this.actualStatus = actualStatus;
  }
}

/**
 * Thrown when `ROOM_APPEND_EVENT_SCRIPT` returns `{-1, existingSequence}` —
 * the idempotency reverse index already has an entry for this key,
 * meaning a prior call from the same client/action lane succeeded
 * with the returned sequence. Caller treats this as a "your prior
 * write took effect, the sequence is N" signal and proceeds.
 *
 * NOT a true error — it's the expected outcome of a client retry.
 * Surfaced as a typed error so callers can distinguish replay from
 * a genuine fresh write (the latter returns just `{seq}`).
 */
export class RoomEventIdempotencyReplayError extends Error {
  public readonly roomId: string;
  public readonly existingSequence: number;
  constructor(roomId: string, existingSequence: number) {
    super(
      `Idempotency replay for room ${roomId}: prior write at sequence ${existingSequence}. Treat as success.`,
    );
    this.name = "RoomEventIdempotencyReplayError";
    this.roomId = roomId;
    this.existingSequence = existingSequence;
  }
}

/** Event body exceeded `ROOM_EVENT_BODY_MAX_BYTES` (8 KiB serialized). */
export class RoomEventBodyTooLargeError extends Error {
  public readonly sizeBytes: number;
  constructor(sizeBytes: number) {
    super(
      `Event body exceeds ${ROOM_EVENT_BODY_MAX_BYTES} bytes (got ${sizeBytes}). Move large payloads to a contribution body or external reference.`,
    );
    this.name = "RoomEventBodyTooLargeError";
    this.sizeBytes = sizeBytes;
  }
}

/** Contribution `raw_md` exceeded `ROOM_CONTRIBUTION_RAW_MD_MAX_BYTES` (32 KiB). */
export class RoomContributionTooLargeError extends Error {
  public readonly sizeBytes: number;
  constructor(sizeBytes: number) {
    super(
      `Contribution raw_md exceeds ${ROOM_CONTRIBUTION_RAW_MD_MAX_BYTES} bytes (got ${sizeBytes}). Attach as a gist / external file and put the URL in the contribution body.`,
    );
    this.name = "RoomContributionTooLargeError";
    this.sizeBytes = sizeBytes;
  }
}

/**
 * Role string is server-derived from the bearer envelope's `agent_role`
 * field — never accepted from request body. This boundary regex
 * catches the very unlikely "envelope had a corrupted role" case
 * before it lands in the materialized hash key.
 */
const ROLE_REGEX = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Server-canonical idempotency key derivation. Input is a stable
 * tuple of (roomId, role, action, sequenceObservedByClient); SHA-256
 * keeps the key opaque + bounded-length while making collisions
 * cryptographically negligible.
 *
 * `sequenceObservedByClient` is the `If-Room-Sequence-At-Or-After`
 * header value the client read when constructing the request. Two
 * retries from the same client see the same observed sequence and
 * thus derive the same key — that's the desired behavior for the
 * replay-detection path.
 */
export function deriveIdempotencyKey(args: {
  roomId: string;
  role: string;
  action: RoomEventAction;
  sequenceObservedByClient: number;
}): string {
  return createHash("sha256")
    .update(
      `v1:${args.roomId}:${args.role}:${args.action}:${args.sequenceObservedByClient}`,
    )
    .digest("hex");
}

/** Action vocabulary for idempotency derivation. Distinct from
 * `RoomEventType` because two event types can share the same
 * action lane (e.g., `participant_presented` and a future
 * `participant_re_presented` would both be `present`). */
export type RoomEventAction =
  | "present"
  | "withdraw_participant"
  | "contribute"
  | "withdraw_contribution"
  | "timeout"
  | "decide"
  | "close";

// ---------------------------------------------------------------------------
// ROOM_APPEND_EVENT_SCRIPT — atomic event append
// ---------------------------------------------------------------------------

/**
 * Atomic event append with idempotency, status precondition, and
 * optional materialized-view update.
 *
 * Design references:
 *   - WAR_ROOM_DESIGN.md L320-380 — script source
 *   - WAR_ROOM_DESIGN.md L139-216 — RSVP-driven lifecycle
 *
 * Order of operations (single EVAL):
 *   1. Idempotency check: if `idempotencyKey` is set and `:idem:{key}`
 *      exists, return `{-1, existingSequence}` (replay-safe).
 *   2. Status precondition: if `status_from` is set, compare against
 *      the room's current `status` field. Mismatch → `{-2, currStatus}`.
 *   3. INCR `:seq` for the new event's sequence number.
 *   4. ZADD the event JSON to `:events` with score=seq. The TS caller
 *      writes `__SEQ__` in the JSON template; the script `gsub`s it
 *      to the actual sequence number before ZADD.
 *   5. SET the idempotency reverse index (if key non-empty) with
 *      caller-supplied TTL (parameterized — closes Queen R3 #5).
 *   6. HSET the materialized view (participants / contributions) if
 *      `materializedFieldName` is non-empty.
 *   7. Status transition (if `status_to` is set): HSET status, SREM
 *      from-set, SADD to-set.
 *
 * KEYS:
 *   [1] seqKey                — sequence counter
 *   [2] eventsKey             — event log sorted set
 *   [3] idemKey               — idempotency reverse index for this key
 *   [4] roomKey               — room hash (for status read/write)
 *   [5] materializedKey       — participants OR contributions hash
 *   [6] statusFromSetKey      — status:awaiting_X set (for transition SREM)
 *   [7] statusToSetKey        — status:awaiting_Y set (for transition SADD)
 *
 * ARGV:
 *   [1] eventJsonTemplate     — JSON with `__SEQ__` placeholder (Lua substitutes)
 *   [2] idempotencyKey        — empty string disables idem check
 *   [3] eventType             — diagnostic only (logged in audit)
 *   [4] materializedFieldName — empty disables materialized update
 *   [5] materializedFieldJson — value to HSET when fieldName set
 *   [6] roomStatusFrom        — empty disables status precondition
 *   [7] roomStatusTo          — empty disables status transition
 *   [8] roomId                — for index updates
 *   [9] idemTtlSecs           — TTL for the idempotency reverse index
 *
 * Returns:
 *   {seq}                     success
 *   {-1, existingSequence}    idempotency replay (caller treats as success)
 *   {-2, currentRoomStatus}   status precondition mismatch
 */
export const ROOM_APPEND_EVENT_SCRIPT = `
if ARGV[2] ~= "" then
  local existing = redis.call("get", KEYS[3])
  if existing then return {-1, tonumber(existing)} end
end
local currStatus = redis.call("hget", KEYS[4], "status")
if ARGV[6] ~= "" and currStatus ~= ARGV[6] then
  return {-2, currStatus}
end
local seq = redis.call("incr", KEYS[1])
local eventJson = string.gsub(ARGV[1], "__SEQ__", tostring(seq))
redis.call("zadd", KEYS[2], seq, eventJson)
if ARGV[2] ~= "" then
  redis.call("set", KEYS[3], tostring(seq), "EX", tonumber(ARGV[9]))
end
if ARGV[4] ~= "" then
  redis.call("hset", KEYS[5], ARGV[4], ARGV[5])
end
if ARGV[7] ~= "" then
  redis.call("hset", KEYS[4], "status", ARGV[7])
  redis.call("srem", KEYS[6], ARGV[8])
  redis.call("sadd", KEYS[7], ARGV[8])
end
return {seq}
`;

// ---------------------------------------------------------------------------
// Helpers (D.1.a-ii)
// ---------------------------------------------------------------------------

/** Validate role at the boundary. Server-supplied (from envelope) so
 * mismatches are an internal-correctness signal, not a 400 to clients. */
function assertRoleFormat(role: string): void {
  if (!ROLE_REGEX.test(role)) {
    throw new Error(
      `Internal: role ${JSON.stringify(role)} from token envelope failed format validation (/^[a-z][a-z0-9_-]{0,31}$/).`,
    );
  }
}

/** Throw if event body exceeds the 8 KiB cap. Measured on the
 * UTF-8 byte length of the serialized JSON (NOT the surrogate-pair
 * character count). */
function assertEventBodySize(body: Record<string, unknown>): void {
  const serialized = JSON.stringify(body);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > ROOM_EVENT_BODY_MAX_BYTES) {
    throw new RoomEventBodyTooLargeError(bytes);
  }
}

/** Throw if contribution `raw_md` exceeds the 32 KiB cap. */
function assertContributionMdSize(rawMd: string): void {
  const bytes = Buffer.byteLength(rawMd, "utf8");
  if (bytes > ROOM_CONTRIBUTION_RAW_MD_MAX_BYTES) {
    throw new RoomContributionTooLargeError(bytes);
  }
}

/** Compute the IDEM TTL for a room, consistent across all event paths. */
function idemTtlSecs(roomMaxAgeSecs: number): number {
  return roomMaxAgeSecs * IDEM_TTL_MULTIPLIER;
}

// ---------------------------------------------------------------------------
// Low-level append primitive
// ---------------------------------------------------------------------------

interface AppendRoomEventArgs {
  installationId: string;
  roomId: string;
  /** Event metadata. The serialized JSON gets `__SEQ__` substituted to the
   * actual sequence inside the Lua script before the ZADD. */
  event: {
    timestamp: string;
    event_type: RoomEventType;
    actor_role: string;
    actor_id: string;
    body: Record<string, unknown>;
  };
  /** Empty disables idem check. Typically derived via `deriveIdempotencyKey`. */
  idempotencyKey: string;
  /** When set, append HSETs `materializedFieldName → materializedFieldJson` on
   * `materializedKey` after the event lands. Use for participants /
   * contributions materialized views. */
  materialized?: {
    key: string;
    field: string;
    json: string;
  };
  /** Optional status transition. When provided, both fields required:
   * the script enforces `from` precondition + transitions status sets. */
  statusTransition?: {
    from: RoomStatus;
    to: RoomStatus;
  };
  /** TTL for the idem reverse index. Defaults to
   * `IDEM_TTL_MULTIPLIER × DEFAULT_MAX_AGE_SECS`. Caller passes the
   * room's actual `timing_config.max_age_secs * IDEM_TTL_MULTIPLIER`
   * for accuracy across rooms with custom timing. */
  idemTtlSecs?: number;
  redis: Redis;
}

/**
 * Append an event to a war room atomically. Underlying primitive for
 * the high-level RSVP / contribute / timeout / decide / close wrappers.
 *
 * Returns the assigned sequence number on success. On idempotency
 * replay, throws `RoomEventIdempotencyReplayError` carrying the
 * existing sequence so callers can treat it as success without
 * losing the sequence-number signal.
 *
 * Throws:
 *   - `RoomEventIdempotencyReplayError` (replay — caller treats as success)
 *   - `RoomEventStatusPreconditionError` (room moved out of `from` state)
 *   - `RoomEventBodyTooLargeError` (body > 8 KiB serialized)
 */
export async function appendRoomEvent(
  args: AppendRoomEventArgs,
): Promise<number> {
  assertEventBodySize(args.event.body);

  // Encode the event JSON template with __SEQ__ placeholder; Lua
  // gsub replaces it with the actual sequence number atomically.
  const eventTemplate = JSON.stringify({
    seq: "__SEQ__",
    timestamp: args.event.timestamp,
    event_type: args.event.event_type,
    actor_role: args.event.actor_role,
    actor_id: args.event.actor_id,
    body: args.event.body,
  });

  // The script gsub looks for the LITERAL string `"__SEQ__"` in the
  // template (with quotes — JSON.stringify wrapped __SEQ__ as a
  // string). Lua replaces with the unquoted number, producing valid
  // JSON like `"seq":42`.
  const luaTemplate = eventTemplate.replace('"__SEQ__"', "__SEQ__");

  const ttl = args.idemTtlSecs ?? idemTtlSecs(DEFAULT_MAX_AGE_SECS);

  const result = dispatchScriptResult(
    await args.redis.eval(
      ROOM_APPEND_EVENT_SCRIPT,
      [
        seqKey(args.roomId),
        eventsKey(args.roomId),
        idemKey(args.roomId, args.idempotencyKey),
        roomKey(args.installationId, args.roomId),
        args.materialized?.key ?? "__unused__",
        args.statusTransition
          ? statusIndexKey(args.installationId, args.statusTransition.from)
          : "__unused__",
        args.statusTransition
          ? statusIndexKey(args.installationId, args.statusTransition.to)
          : "__unused__",
      ],
      [
        luaTemplate,
        args.idempotencyKey,
        args.event.event_type,
        args.materialized?.field ?? "",
        args.materialized?.json ?? "",
        args.statusTransition?.from ?? "",
        args.statusTransition?.to ?? "",
        args.roomId,
        String(ttl),
      ],
    ),
  );

  if (result.ok === -1 && typeof result.tag1 === "number") {
    throw new RoomEventIdempotencyReplayError(args.roomId, result.tag1);
  }
  if (result.ok === -2 && typeof result.tag1 === "string") {
    throw new RoomEventStatusPreconditionError(
      args.roomId,
      args.statusTransition?.from ?? "",
      result.tag1,
    );
  }
  // The script's success shape is `{seq}` — ScriptResult parses
  // that as `{ok: seq, tag1: undefined}`. Sequence numbers from
  // `INCR` are always positive integers, so `ok > 0` distinguishes
  // success from the negative-tag error returns.
  if (result.ok > 0) return result.ok;

  throw new Error(
    `ROOM_APPEND_EVENT_SCRIPT returned unexpected result: ${JSON.stringify(result)}`,
  );
}

// ---------------------------------------------------------------------------
// High-level RSVP / contribute / timeout primitives
// ---------------------------------------------------------------------------

interface RSVPCommonArgs {
  installationId: string;
  roomId: string;
  /** Server-derived from token envelope's `agent_role`. NEVER accepted
   * from request body — the materialized hash field key is the role,
   * so client-supplied role would let one bearer overwrite another's
   * RSVP. */
  role: string;
  /** Server-derived from token envelope's `name`. Used as the actor_id
   * on the event log + materialized participant record. */
  agentId: string;
  /** Required header value (`If-Room-Sequence-At-Or-After`). Used to
   * derive the idempotency key — two retries with the same observed
   * sequence resolve to the same key, replay-safe. */
  sequenceObservedByClient: number;
  /** Optional — overrides the default IDEM TTL for rooms with custom
   * `max_age_secs`. */
  roomMaxAgeSecs?: number;
  redis: Redis;
  nowMs?: number;
}

/**
 * Worker presents itself as a participant in a war room. Soft event —
 * doesn't transition room status (transition to
 * `awaiting_contributions` happens via a separate script when all
 * expected roles are present).
 *
 * Idempotent: a retry with the same `sequenceObservedByClient` returns
 * (via `RoomEventIdempotencyReplayError`) the original sequence.
 */
export async function presentParticipant(args: RSVPCommonArgs & {
  intentHint?: string;
}): Promise<number> {
  assertRoleFormat(args.role);
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString();
  const participant: RoomParticipant = {
    agent_id: args.agentId,
    role: args.role,
    status: "present",
    rsvp_at: nowIso,
  };

  return await appendRoomEvent({
    installationId: args.installationId,
    roomId: args.roomId,
    event: {
      timestamp: nowIso,
      event_type: "participant_presented",
      actor_role: args.role,
      actor_id: args.agentId,
      body: {
        ...(args.intentHint !== undefined ? { intent_hint: args.intentHint } : {}),
      },
    },
    idempotencyKey: deriveIdempotencyKey({
      roomId: args.roomId,
      role: args.role,
      action: "present",
      sequenceObservedByClient: args.sequenceObservedByClient,
    }),
    materialized: {
      key: participantsKey(args.roomId),
      field: args.role,
      json: JSON.stringify(participant),
    },
    idemTtlSecs: idemTtlSecs(args.roomMaxAgeSecs ?? DEFAULT_MAX_AGE_SECS),
    redis: args.redis,
  });
}

/**
 * Worker withdraws their RSVP. Updates the participant record's
 * `status` to `"withdrawn"` so leader election skips them. Soft —
 * doesn't transition room status.
 */
export async function withdrawParticipant(
  args: RSVPCommonArgs & { reason?: string },
): Promise<number> {
  assertRoleFormat(args.role);
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString();
  const participant: RoomParticipant = {
    agent_id: args.agentId,
    role: args.role,
    status: "withdrawn",
    rsvp_at: nowIso,
    resolved_at: nowIso,
  };

  return await appendRoomEvent({
    installationId: args.installationId,
    roomId: args.roomId,
    event: {
      timestamp: nowIso,
      event_type: "participant_withdrawn",
      actor_role: args.role,
      actor_id: args.agentId,
      body: {
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      },
    },
    idempotencyKey: deriveIdempotencyKey({
      roomId: args.roomId,
      role: args.role,
      action: "withdraw_participant",
      sequenceObservedByClient: args.sequenceObservedByClient,
    }),
    materialized: {
      key: participantsKey(args.roomId),
      field: args.role,
      json: JSON.stringify(participant),
    },
    idemTtlSecs: idemTtlSecs(args.roomMaxAgeSecs ?? DEFAULT_MAX_AGE_SECS),
    redis: args.redis,
  });
}

/**
 * Worker submits a contribution (analysis / verdict). Latest-wins per
 * role: re-submitting overwrites the prior contribution in the
 * materialized hash. Soft — doesn't transition room status.
 *
 * Throws `RoomContributionTooLargeError` if `rawMd` exceeds 32 KiB.
 */
export async function submitContribution(args: RSVPCommonArgs & {
  body: Record<string, unknown>;
  rawMd: string;
}): Promise<number> {
  assertRoleFormat(args.role);
  assertContributionMdSize(args.rawMd);
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString();
  const contribution: RoomContribution = {
    body: args.body,
    raw_md: args.rawMd,
    contributed_at: nowIso,
  };

  return await appendRoomEvent({
    installationId: args.installationId,
    roomId: args.roomId,
    event: {
      timestamp: nowIso,
      event_type: "contribution_submitted",
      actor_role: args.role,
      actor_id: args.agentId,
      body: {
        body: args.body,
        // Don't include raw_md in the event body (it's bounded
        // separately at 32 KiB; the event body's 8 KiB cap would be
        // blown by typical-sized contributions). The materialized
        // hash carries the full raw_md for caller retrieval.
      },
    },
    idempotencyKey: deriveIdempotencyKey({
      roomId: args.roomId,
      role: args.role,
      action: "contribute",
      sequenceObservedByClient: args.sequenceObservedByClient,
    }),
    materialized: {
      key: contributionsKey(args.roomId),
      field: args.role,
      json: JSON.stringify(contribution),
    },
    idemTtlSecs: idemTtlSecs(args.roomMaxAgeSecs ?? DEFAULT_MAX_AGE_SECS),
    redis: args.redis,
  });
}

/**
 * Worker withdraws a previously-submitted contribution. Soft event —
 * the contribution remains in the materialized hash with
 * `withdrawn: true` flag. Queen synthesis skips withdrawn contributions.
 */
export async function withdrawContribution(
  args: RSVPCommonArgs & { reason?: string },
): Promise<number> {
  assertRoleFormat(args.role);
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString();
  // Mark the existing contribution as withdrawn. Caller is expected
  // to have an existing contribution; if not, the event lands but
  // the materialized hash has no prior entry to update — that's a
  // diagnosable misuse, not a failure mode here.
  const tombstone: Partial<RoomContribution> & { withdrawn: true } = {
    withdrawn: true,
    contributed_at: nowIso,
  };

  return await appendRoomEvent({
    installationId: args.installationId,
    roomId: args.roomId,
    event: {
      timestamp: nowIso,
      event_type: "contribution_withdrawn",
      actor_role: args.role,
      actor_id: args.agentId,
      body: {
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      },
    },
    idempotencyKey: deriveIdempotencyKey({
      roomId: args.roomId,
      role: args.role,
      action: "withdraw_contribution",
      sequenceObservedByClient: args.sequenceObservedByClient,
    }),
    materialized: {
      key: contributionsKey(args.roomId),
      field: args.role,
      json: JSON.stringify(tombstone),
    },
    idemTtlSecs: idemTtlSecs(args.roomMaxAgeSecs ?? DEFAULT_MAX_AGE_SECS),
    redis: args.redis,
  });
}

/**
 * Watchdog-driven: mark a participant as timed out. Called by the
 * bot's manager loop, NOT by clients. The `actorRole` is the
 * watchdog's ("manager"); the `subjectRole` is the participant
 * being timed out.
 *
 * Status precondition: only fires when the room is still in
 * `awaiting_contributions` (closes G7 watchdog-vs-claim race —
 * if the queen has already moved status to `deciding`, this
 * returns `RoomEventStatusPreconditionError` and the watchdog
 * re-scans on the next tick).
 */
export async function timeoutParticipant(args: {
  installationId: string;
  roomId: string;
  /** The participant role being timed out (NOT the watchdog's role). */
  subjectRole: string;
  /** The watchdog's role + agent identity (server-derived). */
  watchdogRole: string;
  watchdogAgentId: string;
  /** Watchdog observes the current sequence at scan time and passes
   * it through for idempotency. */
  sequenceObservedByClient: number;
  roomMaxAgeSecs?: number;
  redis: Redis;
  nowMs?: number;
}): Promise<number> {
  assertRoleFormat(args.subjectRole);
  assertRoleFormat(args.watchdogRole);
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString();
  // Tombstone the participant. agent_id stays unchanged from the
  // prior present (the timeout doesn't claim a new agent); since
  // we're updating the existing record, we keep what was there
  // semantically — but the watchdog doesn't have it on hand, so
  // we record the agent_id as the watchdog's for traceability.
  // Operators reading the participants hash see the timeout marker;
  // forensic detail (who originally RSVP'd) lives in the event log.
  const participant: RoomParticipant = {
    agent_id: args.watchdogAgentId,
    role: args.subjectRole,
    status: "timed_out",
    rsvp_at: nowIso,
    resolved_at: nowIso,
  };

  return await appendRoomEvent({
    installationId: args.installationId,
    roomId: args.roomId,
    event: {
      timestamp: nowIso,
      event_type: "participant_timed_out",
      actor_role: args.watchdogRole,
      actor_id: args.watchdogAgentId,
      body: { subject_role: args.subjectRole },
    },
    idempotencyKey: deriveIdempotencyKey({
      roomId: args.roomId,
      role: args.subjectRole, // keyed on subject so concurrent watchdog ticks dedupe
      action: "timeout",
      sequenceObservedByClient: args.sequenceObservedByClient,
    }),
    materialized: {
      key: participantsKey(args.roomId),
      field: args.subjectRole,
      json: JSON.stringify(participant),
    },
    // Status precondition: only time out while still awaiting contributions
    // — closes the watchdog vs `/decide` race per design G7.
    statusTransition: {
      from: "awaiting_contributions",
      to: "awaiting_contributions",
    },
    idemTtlSecs: idemTtlSecs(args.roomMaxAgeSecs ?? DEFAULT_MAX_AGE_SECS),
    redis: args.redis,
  });
}

// ---------------------------------------------------------------------------
// Read primitives — events / participants / contributions
// ---------------------------------------------------------------------------

/**
 * Read events from a room's append-only log, ordered by sequence.
 * `since` filters to events with `seq > since` (caller's last-seen
 * cursor). `limit` defaults to 200 — large enough for the typical
 * room (event count is bounded by the soft contribution deadline).
 */
export async function listRoomEvents(args: {
  roomId: string;
  since?: number;
  limit?: number;
  redis: Redis;
}): Promise<RoomEvent[]> {
  const limit = args.limit ?? 200;
  const minScore = (args.since ?? 0) + 1; // exclusive of `since`
  const raw = await args.redis.zrange<string[]>(
    eventsKey(args.roomId),
    minScore,
    "+inf",
    {
      byScore: true,
      offset: 0,
      count: limit,
    },
  );
  return raw.map((s) => JSON.parse(s) as RoomEvent);
}

/** Read all participants for a room, keyed by role. Returns `{}`
 * for rooms with no participants yet (or rooms that don't exist —
 * caller should `getRoomCore` separately if existence is meaningful). */
export async function getRoomParticipants(args: {
  roomId: string;
  redis: Redis;
}): Promise<Record<string, RoomParticipant>> {
  const raw = await args.redis.hgetall<Record<string, string | RoomParticipant>>(
    participantsKey(args.roomId),
  );
  if (raw === null) return {};
  const out: Record<string, RoomParticipant> = {};
  for (const [role, value] of Object.entries(raw)) {
    out[role] =
      typeof value === "string" ? (JSON.parse(value) as RoomParticipant) : value;
  }
  return out;
}

/** Read all contributions for a room, keyed by role. Same shape as
 * `getRoomParticipants` — `{}` for empty / nonexistent. */
export async function getRoomContributions(args: {
  roomId: string;
  redis: Redis;
}): Promise<Record<string, RoomContribution>> {
  const raw = await args.redis.hgetall<Record<string, string | RoomContribution>>(
    contributionsKey(args.roomId),
  );
  if (raw === null) return {};
  const out: Record<string, RoomContribution> = {};
  for (const [role, value] of Object.entries(raw)) {
    out[role] =
      typeof value === "string"
        ? (JSON.parse(value) as RoomContribution)
        : value;
  }
  return out;
}
