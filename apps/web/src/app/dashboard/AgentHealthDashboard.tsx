"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildGroups,
  getGroupStatus,
  GROUP_STATUS_META,
  GROUP_STATUS_ORDER,
  type GroupMode,
  type GroupStatus,
} from "./agent-health-grouping";

// ---------------------------------------------------------------------------
// Types (matches server-side HealthOverviewEntry and HealthReport)
// ---------------------------------------------------------------------------

interface AgentOverviewEntry {
  agent_id: string;
  repo: string;
  run_id?: string;
  outcome?: "success" | "failure" | "timeout";
  duration_secs?: number;
  consecutive_failures?: number;
  error?: string;
  exit_code?: number;
  received_at: string | null;
  online?: boolean;
  status?: "ok" | "failed" | "late" | "unknown";
  next_run_at?: string;
}

interface HealthHistoryEntry {
  agent_id: string;
  repo: string;
  run_id: string;
  outcome: "success" | "failure" | "timeout";
  duration_secs: number;
  consecutive_failures: number;
  error?: string;
  exit_code?: number;
  received_at: string;
}


// ---------------------------------------------------------------------------
// Icons (inline SVGs, following project convention)
// ---------------------------------------------------------------------------

function PulseIcon({ className }: { className?: string }) {
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
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2" />
    </svg>
  );
}

function ArrowLeftIcon({ className }: { className?: string }) {
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

function statusColor(status: GroupStatus): string {
  switch (status) {
    case "ok":
      return "text-green-400";
    case "failed":
      return "text-red-400";
    case "late":
      return "text-amber-400";
    case "unknown":
      return "text-zinc-500";
  }
}

function statusLabel(status: GroupStatus): string {
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

const GROUP_MODE_STORAGE_KEY = "hivemoot-dashboard-group";

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function relativeTimeUntil(iso: string | undefined): string | null {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `${hours}h`;
  return `${hours}h ${remainingMinutes}m`;
}

// ---------------------------------------------------------------------------
// Refresh interval
// ---------------------------------------------------------------------------

const REFRESH_INTERVAL_MS = 30_000; // 30 seconds

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AgentHealthDashboard() {
  const [agents, setAgents] = useState<AgentOverviewEntry[]>([]);
  const [groupMode, setGroupMode] = useState<GroupMode>("repo");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<{
    agent_id: string;
    repo: string;
  } | null>(null);
  const [history, setHistory] = useState<HealthHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyAbortRef = useRef<AbortController | null>(null);
  const historyRequestIdRef = useRef(0);
  const groupedAgents = useMemo(
    () => buildGroups(agents, groupMode),
    [agents, groupMode],
  );

  const fetchOverview = useCallback(async () => {
    try {
      const res = await fetch("/api/agent-health");
      if (!res.ok) {
        if (res.status === 401) {
          setError("Session expired — please log in again.");
          return;
        }
        setError("Failed to load agent status.");
        return;
      }
      const data = await res.json();
      setAgents(data.agents ?? []);
      setError(null);
    } catch {
      setError("Network error — could not reach server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOverview();
    const interval = setInterval(fetchOverview, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchOverview]);

  useEffect(() => {
    try {
      const savedGroupMode = window.localStorage.getItem(GROUP_MODE_STORAGE_KEY);
      if (savedGroupMode === "repo" || savedGroupMode === "agent") {
        setGroupMode(savedGroupMode);
      }
    } catch {
      // Ignore localStorage errors and keep default grouping mode.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(GROUP_MODE_STORAGE_KEY, groupMode);
    } catch {
      // Ignore localStorage errors and continue with in-memory preference.
    }
  }, [groupMode]);

  useEffect(() => {
    return () => {
      historyAbortRef.current?.abort();
    };
  }, []);

  async function viewHistory(agentId: string, repo: string) {
    historyAbortRef.current?.abort();
    const abortController = new AbortController();
    historyAbortRef.current = abortController;
    const requestId = ++historyRequestIdRef.current;

    setSelectedAgent({ agent_id: agentId, repo });
    setHistory([]);
    setHistoryError(null);
    setHistoryLoading(true);

    try {
      const params = new URLSearchParams({ agent_id: agentId, repo });
      const res = await fetch(`/api/agent-health?${params}`, {
        signal: abortController.signal,
      });
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error("Session expired — please log in again.");
        }
        throw new Error("Failed to load run history.");
      }

      const data = await res.json();
      if (
        abortController.signal.aborted ||
        requestId !== historyRequestIdRef.current
      ) {
        return;
      }

      setHistory(data.history ?? []);
    } catch (err) {
      if (
        abortController.signal.aborted ||
        requestId !== historyRequestIdRef.current
      ) {
        return;
      }

      if (err instanceof Error && err.message) {
        setHistoryError(err.message);
      } else {
        setHistoryError("Failed to load run history.");
      }
      setHistory([]);
    } finally {
      if (
        abortController.signal.aborted ||
        requestId !== historyRequestIdRef.current
      ) {
        return;
      }
      setHistoryLoading(false);
    }
  }

  // -------------------------------------------------------------------------
  // History detail view
  // -------------------------------------------------------------------------

  if (selectedAgent) {
    return (
      <div>
        <button
          onClick={() => {
            historyAbortRef.current?.abort();
            setSelectedAgent(null);
            setHistory([]);
            setHistoryError(null);
            setHistoryLoading(false);
          }}
          className="mb-6 flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-300"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" />
          Back to overview
        </button>

        <div className="mb-6">
          <h2 className="text-lg font-semibold text-[#fafafa]">
            {selectedAgent.agent_id}
          </h2>
          <p className="mt-1 text-sm text-zinc-400">{selectedAgent.repo}</p>
        </div>

        {historyLoading ? (
          <p className="text-sm text-zinc-500">Loading history…</p>
        ) : historyError ? (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4">
            <p className="text-sm text-red-400">{historyError}</p>
          </div>
        ) : history.length === 0 ? (
          <p className="text-sm text-zinc-500">No run history available.</p>
        ) : (
          <div className="space-y-2">
            {history.map((entry, i) => (
              <div
                key={`${entry.received_at}-${i}`}
                className="flex items-start gap-4 rounded-lg border border-white/[0.06] bg-[#141414] px-4 py-3"
              >
                <div className="mt-0.5 flex items-center gap-2">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      entry.outcome === "failure" || entry.outcome === "timeout"
                        ? "bg-red-400"
                        : entry.outcome === "success"
                          ? "bg-green-400"
                          : "bg-zinc-500"
                    }`}
                  />
                  <span
                    className={`text-xs font-medium ${
                      entry.outcome === "failure" || entry.outcome === "timeout"
                        ? "text-red-400"
                        : entry.outcome === "success"
                          ? "text-green-400"
                          : "text-zinc-400"
                    }`}
                  >
                    {entry.outcome}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-zinc-300">
                    {entry.run_id}
                    {entry.duration_secs !== undefined && (
                      <span className="ml-2 text-zinc-500">
                        {entry.duration_secs}s
                      </span>
                    )}
                  </p>
                  {entry.error && (
                    <p className="mt-0.5 text-sm text-red-400">{entry.error}</p>
                  )}
                  {entry.exit_code !== undefined && (
                    <p className="text-xs text-zinc-500">
                      exit code {entry.exit_code}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-xs text-zinc-600">
                  {relativeTime(entry.received_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Overview grid
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center gap-3 text-sm text-zinc-500">
        <PulseIcon className="h-4 w-4 animate-pulse" />
        Loading agent status…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6">
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-[#141414] p-8 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-honey-500/10">
          <PulseIcon className="h-5 w-5 text-honey-500" />
        </div>
        <h3 className="mt-4 text-sm font-semibold text-[#fafafa]">
          No agents reporting
        </h3>
        <p className="mt-2 text-sm text-zinc-400">
          Once your agents start sending health reports, they&apos;ll appear
          here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div
        className="inline-flex rounded-lg border border-white/[0.06] bg-[#141414] p-1"
        role="group"
        aria-label="Group dashboard by"
      >
        <button
          type="button"
          onClick={() => setGroupMode("repo")}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            groupMode === "repo"
              ? "border border-honey-500/40 bg-honey-500/10 text-honey-400"
              : "text-zinc-400 hover:text-zinc-300"
          }`}
          aria-pressed={groupMode === "repo"}
        >
          By Repo
        </button>
        <button
          type="button"
          onClick={() => setGroupMode("agent")}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            groupMode === "agent"
              ? "border border-honey-500/40 bg-honey-500/10 text-honey-400"
              : "text-zinc-400 hover:text-zinc-300"
          }`}
          aria-pressed={groupMode === "agent"}
        >
          By Agent
        </button>
      </div>

      <div className="space-y-6">
        {groupedAgents.map((group) => (
          <section key={group.name}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-[#fafafa]">{group.name}</h3>
              <div className="flex flex-wrap items-center justify-end gap-3">
                {GROUP_STATUS_ORDER.map((status) => {
                  const count = group.statusCounts[status];
                  if (count === 0) return null;

                  return (
                    <span
                      key={status}
                      className="inline-flex items-center gap-1.5 text-xs text-zinc-300"
                    >
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${
                          GROUP_STATUS_META[status].colorClass
                        }`}
                      />
                      {count} {GROUP_STATUS_META[status].label}
                    </span>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.entries.map((agent) => {
                const resolvedStatus = getGroupStatus(agent);
                const nextRunIn = relativeTimeUntil(agent.next_run_at);
                return (
                  <button
                    key={`${group.name}:${agent.agent_id}:${agent.repo}`}
                    onClick={() => viewHistory(agent.agent_id, agent.repo)}
                    className="group rounded-xl border border-white/[0.06] bg-[#141414] p-5 text-left transition-colors hover:border-white/10"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`inline-block h-2.5 w-2.5 rounded-full ${
                            GROUP_STATUS_META[resolvedStatus].colorClass
                          }`}
                        />
                        <span className="truncate text-sm font-medium text-[#fafafa]">
                          {groupMode === "repo" ? agent.agent_id : agent.repo}
                        </span>
                      </div>
                      <span
                        className={`text-xs font-medium ${statusColor(
                          resolvedStatus,
                        )}`}
                      >
                        {statusLabel(resolvedStatus)}
                      </span>
                    </div>

                    {agent.error && (
                      <p className="mt-2 truncate text-xs text-red-400">
                        {agent.error}
                      </p>
                    )}

                    <div className="mt-3 flex items-center text-xs">
                      <div className="flex items-center gap-3 text-zinc-600">
                        <span>{relativeTime(agent.received_at)}</span>
                        {nextRunIn && <span>next: {nextRunIn}</span>}
                      </div>
                      {agent.consecutive_failures != null &&
                        agent.consecutive_failures > 0 && (
                          <span className="ml-auto text-red-400/70">
                            {agent.consecutive_failures} failures
                          </span>
                        )}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
