/**
 * Shared icons + helpers for the Agents dashboard. Inline SVGs (project
 * convention: no icon libraries) and the time/format helpers mirrored from
 * AgentHealthDashboard so the run-history rendering stays visually identical.
 */

import type { StatusTone } from "@/app/dashboard/ui";
import type {
  AgentHealthStatus,
  AgentTriggers,
  TokenUsage,
  TriggerKey,
} from "./types";

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/** agent-health status → kit tone (matches the project's standard mapping). */
export function healthTone(status: AgentHealthStatus): StatusTone {
  switch (status) {
    case "ok":
      return "green";
    case "failed":
      return "red";
    case "late":
      return "amber";
    case "unknown":
      return "zinc";
  }
}

export function healthLabel(status: AgentHealthStatus): string {
  switch (status) {
    case "ok":
      return "OK";
    case "failed":
      return "Failed";
    case "late":
      return "Late";
    case "unknown":
      return "Unknown";
  }
}

/** run outcome → kit tone. */
export function outcomeTone(outcome: "success" | "failure" | "timeout"): StatusTone {
  if (outcome === "success") return "green";
  return "red"; // failure | timeout
}

// ---------------------------------------------------------------------------
// Trigger labels
// ---------------------------------------------------------------------------

export const TRIGGER_ORDER: TriggerKey[] = [
  "schedule",
  "pull_requests",
  "mentions",
  "tasks",
  "war_rooms",
];

export const TRIGGER_LABELS: Record<TriggerKey, string> = {
  schedule: "Schedule",
  pull_requests: "Pull requests",
  mentions: "Mentions",
  tasks: "Tasks",
  war_rooms: "War rooms",
};

/** Short chip labels for the list view. */
export const TRIGGER_CHIP_LABELS: Record<TriggerKey, string> = {
  schedule: "schedule",
  pull_requests: "PRs",
  mentions: "mentions",
  tasks: "tasks",
  war_rooms: "war rooms",
};

export function enabledTriggerKeys(triggers: AgentTriggers): TriggerKey[] {
  return TRIGGER_ORDER.filter((k) => triggers[k].enabled);
}

// ---------------------------------------------------------------------------
// Time + number formatting (mirrors AgentHealthDashboard)
// ---------------------------------------------------------------------------

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function relativeTimeUntil(iso: string | undefined): string | null {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `${hours}h`;
  return `${hours}h ${remainingMinutes}m`;
}

export function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function cacheHitRate(tu: TokenUsage): string | null {
  const read = tu.cache_read_input_tokens ?? 0;
  const creation = tu.cache_creation_input_tokens ?? 0;
  const total = tu.input_tokens + read + creation;
  if (total === 0) return null;
  return `${Math.round((read / total) * 100)}%`;
}

export function primaryModel(tu: TokenUsage): string | null {
  if (!tu.model_breakdown) return null;
  const entries = Object.entries(tu.model_breakdown);
  if (entries.length === 0) return null;
  entries.sort(([, a], [, b]) => (b.output_tokens ?? 0) - (a.output_tokens ?? 0));
  return entries[0][0];
}

// ---------------------------------------------------------------------------
// Icons (inline SVGs)
// ---------------------------------------------------------------------------

export function ArrowLeftIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "h-4 w-4"}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="13" y1="8" x2="3" y2="8" />
      <polyline points="7 4 3 8 7 12" />
    </svg>
  );
}

export function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "h-4 w-4"}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="8" y1="3" x2="8" y2="13" />
      <line x1="3" y1="8" x2="13" y2="8" />
    </svg>
  );
}

export function BotIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "h-5 w-5"}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <path d="M8 2v3" />
      <circle cx="8" cy="2" r="0.5" fill="currentColor" />
      <circle cx="6" cy="9" r="0.75" fill="currentColor" />
      <circle cx="10" cy="9" r="0.75" fill="currentColor" />
      <path d="M1 8.5v2M15 8.5v2" />
    </svg>
  );
}

export function RepoIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "h-3.5 w-3.5"}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 2h8a1 1 0 0 1 1 1v10.5a.5.5 0 0 1-.5.5H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" />
      <path d="M3 11.5A1 1 0 0 1 4 11h9" />
    </svg>
  );
}

export function EngineIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "h-3.5 w-3.5"}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4" />
    </svg>
  );
}

export function TokenIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "h-3.5 w-3.5"}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <ellipse cx="8" cy="10" rx="6" ry="2.5" />
      <ellipse cx="8" cy="6" rx="6" ry="2.5" />
      <path d="M2 6v4" />
      <path d="M14 6v4" />
    </svg>
  );
}

export function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "h-2.5 w-2.5"}
      viewBox="0 0 8 8"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M2 1l4 3-4 3V1z" />
    </svg>
  );
}
