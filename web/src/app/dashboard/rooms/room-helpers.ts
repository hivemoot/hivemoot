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
