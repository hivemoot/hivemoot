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
export declare const ROOM_PREFIX = "hive:v1:room:";
/**
 * Default room lifetime before auto-expiry. The subject-uniqueness
 * index TTL matches this so a stalled-recovery scenario can't
 * permanently block new rooms (Queen R3 #3).
 */
export declare const DEFAULT_MAX_AGE_SECS = 3600;
/**
 * Retention window after a room closes. The room hash + sibling keys
 * are TTL'd to this; secondary indexes are explicitly cleaned (see
 * Queen R2 #2 — closed rooms must be ZREM'd from the installation
 * index, not just removed from the status set).
 */
export declare const ROOM_RETENTION_AFTER_CLOSE_SECS: number;
export declare function roomKey(installationId: string, roomId: string): string;
export declare function eventsKey(roomId: string): string;
export declare function participantsKey(roomId: string): string;
export declare function contributionsKey(roomId: string): string;
export declare function seqKey(roomId: string): string;
export declare function claimKey(roomId: string): string;
export declare function idemKey(roomId: string, idempotencyKey: string): string;
export declare function subjectIndexKey(installationId: string, subjectType: SubjectType, subjectRef: string): string;
export declare function installationIndexKey(installationId: string): string;
export declare function statusIndexKey(installationId: string, status: RoomStatus): string;
export declare function repoIndexKey(installationId: string, repo: string): string;
export declare function roomLockKey(installationId: string, roomId: string): string;
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
export type RoomStatus = "awaiting_contributions" | "deciding" | "closed" | "expired";
/** Subject classes V1 supports. New types require backend
 * regex validation per `subject_ref` shape. */
export type SubjectType = "pr_review" | "mention_response" | "issue_triage";
/** Reason a room reached a terminal state via the
 * `ROOM_TERMINATE_SCRIPT` path (vs the queen's happy-path close). */
export type TerminalReason = "expired" | "failed_synthesis" | "force_close" | "manual";
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
     * has lapsed gets dropped by the watchdog. Default 600 (10m).
     *
     * Replaces the deprecated `rsvp_deadline_secs` /
     * `contribution_deadline_secs` pair from the pre-heartbeat model.
     * Agents heartbeat at their own cadence; the server only enforces
     * this drop threshold. */
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
    opened_at: string;
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
    synthesized_at: string;
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
    timestamp: string;
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
export type RoomEventType = "room_opened" | "participant_presented" | "participant_timed_out" | "participant_withdrawn" | "contribution_submitted" | "contribution_withdrawn" | "room_decided" | "room_recovered" | "room_terminated" | "subject_updated" | "queen_question";
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
export declare class RoomSubjectAlreadyOpenError extends Error {
    readonly installationId: string;
    readonly subjectType: SubjectType;
    readonly subjectRef: string;
    readonly existingRoomId: string;
    constructor(installationId: string, subjectType: SubjectType, subjectRef: string, existingRoomId: string);
}
export declare class RoomNotFoundError extends Error {
    readonly installationId: string;
    readonly roomId: string;
    constructor(installationId: string, roomId: string);
}
export declare class RoomSubjectRefError extends Error {
    readonly subjectType: SubjectType;
    readonly subjectRef: string;
    constructor(subjectType: SubjectType, subjectRef: string, expected: string);
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
export declare class RoomIdFormatError extends Error {
    readonly roomId: string;
    constructor(roomId: string);
}
/**
 * Thrown when ROOM_OPEN finds the roomKey already populated. Distinct
 * from RoomSubjectAlreadyOpenError (which fires on the subject-uniqueness
 * index) — this catches the rare-but-possible UUIDv4 reuse, OR a
 * roomId being submitted twice for different subjects. Closes #509
 * guard R1 G3 (second compounding issue: no EXISTS check on roomKey).
 */
export declare class RoomIdTakenError extends Error {
    readonly installationId: string;
    readonly roomId: string;
    constructor(installationId: string, roomId: string);
}
export declare function validateSubjectRef(subject: SubjectRef): void;
/** Extract the `{owner}/{repo}` prefix from a subject_ref so callers
 * can populate the per-repo index. Assumes `validateSubjectRef` has
 * already run; falls back to empty string if format is unexpected. */
export declare function repoFromSubjectRef(ref: string): string;
export declare function validateRoomId(roomId: string): void;
export declare function validateRunnerFormat(runner: string): void;
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
export declare const ROOM_OPEN_SCRIPT = "\nlocal existingRoomId = redis.call(\"get\", KEYS[1])\nif existingRoomId then\n  return {0, \"subject_taken\", existingRoomId}\nend\n\nif redis.call(\"exists\", KEYS[2]) == 1 then\n  return {0, \"room_id_taken\", ARGV[1]}\nend\n\n-- Reserve the subject-uniqueness slot first (TTL'd so a stalled\n-- recovery can't permanently block new rooms \u2014 closes Queen R3 #3).\nredis.call(\"set\", KEYS[1], ARGV[1], \"EX\", tonumber(ARGV[6]))\n\n-- Write the room hash: data field (JSON blob) + status field\n-- (separate string, mutated by transition scripts via single-field\n-- HSET per design L346).\nredis.call(\"hset\", KEYS[2], \"data\", ARGV[2])\nredis.call(\"hset\", KEYS[2], \"status\", ARGV[3])\n\n-- Initialize the sequence counter directly to 1 (matches design L303;\n-- one fewer Redis call than SET 0 + INCR).\nredis.call(\"set\", KEYS[3], 1)\n\n-- The opening event lands at seq=1 with score matching the sequence\n-- so ZRANGE returns events in order.\nredis.call(\"zadd\", KEYS[4], 1, ARGV[4])\n\n-- Status + installation + repo indexes. Updated on every transition;\n-- the close path SREM/ZREM cleans them all (see ROOM_CLOSE_SCRIPT).\nredis.call(\"sadd\", KEYS[5], ARGV[1])\nredis.call(\"zadd\", KEYS[6], tonumber(ARGV[5]), ARGV[1])\nredis.call(\"sadd\", KEYS[7], ARGV[1])\n\nreturn {1, ARGV[1]}\n";
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
export declare function createRoom(args: {
    installationId: string;
    roomId: string;
    manager: string;
    subject: SubjectRef;
    timing?: Partial<TimingConfig>;
    redis: Redis;
    nowMs?: number;
}): Promise<RoomCore>;
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
export declare function getRoomCore(args: {
    installationId: string;
    roomId: string;
    redis: Redis;
}): Promise<RoomCore>;
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
export declare function listRooms(args: {
    installationId: string;
    redis: Redis;
    limit?: number;
}): Promise<RoomCoreWithId[]>;
/** Per WAR_ROOM_DESIGN.md: event body bounded ≤ 8 KiB serialized.
 * Larger payloads belong in the contribution `raw_md` (32 KiB) or
 * external storage with a reference. Enforced at append time so a
 * runaway event can't fill the per-room sorted set. */
export declare const ROOM_EVENT_BODY_MAX_BYTES: number;
/** Per WAR_ROOM_DESIGN.md: contribution `raw_md` bounded ≤ 32 KiB.
 * Markdown that exceeds belongs in a gist or attached file with the
 * URL in the contribution body. */
export declare const ROOM_CONTRIBUTION_RAW_MD_MAX_BYTES: number;
/** Multiplier for idempotency-reverse-index TTL relative to the room's
 * `max_age_secs`. The idem TTL must outlive any reasonable client
 * retry window but expire well before the room's 30-day post-close
 * retention so a stale replay can't resolve months later.
 *   max_age_secs default 3600 → idem TTL default 7200 (2 h). */
export declare const IDEM_TTL_MULTIPLIER = 2;
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
export declare const SYNTHESIS_CLAIM_TTL_SECS = 360;
/** Contribution body bounds per WAR_ROOM_DESIGN.md L1166-1188. */
export declare const CONTRIBUTION_SUMMARY_MAX_CHARS = 500;
export declare const CONTRIBUTION_FINDING_AREA_MAX_CHARS = 80;
export declare const CONTRIBUTION_FINDING_DETAIL_MAX_CHARS = 2000;
export declare const CONTRIBUTION_FINDINGS_MAX_COUNT = 20;
/**
 * Verdict enum for contribution bodies. UPPERCASE per
 * WAR_ROOM_DESIGN.md §"silent downgrade trap" — the synthesis path
 * applies a structural DOWNGRADE-only invariant and must reject
 * malformed/typo'd verdicts at the boundary rather than silently
 * defaulting to COMMENT.
 */
export type ContributionVerdict = "APPROVE" | "COMMENT" | "CONCERNS" | "REQUEST_CHANGES";
export type ContributionFindingSeverity = "blocker" | "warning" | "info";
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
 * Structured contribution body. Bounded fields, enforced enums, and
 * a hard `verdict` requirement so the queen synthesis can rely on
 * the body being well-formed. Validated at submit time via
 * `validateContributionBody` — violations throw
 * `ContributionValidationError` BEFORE any storage write.
 */
export interface ContributionBody {
    verdict: ContributionVerdict;
    /** 1-500 chars. */
    summary: string;
    /** ≤20 items. */
    findings?: ContributionFinding[];
    severity_counts?: {
        blocker?: number;
        warning?: number;
        info?: number;
    };
}
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
export declare class RoomEventStatusPreconditionError extends Error {
    readonly roomId: string;
    readonly expectedFrom: string;
    readonly actualStatus: string;
    constructor(roomId: string, expectedFrom: string, actualStatus: string);
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
export declare class RoomEventIdempotencyReplayError extends Error {
    readonly roomId: string;
    readonly existingSequence: number;
    constructor(roomId: string, existingSequence: number);
}
/** Event body exceeded `ROOM_EVENT_BODY_MAX_BYTES` (8 KiB serialized). */
export declare class RoomEventBodyTooLargeError extends Error {
    readonly sizeBytes: number;
    constructor(sizeBytes: number);
}
/** Contribution `raw_md` exceeded `ROOM_CONTRIBUTION_RAW_MD_MAX_BYTES` (32 KiB). */
export declare class RoomContributionTooLargeError extends Error {
    readonly sizeBytes: number;
    constructor(sizeBytes: number);
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
export declare class RoomDecisionTooLargeError extends Error {
    readonly sizeBytes: number;
    constructor(sizeBytes: number);
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
export declare class RoomClaimAlreadyHeldError extends Error {
    readonly roomId: string;
    readonly heldByRunner: string;
    readonly throughSequence: number;
    constructor(roomId: string, heldByRunner: string, throughSequence: number);
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
export declare class RoomTransitionInvalidStatusError extends Error {
    readonly roomId: string;
    readonly action: string;
    readonly expectedStatuses: RoomStatus[];
    readonly actualStatus: string;
    constructor(roomId: string, action: string, expectedStatuses: RoomStatus[], actualStatus: string);
}
/**
 * Thrown when a Lua script's `cjson.decode` fails on a stored claim
 * payload (corrupted/partial-write/manual ops intervention). Closes
 * #512 guard N2: even the defensive `already_claimed` branch shouldn't
 * panic on payload corruption — the script returns `{-3, "decode_error"}`
 * and the caller surfaces this typed error so an operator can DEL the
 * claim key out-of-band.
 */
export declare class RoomClaimPayloadCorruptError extends Error {
    readonly roomId: string;
    constructor(roomId: string);
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
export declare class RoomAlreadyClosedError extends Error {
    readonly roomId: string;
    readonly status: RoomStatus;
    constructor(roomId: string, status: RoomStatus);
}
/**
 * Thrown by `closeRoomWithDecision` when the synthesis claim has
 * been DELed out from under the queen runner — typically by an
 * `force_close` TERMINATE racing the queen's `/close`. The queen
 * MUST abort the GitHub posting and let the operator's force-close
 * stand (per design L508).
 */
export declare class RoomCloseClaimLostError extends Error {
    readonly roomId: string;
    constructor(roomId: string);
}
/**
 * Thrown by `closeRoomWithDecision` when the claim record's stored
 * `throughSequence` doesn't match the caller's `expectedThroughSequence`.
 * Indicates a different runner re-claimed the room since this caller
 * acquired the claim — should never happen in normal flow (claim TTL
 * + atomic acquisition prevents it) but the script defends against
 * partial-write desync.
 */
export declare class RoomCloseClaimThroughSeqMismatchError extends Error {
    readonly roomId: string;
    readonly expectedThroughSequence: number;
    readonly actualThroughSequence: number;
    constructor(roomId: string, expectedThroughSequence: number, actualThroughSequence: number);
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
export declare class RoomCloseDriftError extends Error {
    readonly roomId: string;
    readonly expectedThroughSequence: number;
    readonly lastSeq: number;
    constructor(roomId: string, expectedThroughSequence: number, lastSeq: number);
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
export declare class RoomRunnerFormatError extends Error {
    readonly invalidRunner: string;
    constructor(invalidRunner: string, reason: string);
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
export declare class RoomParticipantStatePreconditionError extends Error {
    readonly roomId: string;
    readonly role: string;
    readonly allowedStates: string[];
    readonly actualState: string;
    constructor(roomId: string, role: string, allowedStates: string[], actualState: string);
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
export declare class RoomParticipantNotFoundError extends Error {
    readonly roomId: string;
    readonly role: string;
    constructor(roomId: string, role: string);
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
export declare class RoomParticipantOwnerConflictError extends Error {
    readonly roomId: string;
    readonly role: string;
    readonly existingAgentId: string;
    readonly attemptedAgentId: string;
    constructor(roomId: string, role: string, existingAgentId: string, attemptedAgentId: string);
}
/**
 * Thrown when a contribution body fails schema validation at the
 * boundary. Carries the offending field name + reason so the route
 * layer can surface a structured 400 with per-field error codes
 * (`MISSING_VERDICT`, `INVALID_VERDICT`, `SUMMARY_TOO_LONG`, etc.
 * per WAR_ROOM_DESIGN.md L1187).
 */
export declare class ContributionValidationError extends Error {
    readonly field: string;
    readonly value: unknown;
    constructor(field: string, value: unknown, expected: string);
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
export declare function validateContributionBody(body: ContributionBody): void;
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
export declare function deriveIdempotencyKey(args: {
    roomId: string;
    role: string;
    action: RoomEventAction;
    sequenceObservedByClient: number;
    /** Per-runner identity for subscriber-mode idem-lane separation
     * (#522). Omit for non-RSVP actions where there's no per-runner
     * concept. */
    agentId?: string;
}): string;
/** Action vocabulary for idempotency derivation. Distinct from
 * `RoomEventType` because two event types can share the same
 * action lane (e.g., `participant_presented` and a future
 * `participant_re_presented` would both be `present`). */
export type RoomEventAction = "present" | "withdraw_participant" | "contribute" | "withdraw_contribution" | "timeout" | "decide" | "close" | "subject_updated" | "queen_question";
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
export declare const ROOM_APPEND_EVENT_SCRIPT = "\nif ARGV[2] ~= \"\" then\n  local existing = redis.call(\"get\", KEYS[3])\n  if existing then return {-1, tonumber(existing)} end\nend\nlocal currStatus = redis.call(\"hget\", KEYS[4], \"status\")\nif not currStatus then return {-3, \"room_not_found\"} end\nif ARGV[8] ~= \"\" then\n  local found = false\n  for s in string.gmatch(ARGV[8], \"[^,]+\") do\n    if s == currStatus then found = true; break end\n  end\n  if not found then return {-2, currStatus} end\nend\nif ARGV[4] ~= \"\" then\n  local existingMat = redis.call(\"hget\", KEYS[5], ARGV[4])\n  if existingMat then\n    local parsed = cjson.decode(existingMat)\n    if parsed.agent_id ~= ARGV[5] and parsed.status ~= \"withdrew\" then\n      return {-4, \"owner_conflict\", parsed.agent_id}\n    end\n  end\nend\nlocal seq = redis.call(\"incr\", KEYS[1])\nlocal eventJson = string.gsub(ARGV[1], \"__SEQ__\", tostring(seq), 1)\nredis.call(\"zadd\", KEYS[2], seq, eventJson)\nif ARGV[2] ~= \"\" then\n  redis.call(\"set\", KEYS[3], tostring(seq), \"EX\", tonumber(ARGV[11]))\nend\nif ARGV[6] ~= \"\" then\n  local mat1 = ARGV[7]\n  -- Opt-in seq substitution. Off-by-default so user-controlled\n  -- materialized content (e.g. contribution bodies whose summary\n  -- contains the literal \"__SEQ__\") cannot be silently rewritten.\n  -- Caller sets ARGV[14]=\"1\" for the withdraw-participant path\n  -- where withdrew_at_sequence MUST be the actual sequence number.\n  if ARGV[14] == \"1\" then\n    mat1 = string.gsub(mat1, \"__SEQ__\", tostring(seq), 1)\n  end\n  redis.call(\"hset\", KEYS[6], ARGV[6], mat1)\nend\nif ARGV[12] ~= \"\" then\n  local mat2 = ARGV[13]\n  if ARGV[15] == \"1\" then\n    mat2 = string.gsub(mat2, \"__SEQ__\", tostring(seq), 1)\n  end\n  redis.call(\"hset\", KEYS[9], ARGV[12], mat2)\nend\nif ARGV[9] ~= \"\" then\n  redis.call(\"hset\", KEYS[4], \"status\", ARGV[9])\n  redis.call(\"srem\", KEYS[7], ARGV[10])\n  redis.call(\"sadd\", KEYS[8], ARGV[10])\nend\nreturn {seq}\n";
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
export declare const ROOM_PARTICIPANT_TRANSITION_SCRIPT = "\nif ARGV[2] ~= \"\" then\n  local existing = redis.call(\"get\", KEYS[3])\n  if existing then return {-1, tonumber(existing)} end\nend\nlocal currStatus = redis.call(\"hget\", KEYS[4], \"status\")\nif not currStatus then return {-3, \"room_not_found\"} end\nif ARGV[7] ~= \"\" then\n  local found = false\n  for s in string.gmatch(ARGV[7], \"[^,]+\") do\n    if s == currStatus then found = true; break end\n  end\n  if not found then return {-2, currStatus} end\nend\nlocal existingP = redis.call(\"hget\", KEYS[5], ARGV[4])\nif not existingP then return {-5, \"no_participant\"} end\nlocal p = cjson.decode(existingP)\nif ARGV[5] == \"1\" and p.agent_id ~= ARGV[6] then\n  return {-4, \"owner_conflict\", p.agent_id}\nend\n-- Participant-state precondition (closes #510 builder R3): each\n-- transition is gated on the participant's current status so a\n-- stale watchdog scan can't run timeout against an already-resolved\n-- slot, and submitContribution can't reach into withdrew/timed_out\n-- slots without a fresh /present.\nif ARGV[13] ~= \"\" then\n  local found = false\n  for s in string.gmatch(ARGV[13], \"[^,]+\") do\n    if s == p.status then found = true; break end\n  end\n  if not found then\n    return {-6, \"participant_state_precondition\", p.status}\n  end\nend\nlocal seq = redis.call(\"incr\", KEYS[1])\nlocal eventJson = string.gsub(ARGV[1], \"__SEQ__\", tostring(seq), 1)\nredis.call(\"zadd\", KEYS[2], seq, eventJson)\nif ARGV[2] ~= \"\" then\n  redis.call(\"set\", KEYS[3], tostring(seq), \"EX\", tonumber(ARGV[9]))\nend\nlocal transform = ARGV[10]\nif transform == \"resolve\" then\n  p.status = \"resolved\"\n  p.resolved_at = ARGV[11]\n  p.withdrew_at_sequence = nil\n  redis.call(\"hset\", KEYS[5], ARGV[4], cjson.encode(p))\nelseif transform == \"withdraw\" then\n  p.status = \"withdrew\"\n  p.resolved_at = ARGV[11]\n  p.withdrew_at_sequence = seq\n  redis.call(\"hset\", KEYS[5], ARGV[4], cjson.encode(p))\nelseif transform == \"timeout\" then\n  p.status = \"timed_out\"\n  p.resolved_at = ARGV[11]\n  redis.call(\"hset\", KEYS[5], ARGV[4], cjson.encode(p))\nend\nif ARGV[12] ~= \"\" then\n  redis.call(\"hset\", KEYS[6], ARGV[4], ARGV[12])\nend\nreturn {seq}\n";
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
export declare const ROOM_DECIDE_CLAIM_SCRIPT = "\nlocal currStatus = redis.call(\"hget\", KEYS[1], \"status\")\nif not currStatus then return {-1, \"room_not_found\"} end\nif currStatus ~= \"awaiting_contributions\" then\n  return {-1, currStatus}\nend\nlocal existingClaim = redis.call(\"get\", KEYS[2])\nif existingClaim then\n  local ok, parsed = pcall(cjson.decode, existingClaim)\n  if not ok then return {-3, \"decode_error\"} end\n  return {0, \"already_claimed\", cjson.encode({runner = parsed.runner, throughSequence = parsed.throughSequence})}\nend\nlocal seq = redis.call(\"get\", KEYS[5])\nif not seq then return {-1, \"no_seq\"} end\nlocal seqNum = tonumber(seq)\nlocal claimJson = cjson.encode({runner = ARGV[2], throughSequence = seqNum})\nredis.call(\"set\", KEYS[2], claimJson, \"EX\", tonumber(ARGV[3]))\nredis.call(\"hset\", KEYS[1], \"status\", \"deciding\", \"deciding_through_sequence\", tostring(seqNum))\nredis.call(\"srem\", KEYS[3], ARGV[1])\nredis.call(\"sadd\", KEYS[4], ARGV[1])\nreturn {1, seqNum}\n";
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
export declare const ROOM_RECOVER_DECIDING_SCRIPT = "\nlocal currStatus = redis.call(\"hget\", KEYS[1], \"status\")\nif not currStatus then return {-1, \"room_not_found\"} end\nif currStatus ~= \"deciding\" then\n  return {-1, currStatus}\nend\nif redis.call(\"exists\", KEYS[2]) == 1 then\n  return {0, \"claim_active\"}\nend\nlocal seq = redis.call(\"incr\", KEYS[5])\nlocal eventJson = string.gsub(ARGV[2], \"__SEQ__\", tostring(seq), 1)\nredis.call(\"zadd\", KEYS[6], seq, eventJson)\nredis.call(\"hset\", KEYS[1], \"status\", \"awaiting_contributions\", \"deciding_through_sequence\", \"\")\nredis.call(\"srem\", KEYS[3], ARGV[1])\nredis.call(\"sadd\", KEYS[4], ARGV[1])\nreturn {1, seq}\n";
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
export declare const ROOM_TERMINATE_SCRIPT = "\nlocal currStatus = redis.call(\"hget\", KEYS[1], \"status\")\nif not currStatus then return {-1, \"room_not_found\"} end\nif currStatus == \"closed\" then\n  return {-1, currStatus}\nend\nredis.call(\"del\", KEYS[12])\nlocal seq = redis.call(\"incr\", KEYS[8])\nlocal eventJson = string.gsub(ARGV[2], \"__SEQ__\", tostring(seq), 1)\nredis.call(\"zadd\", KEYS[9], seq, eventJson)\nredis.call(\"hset\", KEYS[1], \"status\", \"closed\",\n                          \"closed_at\", ARGV[3],\n                          \"closed_reason\", ARGV[5])\nredis.call(\"del\", KEYS[2])\nredis.call(\"srem\", KEYS[3], ARGV[1])\nredis.call(\"srem\", KEYS[4], ARGV[1])\nredis.call(\"srem\", KEYS[5], ARGV[1])\nredis.call(\"zrem\", KEYS[6], ARGV[1])\nredis.call(\"srem\", KEYS[7], ARGV[1])\nlocal retention = tonumber(ARGV[4])\nredis.call(\"expire\", KEYS[1], retention)\nredis.call(\"expire\", KEYS[8], retention)\nredis.call(\"expire\", KEYS[9], retention)\nredis.call(\"expire\", KEYS[10], retention)\nredis.call(\"expire\", KEYS[11], retention)\nreturn {1, seq}\n";
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
export declare const ROOM_CLOSE_SCRIPT = "\nlocal claim = redis.call(\"get\", KEYS[2])\nif not claim then return {-3, \"claim_lost\"} end\nlocal ok, parsed = pcall(cjson.decode, claim)\nif not ok then return {-3, \"decode_error\"} end\nlocal claimThroughSeq = tonumber(parsed.throughSequence)\nlocal expectedThroughSeq = tonumber(ARGV[2])\nif claimThroughSeq ~= expectedThroughSeq then\n  return {-3, \"claim_throughSeq_mismatch\", claimThroughSeq}\nend\nlocal lastSeq = tonumber(redis.call(\"get\", KEYS[3])) or 0\nif lastSeq ~= expectedThroughSeq then\n  -- Drift: new events arrived during synthesis. Revert atomically\n  -- (closes design B2: prior implementation orphaned rooms from\n  -- both deciding and awaiting_contributions sets, making them\n  -- invisible to subsequent ticks).\n  redis.call(\"del\", KEYS[2])\n  redis.call(\"hset\", KEYS[1], \"status\", \"awaiting_contributions\",\n                            \"deciding_through_sequence\", \"\")\n  redis.call(\"srem\", KEYS[4], ARGV[1])\n  redis.call(\"sadd\", KEYS[5], ARGV[1])\n  return {-2, lastSeq}\nend\nlocal closedSeq = lastSeq + 1\nlocal closedEventJson = string.gsub(ARGV[4], \"__SEQ__\", tostring(closedSeq), 1)\nredis.call(\"hset\", KEYS[1], \"status\", \"closed\",\n                          \"decision\", ARGV[3],\n                          \"closed_at\", ARGV[5])\nredis.call(\"zadd\", KEYS[7], closedSeq, closedEventJson)\nredis.call(\"set\", KEYS[3], tostring(closedSeq))\nredis.call(\"del\", KEYS[2])\nredis.call(\"del\", KEYS[6])\nredis.call(\"srem\", KEYS[4], ARGV[1])\nredis.call(\"zrem\", KEYS[10], ARGV[1])\nredis.call(\"srem\", KEYS[11], ARGV[1])\nlocal retention = tonumber(ARGV[6])\nredis.call(\"expire\", KEYS[1], retention)\nredis.call(\"expire\", KEYS[3], retention)\nredis.call(\"expire\", KEYS[7], retention)\nredis.call(\"expire\", KEYS[8], retention)\nredis.call(\"expire\", KEYS[9], retention)\nreturn {1, closedSeq}\n";
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
export declare function validateRoleFormat(role: string): void;
/** Thrown by `validateRoleFormat` on a malformed body-supplied role. */
export declare class RoomRoleFormatError extends Error {
    readonly invalidRole: unknown;
    constructor(invalidRole: unknown);
}
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
        field: string;
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
export declare function appendRoomEvent(args: AppendRoomEventArgs): Promise<number>;
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
export declare function transitionRoomParticipant(args: TransitionRoomParticipantArgs): Promise<number>;
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
export declare function presentParticipant(args: RSVPCommonArgs & {
    intentHint?: string;
}): Promise<number>;
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
export declare function withdrawParticipant(args: RSVPCommonArgs & {
    reason?: string;
}): Promise<number>;
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
export declare function submitContribution(args: RSVPCommonArgs & {
    body: ContributionBody;
    rawMd: string;
}): Promise<number>;
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
export declare function withdrawContribution(args: RSVPCommonArgs & {
    reason?: string;
}): Promise<number>;
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
export declare function timeoutParticipant(args: {
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
}): Promise<number>;
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
export declare function claimSynthesis(args: {
    installationId: string;
    roomId: string;
    /** Opaque queen runner identity (hostname + pid + monotonic).
     * Stored in the claim record so observers know who holds it.
     * Boundary-validated via `validateRunnerFormat` (closes #512
     * guard N6: defense-in-depth against gsub-sentinel collision). */
    queenRunner: string;
    claimTtlSecs?: number;
    redis: Redis;
}): Promise<ClaimSynthesisResult>;
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
export declare function recoverDeciding(args: {
    installationId: string;
    roomId: string;
    redis: Redis;
    nowMs?: number;
}): Promise<{
    recovered: true;
    sequence: number;
} | {
    recovered: false;
    reason: "claim_active";
}>;
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
export declare function terminateRoom(args: {
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
}): Promise<number>;
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
export declare function closeRoomWithDecision(args: {
    installationId: string;
    roomId: string;
    /** Captured at claim time from `claimSynthesis(...).throughSequence`. */
    expectedThroughSequence: number;
    decision: RoomDecision;
    subject: SubjectRef;
    retentionSecs?: number;
    redis: Redis;
    nowMs?: number;
}): Promise<number>;
/**
 * Read events from a room's append-only log, ordered by sequence.
 * `since` filters to events with `seq > since` (caller's last-seen
 * cursor). `limit` defaults to 200 — large enough for the typical
 * room (event count is bounded by the soft contribution deadline).
 */
export declare function listRoomEvents(args: {
    roomId: string;
    since?: number;
    limit?: number;
    redis: Redis;
}): Promise<RoomEvent[]>;
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
export declare function listRecentRoomEvents(args: {
    roomId: string;
    limit?: number;
    redis: Redis;
}): Promise<RoomEvent[]>;
/** Read all participants for a room, keyed by role. Returns `{}`
 * for rooms with no participants yet (or rooms that don't exist —
 * caller should `getRoomCore` separately if existence is meaningful). */
export declare function getRoomParticipants(args: {
    roomId: string;
    redis: Redis;
}): Promise<Record<string, RoomParticipant>>;
/** Read all contributions for a room, keyed by role. Same shape as
 * `getRoomParticipants` — `{}` for empty / nonexistent. */
export declare function getRoomContributions(args: {
    roomId: string;
    redis: Redis;
}): Promise<Record<string, RoomContribution>>;
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
export declare function canRoleRsvpToRoom(args: {
    participants: Record<string, RoomParticipant>;
    bearerRole: string;
    currentSequence: number;
}): boolean;
export {};
//# sourceMappingURL=war-room.d.ts.map