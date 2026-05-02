/**
 * Wire types for the hivemoot.dev war-room HTTP API. Mirrors the
 * server shapes in `web/src/server/war-room.ts` so the CLI's parsed
 * response is structurally identical to what the server emits.
 *
 * Only the fields the CLI consumes are modelled. Optional fields
 * (`closed_at`, `closed_reason`, `decision`, etc.) are typed as
 * `?` — present only on rooms that have reached the relevant
 * lifecycle state.
 */

export type RoomStatus =
  | "awaiting_contributions"
  | "deciding"
  | "closed"
  | "expired";

export type SubjectType = "pr_review" | "mention_response" | "issue_triage";

/** Reason a room reached a terminal state via the
 * `ROOM_TERMINATE_SCRIPT` path (vs the queen's happy-path close).
 * Mirrors `TerminalReason` in `web/src/server/war-room.ts`. */
export type TerminalReason =
  | "expired"
  | "failed_synthesis"
  | "force_close"
  | "manual";

export interface TimingConfig {
  max_age_secs: number;
  drop_threshold_secs: number;
  quiet_period_secs: number;
}

export interface RoomDecision {
  synthesized_at: string;
  synthesis_runner: string;
  content: string;
  sequence_closed: number;
}

/**
 * Base room core shape — what `GET /api/rooms/{roomId}` returns.
 * Matches `RoomCore` on the server side (no `roomId` field; the
 * caller already knows it from the request URL).
 */
export interface RoomCore {
  manager: string;
  subject_type: SubjectType;
  subject_ref: string;
  opened_at: string;
  timing_config: TimingConfig;
  status: RoomStatus;
  closed_at?: string;
  closed_reason?: TerminalReason;
  deciding_through_sequence?: number;
  decision?: RoomDecision;
}

/**
 * Shape returned by `GET /api/rooms` (one entry per room). Matches
 * `RoomCoreWithId` on the server side — `RoomCore` plus the room's
 * own id so callers can correlate without a second round-trip.
 */
export interface ListedRoom extends RoomCore {
  roomId: string;
}

export interface ListRoomsResponse {
  rooms: ListedRoom[];
}

/**
 * Event classes the server emits. Mirrors `RoomEventType` in
 * `web/src/server/war-room.ts:322-337`. CLI keeps a closed union
 * for editor IntelliSense + grep-discoverability, but at parse time
 * an unknown server-supplied value still flows through unchanged
 * (the CLI never re-validates the type — it just renders whatever
 * the server emits).
 */
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
  | "subject_updated"
  | "queen_question";

/**
 * Single entry from `GET /api/rooms/{roomId}/events`. Mirrors
 * `RoomEvent` in `web/src/server/war-room.ts:296-319` exactly —
 * `actor_role` + `actor_id` are server-derived from the bearer's
 * envelope (with sentinel values for system actors like the cron
 * watchdog: `actor_role="manager"|"system"`, `actor_id="watchdog"|
 * "vercel-cron"`). `body` carries event-type-specific payload,
 * bounded ≤ 8 KiB serialized.
 */
export interface RoomEvent {
  seq: number;
  timestamp: string;
  event_type: RoomEventType;
  actor_role: string;
  actor_id: string;
  body: Record<string, unknown>;
}

export interface RoomEventsResponse {
  roomId: string;
  events: RoomEvent[];
}

/**
 * Loose UUIDv4 shape — not a strict RFC 4122 check (the server does
 * that). Just a smoke test so an obvious typo (`1234`, empty string,
 * or a non-hyphenated mash) doesn't waste a round-trip. Shared by
 * every CLI command that takes a `<roomId>` argument.
 */
export const ROOM_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verdict enum for contribution bodies. UPPERCASE per server's
 * `ContributionVerdict` (`web/src/server/war-room.ts:1023-1027`).
 * The downgrade-only synthesis invariant means typos here would
 * silently default to COMMENT — so the CLI rejects malformed values
 * at the boundary BEFORE the round-trip.
 */
export type ContributionVerdict =
  | "APPROVE"
  | "COMMENT"
  | "CONCERNS"
  | "REQUEST_CHANGES";

export const CONTRIBUTION_VERDICTS: ReadonlyArray<ContributionVerdict> = [
  "APPROVE",
  "COMMENT",
  "CONCERNS",
  "REQUEST_CHANGES",
];

export type ContributionFindingSeverity = "blocker" | "warning" | "info";

export interface ContributionFinding {
  area: string;
  severity: ContributionFindingSeverity;
  detail: string;
  code_ref?: string;
}

/**
 * Structured contribution body. Mirrors `ContributionBody` in
 * `web/src/server/war-room.ts:1062-1073` exactly. Server validates
 * via `validateContributionBody` at submit time — the CLI does a
 * minimal pre-flight check (verdict enum, summary length) so the
 * obvious malformed-body cases fail locally without a round-trip.
 */
export interface ContributionBody {
  verdict: ContributionVerdict;
  summary: string;
  findings?: ContributionFinding[];
  severity_counts?: {
    blocker?: number;
    warning?: number;
    info?: number;
  };
}

/** Wire request body for `POST /api/rooms/{roomId}/contributions`. */
export interface SubmitContributionRequest {
  sequenceObservedByClient: number;
  body: ContributionBody;
  rawMd: string;
  agentId?: string;
}

/** Wire response from `POST /api/rooms/{roomId}/contributions`. */
export interface SubmitContributionResponse {
  sequence: number;
}

/** Inclusive cap matching server's `RoomContributionTooLargeError`
 * threshold — 32 KiB UTF-8 bytes. CLI surface checks the byte length
 * before the round-trip so the operator sees an actionable error
 * locally rather than a server-side 400 race against transient
 * network glitches. */
export const RAW_MD_MAX_BYTES = 32 * 1024;

/** Max summary length per server's `validateContributionBody`
 * (war-room.ts ContributionBody.summary "1-500 chars"). */
export const SUMMARY_MAX_CHARS = 500;

/**
 * Per-role RSVP entry materialized in the room's participant hash.
 * Mirrors `RoomParticipant` in `web/src/server/war-room.ts:349-364`.
 * Status lifecycle:
 *   pending  → resolved   (worker submits a contribution)
 *   pending  → withdrew   (worker explicitly withdraws)
 *   pending  → timed_out  (watchdog times out)
 *   withdrew → pending    (re-RSVP after subject_updated)
 */
export interface RoomParticipant {
  agent_id: string;
  role: string;
  status: "pending" | "resolved" | "withdrew" | "timed_out";
  rsvp_at?: string;
  withdrew_at_sequence?: number;
}

/**
 * One entry in the enriched response from
 * `GET /api/rooms/watching`. `core` is `RoomCoreWithId` so the
 * caller has the roomId without a follow-up read.
 *
 * The /watching endpoint is the only V1 surface that bundles
 * participants + currentSequence with the room core — the design's
 * compensation for `rooms.read_all` not being on the worker preset
 * (workers can't /api/rooms/{id} their way to the same view).
 */
export interface WatchingRoom {
  core: ListedRoom;
  participants: Record<string, RoomParticipant>;
  currentSequence: number;
}

export interface WatchingRoomsResponse {
  rooms: WatchingRoom[];
}
