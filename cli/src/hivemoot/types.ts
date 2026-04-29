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
  | "awaiting_rsvp"
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
  rsvp_deadline_secs: number;
  contribution_deadline_secs: number;
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
 * Single entry from `GET /api/rooms/{roomId}/events`. Mirrors
 * `RoomEvent` on the server side; the optional fields cover the
 * event-type-specific payload (e.g., `subject_updated` carries
 * `subject_ref`, `participant_*` events carry `agent_role`, etc.).
 *
 * Untyped here as `Record<string, unknown>` because the union of all
 * event-type-specific fields is large and event-type-discriminated;
 * V1 CLI displays them as opaque JSON. Future slices can narrow.
 */
export interface RoomEvent {
  seq: number;
  timestamp: string;
  event_type: string;
  agent_role?: string;
  agent_id?: string;
  [extra: string]: unknown;
}

export interface RoomEventsResponse {
  roomId: string;
  events: RoomEvent[];
}
