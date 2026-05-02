// Shared client-side war-room models used by the dashboard list +
// detail views. Kept aligned with the storage layer's wire shape
// (see web/src/server/war-room.ts for the canonical types).

export type RoomStatus =
  | "awaiting_contributions"
  | "deciding"
  | "closed"
  | "expired";

export type SubjectType = "pr_review" | "mention_response" | "issue_triage";

export interface RoomCore {
  manager: string;
  subject_type: SubjectType;
  subject_ref: string;
  status: RoomStatus;
  opened_at: string;
  timing_config?: {
    max_age_secs?: number;
    drop_threshold_secs?: number;
    quiet_period_secs?: number;
  };
  closed_at?: string;
  closed_reason?: "expired" | "failed_synthesis" | "force_close" | "manual";
  deciding_through_sequence?: number;
  decision?: {
    synthesized_at: string;
    synthesis_runner: string;
    content: string;
    sequence_closed: number;
  };
}

export interface RoomCoreWithId extends RoomCore {
  roomId: string;
}

export interface RoomParticipant {
  agent_id: string;
  role: string;
  status: "pending" | "resolved" | "withdrew" | "timed_out";
  rsvp_at: string;
  resolved_at?: string;
  withdrew_at_sequence?: number;
}

export interface RoomContribution {
  body?: Record<string, unknown>;
  raw_md?: string;
  contributed_at?: string;
  withdrawn?: boolean;
}

export interface RoomEvent {
  seq: number;
  timestamp: string;
  event_type: string;
  actor_role: string;
  actor_id: string;
  body: Record<string, unknown>;
}

export interface RoomDetailResponse {
  roomId: string;
  core: RoomCore;
  participants: Record<string, RoomParticipant>;
  contributions: Record<string, RoomContribution>;
  events: RoomEvent[];
  eventLimit: number;
}
