// Pure helpers for war-room dashboard views. Extracted so they can
// be unit-tested without a DOM environment.
import type { RoomParticipant, RoomStatus, SubjectType } from "./types";

const STATUS_LABELS: Record<RoomStatus, string> = {
  awaiting_rsvp: "Awaiting RSVPs",
  awaiting_contributions: "Awaiting contributions",
  deciding: "Synthesizing",
  closed: "Closed",
  expired: "Expired",
};

export function statusLabel(status: RoomStatus): string {
  return STATUS_LABELS[status] ?? status;
}

/**
 * Tailwind class fragment for the colored status pill. Matches the
 * dashboard's existing color vocabulary.
 */
export function statusPillClass(status: RoomStatus): string {
  switch (status) {
    case "awaiting_rsvp":
    case "awaiting_contributions":
      return "bg-honey-500/10 text-honey-400 ring-1 ring-honey-500/20";
    case "deciding":
      return "bg-blue-500/10 text-blue-300 ring-1 ring-blue-500/20";
    case "closed":
      return "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/20";
    case "expired":
      return "bg-red-500/10 text-red-300 ring-1 ring-red-500/20";
    default:
      return "bg-zinc-700/30 text-zinc-300 ring-1 ring-zinc-700/40";
  }
}

const SUBJECT_LABELS: Record<SubjectType, string> = {
  pr_review: "PR review",
  mention_response: "Mention",
  issue_triage: "Issue triage",
};

export function subjectLabel(type: SubjectType): string {
  return SUBJECT_LABELS[type] ?? type;
}

/** Build a GitHub URL from a subject_ref of the form `owner/repo#N`.
 * Returns null when the ref doesn't match. */
export function subjectGithubUrl(subjectRef: string): string | null {
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#([1-9][0-9]*)$/.exec(
    subjectRef,
  );
  if (!match) return null;
  const [, owner, repo, num] = match;
  return `https://github.com/${owner}/${repo}/issues/${num}`;
}

/**
 * Counts of participants by status. Empty hash → all-zero counts.
 */
export function participantStatusCounts(
  participants: Record<string, RoomParticipant>,
): {
  pending: number;
  resolved: number;
  withdrew: number;
  timed_out: number;
  total: number;
} {
  const counts = { pending: 0, resolved: 0, withdrew: 0, timed_out: 0 };
  for (const p of Object.values(participants)) {
    counts[p.status] += 1;
  }
  return { ...counts, total: Object.keys(participants).length };
}

// ---------------------------------------------------------------------------
// Stuckness — closes #553 builder R1 (WAR_ROOM_DESIGN.md L1247)
// ---------------------------------------------------------------------------

/** Active rooms — workers / queen are still expected to act. The
 * dashboard prioritizes these above terminal rooms because they're
 * the ones that may need operator attention. */
export const ACTIVE_STATUSES: ReadonlySet<RoomStatus> = new Set([
  "awaiting_rsvp",
  "awaiting_contributions",
  "deciding",
]);

export function isActiveStatus(status: RoomStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

/**
 * Pick the relevant deadline for a room based on its current status.
 * - awaiting_rsvp → rsvp_deadline_secs
 * - awaiting_contributions / deciding → contribution_deadline_secs
 * - terminal statuses → null (no deadline applies)
 *
 * Falls back to undefined when the room has no timing_config (older
 * rooms or test fixtures).
 */
export function relevantDeadlineSecs(
  status: RoomStatus,
  timingConfig?: { rsvp_deadline_secs?: number; contribution_deadline_secs?: number },
): number | null {
  if (!isActiveStatus(status)) return null;
  if (!timingConfig) return null;
  if (status === "awaiting_rsvp") {
    return timingConfig.rsvp_deadline_secs ?? null;
  }
  return timingConfig.contribution_deadline_secs ?? null;
}

/**
 * `(now - opened_at) / deadline` ratio in [0, ∞). Used for sorting
 * (highest first = most stuck) AND highlighting (>= 0.8 → red row
 * per WAR_ROOM_DESIGN.md L1248).
 *
 * Returns 0 for terminal rooms or rooms with no relevant deadline
 * — terminal rooms aren't "stuck" and unconfigured rooms can't be
 * scored.
 */
export function stucknessRatio(
  openedAtIso: string,
  status: RoomStatus,
  timingConfig?: { rsvp_deadline_secs?: number; contribution_deadline_secs?: number },
  nowMs: number = Date.now(),
): number {
  const deadline = relevantDeadlineSecs(status, timingConfig);
  if (deadline === null || deadline <= 0) return 0;
  const openedMs = Date.parse(openedAtIso);
  if (!Number.isFinite(openedMs)) return 0;
  const ageSecs = Math.max(0, (nowMs - openedMs) / 1000);
  return ageSecs / deadline;
}

/** Per WAR_ROOM_DESIGN.md L1248: red highlight when past 80% of
 * the relevant deadline. */
export const STUCK_THRESHOLD = 0.8;

export function isRoomStuck(
  openedAtIso: string,
  status: RoomStatus,
  timingConfig?: { rsvp_deadline_secs?: number; contribution_deadline_secs?: number },
  nowMs: number = Date.now(),
): boolean {
  return (
    stucknessRatio(openedAtIso, status, timingConfig, nowMs) >= STUCK_THRESHOLD
  );
}

/**
 * Sort rooms for the default dashboard view per WAR_ROOM_DESIGN.md
 * L1247 — active rooms by stuck-ness DESC (most-stuck first), then
 * terminal rooms by opened_at DESC (most-recent first). Operators
 * see the rooms that need attention without filtering.
 *
 * Pure function on `(rooms, nowMs)` — no Date.now coupling so the
 * sort can be tested deterministically.
 */
export function sortRoomsByStuckness<
  T extends {
    status: RoomStatus;
    opened_at: string;
    timing_config?: {
      rsvp_deadline_secs?: number;
      contribution_deadline_secs?: number;
    };
  },
>(rooms: T[], nowMs: number = Date.now()): T[] {
  return [...rooms].sort((a, b) => {
    const aActive = isActiveStatus(a.status);
    const bActive = isActiveStatus(b.status);
    // Active rooms always come before terminal.
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    if (aActive && bActive) {
      // Within active: most-stuck (highest ratio) first. Falls back
      // to opened_at ASC (oldest first) when ratios tie at 0.
      const aRatio = stucknessRatio(a.opened_at, a.status, a.timing_config, nowMs);
      const bRatio = stucknessRatio(b.opened_at, b.status, b.timing_config, nowMs);
      if (aRatio !== bRatio) return bRatio - aRatio;
      return Date.parse(a.opened_at) - Date.parse(b.opened_at);
    }
    // Within terminal: most-recent opened_at first.
    return Date.parse(b.opened_at) - Date.parse(a.opened_at);
  });
}

/**
 * Format an ISO 8601 timestamp as a human-readable relative time
 * ("3m ago", "2h ago"). Returns absolute date for >7d ago.
 */
export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const deltaSecs = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (deltaSecs < 5) return "just now";
  if (deltaSecs < 60) return `${deltaSecs}s ago`;
  const mins = Math.floor(deltaSecs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}
