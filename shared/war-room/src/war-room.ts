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

/**
 * Subject-uniqueness lock key for room creation. For repo-anchored
 * subject types (`pr_review` / `mention_response` / `issue_triage`),
 * collisions on the same `subject_ref` block a duplicate open room.
 *
 * For `general` (operator-created free-form rooms) the lock is keyed
 * per-roomId rather than per-subject_ref so two ad-hoc rooms can
 * share a title — uniqueness is degenerate (always passes), the
 * key still gets cleaned up by the close/terminate scripts via the
 * same KEYS slot. Closes the "no special handling" requirement —
 * existing Lua scripts work unchanged because the key shape is
 * still `hive:v1:idx:room:subject:...`.
 */
export function subjectLockKey(
  installationId: string,
  subjectType: SubjectType,
  subjectRef: string,
  roomId: string,
): string {
  if (subjectType === "general") {
    return `${SUBJECT_INDEX_PREFIX}${installationId}:general:${roomId}`;
  }
  return subjectIndexKey(installationId, subjectType, subjectRef);
}

/**
 * Per-repo index key derived from a subject. Repo-anchored types
 * use `{owner}/{repo}` parsed from `subject_ref`. `general` rooms
 * have no repo — they all share a single `_general` bucket so the
 * close/terminate scripts can still SREM the same key on cleanup
 * without introducing a "skip this slot" branch in the Lua.
 */
export function repoIndexKeyForSubject(
  installationId: string,
  subjectType: SubjectType,
  subjectRef: string,
): string {
  if (subjectType === "general") {
    return repoIndexKey(installationId, "_general");
  }
  return repoIndexKey(installationId, repoFromSubjectRef(subjectRef));
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
 * Status state machine (presence/heartbeat model — see
 * WAR_ROOM_DESIGN.md §Presence-driven lifecycle):
 *
 *   awaiting_contributions  (the only "open" status)
 *     ├─ [age > max_age_secs AND zero done participants] → expired
 *     ├─ [synthesis failures ≥ 3] → closed (failed_synthesis)
 *     └─ [≥1 done AND 0 working AND quiet_period elapsed] → deciding
 *                ↓
 *     deciding
 *     ├─ [claim TTL expired + recovery] → awaiting_contributions
 *     ├─ [force_close] → closed (force_close)
 *     └─ [queen `/close` with decision] → closed (decision recorded)
 *
 *     closed | expired (terminal, no further transitions)
 */
export type RoomStatus =
  | "awaiting_contributions"
  | "deciding"
  | "closed"
  | "expired";

/** Subject classes V1 supports. New types require backend
 * regex validation per `subject_ref` shape.
 *
 * `general` is the operator-driven escape hatch — a free-form
 * coordination room created manually from the dashboard, not
 * anchored to any GitHub artifact. `subject_ref` for `general`
 * is just a free-form title (1-200 chars, no control chars).
 * Decision-poster skips it (no GitHub comment to post to);
 * agents discover and engage via the existing `/api/rooms/watching`
 * path with no special handling. */
export type SubjectType = "pr_review" | "mention_response" | "issue_triage" | "general";

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
  /** Soft deadline before a `working` participant whose heartbeat
   * has lapsed gets dropped by the watchdog. Default 1200 (20m) —
   * preserves the pre-heartbeat-model `contribution_deadline_secs`
   * default so agents doing deep work that previously fit the old
   * window aren't unexpectedly timed out. Once V2 ships the
   * `/heartbeat` endpoint, agents will be able to keep their slot
   * alive past this window and the default can drop to ~600.
   *
   * Replaces the deprecated `rsvp_deadline_secs` /
   * `contribution_deadline_secs` pair from the pre-heartbeat model.
   * Agents will heartbeat at their own cadence (V2); the server
   * enforces this drop threshold. */
  drop_threshold_secs: number;
  /** Quiet window the queen waits for after the last
   * participant-relevant event (`participant_heartbeat`,
   * `contribution_submitted`, `participant_dropped`) before claiming
   * the room for synthesis. Default 600 (10m).
   *
   * Lets late-arriving agents engage without losing their slot
   * even after one fast contribution has landed. */
  quiet_period_secs: number;
}

/**
 * Immutable bulk fields of a room core. Stored as a JSON string in
 * the room hash's `"data"` field per the design's HSET shape
 * (WAR_ROOM_DESIGN.md L303-304). These fields are written ONCE at
 * `createRoom` time and never mutated — making the JSON-blob shape
 * safe (no per-field race against transition scripts).
 *
 * Mutable fields (`status`, `closed_at`, `closed_reason`,
 * `deciding_through_sequence`, `decision`) live as SEPARATE hash
 * fields so transition scripts (DECIDE_CLAIM, RECOVER, TERMINATE,
 * CLOSE) can update them via single-field HSET without
 * marshaling/unmarshaling the whole record on the hot path. Closes
 * #509 guard R1 carry-forward (the original implementation merged
 * mutable + immutable into one blob, requiring the close path to
 * read-modify-write the entire JSON).
 *
 * Field naming uses snake_case to match the storage shape across
 * other modules (agent-token-v1 envelope, audit entries) —
 * wire-shape translation to camelCase happens at the API boundary.
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
}

/**
 * Room core view returned by `getRoomCore` — the immutable
 * `RoomCoreData` blob plus the mutable transition fields. Each
 * mutable field maps to its own hash field on the room key:
 *
 *   `data`                       → JSON-encoded RoomCoreData (immutable)
 *   `status`                     → string (RoomStatus enum)
 *   `closed_at`                  → ISO 8601 string (set on terminate/close)
 *   `closed_reason`              → TerminalReason (set on TERMINATE only)
 *   `deciding_through_sequence`  → integer (set on DECIDE_CLAIM, cleared
 *                                  on RECOVER + on CLOSE drift path)
 *   `decision`                   → JSON-encoded RoomDecision (set on
 *                                  CLOSE happy path only)
 *
 * Each transition script HSETs only the fields it changes — never a
 * read-modify-write of `data`.
 */
export interface RoomCore extends RoomCoreData {
  status: RoomStatus;
  /** Set when the room reaches a terminal state (closed | expired). */
  closed_at?: string;
  /** Set ONLY by `ROOM_TERMINATE_SCRIPT` (expired/failed_synthesis/
   * force_close/manual). The queen happy-path close via
   * `ROOM_CLOSE_SCRIPT` sets `decision` instead and leaves this
   * undefined — operators distinguish the two paths by which
   * field is populated. */
  closed_reason?: TerminalReason;
  /** Sequence the queen synthesized through (set by claim script,
   * verified at close to detect mid-synthesis drift). Cleared on
   * recovery (claim TTL'd before close) and on CLOSE-drift revert. */
  deciding_through_sequence?: number;
  /** Decision payload — set ONLY by `ROOM_CLOSE_SCRIPT` on the
   * queen happy path. */
  decision?: RoomDecision;
  /** ISO 8601 timestamp of the most recent rejected `subject_updated`
   * event on this room. Set by `recordPostCloseDrift` when the bot's
   * webhook handler observes a `status_precondition_failed` rejection
   * (the room is `closed`/`deciding` and can't accept the update).
   *
   * Surfaces the "diff drifted post-verdict" signal: a closed room's
   * verdict was synthesized over an earlier head SHA, but the PR has
   * since advanced. The dashboard reads this field to render a badge
   * so operators can spot weak-signal merges (PR diff diverged from
   * what the war-room reviewed). Closes hivemoot/hivemoot#605 (Option A).
   *
   * Last-write-wins on repeated rejections — only the most recent
   * attempt's metadata is retained. */
  last_post_close_drift_at?: string;
  /** Head SHA the rejected `subject_updated` event carried, when the
   * bot had one in the webhook payload (typically present for
   * `synchronize` and `reopened`, absent for plain `closed`).
   * Paired with `last_post_close_drift_at`. */
  last_post_close_drift_head_sha?: string;
}

/**
 * `RoomCore` enriched with its `roomId`. Returned by `listRooms` so
 * callers can correlate core records with sibling keys (events,
 * participants, contributions) without a second lookup. The base
 * `RoomCore` intentionally omits `roomId` (the room hash key is the
 * roomId, so it's redundant on `getRoomCore` — the caller already
 * knows it).
 *
 * Used by `GET /api/rooms` and `GET /api/rooms/watching` so the
 * wire response associates each core with its identifier.
 */
export interface RoomCoreWithId extends RoomCore {
  roomId: string;
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
   * a role even if the actor's bearer is later rotated/revoked.
   *
   * **System-actor exception** (closes #512 guard N5): for
   * cron/watchdog-driven transitions there is no bearer behind the
   * action — the manager loop emits these events on its own tick.
   * Such events use sentinel values (`actor_role="manager"`,
   * `actor_id="watchdog"` for `room_recovered` and watchdog-triggered
   * `participant_timed_out`; `actor_role="system"`, `actor_id="vercel-cron"`
   * for cron-fired TERMINATE on expiry). The "never from body" rule
   * still holds — system sentinels are server-issued, not client-supplied. */
  actor_role: string;
  /** Server-derived: the bearer's `name` field. Same caveat AND same
   * system-actor exception as `actor_role` (see above). */
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
  | "room_terminated"
  // Bot/queen meta-events emitted via POST /api/rooms/{id}/event
  // (D.1.b-ii). They DON'T transition status — the bot uses them
  // to record context for workers (subject changed) or pose
  // targeted questions (V1.1 follow-up).
  | "subject_updated"
  | "queen_question";

/** Materialized RSVP entry per role (latest-state-wins). Stored as
 * JSON in the `:participants` hash, keyed by role.
 *
 * Status lifecycle (per WAR_ROOM_DESIGN.md):
 *   pending  → resolved   (worker submits a contribution)
 *   pending  → withdrew   (worker explicitly withdraws)
 *   pending  → timed_out  (watchdog times out)
 *   withdrew → pending    (re-RSVP after subject_updated event;
 *                          clears withdrew_at_sequence)
 */
export interface RoomParticipant {
  agent_id: string;
  role: string;
  status: "pending" | "resolved" | "withdrew" | "timed_out";
  rsvp_at: string;
  /** Set when status moved to resolved / withdrew / timed_out. */
  resolved_at?: string;
  /** Sequence of the participant_withdrawn event. Set ONLY when
   * status === "withdrew"; cleared on re-RSVP. Used by the
   * server-side watcher filter (`GET /api/rooms/watching`) to
   * re-include the room for that role IFF the room has new events
   * past `withdrew_at_sequence`. */
  withdrew_at_sequence?: number;
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
  // Free-form title for operator-created rooms. 1-200 chars, no
  // C0/C1 control chars (allows letters in any script, punctuation,
  // emoji). React escapes these on render so XSS isn't a concern;
  // the bound is just to keep keys + display predictable.
  general: /^[^\u0000-\u001f\u007f-\u009f]{1,200}$/u,
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

/**
 * Bounds on a queen runner identity (`queenRunner` for
 * `claimSynthesis`, `synthesis_runner` in `RoomDecision`). Closes
 * #512 guard N6 — defense-in-depth boundary check at the route
 * layer so any string that flows through Lua `gsub` sentinel
 * substitution is guaranteed not to collide with the sentinel.
 *
 * The shape covers the common queen identity formats:
 *   `<host>.pid<N>.tick<N>`        — bot-as-queen
 *   `queen-<short-hash>`            — standalone queen (post-V1)
 *   `<owner>/<repo>:<runId>`        — GitHub Actions queen variant
 *
 * Constraints (any one violation rejects):
 *   - 1-128 chars
 *   - Only ASCII alphanumeric, `.`, `-`, `_`, `:`, `/`, `+`
 *   - No literal `__SEQ__` substring (sentinel collision guard)
 *   - No surrounding whitespace
 */
const RUNNER_FORMAT_REGEX = /^[A-Za-z0-9._:/+\-]{1,128}$/;
const SEQ_SENTINEL = "__SEQ__";

export function validateRunnerFormat(runner: string): void {
  if (typeof runner !== "string" || runner.length === 0) {
    throw new RoomRunnerFormatError(String(runner), "must be a non-empty string");
  }
  if (!RUNNER_FORMAT_REGEX.test(runner)) {
    throw new RoomRunnerFormatError(
      runner,
      "must match /^[A-Za-z0-9._:/+\\-]{1,128}$/ (no whitespace, no special chars)",
    );
  }
  if (runner.includes(SEQ_SENTINEL)) {
    throw new RoomRunnerFormatError(
      runner,
      `must not contain the literal "${SEQ_SENTINEL}" sentinel — defense-in-depth against future gsub substitutions`,
    );
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
 *      MOST one room in `awaiting_contributions | deciding` status.
 *      The subject-index key doubles as the lock.
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
 *   - Membership in status:awaiting_contributions set
 *   - Membership in repo index (set)
 *
 * KEYS:
 *   [1] subjectIndexKey         — subject-uniqueness lock
 *   [2] roomKey                 — room hash (data + status fields)
 *   [3] seqKey                  — sequence counter
 *   [4] eventsKey               — event log sorted set
 *   [5] statusSetAwaitingContribsKey — status:awaiting_contributions index
 *   [6] installationIndexKey    — all-rooms-for-installation sorted set
 *   [7] repoIndexKey            — per-repo index
 *
 * ARGV:
 *   [1] roomId                  — for index values + error payload
 *   [2] roomCoreDataJson        — RoomCoreData (everything except status) as JSON
 *   [3] initialStatus           — "awaiting_contributions"
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
    drop_threshold_secs: args.timing?.drop_threshold_secs ?? 1200,
    quiet_period_secs: args.timing?.quiet_period_secs ?? 600,
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

  const result = dispatchScriptResult(
    await args.redis.eval(
      ROOM_OPEN_SCRIPT,
      [
        subjectLockKey(args.installationId, args.subject.type, args.subject.ref, args.roomId),
        roomKey(args.installationId, args.roomId),
        seqKey(args.roomId),
        eventsKey(args.roomId),
        statusIndexKey(args.installationId, "awaiting_contributions"),
        installationIndexKey(args.installationId),
        repoIndexKeyForSubject(args.installationId, args.subject.type, args.subject.ref),
      ],
      [
        args.roomId,
        JSON.stringify(data),
        "awaiting_contributions",
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
  return { ...data, status: "awaiting_contributions" };
}

/** Internal: parse all room-hash fields into a typed RoomCore. Used
 * by both `getRoomCore` and `listRooms` so the multi-field
 * reconstruction logic lives in one place. */
function parseRoomCoreFields(
  fields: Record<string, unknown> | null,
): RoomCore | null {
  if (
    fields === null ||
    fields.data === undefined ||
    fields.status === undefined
  ) {
    return null;
  }
  // Upstash auto-parses JSON when the stored value is a JSON string
  // and the type generic is non-string. Defensive: accept both
  // shapes (raw string from HSET, object after auto-parse).
  const data =
    typeof fields.data === "string"
      ? (JSON.parse(fields.data) as RoomCoreData)
      : (fields.data as RoomCoreData);
  const core: RoomCore = {
    ...data,
    status: fields.status as RoomStatus,
  };
  // Mutable transition fields — each comes back as its own hash
  // field (string for primitives, JSON-string for `decision`).
  if (typeof fields.closed_at === "string") {
    core.closed_at = fields.closed_at;
  }
  if (typeof fields.closed_reason === "string") {
    core.closed_reason = fields.closed_reason as TerminalReason;
  }
  if (
    fields.deciding_through_sequence !== undefined &&
    fields.deciding_through_sequence !== null &&
    fields.deciding_through_sequence !== ""
  ) {
    // HSET stores numbers as strings; coerce on read.
    // Empty string is the design's "cleared" sentinel — RECOVER and
    // CLOSE-drift paths set this field to "" rather than DELing the
    // field (per WAR_ROOM_DESIGN.md L415, L523). JS's `Number("")`
    // is 0, NOT NaN, which would silently misread as "claim active
    // through sequence 0" — closes #511 builder R1.
    const n = Number(fields.deciding_through_sequence);
    if (Number.isFinite(n)) core.deciding_through_sequence = n;
  }
  if (fields.decision !== undefined && fields.decision !== null) {
    core.decision =
      typeof fields.decision === "string"
        ? (JSON.parse(fields.decision) as RoomDecision)
        : (fields.decision as RoomDecision);
  }
  if (typeof fields.last_post_close_drift_at === "string" && fields.last_post_close_drift_at !== "") {
    core.last_post_close_drift_at = fields.last_post_close_drift_at;
  }
  if (typeof fields.last_post_close_drift_head_sha === "string" && fields.last_post_close_drift_head_sha !== "") {
    core.last_post_close_drift_head_sha = fields.last_post_close_drift_head_sha;
  }
  return core;
}

/**
 * Read the room core. Throws `RoomNotFoundError` when the room hash
 * is absent (closed-and-TTL'd, never existed, or installation mismatch).
 *
 * Reconstructs `RoomCore` from the room hash's individual fields:
 * the `data` field (immutable JSON blob) + `status` (mutable string)
 * + optional `closed_at` / `closed_reason` /
 * `deciding_through_sequence` / `decision` set by the transition
 * scripts. See WAR_ROOM_DESIGN.md L303+L346+L457 for the rationale —
 * each transition script HSETs only the fields it changes, never
 * the whole record.
 */
export async function getRoomCore(args: {
  installationId: string;
  roomId: string;
  redis: Redis;
}): Promise<RoomCore> {
  const fields = await args.redis.hgetall<Record<string, unknown>>(
    roomKey(args.installationId, args.roomId),
  );
  const core = parseRoomCoreFields(fields);
  if (core === null) {
    throw new RoomNotFoundError(args.installationId, args.roomId);
  }
  return core;
}

/**
 * Persist a "post-close drift" marker on a room: the bot's webhook
 * handler observed a `subject_updated` rejection (typically
 * `status_precondition_failed` because the room is `closed`/`deciding`)
 * and wants the dashboard to surface that the PR's diff has advanced
 * past what the verdict reviewed.
 *
 * Single-key, two-field HSET — no Lua needed since there's no
 * cross-key invariant. Last-write-wins: a later rejection with a
 * different head SHA overwrites the previous markers, so the badge
 * always reflects the most recent post-close attempt.
 *
 * Caller responsibilities:
 *   - Validate `roomId` shape (we re-validate defensively).
 *   - Pass an ISO 8601 `attemptedAt`. The function does NOT call
 *     `new Date().toISOString()` itself so callers can deterministically
 *     test the wire shape.
 *   - `headSha` is optional — `pull_request.closed` events arrive
 *     without a SHA change; in that case omit the field rather than
 *     persisting a stale value.
 *
 * Closes hivemoot/hivemoot#605 (Option A — dashboard signal). The
 * subsequent merge-gate check (Option C) reads these markers in a
 * follow-up PR.
 */
export async function recordPostCloseDrift(args: {
  installationId: string;
  roomId: string;
  attemptedAt: string;
  headSha?: string;
  redis: Redis;
}): Promise<void> {
  validateRoomId(args.roomId);
  // Always HSET both fields — the SHA + timestamp are semantically
  // paired (the SHA explains WHICH head was rejected at the timestamp),
  // so we MUST clear a stale SHA when a later attempt arrives without
  // one (e.g. the first rejection carries `synchronize` + headSha,
  // the next is a `closed` event with no SHA). Write `""` for the
  // missing case rather than DELing the field — mirrors the
  // empty-string sentinel pattern used for `deciding_through_sequence`
  // in RECOVER / CLOSE-drift paths (WAR_ROOM_DESIGN.md L415, L523).
  // The reader (`parseRoomCoreFields`) treats `""` as absent.
  const fields: Record<string, string> = {
    last_post_close_drift_at: args.attemptedAt,
    last_post_close_drift_head_sha:
      args.headSha !== undefined && args.headSha !== "" ? args.headSha : "",
  };
  await args.redis.hset(
    roomKey(args.installationId, args.roomId),
    fields,
  );
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
}): Promise<RoomCoreWithId[]> {
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
      args.redis.hgetall<Record<string, unknown>>(
        roomKey(args.installationId, id),
      ),
    ),
  );

  const out: RoomCoreWithId[] = [];
  const orphans: string[] = [];
  for (let i = 0; i < fanout.length; i++) {
    const core = parseRoomCoreFields(fanout[i]);
    if (core === null) {
      orphans.push(roomIds[i]);
      continue;
    }
    // Attach roomId so callers can correlate with sibling keys
    // (participants, events, contributions) without a second
    // round-trip. /watching uses this for its enriched response.
    out.push({ ...core, roomId: roomIds[i] });
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

/**
 * Synthesis claim TTL in seconds. Per WAR_ROOM_DESIGN.md
 * §"Storage layout" claim row: **6 minutes — intentionally 1 minute
 * ABOVE Vercel Pro's `maxDuration` of 5 minutes** (closes guard R3
 * N7 recovery-vs-synthesis double-post race).
 *
 * The +1m buffer means a queen runner that's still mid-synthesis
 * when its serverless function's 5-minute maxDuration kills it
 * will have already had its claim TTL refreshed (or be on a fresh
 * tick). Recovery scripts only fire when the claim has GENUINELY
 * expired, so a stale recovery can't race a still-active queen
 * runner that hasn't quite finished posting `/close`.
 */
export const SYNTHESIS_CLAIM_TTL_SECS = 360;

/** Contribution body bounds per WAR_ROOM_DESIGN.md L1166-1188. */
export const CONTRIBUTION_SUMMARY_MAX_CHARS = 500;
export const CONTRIBUTION_FINDING_AREA_MAX_CHARS = 80;
export const CONTRIBUTION_FINDING_DETAIL_MAX_CHARS = 2000;
export const CONTRIBUTION_FINDINGS_MAX_COUNT = 20;

// ---------------------------------------------------------------------------
// ContributionBody schema (D.1.a-ii)
// ---------------------------------------------------------------------------

/**
 * Verdict enum for contribution bodies. UPPERCASE per
 * WAR_ROOM_DESIGN.md §"silent downgrade trap" — the synthesis path
 * applies a structural DOWNGRADE-only invariant and must reject
 * malformed/typo'd verdicts at the boundary rather than silently
 * defaulting to COMMENT.
 */
export type ContributionVerdict =
  | "APPROVE"
  | "COMMENT"
  | "CONCERNS"
  | "REQUEST_CHANGES";

const CONTRIBUTION_VERDICTS: ReadonlySet<string> = new Set([
  "APPROVE",
  "COMMENT",
  "CONCERNS",
  "REQUEST_CHANGES",
]);

export type ContributionFindingSeverity = "blocker" | "warning" | "info";

const FINDING_SEVERITIES: ReadonlySet<string> = new Set([
  "blocker",
  "warning",
  "info",
]);

export interface ContributionFinding {
  /** 1-80 chars. Open-ended free text; the synthesis prompt treats
   * this as untrusted user-supplied content. */
  area: string;
  severity: ContributionFindingSeverity;
  /** 1-2000 chars (subject to G2 raw_text cap). */
  detail: string;
  /** Optional file:line reference for IDE / dashboard navigation. */
  code_ref?: string;
}

/**
 * Structured contribution body. All fields optional — agents may
 * submit free-form `raw_md` only and let the queen LLM-derive the
 * verdict from the contribution prose. When a structured `verdict`
 * IS provided, the §S2 floor still uses it; when absent, the queen
 * falls back to LLM-as-judge (defended by forced structured tool-call
 * output, not free LLM prose). Validated at submit time via
 * `validateContributionBody` — violations throw
 * `ContributionValidationError` BEFORE any storage write.
 */
export interface ContributionBody {
  /** When present, drives the structural §S2 floor. When absent,
   * queen synthesis falls back to LLM-derived verdict from `raw_md`. */
  verdict?: ContributionVerdict;
  /** 1-500 chars when present. Optional — `raw_md` is the canonical
   * narrative when no structured summary is provided. */
  summary?: string;
  /** ≤20 items. */
  findings?: ContributionFinding[];
  severity_counts?: {
    blocker?: number;
    warning?: number;
    info?: number;
  };
}

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
 * `RoomDecision.content` exceeded the 64 KiB UTF-8 byte budget.
 *
 * Closes #519 guard N1 — the prior `closeRoomWithDecision`
 * implementation threw a plain `Error` with a free-text message
 * that the route layer had to regex-match (`/exceeds 64 KiB/`),
 * making the mapping silently break on any copy-edit of the
 * message string. Sibling-typed pattern restored: `RoomEventBodyTooLargeError`,
 * `RoomContributionTooLargeError`, and now this one all carry
 * `sizeBytes` for caller logs.
 */
export class RoomDecisionTooLargeError extends Error {
  public readonly sizeBytes: number;
  constructor(sizeBytes: number) {
    super(
      `RoomDecision.content exceeds 64 KiB (got ${sizeBytes} bytes). Reduce body before close — large synthesis output should reference an external gist/issue.`,
    );
    this.name = "RoomDecisionTooLargeError";
    this.sizeBytes = sizeBytes;
  }
}

/**
 * Thrown when `ROOM_DECIDE_CLAIM_SCRIPT` finds the synthesis claim
 * already held by another queen runner (benign conflict — the
 * caller should skip this tick and re-attempt on the next manager
 * loop cycle, OR observe the holder via `heldByRunner`).
 *
 * Per WAR_ROOM_DESIGN.md the claim TTL is 6 minutes (1 minute above
 * Vercel Pro's 5-minute maxDuration cap), so a true crash recovery
 * is bounded — `recoverDeciding` runs against rooms whose claims
 * have actually expired.
 */
export class RoomClaimAlreadyHeldError extends Error {
  public readonly roomId: string;
  public readonly heldByRunner: string;
  public readonly throughSequence: number;
  constructor(
    roomId: string,
    heldByRunner: string,
    throughSequence: number,
  ) {
    super(
      `Synthesis claim for room ${roomId} is already held by ${JSON.stringify(heldByRunner)} through sequence ${throughSequence}. Skip this tick; the claim TTL will release on crash.`,
    );
    this.name = "RoomClaimAlreadyHeldError";
    this.roomId = roomId;
    this.heldByRunner = heldByRunner;
    this.throughSequence = throughSequence;
  }
}

/**
 * Thrown when a status-changing transition (claim, recover) is
 * called on a room whose current status doesn't match the action's
 * allowed-from list.
 *
 * For `claimSynthesis`: room must be in `awaiting_contributions`.
 * For `recoverDeciding`: room must be in `deciding`. (Other status
 * transitions — TERMINATE, CLOSE — land in D.1.a-iii.c with their
 * own allowed-from lists.)
 */
export class RoomTransitionInvalidStatusError extends Error {
  public readonly roomId: string;
  public readonly action: string;
  public readonly expectedStatuses: RoomStatus[];
  public readonly actualStatus: string;
  constructor(
    roomId: string,
    action: string,
    expectedStatuses: RoomStatus[],
    actualStatus: string,
  ) {
    super(
      `Room ${roomId} is in status ${JSON.stringify(actualStatus)}; ${action} requires one of [${expectedStatuses.map((s) => JSON.stringify(s)).join(", ")}].`,
    );
    this.name = "RoomTransitionInvalidStatusError";
    this.roomId = roomId;
    this.action = action;
    this.expectedStatuses = expectedStatuses;
    this.actualStatus = actualStatus;
  }
}

/**
 * Thrown when a Lua script's `cjson.decode` fails on a stored claim
 * payload (corrupted/partial-write/manual ops intervention). Closes
 * #512 guard N2: even the defensive `already_claimed` branch shouldn't
 * panic on payload corruption — the script returns `{-3, "decode_error"}`
 * and the caller surfaces this typed error so an operator can DEL the
 * claim key out-of-band.
 */
export class RoomClaimPayloadCorruptError extends Error {
  public readonly roomId: string;
  constructor(roomId: string) {
    super(
      `Claim payload for room ${roomId} could not be decoded — likely partial write or manual intervention. DEL the claim key out-of-band and re-attempt synthesis on the next manager tick.`,
    );
    this.name = "RoomClaimPayloadCorruptError";
    this.roomId = roomId;
  }
}

/**
 * Thrown by `terminateRoom` when the room is already in `closed`
 * status (operator double-tap or watchdog race after a queen close).
 * Carries the actual status so the caller can distinguish "already
 * terminal" (benign) from "wrong status" (programming error).
 *
 * Per design L443 — TERMINATE returns `{-1, currentStatus}` only on
 * `closed`; any non-closed status proceeds with termination.
 */
export class RoomAlreadyClosedError extends Error {
  public readonly roomId: string;
  public readonly status: RoomStatus;
  constructor(roomId: string, status: RoomStatus) {
    super(
      `Room ${roomId} is already in status ${JSON.stringify(status)}; terminate is a no-op.`,
    );
    this.name = "RoomAlreadyClosedError";
    this.roomId = roomId;
    this.status = status;
  }
}

/**
 * Thrown by `closeRoomWithDecision` when the synthesis claim has
 * been DELed out from under the queen runner — typically by an
 * `force_close` TERMINATE racing the queen's `/close`. The queen
 * MUST abort the GitHub posting and let the operator's force-close
 * stand (per design L508).
 */
export class RoomCloseClaimLostError extends Error {
  public readonly roomId: string;
  constructor(roomId: string) {
    super(
      `Synthesis claim for room ${roomId} was deleted before close completed (likely a force-close TERMINATE). Abort the GitHub post and surface the terminal state to the operator.`,
    );
    this.name = "RoomCloseClaimLostError";
    this.roomId = roomId;
  }
}

/**
 * Thrown by `closeRoomWithDecision` when the claim record's stored
 * `throughSequence` doesn't match the caller's `expectedThroughSequence`.
 * Indicates a different runner re-claimed the room since this caller
 * acquired the claim — should never happen in normal flow (claim TTL
 * + atomic acquisition prevents it) but the script defends against
 * partial-write desync.
 */
export class RoomCloseClaimThroughSeqMismatchError extends Error {
  public readonly roomId: string;
  public readonly expectedThroughSequence: number;
  public readonly actualThroughSequence: number;
  constructor(
    roomId: string,
    expectedThroughSequence: number,
    actualThroughSequence: number,
  ) {
    super(
      `Claim throughSequence mismatch for room ${roomId}: expected ${expectedThroughSequence}, got ${actualThroughSequence}. Another runner re-claimed mid-flight; abort and re-claim.`,
    );
    this.name = "RoomCloseClaimThroughSeqMismatchError";
    this.roomId = roomId;
    this.expectedThroughSequence = expectedThroughSequence;
    this.actualThroughSequence = actualThroughSequence;
  }
}

/**
 * Thrown by `closeRoomWithDecision` when new events arrived between
 * claim acquisition and close attempt — the script atomically reverts
 * status to `awaiting_contributions` AND DELs the claim, so the queen
 * runner aborts its GitHub post and the manager loop re-claims on the
 * next tick (closes design L506-528: drift signal triggers
 * synthesize-retry, not a hard error).
 *
 * The `lastSeq` field carries the live sequence at the close attempt
 * — useful for caller logs ("synthesized through 7, but 9 events landed").
 */
export class RoomCloseDriftError extends Error {
  public readonly roomId: string;
  public readonly expectedThroughSequence: number;
  public readonly lastSeq: number;
  constructor(
    roomId: string,
    expectedThroughSequence: number,
    lastSeq: number,
  ) {
    super(
      `Sequence drift on room ${roomId}: synthesized through ${expectedThroughSequence}, but ${lastSeq - expectedThroughSequence} new event(s) landed during synthesis. Status reverted to awaiting_contributions; re-claim on next manager tick.`,
    );
    this.name = "RoomCloseDriftError";
    this.roomId = roomId;
    this.expectedThroughSequence = expectedThroughSequence;
    this.lastSeq = lastSeq;
  }
}

/**
 * Thrown when a runner identity (`queenRunner` or
 * `RoomDecision.synthesis_runner`) fails the boundary format check.
 * Closes #512 guard N6: any string that flows through Lua `gsub`
 * sentinel substitution must be guaranteed not to collide with the
 * sentinel literal. Even though the claim script doesn't `gsub` the
 * runner string today, validating at the boundary is the
 * defense-in-depth pattern from #510 R2 N2.
 */
export class RoomRunnerFormatError extends Error {
  public readonly invalidRunner: string;
  constructor(invalidRunner: string, reason: string) {
    super(
      `Runner identity ${JSON.stringify(invalidRunner)} failed format validation: ${reason}.`,
    );
    this.name = "RoomRunnerFormatError";
    this.invalidRunner = invalidRunner;
  }
}

/**
 * Thrown when a participant transition's source state is illegal.
 *
 * Closes #510 builder R3: the manager loop's contract (per
 * WAR_ROOM_DESIGN.md L1055) is that timeouts only fire on
 * `pending` participants, and synthesis runs once no participants
 * are pending. Without a state gate, a stale watchdog scan that
 * read `pending` could race a worker's resolve and overwrite a
 * `resolved` slot to `timed_out`, corrupting the synthesis trigger.
 *
 * Each transition wrapper passes its allowed source states:
 *   - submitContribution:  pending | resolved   (re-submit allowed)
 *   - withdrawParticipant: pending | resolved   (withdraw a stale RSVP)
 *   - withdrawContribution: resolved             (only resolved has a contribution to withdraw)
 *   - timeoutParticipant:  pending               (per design L1055)
 *
 * The script checks `existingP.status` BEFORE the INCR + ZADD and
 * returns -6 → this error if the source state isn't allowed.
 */
export class RoomParticipantStatePreconditionError extends Error {
  public readonly roomId: string;
  public readonly role: string;
  public readonly allowedStates: string[];
  public readonly actualState: string;
  constructor(
    roomId: string,
    role: string,
    allowedStates: string[],
    actualState: string,
  ) {
    super(
      `Participant ${JSON.stringify(role)} in room ${roomId} is in state ${JSON.stringify(actualState)}; this transition requires one of [${allowedStates.map((s) => JSON.stringify(s)).join(", ")}]. Re-read state and retry if appropriate.`,
    );
    this.name = "RoomParticipantStatePreconditionError";
    this.roomId = roomId;
    this.role = role;
    this.allowedStates = allowedStates;
    this.actualState = actualState;
  }
}

/**
 * Thrown when withdraw / contribute / withdraw_contribution / timeout
 * is called but the participant slot doesn't exist. Per
 * WAR_ROOM_DESIGN.md L746, `/present` is required before
 * `/contribute` (and similarly for the other transition paths).
 *
 * Closes #510 builder R2 #2: the prior implementation let
 * withdraw / contribute / withdraw_contribution proceed even with
 * a missing participant slot, creating phantom materialized state
 * that the manager loop's RSVP-records logic couldn't reason over.
 * The new `ROOM_PARTICIPANT_TRANSITION_SCRIPT` rejects at the
 * boundary with -5 → this error.
 */
export class RoomParticipantNotFoundError extends Error {
  public readonly roomId: string;
  public readonly role: string;
  constructor(roomId: string, role: string) {
    super(
      `Participant slot ${JSON.stringify(role)} not found in room ${roomId} — caller must /present before this action.`,
    );
    this.name = "RoomParticipantNotFoundError";
    this.roomId = roomId;
    this.role = role;
  }
}

/**
 * Thrown when a write hits the per-(room, role) first-wins gate —
 * a different agent has already claimed this role in the room and
 * the slot is not in the `withdrew` state (which would allow re-RSVP).
 *
 * Closes #510 builder R1 #2: previous unconditional HSET let a
 * second runner overwrite the first runner's RSVP. The script now
 * cjson.decodes the existing slot and rejects with -4 when the
 * agent_id mismatches AND the slot isn't withdrew.
 *
 * Per WAR_ROOM_DESIGN.md §`agent_id semantics`: subscriber-mode
 * fleets where multiple runners share one token still get distinct
 * agent_ids; the per-(room, role) gate ensures only one of them
 * wins the RSVP — others get this error and skip dispatch.
 */
export class RoomParticipantOwnerConflictError extends Error {
  public readonly roomId: string;
  public readonly role: string;
  public readonly existingAgentId: string;
  public readonly attemptedAgentId: string;
  constructor(
    roomId: string,
    role: string,
    existingAgentId: string,
    attemptedAgentId: string,
  ) {
    super(
      `Per-(room=${roomId}, role=${role}) first-wins gate: role is already claimed by agent ${existingAgentId}; attempted by ${attemptedAgentId}. Skip and re-poll on the next watcher tick.`,
    );
    this.name = "RoomParticipantOwnerConflictError";
    this.roomId = roomId;
    this.role = role;
    this.existingAgentId = existingAgentId;
    this.attemptedAgentId = attemptedAgentId;
  }
}

/**
 * Thrown when a contribution body fails schema validation at the
 * boundary. Carries the offending field name + reason so the route
 * layer can surface a structured 400 with per-field error codes
 * (`MISSING_VERDICT`, `INVALID_VERDICT`, `SUMMARY_TOO_LONG`, etc.
 * per WAR_ROOM_DESIGN.md L1187).
 */
export class ContributionValidationError extends Error {
  public readonly field: string;
  public readonly value: unknown;
  constructor(field: string, value: unknown, expected: string) {
    super(
      `Invalid contribution body field ${JSON.stringify(field)} = ${JSON.stringify(value)}: expected ${expected}.`,
    );
    this.name = "ContributionValidationError";
    this.field = field;
    this.value = value;
  }
}

/**
 * Validate a `ContributionBody` against the design's bounded-field
 * schema. Throws `ContributionValidationError` on any violation.
 * Pure function — no storage side effects.
 *
 * Closes #510 builder R1 #4: previously `submitContribution`
 * accepted arbitrary `Record<string, unknown>` and tests landed
 * lowercase verdicts like `"approve"`. Validating at the boundary
 * means malformed bodies cannot land in Redis before queen
 * synthesis ever sees them.
 */
export function validateContributionBody(body: ContributionBody): void {
  // verdict is optional — when present, must be a valid enum.
  // When absent, queen synthesis derives verdict from `raw_md` via
  // forced structured LLM tool-call output (PR 3).
  if (body.verdict !== undefined) {
    if (typeof body.verdict !== "string" || !CONTRIBUTION_VERDICTS.has(body.verdict)) {
      throw new ContributionValidationError(
        "verdict",
        body.verdict,
        "one of APPROVE | COMMENT | CONCERNS | REQUEST_CHANGES (UPPERCASE), or omitted",
      );
    }
  }
  // summary is optional — when present, must be a bounded string.
  // When absent, the contribution's signal is its `raw_md`.
  if (body.summary !== undefined) {
    if (typeof body.summary !== "string") {
      throw new ContributionValidationError(
        "summary",
        body.summary,
        "string (1-500 chars) or omitted",
      );
    }
    if (body.summary.length < 1 || body.summary.length > CONTRIBUTION_SUMMARY_MAX_CHARS) {
      throw new ContributionValidationError(
        "summary",
        body.summary,
        `string of 1-${CONTRIBUTION_SUMMARY_MAX_CHARS} chars (got ${body.summary.length})`,
      );
    }
  }
  if (body.findings !== undefined) {
    if (!Array.isArray(body.findings)) {
      throw new ContributionValidationError(
        "findings",
        body.findings,
        `array of ≤${CONTRIBUTION_FINDINGS_MAX_COUNT} ContributionFinding objects`,
      );
    }
    if (body.findings.length > CONTRIBUTION_FINDINGS_MAX_COUNT) {
      throw new ContributionValidationError(
        "findings",
        body.findings,
        `array of ≤${CONTRIBUTION_FINDINGS_MAX_COUNT} items (got ${body.findings.length})`,
      );
    }
    for (let i = 0; i < body.findings.length; i++) {
      const f = body.findings[i];
      if (typeof f !== "object" || f === null) {
        throw new ContributionValidationError(
          `findings[${i}]`,
          f,
          "ContributionFinding object",
        );
      }
      if (
        typeof f.area !== "string" ||
        f.area.length < 1 ||
        f.area.length > CONTRIBUTION_FINDING_AREA_MAX_CHARS
      ) {
        throw new ContributionValidationError(
          `findings[${i}].area`,
          f.area,
          `string of 1-${CONTRIBUTION_FINDING_AREA_MAX_CHARS} chars`,
        );
      }
      if (typeof f.severity !== "string" || !FINDING_SEVERITIES.has(f.severity)) {
        throw new ContributionValidationError(
          `findings[${i}].severity`,
          f.severity,
          "one of blocker | warning | info",
        );
      }
      if (
        typeof f.detail !== "string" ||
        f.detail.length < 1 ||
        f.detail.length > CONTRIBUTION_FINDING_DETAIL_MAX_CHARS
      ) {
        throw new ContributionValidationError(
          `findings[${i}].detail`,
          f.detail,
          `string of 1-${CONTRIBUTION_FINDING_DETAIL_MAX_CHARS} chars`,
        );
      }
      if (f.code_ref !== undefined && typeof f.code_ref !== "string") {
        throw new ContributionValidationError(
          `findings[${i}].code_ref`,
          f.code_ref,
          "optional string",
        );
      }
    }
  }
  if (body.severity_counts !== undefined) {
    if (typeof body.severity_counts !== "object" || body.severity_counts === null) {
      throw new ContributionValidationError(
        "severity_counts",
        body.severity_counts,
        "optional object with blocker/warning/info numeric fields",
      );
    }
    for (const k of ["blocker", "warning", "info"] as const) {
      const v = body.severity_counts[k];
      if (v !== undefined && (typeof v !== "number" || v < 0 || !Number.isFinite(v))) {
        throw new ContributionValidationError(
          `severity_counts.${k}`,
          v,
          "non-negative finite number",
        );
      }
    }
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
 * tuple of (roomId, role, action, agentId, sequenceObservedByClient);
 * SHA-256 keeps the key opaque + bounded-length while making
 * collisions cryptographically negligible.
 *
 * `sequenceObservedByClient` is the `If-Room-Sequence-At-Or-After`
 * header value the client read when constructing the request. Two
 * retries from the same client see the same observed sequence + same
 * agentId and thus derive the same key — that's the desired behavior
 * for the replay-detection path.
 *
 * **Per-runner idempotency** (#522 / G5 — closes builder R2):
 * `agentId` is included so two runners sharing a bearer (subscriber-
 * mode) AND observing the same sequence DON'T collide on the idem
 * key. Without this, runner A wins the idem write, then runner B
 * gets RoomEventIdempotencyReplayError (which the route maps to 200
 * `replay: true`) — runner B believes its RSVP succeeded but it's
 * actually runner A's slot. The owner check that should reject B
 * runs AFTER the idem check in the script, so it never fires. Adding
 * agentId to the key forces B's request to go through the script's
 * owner check, where it correctly gets 409 owner_conflict.
 *
 * `agentId` is optional in the function signature for back-compat
 * with non-RSVP actions (decide, close, subject_updated, etc.) that
 * don't have a per-runner identity. RSVP actions (present, withdraw,
 * contribute) MUST pass it.
 */
export function deriveIdempotencyKey(args: {
  roomId: string;
  role: string;
  action: RoomEventAction;
  sequenceObservedByClient: number;
  /** Per-runner identity for subscriber-mode idem-lane separation
   * (#522). Omit for non-RSVP actions where there's no per-runner
   * concept. */
  agentId?: string;
}): string {
  // Bump to v2 when agentId is supplied so the per-runner idem
  // namespace is explicitly distinct from any v1 keys still in flight
  // during a deploy. v1 keys expire via TTL within the room's
  // max_age_secs, so no migration needed; the bump just makes the
  // change visible in keyspace if an operator inspects Redis.
  const prefix = args.agentId !== undefined ? "v2" : "v1";
  const agentSegment = args.agentId !== undefined ? `:${args.agentId}` : "";
  return createHash("sha256")
    .update(
      `${prefix}:${args.roomId}:${args.role}:${args.action}${agentSegment}:${args.sequenceObservedByClient}`,
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
  | "close"
  // Bot meta-event idempotency lanes (D.1.b-ii). Caller derives
  // a key per (room, role, action, observed-sequence); same shape
  // as the worker actions above.
  | "subject_updated"
  | "queen_question";

// ---------------------------------------------------------------------------
// ROOM_APPEND_EVENT_SCRIPT — atomic event append
// ---------------------------------------------------------------------------

/**
 * Atomic event append. Single EVAL handles idempotency, room-
 * existence + status preconditions, per-(role) owner check, the
 * event log ZADD, two optional materialized-view writes, and an
 * optional status transition.
 *
 * Design references:
 *   - WAR_ROOM_DESIGN.md L320-380 — original script (extended here
 *     for the closures below)
 *   - WAR_ROOM_DESIGN.md L139-216 — RSVP-driven lifecycle
 *
 * Closures (R2 fixes for #510 R1 review):
 *   - **Builder B1 / Guard N1**: `room must exist` is now an
 *     unconditional check. HGET status returns nil for a missing
 *     room hash → `{-3, "room_not_found"}`. Soft events (RSVPs,
 *     contributions) can no longer create orphan `:seq`/`:events`
 *     keys against a typo'd roomId.
 *   - **Builder B2**: `per-(room, role) first-wins gate` via
 *     cjson.decode of the participants slot. If existing.agent_id
 *     differs from ARGV[5] AND existing.status != "withdrew", the
 *     script returns `{-4, "owner_conflict", existingAgentId}`.
 *     Re-RSVP from `withdrew` is allowed (status flips back to
 *     pending; new agent_id may differ from prior).
 *   - **Builder B3**: dual-materialized writes via KEYS[8]/9 +
 *     ARGV[12]/13 so `submitContribution` can update BOTH the
 *     contribution slot AND the participant's status to "resolved"
 *     atomically (prevents race where queen sees contribution
 *     before participant resolution).
 *   - **Guard B1**: `__SEQ__` gsub is capped at FIRST match so
 *     user-controlled body content containing the literal sentinel
 *     is preserved. The TS template has exactly one unquoted
 *     `__SEQ__` (the seq field); user content is JSON-stringified
 *     and surrounded by quotes — first-match gets the seq slot
 *     deterministically. Materialized JSON gsub also capped.
 *
 * Order of operations (single EVAL):
 *   1. Idempotency check: if `idempotencyKey` is set and
 *      `:idem:{key}` exists → `{-1, existingSequence}`.
 *   2. Room existence: HGET roomKey "status"; nil → `{-3,
 *      "room_not_found"}`. Always runs (even for "soft" events).
 *   3. Allowed-status gate: if `allowedStatuses` is non-empty,
 *      currStatus must be in that comma-separated list →
 *      `{-2, currStatus}` on mismatch.
 *   4. Owner check (per-role first-wins): if `ownerCheckRole` is
 *      set, HGET ownerCheckKey ownerCheckRole; if existing has a
 *      different agent_id AND status != "withdrew", returns
 *      `{-4, "owner_conflict", existingAgentId}`.
 *   5. INCR `:seq`.
 *   6. ZADD event JSON (gsub `__SEQ__` → seq, FIRST MATCH only).
 *   7. SET idem reverse-index with parameterized TTL.
 *   8. HSET materialized 1 (with `__SEQ__` substitution, first-match).
 *   9. HSET materialized 2 (same, for dual-update on submit).
 *   10. Status transition: HSET status, SREM/SADD set membership.
 *
 * KEYS:
 *   [1] seqKey
 *   [2] eventsKey
 *   [3] idemKey
 *   [4] roomKey
 *   [5] ownerCheckKey         — typically participantsKey for
 *                               first-wins enforcement; "__unused__"
 *                               disables (paired with empty ARGV[4])
 *   [6] materializedKey1
 *   [7] statusFromSetKey
 *   [8] statusToSetKey
 *   [9] materializedKey2      — for dual-update on submitContribution;
 *                               "__unused__" disables (paired with
 *                               empty ARGV[12])
 *
 * ARGV:
 *   [1]  eventJsonTemplate      — JSON with `"__SEQ__"` placeholder
 *   [2]  idempotencyKey         — empty disables idem check
 *   [3]  eventType              — diagnostic
 *   [4]  ownerCheckRole         — hash field name to read on KEYS[5]
 *                                  (typically the role); empty disables
 *   [5]  ownerExpected          — agent_id that must own the slot
 *   [6]  materializedFieldName1 — empty disables materialized 1
 *   [7]  materializedFieldJson1 — value (with optional `__SEQ__`)
 *   [8]  allowedStatuses        — comma-separated; empty = any
 *   [9]  statusTo               — empty disables status transition
 *   [10] roomId                 — for set membership updates
 *   [11] idemTtlSecs            — TTL for idem reverse-index
 *   [12] materializedFieldName2 — empty disables materialized 2
 *   [13] materializedFieldJson2 — value (with optional `__SEQ__`)
 *
 * Returns:
 *   {seq}                                   success
 *   {-1, existingSequence}                  idempotency replay
 *   {-2, currentRoomStatus}                 allowed-status mismatch
 *   {-3, "room_not_found"}                  roomKey hash missing
 *   {-4, "owner_conflict", existingAgentId} per-role first-wins gate
 */
export const ROOM_APPEND_EVENT_SCRIPT = `
if ARGV[2] ~= "" then
  local existing = redis.call("get", KEYS[3])
  if existing then return {-1, tonumber(existing)} end
end
local currStatus = redis.call("hget", KEYS[4], "status")
if not currStatus then return {-3, "room_not_found"} end
if ARGV[8] ~= "" then
  local found = false
  for s in string.gmatch(ARGV[8], "[^,]+") do
    if s == currStatus then found = true; break end
  end
  if not found then return {-2, currStatus} end
end
if ARGV[4] ~= "" then
  local existingMat = redis.call("hget", KEYS[5], ARGV[4])
  if existingMat then
    local parsed = cjson.decode(existingMat)
    if parsed.agent_id ~= ARGV[5] and parsed.status ~= "withdrew" then
      return {-4, "owner_conflict", parsed.agent_id}
    end
  end
end
local seq = redis.call("incr", KEYS[1])
local eventJson = string.gsub(ARGV[1], "__SEQ__", tostring(seq), 1)
redis.call("zadd", KEYS[2], seq, eventJson)
if ARGV[2] ~= "" then
  redis.call("set", KEYS[3], tostring(seq), "EX", tonumber(ARGV[11]))
end
if ARGV[6] ~= "" then
  local mat1 = ARGV[7]
  -- Opt-in seq substitution. Off-by-default so user-controlled
  -- materialized content (e.g. contribution bodies whose summary
  -- contains the literal "__SEQ__") cannot be silently rewritten.
  -- Caller sets ARGV[14]="1" for the withdraw-participant path
  -- where withdrew_at_sequence MUST be the actual sequence number.
  if ARGV[14] == "1" then
    mat1 = string.gsub(mat1, "__SEQ__", tostring(seq), 1)
  end
  redis.call("hset", KEYS[6], ARGV[6], mat1)
end
if ARGV[12] ~= "" then
  local mat2 = ARGV[13]
  if ARGV[15] == "1" then
    mat2 = string.gsub(mat2, "__SEQ__", tostring(seq), 1)
  end
  redis.call("hset", KEYS[9], ARGV[12], mat2)
end
if ARGV[9] ~= "" then
  redis.call("hset", KEYS[4], "status", ARGV[9])
  redis.call("srem", KEYS[7], ARGV[10])
  redis.call("sadd", KEYS[8], ARGV[10])
end
return {seq}
`;

/**
 * Atomic participant-state transition. Used by withdraw / contribute /
 * withdraw_contribution / timeout — actions that REQUIRE an existing
 * participant slot and need to atomically transform its status while
 * preserving fields like `agent_id` and `rsvp_at`.
 *
 * Closes #510 builder R2 #2: the prior generic `ROOM_APPEND_EVENT_SCRIPT`
 * let these actions proceed with a missing slot, and `submitContribution`
 * synthesized a fresh participant with `rsvp_at = now`, which would
 * corrupt the manager-loop's quiet-period calculation. This script
 * cjson-decodes the existing slot, applies an action-specific
 * transformation in-place, and HSETs back. `agent_id` + `rsvp_at`
 * are always preserved across `resolve` / `withdraw` / `timeout`.
 *
 * Post-#510 / heartbeat-model revision: `submitContribution` now
 * uses this script with `allowedRoomStatuses = ["awaiting_contributions"]`
 * — there is only one open status in the heartbeat model. Workers
 * RSVP'd via `presentParticipant` and then submit; or, in the
 * heartbeat path, heartbeat then submit. Both paths land here.
 *
 * Order of operations:
 *   1. Idempotency check (replay-safe)
 *   2. Room exists + room status in allowed list
 *   3. Read participant slot — MUST exist (-5 if missing)
 *   4. Owner check (when ARGV[5]="1") — agent_id must match
 *      ARGV[6], OR existing.status == "withdrew" (re-RSVP allowed)
 *   5. INCR seq, ZADD event (first-match `__SEQ__` gsub), SET idem
 *   6. Apply participant transformation in-place:
 *        - "resolve":  status="resolved", resolved_at=now, clear withdrew_at_sequence
 *        - "withdraw": status="withdrew", resolved_at=now, withdrew_at_sequence=seq
 *        - "timeout":  status="timed_out", resolved_at=now
 *        - "noop":     leave participant unchanged (used for withdraw_contribution)
 *      `agent_id`, `role`, `rsvp_at` always preserved.
 *   7. Optional contribution slot HSET (used by submitContribution
 *      + withdrawContribution)
 *
 * KEYS:
 *   [1] seqKey
 *   [2] eventsKey
 *   [3] idemKey
 *   [4] roomKey
 *   [5] participantsKey
 *   [6] contributionsKey      (used when ARGV[12] != "")
 *
 * ARGV:
 *   [1]  eventJsonTemplate    — JSON with first-match `__SEQ__` placeholder
 *   [2]  idempotencyKey       — empty disables idem check
 *   [3]  eventType            — diagnostic
 *   [4]  role                 — participants hash field key
 *   [5]  ownerRequired        — "1" enforces agent_id match; "" disables (watchdog)
 *   [6]  ownerExpected        — agent_id (used only if ownerRequired)
 *   [7]  allowedRoomStatuses  — comma-separated; empty = any
 *   [8]  roomId               — for diagnostic / future status set ops
 *   [9]  idemTtlSecs          — TTL for idem reverse-index
 *   [10] participantTransform — "resolve" | "withdraw" | "timeout" | "noop"
 *   [11] nowIso               — for resolved_at field
 *   [12] contributionFieldJson — empty = don't write contribution slot
 *   [13] allowedParticipantStatuses — comma-separated list of allowed
 *                                     source states for the participant
 *                                     slot; empty = any. Closes #510
 *                                     builder R3.
 *
 * Returns:
 *   {seq}                                   success
 *   {-1, existingSequence}                  idempotency replay
 *   {-2, currentRoomStatus}                 allowed-status mismatch
 *   {-3, "room_not_found"}                  room hash missing
 *   {-4, "owner_conflict", existingAgentId} per-role owner mismatch
 *   {-5, "no_participant"}                  participant slot missing
 *   {-6, "participant_state_precondition", currentParticipantStatus}
 *                                           participant status not in allowed list
 */
export const ROOM_PARTICIPANT_TRANSITION_SCRIPT = `
if ARGV[2] ~= "" then
  local existing = redis.call("get", KEYS[3])
  if existing then return {-1, tonumber(existing)} end
end
local currStatus = redis.call("hget", KEYS[4], "status")
if not currStatus then return {-3, "room_not_found"} end
if ARGV[7] ~= "" then
  local found = false
  for s in string.gmatch(ARGV[7], "[^,]+") do
    if s == currStatus then found = true; break end
  end
  if not found then return {-2, currStatus} end
end
local existingP = redis.call("hget", KEYS[5], ARGV[4])
if not existingP then return {-5, "no_participant"} end
local p = cjson.decode(existingP)
if ARGV[5] == "1" and p.agent_id ~= ARGV[6] then
  return {-4, "owner_conflict", p.agent_id}
end
-- Participant-state precondition (closes #510 builder R3): each
-- transition is gated on the participant's current status so a
-- stale watchdog scan can't run timeout against an already-resolved
-- slot, and submitContribution can't reach into withdrew/timed_out
-- slots without a fresh /present.
if ARGV[13] ~= "" then
  local found = false
  for s in string.gmatch(ARGV[13], "[^,]+") do
    if s == p.status then found = true; break end
  end
  if not found then
    return {-6, "participant_state_precondition", p.status}
  end
end
local seq = redis.call("incr", KEYS[1])
local eventJson = string.gsub(ARGV[1], "__SEQ__", tostring(seq), 1)
redis.call("zadd", KEYS[2], seq, eventJson)
if ARGV[2] ~= "" then
  redis.call("set", KEYS[3], tostring(seq), "EX", tonumber(ARGV[9]))
end
local transform = ARGV[10]
if transform == "resolve" then
  p.status = "resolved"
  p.resolved_at = ARGV[11]
  p.withdrew_at_sequence = nil
  redis.call("hset", KEYS[5], ARGV[4], cjson.encode(p))
elseif transform == "withdraw" then
  p.status = "withdrew"
  p.resolved_at = ARGV[11]
  p.withdrew_at_sequence = seq
  redis.call("hset", KEYS[5], ARGV[4], cjson.encode(p))
elseif transform == "timeout" then
  p.status = "timed_out"
  p.resolved_at = ARGV[11]
  redis.call("hset", KEYS[5], ARGV[4], cjson.encode(p))
end
if ARGV[12] ~= "" then
  redis.call("hset", KEYS[6], ARGV[4], ARGV[12])
end
return {seq}
`;

/**
 * ROOM_PARTICIPANT_HEARTBEAT_SCRIPT — bump a participant's `rsvp_at`
 * without bumping the sequence or appending an event.
 *
 * Per the JOB_LIFECYCLE_UNIFICATION RFC: heartbeats are pure
 * liveness. They MUST NOT incur sequence increments (which would
 * trigger the watcher's seen-cache + cause re-dispatch storms at
 * 45-second intervals) or write to the events log (1h-room × N-
 * agents × heartbeat-interval = unbounded audit-log inflation).
 *
 * Semantics:
 *   - Room must be in `awaiting_contributions`. Heartbeats while
 *     `deciding`/`closed`/`expired` are rejected — the agent's work
 *     is either consumed by the queen or no longer relevant; the
 *     plugin layer is expected to stop heartbeating on rejection.
 *   - Participant slot must exist with matching `agent_id`. Defends
 *     against subscriber-mode-collision (#522) the same way
 *     /present + /contribute do.
 *   - Participant status must be `pending`. Heartbeats on
 *     resolved/withdrew/timed_out participants are no-ops (the
 *     work is already done or the slot is closed). Returns a
 *     benign skip code so the plugin can stop heartbeating.
 *   - On success: HSET on the participant hash with the new
 *     `rsvp_at` ISO timestamp. No seq, no event, no idempotency
 *     key.
 *
 * KEYS:
 *   [1] roomKey                  — room hash (status check)
 *   [2] participantsKey          — participants hash (read + HSET)
 *
 * ARGV:
 *   [1] role                     — participant slot key
 *   [2] expectedAgentId          — owner-check (#522)
 *   [3] nowIso                   — new rsvp_at value
 *
 * Returns:
 *   {1, nowIso}                                   success
 *   {0, "skipped_non_pending", actualPStatus}     benign no-op (already withdrew/resolved/timed_out)
 *   {-1, "room_not_found"}                        room hash missing
 *   {-2, currStatus}                              room not in awaiting_contributions
 *   {-3, "no_participant"}                        participant slot missing
 *   {-4, "owner_conflict", actualAgentId}         agent_id mismatch
 */
export const ROOM_PARTICIPANT_HEARTBEAT_SCRIPT = `
local currStatus = redis.call("hget", KEYS[1], "status")
if not currStatus then return {-1, "room_not_found"} end
if currStatus ~= "awaiting_contributions" then
  return {-2, currStatus}
end
local existingP = redis.call("hget", KEYS[2], ARGV[1])
if not existingP then return {-3, "no_participant"} end
local p = cjson.decode(existingP)
if p.agent_id ~= ARGV[2] then
  return {-4, "owner_conflict", p.agent_id}
end
if p.status ~= "pending" then
  return {0, "skipped_non_pending", p.status}
end
p.rsvp_at = ARGV[3]
redis.call("hset", KEYS[2], ARGV[1], cjson.encode(p))
return {1, ARGV[3]}
`;

/**
 * ROOM_DECIDE_CLAIM_SCRIPT — atomic synthesis claim acquisition.
 *
 * Per WAR_ROOM_DESIGN.md §"Storage layout" + §"Manager loop", a
 * single queen runner claims the synthesis lane for a room atomically:
 *   1. Room must be in `awaiting_contributions` (status precondition)
 *   2. Claim key must be unset (TTL'd or never claimed)
 *   3. Atomically: SET claim with TTL + HSET status="deciding" +
 *      HSET deciding_through_sequence=currentSeq + status-set membership
 *
 * The claim record is `{runner, throughSequence}` JSON. The
 * `throughSequence` is captured at claim time and verified at
 * `ROOM_CLOSE` time to detect new-event drift during synthesis
 * (D.1.a-iii.c). The TTL (6 min, see SYNTHESIS_CLAIM_TTL_SECS) is
 * 1 min above Vercel Pro's maxDuration so a crash recovery is
 * bounded but doesn't race the still-running queen.
 *
 * KEYS:
 *   [1] roomKey                  — room hash (status + deciding_through_sequence)
 *   [2] claimKey                 — synthesis claim with TTL
 *   [3] statusSetAwaitingKey     — status:awaiting_contributions index
 *   [4] statusSetDecidingKey     — status:deciding index
 *   [5] seqKey                   — current sequence counter (read for throughSequence)
 *
 * ARGV:
 *   [1] roomId                   — for set membership updates
 *   [2] queenRunner              — opaque runner identity string
 *   [3] claimTtlSecs             — TTL for the claim key
 *
 * Returns:
 *   {1, throughSequence}                       claim acquired
 *   {0, "already_claimed", holderJson}         another runner holds it
 *                                              (holderJson = JSON-encoded
 *                                              {runner, throughSequence})
 *   {-1, currentStatus}                        not in awaiting_contributions
 *   {-3, "decode_error"}                       claim payload corruption
 *                                              (cjson.decode failed —
 *                                              defensive against partial
 *                                              writes / manual ops; closes
 *                                              #512 guard N2)
 *
 * R3 (D.1.a-iii.c): the conflict response now JSON-packs the holder
 * info into a single tag2 string instead of using positional
 * tag3+tag4. Closes #512 guard N1: previously `dispatchScriptResult`
 * dropped the 4th element, forcing a post-EVAL `GET` to recover the
 * throughSequence (racy if claim TTL'd between EVAL and re-read).
 */
export const ROOM_DECIDE_CLAIM_SCRIPT = `
local currStatus = redis.call("hget", KEYS[1], "status")
if not currStatus then return {-1, "room_not_found"} end
if currStatus ~= "awaiting_contributions" then
  return {-1, currStatus}
end
local existingClaim = redis.call("get", KEYS[2])
if existingClaim then
  local ok, parsed = pcall(cjson.decode, existingClaim)
  if not ok then return {-3, "decode_error"} end
  return {0, "already_claimed", cjson.encode({runner = parsed.runner, throughSequence = parsed.throughSequence})}
end
local seq = redis.call("get", KEYS[5])
if not seq then return {-1, "no_seq"} end
local seqNum = tonumber(seq)
local claimJson = cjson.encode({runner = ARGV[2], throughSequence = seqNum})
redis.call("set", KEYS[2], claimJson, "EX", tonumber(ARGV[3]))
redis.call("hset", KEYS[1], "status", "deciding", "deciding_through_sequence", tostring(seqNum))
redis.call("srem", KEYS[3], ARGV[1])
redis.call("sadd", KEYS[4], ARGV[1])
return {1, seqNum}
`;

/**
 * ROOM_RECOVER_DECIDING_SCRIPT — revert deciding → awaiting_contributions
 * when the synthesis claim TTL has expired.
 *
 * Called by the manager loop's recovery branch. Critical: only
 * fires when the claim KEY is genuinely gone (TTL'd by Redis), NOT
 * when a queen runner is still actively claimed. The script
 * verifies via `EXISTS claim` and returns benignly if the claim
 * is still active (caller skips this tick).
 *
 * Atomicity:
 *   1. Room status precondition (must be `deciding`)
 *   2. Claim key existence check (must be MISSING for recovery to fire)
 *   3. Atomically: INCR seq + ZADD recovery event + HSET status →
 *      awaiting_contributions + clear deciding_through_sequence (via
 *      empty-string sentinel per design L415) + status-set membership
 *
 * KEYS:
 *   [1] roomKey                — room hash
 *   [2] claimKey               — synthesis claim (must NOT exist)
 *   [3] statusSetDecidingKey   — status:deciding index (SREM)
 *   [4] statusSetAwaitingKey   — status:awaiting_contributions index (SADD)
 *   [5] seqKey                 — sequence counter (for recovery event)
 *   [6] eventsKey              — event log sorted set
 *
 * ARGV:
 *   [1] roomId                 — for set membership updates
 *   [2] recoveryEventTemplate  — JSON with `__SEQ__` placeholder
 *
 * Returns:
 *   {1, sequence}              recovered (event emitted, status reverted)
 *   {0, "claim_active"}        claim still alive — caller skips this tick
 *   {-1, currentStatus}        room not in `deciding` (already moved on)
 */
export const ROOM_RECOVER_DECIDING_SCRIPT = `
local currStatus = redis.call("hget", KEYS[1], "status")
if not currStatus then return {-1, "room_not_found"} end
if currStatus ~= "deciding" then
  return {-1, currStatus}
end
if redis.call("exists", KEYS[2]) == 1 then
  return {0, "claim_active"}
end
local seq = redis.call("incr", KEYS[5])
local eventJson = string.gsub(ARGV[2], "__SEQ__", tostring(seq), 1)
redis.call("zadd", KEYS[6], seq, eventJson)
redis.call("hset", KEYS[1], "status", "awaiting_contributions", "deciding_through_sequence", "")
redis.call("srem", KEYS[3], ARGV[1])
redis.call("sadd", KEYS[4], ARGV[1])
return {1, seq}
`;

/**
 * ROOM_TERMINATE_SCRIPT — atomic terminal close without claim.
 *
 * Per WAR_ROOM_DESIGN.md L428-470: covers the four non-decided
 * terminal paths — `expired` (watchdog past max_age), `failed_synthesis`
 * (queen consecutive failures), `force_close` (operator UI), `manual`
 * (operator UI happy path). Distinct from `ROOM_CLOSE_SCRIPT` which
 * requires a claim and represents the queen's clean synthesis path.
 *
 * Critical: if the room is in `deciding`, the queen had a claim — DEL
 * it. The queen's mid-flight `/close` will then return
 * `RoomCloseClaimLostError` and abort the GitHub post (closes design
 * R3 N8: stuck-deciding past max_age was unreachable by the prior
 * `ROOM_EXPIRE_SCRIPT`; same path covers force-close on a deciding
 * room from S5).
 *
 * Atomicity:
 *   1. Status precondition: must NOT be `closed` (already-terminal
 *      check; benign no-op for operator double-tap)
 *   2. DEL claim if any (covers deciding-state cleanup)
 *   3. INCR seq + ZADD `room_terminated` event (`__SEQ__` substituted,
 *      capped at first match per #510 guard B1)
 *   4. HSET status="closed" + closed_at + closed_reason
 *   5. DEL subject index (release the per-installation subject lock)
 *   6. SREM from ALL non-terminal status sets idempotently (closes
 *      #515 builder R1: a stale caller-supplied `currentStatus` could
 *      race a concurrent `claimSynthesis` and SREM the wrong set,
 *      leaving phantom membership in the live status set). ZREM/SREM
 *      from installation + per-repo indexes (closes Queen R2 #2 / M3).
 *   7. EXPIRE all sibling keys at retentionSecs (closes Queen R2 #1
 *      — TTL leak)
 *
 * KEYS:
 *   [1] roomKey
 *   [2] subjectIndexKey
 *   [3] statusSetAwaitingRsvpKey       — SREM idempotent
 *   [4] statusSetAwaitingContribKey    — SREM idempotent
 *   [5] statusSetDecidingKey           — SREM idempotent
 *   [6] installationIndexKey           — all-rooms-for-installation sorted set
 *   [7] repoIndexKey                   — per-repo set
 *   [8] seqKey
 *   [9] eventsKey
 *   [10] participantsKey               — for TTL only
 *   [11] contributionsKey              — for TTL only
 *   [12] claimKey                      — DELed if held (deciding-state cleanup)
 *
 * ARGV:
 *   [1] roomId
 *   [2] terminalEventJson     — JSON template with `__SEQ__` placeholder
 *   [3] closedAt              — ISO 8601
 *   [4] retentionSecs         — sibling-keys TTL after terminate
 *   [5] closedReason          — TerminalReason
 *
 * Returns:
 *   {1, sequence}             terminated cleanly
 *   {-1, currentStatus}       already closed (no-op for operator double-tap)
 */
export const ROOM_TERMINATE_SCRIPT = `
local currStatus = redis.call("hget", KEYS[1], "status")
if not currStatus then return {-1, "room_not_found"} end
if currStatus == "closed" then
  return {-1, currStatus}
end
redis.call("del", KEYS[12])
local seq = redis.call("incr", KEYS[8])
local eventJson = string.gsub(ARGV[2], "__SEQ__", tostring(seq), 1)
redis.call("zadd", KEYS[9], seq, eventJson)
redis.call("hset", KEYS[1], "status", "closed",
                          "closed_at", ARGV[3],
                          "closed_reason", ARGV[5])
redis.call("del", KEYS[2])
redis.call("srem", KEYS[3], ARGV[1])
redis.call("srem", KEYS[4], ARGV[1])
redis.call("srem", KEYS[5], ARGV[1])
redis.call("zrem", KEYS[6], ARGV[1])
redis.call("srem", KEYS[7], ARGV[1])
local retention = tonumber(ARGV[4])
redis.call("expire", KEYS[1], retention)
redis.call("expire", KEYS[8], retention)
redis.call("expire", KEYS[9], retention)
redis.call("expire", KEYS[10], retention)
redis.call("expire", KEYS[11], retention)
return {1, seq}
`;

/**
 * ROOM_CLOSE_SCRIPT — queen happy-path close with sequence-consistency.
 *
 * Per WAR_ROOM_DESIGN.md L493-550: only the queen's `/close` path
 * uses this script. Requires a live claim (DELed claim → abort
 * GitHub post via `RoomCloseClaimLostError`) AND the claim's
 * `throughSequence` to match the caller's `expectedThroughSequence`
 * (mismatch → another runner re-claimed; abort).
 *
 * The drift detection (lastSeq != expectedThroughSequence) means
 * NEW EVENTS arrived during synthesis — typically `subject_updated`
 * from the bot's webhook layer when a worker re-pushed to the PR.
 * The queen's synthesis is now stale; the script atomically:
 *   - DELs the claim
 *   - Reverts status to `awaiting_contributions`
 *   - Restores the deciding → awaiting_contributions status-set
 *     membership (closes design B2)
 *   - Returns `{-2, lastSeq}` so the caller can log the drift and
 *     not panic — manager loop will re-claim on the next tick.
 *
 * Happy path:
 *   - Sequence-stamps the `room_decided` event JSON via `__SEQ__`
 *     substitution (capped at first match)
 *   - HSET status="closed", decision=<json>, closed_at
 *   - ZADD the closed event at the new sequence
 *   - SET seq counter to new sequence (so post-close reads are stable)
 *   - DEL claim, subject index
 *   - SREM/ZREM/SREM from deciding-status, installation, repo indexes
 *   - EXPIRE all siblings at retentionSecs
 *
 * KEYS:
 *   [1] roomKey
 *   [2] claimKey
 *   [3] seqKey
 *   [4] statusSetDecidingKey
 *   [5] statusSetAwaitingContribKey
 *   [6] subjectIndexKey
 *   [7] eventsKey
 *   [8] participantsKey       — TTL only
 *   [9] contributionsKey      — TTL only
 *   [10] installationIndexKey
 *   [11] repoIndexKey
 *
 * ARGV:
 *   [1] roomId
 *   [2] expectedThroughSequence  — caller's claim-time sequence (from claimSynthesis)
 *   [3] decisionJson             — RoomDecision serialized
 *   [4] closedEventJsonTemplate  — JSON with `__SEQ__` placeholder
 *   [5] closedAt                 — ISO 8601
 *   [6] retentionSecs            — sibling TTL
 *
 * Returns:
 *   {1, sequence}                                    closed cleanly
 *   {-2, lastSeq}                                    sequence drift (revert + retry)
 *   {-3, "claim_lost"}                               claim DELed (force-close raced)
 *   {-3, "claim_throughSeq_mismatch", actualThroughSeq}
 *                                                    different runner re-claimed
 *   {-3, "decode_error"}                             claim payload corruption
 */
export const ROOM_CLOSE_SCRIPT = `
local claim = redis.call("get", KEYS[2])
if not claim then return {-3, "claim_lost"} end
local ok, parsed = pcall(cjson.decode, claim)
if not ok then return {-3, "decode_error"} end
local claimThroughSeq = tonumber(parsed.throughSequence)
local expectedThroughSeq = tonumber(ARGV[2])
if claimThroughSeq ~= expectedThroughSeq then
  return {-3, "claim_throughSeq_mismatch", claimThroughSeq}
end
local lastSeq = tonumber(redis.call("get", KEYS[3])) or 0
if lastSeq ~= expectedThroughSeq then
  -- Drift: new events arrived during synthesis. Revert atomically
  -- (closes design B2: prior implementation orphaned rooms from
  -- both deciding and awaiting_contributions sets, making them
  -- invisible to subsequent ticks).
  redis.call("del", KEYS[2])
  redis.call("hset", KEYS[1], "status", "awaiting_contributions",
                            "deciding_through_sequence", "")
  redis.call("srem", KEYS[4], ARGV[1])
  redis.call("sadd", KEYS[5], ARGV[1])
  return {-2, lastSeq}
end
local closedSeq = lastSeq + 1
local closedEventJson = string.gsub(ARGV[4], "__SEQ__", tostring(closedSeq), 1)
redis.call("hset", KEYS[1], "status", "closed",
                          "decision", ARGV[3],
                          "closed_at", ARGV[5])
redis.call("zadd", KEYS[7], closedSeq, closedEventJson)
redis.call("set", KEYS[3], tostring(closedSeq))
redis.call("del", KEYS[2])
redis.call("del", KEYS[6])
redis.call("srem", KEYS[4], ARGV[1])
redis.call("zrem", KEYS[10], ARGV[1])
redis.call("srem", KEYS[11], ARGV[1])
local retention = tonumber(ARGV[6])
redis.call("expire", KEYS[1], retention)
redis.call("expire", KEYS[3], retention)
redis.call("expire", KEYS[7], retention)
redis.call("expire", KEYS[8], retention)
redis.call("expire", KEYS[9], retention)
return {1, closedSeq}
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

/**
 * Validate role at the BODY boundary. Distinct from the internal
 * `assertRoleFormat` — this version is for caller-supplied role
 * strings (e.g., `/timeout`'s `subjectRole` body field) that must
 * be validated before hitting storage. Throws a typed
 * `RoomRoleFormatError` so route handlers can map to 400.
 *
 * Closes #521 builder R1 #3: the prior `/timeout` only checked
 * non-empty string; an invalid `subjectRole` reached
 * `assertRoleFormat` inside `timeoutParticipant` and threw a plain
 * Error → unhandled 500 instead of the documented 400 path.
 */
export function validateRoleFormat(role: string): void {
  if (typeof role !== "string" || !ROLE_REGEX.test(role)) {
    throw new RoomRoleFormatError(role);
  }
}

/** Thrown by `validateRoleFormat` on a malformed body-supplied role. */
export class RoomRoleFormatError extends Error {
  public readonly invalidRole: unknown;
  constructor(invalidRole: unknown) {
    super(
      `Role ${JSON.stringify(String(invalidRole))} failed format validation: must match /^[a-z][a-z0-9_-]{0,31}$/.`,
    );
    this.name = "RoomRoleFormatError";
    this.invalidRole = invalidRole;
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
  /** Event metadata. The serialized JSON gets `__SEQ__` substituted
   * to the actual sequence inside the Lua script (FIRST MATCH only —
   * user-controlled body content containing the literal sentinel is
   * preserved). */
  event: {
    timestamp: string;
    event_type: RoomEventType;
    actor_role: string;
    actor_id: string;
    body: Record<string, unknown>;
  };
  /** Empty disables idem check. Typically derived via `deriveIdempotencyKey`. */
  idempotencyKey: string;
  /** Per-(room, role) first-wins gate. When set, the script HGETs the
   * participants slot at `field`, cjson-decodes, and rejects if the
   * existing `agent_id` differs from `expectedAgentId` AND status is
   * not "withdrew" (re-RSVP from withdrew is allowed). */
  ownerCheck?: {
    field: string; // typically the role
    expectedAgentId: string;
  };
  /** First materialized write (HSET). Set `substituteSeq: true` to
   * have the script gsub `__SEQ__` (first match) with the actual
   * sequence — used by withdrawParticipant for `withdrew_at_sequence`.
   * Default is OFF so user-controlled materialized content (e.g.
   * contribution body summaries) cannot be silently rewritten. */
  materialized1?: {
    key: string;
    field: string;
    json: string;
    substituteSeq?: boolean;
  };
  /** Second materialized write — used by `submitContribution` to
   * update BOTH the contribution slot AND the participant's status
   * to "resolved" atomically (closes #510 builder R1 #3 dual-update
   * concern). Same opt-in `substituteSeq` semantics as materialized1. */
  materialized2?: {
    key: string;
    field: string;
    json: string;
    substituteSeq?: boolean;
  };
  /** Allowed-status gate. Comma-separated list of valid current
   * statuses for this action. Empty = any non-empty status accepted
   * (room must still exist; that's a separate -3 path). */
  allowedStatuses?: RoomStatus[];
  /** Optional status transition. When provided, both fields required:
   * caller asserts the from-set is correct (must match currStatus
   * after the allowed-statuses gate). */
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
 *   - `RoomNotFoundError` (room hash missing — typo'd roomId or
 *      closed-and-TTL'd room)
 *   - `RoomEventStatusPreconditionError` (currStatus not in `allowedStatuses`)
 *   - `RoomParticipantOwnerConflictError` (per-role first-wins gate)
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
  // JSON like `"seq":42`. Cap at first match — preserves any user-
  // supplied content that happens to contain the literal `__SEQ__`
  // (closes #510 guard R1 B1).
  const luaTemplate = eventTemplate.replace('"__SEQ__"', "__SEQ__");

  const ttl = args.idemTtlSecs ?? idemTtlSecs(DEFAULT_MAX_AGE_SECS);
  const allowedCsv =
    args.allowedStatuses && args.allowedStatuses.length > 0
      ? args.allowedStatuses.join(",")
      : "";

  const result = dispatchScriptResult(
    await args.redis.eval(
      ROOM_APPEND_EVENT_SCRIPT,
      [
        seqKey(args.roomId),
        eventsKey(args.roomId),
        idemKey(args.roomId, args.idempotencyKey),
        roomKey(args.installationId, args.roomId),
        // Owner check key is the participants hash by convention;
        // safe to compute even when ownerCheck is unset since the
        // Lua script gates the read on ARGV[4] non-empty.
        participantsKey(args.roomId),
        args.materialized1?.key ?? "__unused__",
        args.statusTransition
          ? statusIndexKey(args.installationId, args.statusTransition.from)
          : "__unused__",
        args.statusTransition
          ? statusIndexKey(args.installationId, args.statusTransition.to)
          : "__unused__",
        args.materialized2?.key ?? "__unused__",
      ],
      [
        luaTemplate,
        args.idempotencyKey,
        args.event.event_type,
        args.ownerCheck?.field ?? "",
        args.ownerCheck?.expectedAgentId ?? "",
        args.materialized1?.field ?? "",
        args.materialized1?.json ?? "",
        allowedCsv,
        args.statusTransition?.to ?? "",
        args.roomId,
        String(ttl),
        args.materialized2?.field ?? "",
        args.materialized2?.json ?? "",
        args.materialized1?.substituteSeq ? "1" : "",
        args.materialized2?.substituteSeq ? "1" : "",
      ],
    ),
  );

  if (result.ok === -1 && typeof result.tag1 === "number") {
    throw new RoomEventIdempotencyReplayError(args.roomId, result.tag1);
  }
  if (result.ok === -2 && typeof result.tag1 === "string") {
    throw new RoomEventStatusPreconditionError(
      args.roomId,
      allowedCsv,
      result.tag1,
    );
  }
  if (result.ok === -3) {
    throw new RoomNotFoundError(args.installationId, args.roomId);
  }
  if (result.ok === -4 && typeof result.tag2 === "string") {
    throw new RoomParticipantOwnerConflictError(
      args.roomId,
      args.ownerCheck?.field ?? "",
      result.tag2,
      args.ownerCheck?.expectedAgentId ?? "",
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
// Low-level participant-transition primitive
// ---------------------------------------------------------------------------

interface TransitionRoomParticipantArgs {
  installationId: string;
  roomId: string;
  /** Participants hash field key. */
  role: string;
  event: {
    timestamp: string;
    event_type: RoomEventType;
    actor_role: string;
    actor_id: string;
    body: Record<string, unknown>;
  };
  idempotencyKey: string;
  /** When true, the script enforces existing participant's `agent_id`
   * matches `ownerExpected`. Watchdog-driven actions (timeout) skip
   * the check (set `false`) so the watchdog can act on any role. */
  ownerRequired: boolean;
  /** Required when `ownerRequired === true`. */
  ownerExpected?: string;
  allowedRoomStatuses: RoomStatus[];
  /** Atomic in-place transformation applied to the participant slot.
   * `noop` leaves the slot unchanged (used by withdrawContribution). */
  transform: "resolve" | "withdraw" | "timeout" | "noop";
  /** Allowed source states for the participant slot — gates the
   * transformation atomically inside the script. Closes #510
   * builder R3 (manager-loop race). E.g.:
   *   - submitContribution → ["pending", "resolved"] (re-submit allowed)
   *   - withdrawParticipant → ["pending", "resolved"]
   *   - withdrawContribution → ["resolved"]
   *   - timeoutParticipant → ["pending"] (per design L1055)
   * Empty = any source state allowed (defensive default; callers
   * should typically pass an explicit list). */
  allowedParticipantStatuses?: RoomParticipant["status"][];
  /** Optional contribution-slot HSET. The contribution JSON is passed
   * verbatim (no `__SEQ__` substitution — contributions don't carry
   * sequence-derived fields). */
  contributionJson?: string;
  idemTtlSecs?: number;
  redis: Redis;
}

/**
 * Atomic participant-state transition. Underlying primitive for
 * withdraw / contribute / withdraw_contribution / timeout — actions
 * that REQUIRE an existing participant slot (per
 * WAR_ROOM_DESIGN.md L746) and need rsvp_at preservation.
 *
 * Throws:
 *   - `RoomEventIdempotencyReplayError` (replay)
 *   - `RoomNotFoundError` (room hash missing)
 *   - `RoomEventStatusPreconditionError` (room status not in allowed list)
 *   - `RoomParticipantOwnerConflictError` (owner mismatch when ownerRequired)
 *   - `RoomParticipantNotFoundError` (participant slot missing — must
 *      `/present` first)
 *   - `RoomEventBodyTooLargeError` (event body > 8 KiB)
 */
export async function transitionRoomParticipant(
  args: TransitionRoomParticipantArgs,
): Promise<number> {
  assertEventBodySize(args.event.body);
  if (args.ownerRequired && args.ownerExpected === undefined) {
    throw new Error(
      "Internal: transitionRoomParticipant requires ownerExpected when ownerRequired=true",
    );
  }

  const eventTemplate = JSON.stringify({
    seq: "__SEQ__",
    timestamp: args.event.timestamp,
    event_type: args.event.event_type,
    actor_role: args.event.actor_role,
    actor_id: args.event.actor_id,
    body: args.event.body,
  });
  const luaTemplate = eventTemplate.replace('"__SEQ__"', "__SEQ__");

  const ttl = args.idemTtlSecs ?? idemTtlSecs(DEFAULT_MAX_AGE_SECS);
  const allowedCsv = args.allowedRoomStatuses.join(",");
  const nowIso = args.event.timestamp;

  const result = dispatchScriptResult(
    await args.redis.eval(
      ROOM_PARTICIPANT_TRANSITION_SCRIPT,
      [
        seqKey(args.roomId),
        eventsKey(args.roomId),
        idemKey(args.roomId, args.idempotencyKey),
        roomKey(args.installationId, args.roomId),
        participantsKey(args.roomId),
        args.contributionJson !== undefined
          ? contributionsKey(args.roomId)
          : "__unused__",
      ],
      [
        luaTemplate,
        args.idempotencyKey,
        args.event.event_type,
        args.role,
        args.ownerRequired ? "1" : "",
        args.ownerExpected ?? "",
        allowedCsv,
        args.roomId,
        String(ttl),
        args.transform,
        nowIso,
        args.contributionJson ?? "",
        args.allowedParticipantStatuses?.join(",") ?? "",
      ],
    ),
  );

  if (result.ok === -1 && typeof result.tag1 === "number") {
    throw new RoomEventIdempotencyReplayError(args.roomId, result.tag1);
  }
  if (result.ok === -2 && typeof result.tag1 === "string") {
    throw new RoomEventStatusPreconditionError(
      args.roomId,
      allowedCsv,
      result.tag1,
    );
  }
  if (result.ok === -3) {
    throw new RoomNotFoundError(args.installationId, args.roomId);
  }
  if (result.ok === -4 && typeof result.tag2 === "string") {
    throw new RoomParticipantOwnerConflictError(
      args.roomId,
      args.role,
      result.tag2,
      args.ownerExpected ?? "",
    );
  }
  if (result.ok === -5) {
    throw new RoomParticipantNotFoundError(args.roomId, args.role);
  }
  if (result.ok === -6 && typeof result.tag2 === "string") {
    throw new RoomParticipantStatePreconditionError(
      args.roomId,
      args.role,
      args.allowedParticipantStatuses ?? [],
      result.tag2,
    );
  }
  if (result.ok > 0) return result.ok;

  throw new Error(
    `ROOM_PARTICIPANT_TRANSITION_SCRIPT returned unexpected result: ${JSON.stringify(result)}`,
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
  /** Per-runner identity used for the per-(room, role) **first-wins
   * gate** (G5 — subscriber-mode). Body-supplied at the route layer
   * (validated via `validateRunnerFormat`). Two runners that share a
   * bearer but have distinct `agentId` race correctly — the second
   * gets `RoomParticipantOwnerConflictError`. Stored on the
   * materialized participant record as `participant.agent_id`.
   *
   * #522 / WAR_ROOM_DESIGN.md L861-877: prior code used the
   * bearer-derived name here, collapsing subscriber-mode runners.
   * The split between `agentId` (gate) and `actorId` (audit) is the
   * fix — together they let us prevent impersonation (audit can't
   * be forged) AND distinguish concurrent runners (gate uses each
   * runner's own id). */
  agentId: string;
  /** Bearer-derived audit identity used for the event log's
   * `actor_id`. Anti-impersonation: a request body cannot forge
   * who-took-this-action in the audit trail. Routes wire this from
   * `auth.name`. May equal `agentId` in single-runner-per-token
   * deployments (drone pilot, etc.).
   *
   * Optional in the type for back-compat with existing call sites
   * (storage tests pre-#522). When omitted, defaults to `agentId`
   * — same behavior as before #522. PRODUCTION ROUTES MUST pass
   * `actorId` explicitly so the audit trail records the bearer,
   * not a body-supplied value. */
  actorId?: string;
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
 * doesn't transition room status (rooms are born `awaiting_contributions`
 * in the heartbeat model and stay there until queen claims).
 *
 * Allowed status: `awaiting_contributions` (the only open status).
 *
 * Per-(room, role) first-wins gate: if a different agent already
 * holds this role's slot AND the slot status isn't "withdrew", the
 * second runner gets `RoomParticipantOwnerConflictError` and skips
 * dispatch (per WAR_ROOM_DESIGN.md §subscriber-mode fleets).
 *
 * Re-RSVP from withdrew: status flips back to "pending"; agent_id
 * may differ from the prior holder (a restarted runner gets a new
 * agent_id and may legitimately re-claim).
 */
export async function presentParticipant(args: RSVPCommonArgs & {
  intentHint?: string;
}): Promise<number> {
  assertRoleFormat(args.role);
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString();
  // Fresh participant record — status: "pending", no
  // withdrew_at_sequence (cleared on re-RSVP per design).
  const participant: RoomParticipant = {
    agent_id: args.agentId,
    role: args.role,
    status: "pending",
    rsvp_at: nowIso,
  };

  return await appendRoomEvent({
    installationId: args.installationId,
    roomId: args.roomId,
    event: {
      timestamp: nowIso,
      event_type: "participant_presented",
      actor_role: args.role,
      // Audit trail uses bearer-derived actorId for impersonation
      // safety. Per-runner agentId (used by ownerCheck below) lives
      // on the materialized participant record only. #522.
      actor_id: args.actorId ?? args.agentId,
      body: {
        ...(args.intentHint !== undefined ? { intent_hint: args.intentHint } : {}),
      },
    },
    idempotencyKey: deriveIdempotencyKey({
      roomId: args.roomId,
      role: args.role,
      action: "present",
      // #522 builder R2: per-runner idem-lane separation. Without
      // this, two runners sharing a bearer + observing same seq
      // collide on the idem key and runner B gets a spurious
      // 200 replay instead of 409 owner_conflict.
      agentId: args.agentId,
      sequenceObservedByClient: args.sequenceObservedByClient,
    }),
    allowedStatuses: ["awaiting_contributions"],
    // First-wins gate: per-runner agentId distinguishes subscriber-
    // mode runners that share a bearer.
    ownerCheck: { field: args.role, expectedAgentId: args.agentId },
    materialized1: {
      key: participantsKey(args.roomId),
      field: args.role,
      json: JSON.stringify(participant),
    },
    idemTtlSecs: idemTtlSecs(args.roomMaxAgeSecs ?? DEFAULT_MAX_AGE_SECS),
    redis: args.redis,
  });
}

/**
 * Worker heartbeat — bumps `rsvp_at` on the participant slot to
 * indicate "still actively working on this room." Pure liveness:
 * does NOT bump the sequence and does NOT append to the events log
 * (per RFC, JOB_LIFECYCLE_UNIFICATION).
 *
 * Allowed status: `awaiting_contributions` only. Heartbeats while
 * the room is `deciding`/`closed`/`expired` are rejected with
 * `RoomTransitionInvalidStatusError`; the agent's plugin layer is
 * expected to stop heartbeating on rejection.
 *
 * Idempotency: not required at the storage layer. Multiple
 * heartbeats just keep bumping `rsvp_at`. The Lua script is
 * atomic, so concurrent heartbeats from the same role + agent_id
 * cannot leave the participant in a half-written state.
 *
 * Returns the new `rsvp_at` ISO string on success, or `null` when
 * the heartbeat was a benign no-op (participant already
 * withdrew/resolved/timed_out — caller should stop heartbeating).
 *
 * Throws:
 *   - `RoomNotFoundError` — room hash missing (TTL'd or never existed)
 *   - `RoomTransitionInvalidStatusError` — room not in `awaiting_contributions`
 *   - `RoomParticipantNotFoundError` — participant slot missing for this role
 *   - `RoomParticipantOwnerConflictError` — participant exists but for a different `agent_id`
 */
export async function heartbeatParticipant(args: {
  installationId: string;
  roomId: string;
  role: string;
  agentId: string;
  redis: Redis;
  nowMs?: number;
}): Promise<string | null> {
  assertRoleFormat(args.role);
  validateRoomId(args.roomId);
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString();

  const result = dispatchScriptResult(
    await args.redis.eval(
      ROOM_PARTICIPANT_HEARTBEAT_SCRIPT,
      [
        roomKey(args.installationId, args.roomId),
        participantsKey(args.roomId),
      ],
      [args.role, args.agentId, nowIso],
    ),
  );

  if (result.ok === 1 && typeof result.tag1 === "string") {
    return result.tag1;
  }
  if (result.ok === 0 && result.tag1 === "skipped_non_pending") {
    return null;
  }
  if (result.ok === -1 && result.tag1 === "room_not_found") {
    throw new RoomNotFoundError(args.installationId, args.roomId);
  }
  if (result.ok === -2 && typeof result.tag1 === "string") {
    throw new RoomTransitionInvalidStatusError(
      args.roomId,
      "heartbeat",
      ["awaiting_contributions"],
      result.tag1,
    );
  }
  if (result.ok === -3 && result.tag1 === "no_participant") {
    throw new RoomParticipantNotFoundError(args.roomId, args.role);
  }
  if (
    result.ok === -4 &&
    typeof result.tag1 === "string" &&
    typeof result.tag2 === "string"
  ) {
    throw new RoomParticipantOwnerConflictError(
      args.roomId,
      args.role,
      result.tag2,
      args.agentId,
    );
  }
  throw new Error(
    `ROOM_PARTICIPANT_HEARTBEAT_SCRIPT returned unexpected result: ${JSON.stringify(result)}`,
  );
}

/**
 * Worker withdraws their RSVP. Uses `transitionRoomParticipant` so
 * the existing slot's `agent_id` + `rsvp_at` are preserved and the
 * `withdrew_at_sequence` field is set atomically to the withdrawal
 * event's sequence. Status transforms from pending/resolved →
 * withdrew.
 *
 * Allowed status: `awaiting_contributions` (the only open status
 * in the heartbeat model). Soft — doesn't transition room status.
 *
 * **Requires existing participant slot** (per design L746): if the
 * caller never `/present`ed, this returns
 * `RoomParticipantNotFoundError`. Closes #510 builder R2 #2.
 */
export async function withdrawParticipant(
  args: RSVPCommonArgs & { reason?: string },
): Promise<number> {
  assertRoleFormat(args.role);
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString();
  return await transitionRoomParticipant({
    installationId: args.installationId,
    roomId: args.roomId,
    role: args.role,
    event: {
      timestamp: nowIso,
      event_type: "participant_withdrawn",
      actor_role: args.role,
      // Audit: bearer-derived. #522.
      actor_id: args.actorId ?? args.agentId,
      body: {
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      },
    },
    idempotencyKey: deriveIdempotencyKey({
      roomId: args.roomId,
      role: args.role,
      action: "withdraw_participant",
      agentId: args.agentId, // #522 builder R2 — per-runner idem lane
      sequenceObservedByClient: args.sequenceObservedByClient,
    }),
    ownerRequired: true,
    ownerExpected: args.agentId,
    allowedRoomStatuses: ["awaiting_contributions"],
    transform: "withdraw",
    // Withdraw a pending RSVP or a resolved (already-contributed)
    // RSVP. Already-withdrew or timed_out are terminal — caller
    // gets RoomParticipantStatePreconditionError.
    allowedParticipantStatuses: ["pending", "resolved"],
    idemTtlSecs: idemTtlSecs(args.roomMaxAgeSecs ?? DEFAULT_MAX_AGE_SECS),
    redis: args.redis,
  });
}

/**
 * Worker submits a contribution (analysis / verdict). Uses
 * `transitionRoomParticipant` so the participant slot is updated
 * atomically (status → "resolved", `resolved_at` = now,
 * `agent_id` + `rsvp_at` preserved from the original RSVP) AND the
 * contribution slot is HSET in the same EVAL.
 *
 * **Schema validation** (closes #510 builder R1 #4): the `body`
 * MUST conform to `ContributionBody`. Validated at the boundary
 * via `validateContributionBody` — malformed bodies throw
 * `ContributionValidationError` BEFORE any storage write.
 *
 * **Allowed status**: `awaiting_contributions` (the only open
 * status in the heartbeat model). Rooms are born in this status
 * so workers may contribute from T+0 onwards.
 *
 * **Requires existing participant slot** (closes #510 builder R2 #2):
 * caller must have called `presentParticipant` first. Otherwise
 * `RoomParticipantNotFoundError`.
 *
 * **rsvp_at preservation**: the script reads the existing
 * participant via `cjson.decode`, modifies status / resolved_at /
 * clears withdrew_at_sequence, and re-encodes. The original
 * `rsvp_at` is preserved across the call so the manager loop's
 * quiet-period calculation reasons over true RSVP times.
 *
 * Throws `RoomContributionTooLargeError` if `rawMd` exceeds 32 KiB.
 */
export async function submitContribution(args: RSVPCommonArgs & {
  body: ContributionBody;
  rawMd: string;
}): Promise<number> {
  assertRoleFormat(args.role);
  validateContributionBody(args.body);
  assertContributionMdSize(args.rawMd);
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString();
  const contribution: RoomContribution = {
    body: args.body as unknown as Record<string, unknown>,
    raw_md: args.rawMd,
    contributed_at: nowIso,
  };

  return await transitionRoomParticipant({
    installationId: args.installationId,
    roomId: args.roomId,
    role: args.role,
    event: {
      timestamp: nowIso,
      event_type: "contribution_submitted",
      actor_role: args.role,
      // Audit: bearer-derived. Owner check below uses per-runner
      // agentId for subscriber-mode safety. #522.
      actor_id: args.actorId ?? args.agentId,
      body: {
        body: args.body as unknown as Record<string, unknown>,
        // raw_md NOT in event body — bounded separately at 32 KiB
        // in the materialized contribution slot.
      },
    },
    idempotencyKey: deriveIdempotencyKey({
      roomId: args.roomId,
      role: args.role,
      action: "contribute",
      agentId: args.agentId, // #522 builder R2 — per-runner idem lane
      sequenceObservedByClient: args.sequenceObservedByClient,
    }),
    ownerRequired: true,
    ownerExpected: args.agentId,
    allowedRoomStatuses: ["awaiting_contributions"],
    transform: "resolve",
    // First contribution from "pending"; re-submit overwrites from
    // "resolved". A worker who withdrew or got timed_out must
    // /present again first (re-RSVP flips the slot back to pending).
    allowedParticipantStatuses: ["pending", "resolved"],
    contributionJson: JSON.stringify(contribution),
    idemTtlSecs: idemTtlSecs(args.roomMaxAgeSecs ?? DEFAULT_MAX_AGE_SECS),
    redis: args.redis,
  });
}

/**
 * Worker withdraws a previously-submitted contribution. Soft event —
 * the contribution slot in the materialized hash gets a tombstone
 * (`withdrawn: true`); queen synthesis skips withdrawn contributions.
 * The participant's status is **unchanged** — that's a separate
 * signal from contribution withdrawal.
 *
 * **Allowed status**: `awaiting_contributions` (matches
 * submitContribution's allowed window in the heartbeat model).
 *
 * **Requires existing participant slot** (closes #510 builder R2 #2):
 * caller must have called `presentParticipant` first.
 *
 * **Owner check**: agent must hold the role's RSVP slot.
 */
export async function withdrawContribution(
  args: RSVPCommonArgs & { reason?: string },
): Promise<number> {
  assertRoleFormat(args.role);
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString();
  const tombstone: Partial<RoomContribution> & { withdrawn: true } = {
    withdrawn: true,
    contributed_at: nowIso,
  };

  return await transitionRoomParticipant({
    installationId: args.installationId,
    roomId: args.roomId,
    role: args.role,
    event: {
      timestamp: nowIso,
      event_type: "contribution_withdrawn",
      actor_role: args.role,
      // Audit: bearer-derived. #522.
      actor_id: args.actorId ?? args.agentId,
      body: {
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      },
    },
    idempotencyKey: deriveIdempotencyKey({
      roomId: args.roomId,
      role: args.role,
      action: "withdraw_contribution",
      agentId: args.agentId, // #522 builder R2 — per-runner idem lane
      sequenceObservedByClient: args.sequenceObservedByClient,
    }),
    ownerRequired: true,
    ownerExpected: args.agentId,
    allowedRoomStatuses: ["awaiting_contributions"],
    transform: "noop", // participant status unchanged
    // Only resolved participants have a contribution to withdraw.
    // Pending hasn't contributed; withdrew/timed_out are terminal.
    allowedParticipantStatuses: ["resolved"],
    contributionJson: JSON.stringify(tombstone),
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
  // Use transitionRoomParticipant — the script atomically reads the
  // existing slot, preserves agent_id + rsvp_at, and applies the
  // timed_out transformation. Closes #510 guard R1 N2 properly
  // (previously the wrapper read participant TS-side outside the
  // lock, then overwrote with the watchdog's identity inside the
  // script — race window).
  return await transitionRoomParticipant({
    installationId: args.installationId,
    roomId: args.roomId,
    role: args.subjectRole,
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
    // Watchdog can timeout any participant — no owner check.
    ownerRequired: false,
    allowedRoomStatuses: ["awaiting_contributions"],
    transform: "timeout",
    // Per design L1055, the manager loop only times out PENDING
    // participants — once a worker has resolved (contributed),
    // they're synthesis-ready and the timeout is the wrong signal.
    // Closes #510 builder R3: a stale watchdog scan that read
    // "pending" can no longer overwrite a now-resolved slot to
    // timed_out. Stale calls return RoomParticipantStatePreconditionError
    // and the watchdog re-scans on the next tick.
    allowedParticipantStatuses: ["pending"],
    idemTtlSecs: idemTtlSecs(args.roomMaxAgeSecs ?? DEFAULT_MAX_AGE_SECS),
    redis: args.redis,
  });
}

// ---------------------------------------------------------------------------
// Synthesis claim / recovery primitives (D.1.a-iii.b)
// ---------------------------------------------------------------------------

/**
 * Result of a successful synthesis claim acquisition. The
 * `throughSequence` is captured atomically by the script and is
 * the value that ROOM_CLOSE will compare against the current
 * sequence at close-time to detect new-event drift during
 * synthesis (D.1.a-iii.c).
 */
export interface ClaimSynthesisResult {
  throughSequence: number;
  claimTtlSecs: number;
}

/**
 * Acquire the synthesis claim for a room — atomic transition from
 * `awaiting_contributions` → `deciding` with claim TTL.
 *
 * Single-runner-wins: only one queen runner across the fleet can
 * hold the claim at a time. The TTL (default 6 minutes — see
 * `SYNTHESIS_CLAIM_TTL_SECS`) is intentionally 1 minute above
 * Vercel Pro's 5-minute `maxDuration` so that a queen runner that
 * crashes mid-synthesis releases its claim only after a buffer
 * window. `recoverDeciding` then fires on the next manager tick.
 *
 * Sibling effects (all atomic):
 *   - Status flips `awaiting_contributions` → `deciding`
 *   - `deciding_through_sequence` is set to the current sequence
 *     (frozen at claim time so close-time drift detection can fire)
 *   - Status-set membership migrates from awaiting → deciding
 *
 * Throws:
 *   - `RoomClaimAlreadyHeldError` when another runner holds it
 *     (carries `heldByRunner` + `throughSequence` for caller log)
 *   - `RoomTransitionInvalidStatusError` when the room is not in
 *     `awaiting_contributions` (already deciding / closed / etc.)
 *   - `RoomNotFoundError` when the room hash is gone (TTL'd or
 *     never opened)
 */
export async function claimSynthesis(args: {
  installationId: string;
  roomId: string;
  /** Opaque queen runner identity (hostname + pid + monotonic).
   * Stored in the claim record so observers know who holds it.
   * Boundary-validated via `validateRunnerFormat` (closes #512
   * guard N6: defense-in-depth against gsub-sentinel collision). */
  queenRunner: string;
  claimTtlSecs?: number;
  redis: Redis;
}): Promise<ClaimSynthesisResult> {
  validateRunnerFormat(args.queenRunner);
  const ttl = args.claimTtlSecs ?? SYNTHESIS_CLAIM_TTL_SECS;

  const result = dispatchScriptResult(
    await args.redis.eval(
      ROOM_DECIDE_CLAIM_SCRIPT,
      [
        roomKey(args.installationId, args.roomId),
        claimKey(args.roomId),
        statusIndexKey(args.installationId, "awaiting_contributions"),
        statusIndexKey(args.installationId, "deciding"),
        seqKey(args.roomId),
      ],
      [args.roomId, args.queenRunner, String(ttl)],
    ),
  );

  if (result.ok === 1 && typeof result.tag1 === "number") {
    return { throughSequence: result.tag1, claimTtlSecs: ttl };
  }
  if (
    result.ok === 0 &&
    result.tag1 === "already_claimed" &&
    typeof result.tag2 === "string"
  ) {
    // Script JSON-packs the holder info into tag2 (closes #512 guard
    // N1: previously the script returned 4 elements but
    // `dispatchScriptResult` only captures tag1+tag2, forcing a
    // post-EVAL `GET` to recover the throughSequence. The re-read
    // was racy — the claim could TTL between EVAL and GET, leaving
    // throughSequence as 0 in the surfaced error.
    let heldByRunner = "(unparsed)";
    let throughSequence = 0;
    try {
      const parsed = JSON.parse(result.tag2) as {
        runner?: string;
        throughSequence?: number;
      };
      if (typeof parsed.runner === "string") heldByRunner = parsed.runner;
      if (typeof parsed.throughSequence === "number") {
        throughSequence = parsed.throughSequence;
      }
    } catch {
      // Defensive: script-emitted JSON should never fail to parse,
      // but if it does we still raise the error rather than swallow it.
    }
    throw new RoomClaimAlreadyHeldError(
      args.roomId,
      heldByRunner,
      throughSequence,
    );
  }
  if (result.ok === -1 && typeof result.tag1 === "string") {
    if (result.tag1 === "room_not_found" || result.tag1 === "no_seq") {
      throw new RoomNotFoundError(args.installationId, args.roomId);
    }
    throw new RoomTransitionInvalidStatusError(
      args.roomId,
      "claim_synthesis",
      ["awaiting_contributions"],
      result.tag1,
    );
  }
  if (result.ok === -3 && result.tag1 === "decode_error") {
    // Claim payload corrupted (cjson.decode failed in script).
    // Surfaces #512 guard N2: defensive against partial writes /
    // manual ops intervention. Operator should inspect the claim
    // key directly and decide whether to DEL it.
    throw new RoomClaimPayloadCorruptError(args.roomId);
  }
  throw new Error(
    `ROOM_DECIDE_CLAIM_SCRIPT returned unexpected result: ${JSON.stringify(result)}`,
  );
}

/**
 * Recover a stuck `deciding` room when its synthesis claim TTL has
 * expired. Reverts status to `awaiting_contributions` and emits a
 * `room_recovered` event so observers can see why the manager
 * loop re-opened it.
 *
 * Called from the bot's manager loop. Critical guard: the script
 * verifies the claim key has GENUINELY expired (`EXISTS` returns 0)
 * before reverting. If a still-active queen runner holds the claim,
 * the script returns `{0, "claim_active"}` and this primitive
 * returns `null` — the caller skips this tick and re-scans next.
 *
 * Atomicity:
 *   - INCR seq + ZADD recovery event + HSET status + clear
 *     `deciding_through_sequence` (empty-string sentinel) + status-set
 *     membership update — all in one EVAL.
 *
 * Returns:
 *   - `{ recovered: true, sequence }` — recovery event emitted
 *   - `{ recovered: false, reason: "claim_active" }` — still active
 *
 * Throws:
 *   - `RoomTransitionInvalidStatusError` if the room is not
 *     `deciding` (already closed / terminated / awaiting via another
 *     recovery path)
 *   - `RoomNotFoundError` if the room hash is gone entirely
 */
export async function recoverDeciding(args: {
  installationId: string;
  roomId: string;
  redis: Redis;
  nowMs?: number;
}): Promise<
  | { recovered: true; sequence: number }
  | { recovered: false; reason: "claim_active" }
> {
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString();

  // Build the recovery event template with __SEQ__ placeholder; Lua
  // gsub (capped at first match) substitutes the actual sequence
  // atomically with the status revert. The template uses the same
  // pattern as `appendRoomEvent` for consistency.
  const eventTemplate = JSON.stringify({
    seq: "__SEQ__",
    timestamp: nowIso,
    event_type: "room_recovered",
    actor_role: "manager",
    actor_id: "watchdog",
    body: { reason: "claim_ttl_expired" },
  });
  const luaTemplate = eventTemplate.replace('"__SEQ__"', "__SEQ__");

  const result = dispatchScriptResult(
    await args.redis.eval(
      ROOM_RECOVER_DECIDING_SCRIPT,
      [
        roomKey(args.installationId, args.roomId),
        claimKey(args.roomId),
        statusIndexKey(args.installationId, "deciding"),
        statusIndexKey(args.installationId, "awaiting_contributions"),
        seqKey(args.roomId),
        eventsKey(args.roomId),
      ],
      [args.roomId, luaTemplate],
    ),
  );

  if (result.ok === 1 && typeof result.tag1 === "number") {
    return { recovered: true, sequence: result.tag1 };
  }
  if (result.ok === 0 && result.tag1 === "claim_active") {
    return { recovered: false, reason: "claim_active" };
  }
  if (result.ok === -1 && typeof result.tag1 === "string") {
    if (result.tag1 === "room_not_found") {
      throw new RoomNotFoundError(args.installationId, args.roomId);
    }
    throw new RoomTransitionInvalidStatusError(
      args.roomId,
      "recover_deciding",
      ["deciding"],
      result.tag1,
    );
  }
  throw new Error(
    `ROOM_RECOVER_DECIDING_SCRIPT returned unexpected result: ${JSON.stringify(result)}`,
  );
}

// ---------------------------------------------------------------------------
// Termination / close primitives (D.1.a-iii.c)
// ---------------------------------------------------------------------------

/**
 * Terminate a room — atomic close without claim. Called from the
 * watchdog (expired / failed_synthesis) AND from operator UI
 * (force_close / manual). Distinct from `closeRoomWithDecision`
 * which is the queen's clean synthesis-complete path.
 *
 * If the room is in `deciding`, the queen's claim is DELed so the
 * queen's mid-flight `closeRoomWithDecision` returns
 * `RoomCloseClaimLostError` and aborts the GitHub post.
 *
 * Idempotent on already-closed rooms: returns
 * `RoomAlreadyClosedError` instead of double-emitting a terminate
 * event. Caller chooses to swallow or surface.
 *
 * Status effects:
 *   - status flips to `closed`
 *   - closed_at = nowIso
 *   - closed_reason = args.reason
 *   - claim DELed if any
 *   - subject index DELed (releases per-installation subject lock)
 *   - removed from ALL secondary indexes (status / installation / repo)
 *   - sibling keys EXPIRE at retentionSecs
 *
 * Throws:
 *   - `RoomAlreadyClosedError` when status is already `closed`
 *   - `RoomNotFoundError` when the room hash is gone
 */
export async function terminateRoom(args: {
  installationId: string;
  roomId: string;
  reason: TerminalReason;
  /** Subject ref needed to compute the subject index key (the
   * subject lock to release). Caller-supplied because the room hash
   * stores subject_ref inside the `data` JSON blob — passing it
   * explicitly avoids a pre-EVAL HGETALL. */
  subject: SubjectRef;
  /** Source actor for the `room_terminated` event. System-driven
   * paths (watchdog / cron) use sentinel actors; operator UI uses
   * the bearer envelope's role+id. */
  actorRole: string;
  actorId: string;
  retentionSecs?: number;
  redis: Redis;
  nowMs?: number;
}): Promise<number> {
  validateSubjectRef(args.subject);

  const nowMs = args.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const retention = args.retentionSecs ?? ROOM_RETENTION_AFTER_CLOSE_SECS;

  const eventTemplate = JSON.stringify({
    seq: "__SEQ__",
    timestamp: nowIso,
    event_type: "room_terminated",
    actor_role: args.actorRole,
    actor_id: args.actorId,
    body: { reason: args.reason },
  });
  const luaTemplate = eventTemplate.replace('"__SEQ__"', "__SEQ__");

  const result = dispatchScriptResult(
    await args.redis.eval(
      ROOM_TERMINATE_SCRIPT,
      [
        roomKey(args.installationId, args.roomId),
        subjectLockKey(
          args.installationId,
          args.subject.type,
          args.subject.ref,
          args.roomId,
        ),
        // All non-terminal status sets — script SREMs each
        // idempotently. Closes #515 builder R1: a stale
        // caller-supplied currentStatus could SREM the wrong set
        // and leave phantom membership in the live one.
        //
        // Legacy `awaiting_rsvp` is included for one-time cleanup of
        // pre-heartbeat-model rooms still hanging around in that
        // index. The web watchdog also keeps `awaiting_rsvp` in its
        // expire-scan branch (web/src/server/queen-tick.ts) so those
        // rooms reach `terminateRoom` and trigger this SREM.
        //
        // TODO(post-deploy): once `max_age_secs` (default 1h) has
        // elapsed since the heartbeat-model deploy, no `awaiting_rsvp`
        // rooms remain in storage and this entry + the cast below
        // can be dropped (search "awaiting_rsvp" across the repo to
        // find all the cleanup paths to remove together).
        statusIndexKey(args.installationId, "awaiting_rsvp" as RoomStatus),
        statusIndexKey(args.installationId, "awaiting_contributions"),
        statusIndexKey(args.installationId, "deciding"),
        installationIndexKey(args.installationId),
        repoIndexKeyForSubject(args.installationId, args.subject.type, args.subject.ref),
        seqKey(args.roomId),
        eventsKey(args.roomId),
        participantsKey(args.roomId),
        contributionsKey(args.roomId),
        claimKey(args.roomId),
      ],
      [
        args.roomId,
        luaTemplate,
        nowIso,
        String(retention),
        args.reason,
      ],
    ),
  );

  if (result.ok === 1 && typeof result.tag1 === "number") {
    return result.tag1;
  }
  if (result.ok === -1 && typeof result.tag1 === "string") {
    if (result.tag1 === "room_not_found") {
      throw new RoomNotFoundError(args.installationId, args.roomId);
    }
    if (result.tag1 === "closed") {
      throw new RoomAlreadyClosedError(args.roomId, "closed");
    }
    // Defensive: any other status value would be a programming error
    // (TERMINATE allows ALL non-closed statuses); surface it loudly.
    throw new Error(
      `ROOM_TERMINATE_SCRIPT returned unexpected status: ${result.tag1}`,
    );
  }
  throw new Error(
    `ROOM_TERMINATE_SCRIPT returned unexpected result: ${JSON.stringify(result)}`,
  );
}

/**
 * Close a room with the queen's synthesized decision — happy-path
 * close that requires a live claim AND sequence consistency.
 *
 * The queen calls this AFTER `claimSynthesis` returns
 * `{throughSequence, claimTtlSecs}` and AFTER the queen's runtime
 * has produced a `RoomDecision`. The script verifies:
 *   1. Claim still exists (DEL'd → force-close raced; abort)
 *   2. Claim's `throughSequence` matches caller's expectation
 *      (mismatch → another runner re-claimed; abort)
 *   3. Live `seq` matches `expectedThroughSequence` (drift → new
 *      events arrived during synthesis; revert + retry)
 *
 * Drift handling: revert is atomic. The queen aborts its GitHub
 * post on `RoomCloseDriftError`, and the manager loop re-claims on
 * the next tick (the room's status is back at
 * `awaiting_contributions` — synthesis re-enters cleanly).
 *
 * Throws (each typed for caller decision):
 *   - `RoomCloseClaimLostError` — claim DELed (likely force-close);
 *     ABORT the GitHub post and surface terminal state to operator
 *   - `RoomCloseClaimThroughSeqMismatchError` — different runner
 *     re-claimed; ABORT, do NOT post
 *   - `RoomCloseDriftError` — sequence drift; revert is already
 *     applied, queen logs and exits, manager re-claims
 *   - `RoomClaimPayloadCorruptError` — claim payload corrupted;
 *     ABORT, operator inspects
 */
export async function closeRoomWithDecision(args: {
  installationId: string;
  roomId: string;
  /** Captured at claim time from `claimSynthesis(...).throughSequence`. */
  expectedThroughSequence: number;
  decision: RoomDecision;
  subject: SubjectRef;
  retentionSecs?: number;
  redis: Redis;
  nowMs?: number;
}): Promise<number> {
  validateSubjectRef(args.subject);
  validateRunnerFormat(args.decision.synthesis_runner);
  // BYTE length, not UTF-16 code-unit `.length`. A multi-byte
  // synthesis (emoji, non-ASCII narrative) can have `.length` < byte
  // budget while the actual storage payload exceeds 64 KiB. Closes
  // #515 builder R1 — file uses Buffer.byteLength elsewhere for
  // consistency (see ROOM_EVENT_BODY_MAX_BYTES enforcement at
  // assertEventBodySize).
  const decisionContentBytes = Buffer.byteLength(args.decision.content, "utf8");
  if (decisionContentBytes > 64 * 1024) {
    // Typed class (closes #519 guard N1) so the route layer can
    // map via `instanceof` instead of regex-matching the message.
    throw new RoomDecisionTooLargeError(decisionContentBytes);
  }

  const nowMs = args.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const retention = args.retentionSecs ?? ROOM_RETENTION_AFTER_CLOSE_SECS;

  // Top-level `seq` carries the sequence; body intentionally does
  // NOT duplicate it (would force an uncapped gsub and reintroduce
  // #510 B1 — user-content collision risk on the synthesis_runner
  // string). Consumers read seq from the event's top-level field.
  const eventTemplate = JSON.stringify({
    seq: "__SEQ__",
    timestamp: nowIso,
    event_type: "room_decided",
    actor_role: "manager",
    actor_id: args.decision.synthesis_runner,
    body: { synthesis_runner: args.decision.synthesis_runner },
  });
  const luaTemplate = eventTemplate.replace('"__SEQ__"', "__SEQ__");

  const result = dispatchScriptResult(
    await args.redis.eval(
      ROOM_CLOSE_SCRIPT,
      [
        roomKey(args.installationId, args.roomId),
        claimKey(args.roomId),
        seqKey(args.roomId),
        statusIndexKey(args.installationId, "deciding"),
        statusIndexKey(args.installationId, "awaiting_contributions"),
        subjectLockKey(
          args.installationId,
          args.subject.type,
          args.subject.ref,
          args.roomId,
        ),
        eventsKey(args.roomId),
        participantsKey(args.roomId),
        contributionsKey(args.roomId),
        installationIndexKey(args.installationId),
        repoIndexKeyForSubject(args.installationId, args.subject.type, args.subject.ref),
      ],
      [
        args.roomId,
        String(args.expectedThroughSequence),
        JSON.stringify(args.decision),
        luaTemplate,
        nowIso,
        String(retention),
      ],
    ),
  );

  if (result.ok === 1 && typeof result.tag1 === "number") {
    return result.tag1;
  }
  if (result.ok === -2 && typeof result.tag1 === "number") {
    throw new RoomCloseDriftError(
      args.roomId,
      args.expectedThroughSequence,
      result.tag1,
    );
  }
  if (result.ok === -3 && typeof result.tag1 === "string") {
    if (result.tag1 === "claim_lost") {
      throw new RoomCloseClaimLostError(args.roomId);
    }
    if (result.tag1 === "decode_error") {
      throw new RoomClaimPayloadCorruptError(args.roomId);
    }
    if (result.tag1 === "claim_throughSeq_mismatch") {
      const actual =
        typeof result.tag2 === "number" ? result.tag2 : -1;
      throw new RoomCloseClaimThroughSeqMismatchError(
        args.roomId,
        args.expectedThroughSequence,
        actual,
      );
    }
  }
  throw new Error(
    `ROOM_CLOSE_SCRIPT returned unexpected result: ${JSON.stringify(result)}`,
  );
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
  // Upstash auto-parses JSON when stored values are JSON strings and
  // the response type generic isn't `string[]`. Defensive: accept
  // both shapes (raw string from the ZADD path; object after auto-parse).
  return raw.map((s) =>
    typeof s === "string" ? (JSON.parse(s) as RoomEvent) : (s as unknown as RoomEvent),
  );
}

/**
 * Read the N most-recent events for a room, returned in chronological
 * order (oldest-first within the returned slice).
 *
 * For dashboards / detail views that want to surface recent activity
 * (close, recovery, subject_updated, latest contributions). Distinct
 * from `listRoomEvents` which reads forward from `since` and would
 * return the OLDEST events for a room with more than `limit` events.
 *
 * Uses ZRANGE BYSCORE with `rev: true` to fetch the highest-scored
 * `limit` entries (newest seq), then reverses client-side to deliver
 * chronological order so callers can render top-down naturally.
 */
export async function listRecentRoomEvents(args: {
  roomId: string;
  limit?: number;
  redis: Redis;
}): Promise<RoomEvent[]> {
  const limit = args.limit ?? 200;
  const raw = await args.redis.zrange<string[]>(
    eventsKey(args.roomId),
    "+inf",
    0,
    {
      byScore: true,
      rev: true,
      offset: 0,
      count: limit,
    },
  );
  // ZREVRANGE returns newest-first; reverse for chronological
  // delivery so callers don't need to know about the rev: detail.
  // Upstash auto-parses JSON when stored values are JSON strings and
  // the response type generic isn't `string[]`. Accept both shapes.
  return raw
    .map((s) =>
      typeof s === "string" ? (JSON.parse(s) as RoomEvent) : (s as unknown as RoomEvent),
    )
    .reverse();
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

// ---------------------------------------------------------------------------
// Worker visibility (D.1.b-iii)
// ---------------------------------------------------------------------------

/**
 * Decide whether a role can act on a room — used by GET
 * /api/rooms/watching to filter the list to rooms a worker bearer
 * should attend to.
 *
 * Per WAR_ROOM_DESIGN.md L780-790, /watching surfaces rooms where
 * the role is EITHER:
 *   - Not yet a participant (eligible to RSVP)
 *   - A participant whose work is incomplete (still needs to
 *     contribute or react to a subject change)
 *
 * Excluded:
 *   - `resolved` — already contributed; no further action needed
 *   - `timed_out` — terminal, watcher has nothing to do
 *   - `withdrew` AT current sequence — withdrew with no new events
 *     since (re-RSVP only on subject_updated post-withdrawal)
 *
 * Closed/terminated rooms are excluded by the caller's status filter
 * (this predicate assumes the room is open).
 */
export function canRoleRsvpToRoom(args: {
  participants: Record<string, RoomParticipant>;
  bearerRole: string;
  currentSequence: number;
}): boolean {
  const slot = args.participants[args.bearerRole];
  if (!slot) {
    // No participant entry yet — role can still RSVP fresh.
    return true;
  }
  switch (slot.status) {
    case "pending":
      // Still in the contribution window — visible.
      return true;
    case "resolved":
      // Already contributed — done, hide from watching.
      return false;
    case "timed_out":
      // Terminal for this role — watchdog already moved on.
      return false;
    case "withdrew":
      // Re-RSVP gated on new events past withdrew_at_sequence
      // (closes design L780-783). If withdrew_at_sequence is
      // unset we conservatively treat the slot as not-visible
      // (the field is set by transitionRoomParticipant on withdraw,
      // so absence means a malformed slot — fail closed).
      if (typeof slot.withdrew_at_sequence !== "number") return false;
      return args.currentSequence > slot.withdrew_at_sequence;
    default:
      // Defensive: an unknown status (future enum addition) is
      // hidden. The caller's status filter should also have
      // excluded the room, but belt + braces.
      return false;
  }
}
