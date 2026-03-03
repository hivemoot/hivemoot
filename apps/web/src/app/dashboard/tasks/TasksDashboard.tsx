"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskRecord {
  task_id: string;
  status: string;
  engine: string;
  prompt: string;
  repos: string[];
  timeout_secs: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  progress?: string;
  result?: string;
}

type CreateFormStatus = "idle" | "submitting" | "success" | "error";

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function TaskIcon({ className }: { className?: string }) {
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
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M5 8h6M5 5.5h6M5 10.5h3" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
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

function SpinnerIcon() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function XCircleIcon({ className }: { className?: string }) {
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
      <circle cx="8" cy="8" r="6" />
      <line x1="6" y1="6" x2="10" y2="10" />
      <line x1="10" y1="6" x2="6" y2="10" />
    </svg>
  );
}

function SendIcon({ className }: { className?: string }) {
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
      <path d="M14 2L7 9" />
      <path d="M14 2l-4.5 12-2.5-5.5L2 6z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return "text-green-400";
    case "running":
      return "text-blue-400";
    case "pending":
      return "text-zinc-400";
    case "needs_follow_up":
      return "text-amber-400";
    case "failed":
    case "timed_out":
      return "text-red-400";
    default:
      return "text-zinc-500";
  }
}

function statusDotColor(status: string): string {
  switch (status) {
    case "completed":
      return "bg-green-400";
    case "running":
      return "bg-blue-400";
    case "pending":
      return "bg-zinc-400";
    case "needs_follow_up":
      return "bg-amber-400";
    case "failed":
    case "timed_out":
      return "bg-red-400";
    default:
      return "bg-zinc-500";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "running":
      return "Running";
    case "pending":
      return "Pending";
    case "needs_follow_up":
      return "Needs follow-up";
    case "failed":
      return "Failed";
    case "timed_out":
      return "Timed out";
    default:
      return status;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

const REFRESH_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TasksDashboard() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createStatus, setCreateStatus] = useState<CreateFormStatus>("idle");
  const [createError, setCreateError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [repos, setRepos] = useState("hivemoot/hivemoot");
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?limit=20");
      if (!res.ok) {
        if (res.status === 401) {
          setError("Session expired — please log in again.");
          return;
        }
        setError("Failed to load tasks.");
        return;
      }
      const data = await res.json();
      setTasks(data.tasks ?? []);
      setError(null);
    } catch {
      setError("Network error — could not reach server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  async function handleCreateTask(e: React.FormEvent) {
    e.preventDefault();
    if (createStatus === "submitting") return;

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setCreateError("Please enter a task prompt.");
      return;
    }

    const repoList = repos
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);

    if (repoList.length === 0) {
      setCreateError("Please enter at least one repository.");
      return;
    }

    setCreateStatus("submitting");
    setCreateError("");

    try {
      const res = await fetch("/api/tasks/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: trimmedPrompt,
          repos: repoList,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Unknown error" }));
        setCreateError(err.message ?? "Failed to create task.");
        setCreateStatus("error");
        return;
      }

      setCreateStatus("success");
      setPrompt("");
      setShowCreateForm(false);
      setCreateStatus("idle");
      await fetchTasks();
    } catch {
      setCreateError("Could not reach the server.");
      setCreateStatus("error");
    }
  }

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center gap-3 text-sm text-zinc-500">
        <SpinnerIcon />
        Loading tasks…
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

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[#fafafa]">Tasks</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Delegate work to agents and track progress.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowCreateForm((v) => !v);
            if (!showCreateForm) {
              setTimeout(() => promptRef.current?.focus(), 50);
            }
          }}
          className="flex items-center gap-2 rounded-lg bg-honey-500 px-4 py-2 text-sm font-semibold text-[#0a0a0a] transition-colors hover:bg-honey-400"
        >
          <PlusIcon className="h-4 w-4" />
          New Task
        </button>
      </div>

      {/* Create form */}
      {showCreateForm && (
        <section className="rounded-xl border border-white/[0.06] bg-[#141414] p-6">
          <h3 className="mb-4 text-sm font-semibold text-[#fafafa]">Create Task</h3>

          {createError && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
              <XCircleIcon className="h-4 w-4 shrink-0 text-red-400" />
              <p className="text-sm text-red-400">{createError}</p>
            </div>
          )}

          <form onSubmit={handleCreateTask}>
            <div className="mb-4">
              <label htmlFor="task-prompt" className="mb-2 block text-sm text-zinc-400">
                Prompt
              </label>
              <textarea
                ref={promptRef}
                id="task-prompt"
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe what the agent should do…"
                className="w-full resize-y rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-sm text-[#fafafa] placeholder-zinc-600 transition-colors focus:border-honey-500/50 focus:outline-none focus:ring-1 focus:ring-honey-500/20"
              />
            </div>

            <div className="mb-4">
              <label htmlFor="task-repos" className="mb-2 block text-sm text-zinc-400">
                Repositories <span className="text-zinc-600">(comma-separated)</span>
              </label>
              <input
                id="task-repos"
                type="text"
                value={repos}
                onChange={(e) => setRepos(e.target.value)}
                placeholder="hivemoot/hivemoot"
                className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 font-mono text-sm text-[#fafafa] placeholder-zinc-600 transition-colors focus:border-honey-500/50 focus:outline-none focus:ring-1 focus:ring-honey-500/20"
              />
            </div>

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={createStatus === "submitting"}
                className="flex items-center gap-2 rounded-lg bg-honey-500 px-5 py-2.5 text-sm font-semibold text-[#0a0a0a] transition-colors hover:bg-honey-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {createStatus === "submitting" ? (
                  <>
                    <SpinnerIcon />
                    Creating…
                  </>
                ) : (
                  <>
                    <SendIcon className="h-4 w-4" />
                    Create Task
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCreateForm(false);
                  setCreateError("");
                  setCreateStatus("idle");
                }}
                className="rounded-lg border border-white/[0.06] px-5 py-2.5 text-sm text-zinc-400 transition-colors hover:border-white/10 hover:text-zinc-300"
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Task list */}
      {tasks.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-[#141414] p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-honey-500/10">
            <TaskIcon className="h-5 w-5 text-honey-500" />
          </div>
          <h3 className="mt-4 text-sm font-semibold text-[#fafafa]">
            No tasks yet
          </h3>
          <p className="mt-2 text-sm text-zinc-400">
            Create a task to delegate work to an agent.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {tasks.map((task) => (
            <Link
              key={task.task_id}
              href={`/dashboard/tasks/${task.task_id}`}
              className="group flex items-start gap-4 rounded-xl border border-white/[0.06] bg-[#141414] px-5 py-4 transition-colors hover:border-white/10"
            >
              <div className="mt-1 flex items-center gap-2.5">
                <span
                  className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${statusDotColor(task.status)}`}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate text-sm font-medium text-[#fafafa]">
                    {truncate(task.prompt, 80)}
                  </p>
                  <span className={`shrink-0 text-xs font-medium ${statusColor(task.status)}`}>
                    {statusLabel(task.status)}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-3 text-xs text-zinc-600">
                  <span className="font-mono">{task.repos.join(", ")}</span>
                  <span>{relativeTime(task.created_at)}</span>
                </div>
                {task.progress && task.status !== "pending" && (
                  <p className="mt-1 truncate text-xs text-zinc-500">
                    {task.progress}
                  </p>
                )}
                {task.status === "needs_follow_up" && (
                  <p className="mt-1 text-xs text-amber-400/80">
                    Agent is waiting for your input
                  </p>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
