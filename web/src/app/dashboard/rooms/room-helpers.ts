// Pure helpers for war-room dashboard views. Extracted so they can
// be unit-tested without a DOM environment.
import type { RoomParticipant, RoomStatus, SubjectType } from "./types";

const STATUS_LABELS: Record<RoomStatus, string> = {
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
  general: "General",
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
  "awaiting_contributions",
  "deciding",
]);

export function isActiveStatus(status: RoomStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

/**
 * Status-filter buckets used by the rooms-list UI.  `all` shows
 * every room the API returned; the other buckets narrow to a single
 * matching status (or status set).  Operators flip between these
 * to inspect past conversations without scrolling past active
 * rooms — the API already returns closed + expired rooms but they
 * sort below active ones, so a filter is the quickest lookup.
 */
export type RoomStatusFilter = "all" | "active" | "closed" | "expired";

export function roomMatchesFilter<T extends { status: RoomStatus }>(
  room: T,
  filter: RoomStatusFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "active") return isActiveStatus(room.status);
  return room.status === filter;
}

/** Per-filter room counts.  Used to render the count next to each
 * filter chip so the operator sees at a glance how many rooms each
 * bucket holds. */
export function countRoomsByFilter<T extends { status: RoomStatus }>(
  rooms: T[],
): Record<RoomStatusFilter, number> {
  const counts: Record<RoomStatusFilter, number> = {
    all: rooms.length,
    active: 0,
    closed: 0,
    expired: 0,
  };
  for (const r of rooms) {
    if (isActiveStatus(r.status)) counts.active += 1;
    if (r.status === "closed") counts.closed += 1;
    if (r.status === "expired") counts.expired += 1;
  }
  return counts;
}

/**
 * Substring match against a room's `subject_ref` (e.g.
 * `owner/repo#42`).  Case-insensitive so `HIVEMOOT/HIVEMOOT#42`
 * matches `hivemoot/hivemoot#42`, and a bare `42` matches the
 * trailing `#42`.  Empty / whitespace-only query matches every
 * room — that's the "no filter" default the UI starts in.
 *
 * Pure on `(room, query)` so the rooms-list component can run it
 * client-side over the full fetched set without thrashing the API.
 */
export function roomMatchesSubjectQuery<T extends { subject_ref: string }>(
  room: T,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") return true;
  return room.subject_ref.toLowerCase().includes(normalized);
}

/**
 * Shape of the timing-config the stuckness helpers below read.
 * Mirrors `RoomCoreWithId['timing_config']` from `./types` but
 * inlined as a narrow structural type so each helper's signature
 * documents exactly which fields it touches.
 */
type StuckTimingConfig = {
  max_age_secs?: number;
  quiet_period_secs?: number;
  drop_threshold_secs?: number;
};

/**
 * Pick the relevant deadline for a room based on its current status.
 * - awaiting_contributions / deciding → max_age_secs (the hard cap
 *   on room lifetime; rooms past this get terminated by the
 *   watchdog as `expired`).
 * - terminal statuses → null (no deadline applies).
 *
 * Falls back to undefined when the room has no timing_config (older
 * rooms or test fixtures).
 *
 * Why `max_age_secs` and not `quiet_period_secs` (the previous
 * choice): under the heartbeat model, `quiet_period_secs` is the
 * bot manager-loop's settling window BEFORE claiming a room — it
 * resets every time a participant transition lands.  Treating it
 * as the dashboard "deadline" highlighted every active room as
 * "near deadline" within a couple minutes of opening, which is
 * normal triage progress, not a stuck-room signal.  `max_age_secs`
 * is the actual expiration deadline (3600s default = 1h) and the
 * one operators care about: "this room has been open long enough
 * that it's about to be force-expired."
 */
export function relevantDeadlineSecs(
  status: RoomStatus,
  timingConfig?: StuckTimingConfig,
): number | null {
  if (!isActiveStatus(status)) return null;
  if (!timingConfig) return null;
  return timingConfig.max_age_secs ?? null;
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
  timingConfig?: StuckTimingConfig,
  nowMs: number = Date.now(),
): number {
  const deadline = relevantDeadlineSecs(status, timingConfig);
  if (deadline === null || deadline <= 0) return 0;
  const openedMs = Date.parse(openedAtIso);
  if (!Number.isFinite(openedMs)) return 0;
  const ageSecs = Math.max(0, (nowMs - openedMs) / 1000);
  return ageSecs / deadline;
}

/**
 * Human-friendly "expires in 57m" string for an active room. Pure
 * function so the rooms-list view can render without time mocking.
 *
 * Returns ``null`` when no deadline applies (terminal status, no
 * timing_config, etc.) so callers can omit the indicator instead
 * of rendering empty/garbage strings. Returns "expired" for rooms
 * past their deadline (the watchdog typically sweeps these within
 * one tick; the marker is the bridge state).
 */
export function timeUntilDeadline(
  openedAtIso: string,
  status: RoomStatus,
  timingConfig?: StuckTimingConfig,
  nowMs: number = Date.now(),
): string | null {
  const deadlineSecs = relevantDeadlineSecs(status, timingConfig);
  if (deadlineSecs === null || deadlineSecs <= 0) return null;
  const openedMs = Date.parse(openedAtIso);
  if (!Number.isFinite(openedMs)) return null;
  const remainingSecs =
    deadlineSecs - Math.max(0, (nowMs - openedMs) / 1000);
  if (remainingSecs <= 0) return "expired";
  if (remainingSecs < 60) return `${Math.floor(remainingSecs)}s left`;
  const mins = Math.floor(remainingSecs / 60);
  if (mins < 60) return `${mins}m left`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h left`;
  const days = Math.floor(hours / 24);
  return `${days}d left`;
}

/** Recognized verdict strings the queen can synthesize. Mirrors the
 * Zod enum on the synthesizer side so the dashboard's pill colors
 * stay in sync with the structural enum. */
export type Verdict =
  | "APPROVE"
  | "COMMENT"
  | "CONCERNS"
  | "REQUEST_CHANGES";

const _VERDICT_VALUES: ReadonlySet<string> = new Set([
  "APPROVE",
  "COMMENT",
  "CONCERNS",
  "REQUEST_CHANGES",
]);

/**
 * Extract the verdict from a decision's markdown body. The queen's
 * synthesizer template starts each comment with the line
 * ``**Verdict:** `<VERDICT>`'' followed by parenthesized provenance
 * — a single regex captures the value without needing to parse
 * the rest.
 *
 * Returns ``null`` when the content doesn't match the template
 * (older rooms, custom synthesizers, etc.) so the caller can fall
 * back to a generic "decided" pill instead of rendering garbage.
 */
export function extractDecisionVerdict(content: string): Verdict | null {
  const match = /\*\*Verdict:\*\*\s*`?([A-Z_]+)`?/i.exec(content);
  if (!match) return null;
  const candidate = match[1].toUpperCase();
  return _VERDICT_VALUES.has(candidate) ? (candidate as Verdict) : null;
}

/**
 * Tailwind class fragment for a verdict pill. Centralized so the
 * rooms-list and the room-detail synthesis surfaces stay visually
 * consistent. Matches the dashboard's status-pill vocabulary —
 * emerald for approve, amber for caution, rose for blocking.
 */
export function verdictPillClass(verdict: Verdict): string {
  switch (verdict) {
    case "APPROVE":
      return "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/20";
    case "COMMENT":
      return "bg-zinc-500/10 text-zinc-300 ring-1 ring-zinc-500/20";
    case "CONCERNS":
      return "bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/20";
    case "REQUEST_CHANGES":
      return "bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/20";
  }
}

/** Per WAR_ROOM_DESIGN.md L1248: red highlight when past 80% of
 * the relevant deadline. */
export const STUCK_THRESHOLD = 0.8;

export function isRoomStuck(
  openedAtIso: string,
  status: RoomStatus,
  timingConfig?: StuckTimingConfig,
  nowMs: number = Date.now(),
): boolean {
  return (
    stucknessRatio(openedAtIso, status, timingConfig, nowMs) >= STUCK_THRESHOLD
  );
}

// ---------------------------------------------------------------------------
// Diff-drifted-post-verdict — closes hivemoot/hivemoot#605 (Option A)
// ---------------------------------------------------------------------------

/**
 * "Diff drifted post-verdict" — true when a closed room's verdict
 * was synthesized over an earlier head SHA but the bot has since
 * observed a `subject_updated` rejection (the PR's diff advanced
 * past what the war-room reviewed).  The bot persists
 * `last_post_close_drift_at` on the room core when the rejection
 * happens; the dashboard surfaces the marker as a badge so operators
 * see at a glance that the visible verdict doesn't cover the latest
 * diff — a pre-condition for the merge-gate check (Option C, follow-up).
 *
 * Only meaningful for `closed` rooms — `awaiting_contributions` and
 * `deciding` haven't produced a verdict yet, and `expired` rooms
 * never closed cleanly.  A `deciding`-then-rejected attempt may end
 * up with a marker that's only visible after the room subsequently
 * closes (the close path doesn't clear the marker by design — the
 * verdict is still over the pre-drift SHA, so the badge is honest).
 */
export function hasDiffDriftedPostVerdict<T extends {
  status: RoomStatus;
  last_post_close_drift_at?: string;
}>(room: T): boolean {
  return (
    room.status === "closed" &&
    typeof room.last_post_close_drift_at === "string" &&
    room.last_post_close_drift_at !== ""
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
    timing_config?: StuckTimingConfig;
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
 * Liveness classification for a participant's last-seen timestamp,
 * driven by the heartbeat endpoint that bumps ``rsvp_at`` every
 * ``heartbeat_interval`` seconds (PRs A + C of the
 * JOB_LIFECYCLE_UNIFICATION RFC).
 *
 * * ``fresh`` — pending participant with rsvp_at within ~2 heartbeat
 *   intervals (90s). Agent is actively heartbeating.
 * * ``stale`` — pending participant with rsvp_at 90s–5min old.
 *   Possibly slow agent; one or two missed heartbeats.
 * * ``dead`` — pending participant with rsvp_at >5min old. Several
 *   missed heartbeats; agent is likely stalled. The watchdog will
 *   typically time the slot out around the same threshold.
 * * ``inactive`` — non-pending statuses (resolved / withdrew /
 *   timed_out). Heartbeats no longer fire; rsvp_at is frozen at
 *   the last update. No freshness signal needed.
 */
export type ParticipantHeartbeatFreshness =
  | "fresh"
  | "stale"
  | "dead"
  | "inactive";

const FRESH_THRESHOLD_MS = 90 * 1000;     // 2× the 45s default interval
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5min — beyond this, agent is gone

/**
 * Classify a participant's heartbeat liveness. Pure function so the
 * test suite can pin the boundaries without time mocking. Default
 * ``nowMs`` mirrors ``relativeTime`` for ergonomics.
 */
export function participantHeartbeatFreshness(
  participant: { rsvp_at: string; status: string },
  nowMs: number = Date.now(),
): ParticipantHeartbeatFreshness {
  if (participant.status !== "pending") return "inactive";
  const t = Date.parse(participant.rsvp_at);
  if (!Number.isFinite(t)) return "dead";
  const ageMs = nowMs - t;
  if (ageMs < FRESH_THRESHOLD_MS) return "fresh";
  if (ageMs < STALE_THRESHOLD_MS) return "stale";
  return "dead";
}

/**
 * Tailwind classes for the heartbeat-freshness indicator dot.
 * Centralized so the room detail view + any future surfacings (the
 * rooms list, etc.) render consistent colors.
 */
export function heartbeatFreshnessDotClass(
  freshness: ParticipantHeartbeatFreshness,
): string {
  switch (freshness) {
    case "fresh":
      return "bg-emerald-400";
    case "stale":
      return "bg-amber-400";
    case "dead":
      return "bg-rose-500";
    case "inactive":
      return "bg-zinc-600";
  }
}

/**
 * Human-readable tooltip text for a freshness classification.
 * Surfaces the rationale ("agent is actively heartbeating", etc.)
 * so operators understand what the colored dot means without
 * leaving the page.
 */
export function heartbeatFreshnessTitle(
  freshness: ParticipantHeartbeatFreshness,
): string {
  switch (freshness) {
    case "fresh":
      return "Agent is actively heartbeating (≤90s since last ping)";
    case "stale":
      return "Agent's last heartbeat was 90s–5min ago — possibly slow";
    case "dead":
      return "No heartbeat in >5min — agent is likely stalled";
    case "inactive":
      return "Participant is not pending — heartbeats no longer fire";
  }
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
