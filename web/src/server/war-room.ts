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
