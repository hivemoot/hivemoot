"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types (mirroring server-side HealthOverviewEntry and HealthReport)
// ---------------------------------------------------------------------------

interface AgentOverviewEntry {
  agent_id: string;
  repo: string;
  status: "idle" | "working" | "error";
  current_issue?: number;
  summary?: string;
  error_message?: string;
  received_at: string;
  online: boolean;
}

interface HealthHistoryEntry {
  agent_id: string;
  repo: string;
  status: "idle" | "working" | "error";
  current_issue?: number;
  summary?: string;
  error_message?: string;
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

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function statusColor(status: string, online: boolean): string {
  if (!online) return "text-zinc-500";
  switch (status) {
    case "working":
      return "text-green-400";
    case "error":
      return "text-red-400";
    default:
      return "text-zinc-400";
  }
}

function statusDot(online: boolean): string {
  if (!online) return "bg-zinc-600";
  return "bg-green-400";
}

function statusLabel(status: string, online: boolean): string {
  if (!online) return "Offline";
  switch (status) {
    case "working":
      return "Working";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

function relativeTime(iso: string): string {
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

// ---------------------------------------------------------------------------
// Refresh interval
// ---------------------------------------------------------------------------

const REFRESH_INTERVAL_MS = 30_000; // 30 seconds

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AgentHealthDashboard() {
  const [agents, setAgents] = useState<AgentOverviewEntry[]>([]);
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
                      entry.status === "error"
                        ? "bg-red-400"
                        : entry.status === "working"
                          ? "bg-green-400"
                          : "bg-zinc-500"
                    }`}
                  />
                  <span
                    className={`text-xs font-medium ${
                      entry.status === "error"
                        ? "text-red-400"
                        : entry.status === "working"
                          ? "text-green-400"
                          : "text-zinc-400"
                    }`}
                  >
                    {entry.status}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  {entry.summary && (
                    <p className="text-sm text-zinc-300">{entry.summary}</p>
                  )}
                  {entry.error_message && (
                    <p className="text-sm text-red-400">{entry.error_message}</p>
                  )}
                  {entry.current_issue && (
                    <p className="text-xs text-zinc-500">
                      Issue #{entry.current_issue}
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
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {agents.map((agent) => (
        <button
          key={`${agent.agent_id}:${agent.repo}`}
          onClick={() => viewHistory(agent.agent_id, agent.repo)}
          className="group rounded-xl border border-white/[0.06] bg-[#141414] p-5 text-left transition-colors hover:border-white/10"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full ${statusDot(
                  agent.online,
                )}`}
              />
              <span className="text-sm font-medium text-[#fafafa]">
                {agent.agent_id}
              </span>
            </div>
            <span
              className={`text-xs font-medium ${statusColor(
                agent.status,
                agent.online,
              )}`}
            >
              {statusLabel(agent.status, agent.online)}
            </span>
          </div>

          <p className="mt-2 truncate text-xs text-zinc-500">{agent.repo}</p>

          {agent.summary && (
            <p className="mt-2 truncate text-xs text-zinc-400">
              {agent.summary}
            </p>
          )}

          {agent.error_message && (
            <p className="mt-2 truncate text-xs text-red-400">
              {agent.error_message}
            </p>
          )}

          <div className="mt-3 flex items-center justify-between text-xs text-zinc-600">
            <span>{relativeTime(agent.received_at)}</span>
            {agent.current_issue && (
              <span>Issue #{agent.current_issue}</span>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
