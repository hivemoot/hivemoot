"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  draftStorageKey,
  filterConversationMessages,
  isSubmitShortcut,
  taskComposerGuidance,
  taskComposerPlaceholder,
} from "../task-helpers";
import { MarkdownContent } from "../../MarkdownContent";
import { type TaskMessage, type TaskRecord } from "../types";

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

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

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? "h-4 w-4 animate-spin"} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
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

function UserIcon({ className }: { className?: string }) {
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
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 14c0-2.8 2.2-5 5-5s5 2.2 5 5" />
    </svg>
  );
}

function BotIcon({ className }: { className?: string }) {
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
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <circle cx="6" cy="9" r="1" fill="currentColor" />
      <circle cx="10" cy="9" r="1" fill="currentColor" />
      <line x1="8" y1="2" x2="8" y2="5" />
      <circle cx="8" cy="2" r="1" />
    </svg>
  );
}

function RetryIcon({ className }: { className?: string }) {
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
      <path d="M2.5 8a5.5 5.5 0 0 1 9.3-4" />
      <polyline points="12 2 12 5 9 5" />
      <path d="M13.5 8a5.5 5.5 0 0 1-9.3 4" />
      <polyline points="4 14 4 11 7 11" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
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
      <polyline points="3 4 13 4" />
      <path d="M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1" />
      <path d="M4.5 4l.7 9.1a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9L11.5 4" />
    </svg>
  );
}

function MessageSquareIcon({ className }: { className?: string }) {
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
      <path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5l-3 3V3z" />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
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
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

function RepoIcon({ className }: { className?: string }) {
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
      <path d="M4 2v12M4 4h6a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2H4" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

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

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
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

function statusBgColor(status: string): string {
  switch (status) {
    case "completed":
      return "bg-green-500/10";
    case "running":
      return "bg-blue-500/10";
    case "pending":
      return "bg-zinc-500/10";
    case "needs_follow_up":
      return "bg-amber-500/10";
    case "failed":
    case "timed_out":
      return "bg-red-500/10";
    default:
      return "bg-zinc-500/10";
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

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "timed_out";
}

function isRetryable(status: string): boolean {
  return status === "failed" || status === "timed_out";
}

function isDeletable(status: string): boolean {
  return status === "pending" || isTerminal(status);
}

function canSendMessage(status: string): boolean {
  return status !== "running";
}

function messageEndpoint(status: string): "messages" | "follow-up" {
  return status === "needs_follow_up" ? "follow-up" : "messages";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TaskDetail({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [messages, setMessages] = useState<TaskMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [followUpText, setFollowUpText] = useState("");
  const [followUpSubmitting, setFollowUpSubmitting] = useState(false);
  const [followUpError, setFollowUpError] = useState("");
  const [actionBusy, setActionBusy] = useState<"retry" | "delete" | null>(null);
  const [actionError, setActionError] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sseRef = useRef<{ close: () => void } | null>(null);

  // ---- Draft persistence via sessionStorage ----
  const draftKey = draftStorageKey(taskId);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(draftKey);
      if (saved) setFollowUpText(saved);
    } catch {
      // sessionStorage unavailable (SSR or restricted)
    }
  }, [draftKey]);

  useEffect(() => {
    try {
      if (followUpText) sessionStorage.setItem(draftKey, followUpText);
      else sessionStorage.removeItem(draftKey);
    } catch {
      // Best-effort persistence.
    }
  }, [followUpText, draftKey]);

  // ---- Auto-resize textarea ----
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [followUpText]);

  // ---- Fetch task + messages ----
  const fetchTask = useCallback(async () => {
    try {
      const [taskRes, msgRes] = await Promise.all([
        fetch(`/api/tasks/${taskId}`),
        fetch(`/api/tasks/${taskId}/messages`),
      ]);

      if (!taskRes.ok) {
        if (taskRes.status === 401) { setError("Session expired \u2014 please log in again."); return; }
        if (taskRes.status === 404) { setError("Task not found."); return; }
        setError("Failed to load task.");
        return;
      }

      const taskData = await taskRes.json();
      setTask(taskData.task);

      if (msgRes.ok) {
        const msgData = await msgRes.json();
        setMessages(msgData.messages ?? []);
      }
      setError(null);
    } catch {
      setError("Network error \u2014 could not reach server.");
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => { fetchTask(); }, [fetchTask]);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ---- SSE streaming for live updates ----
  useEffect(() => {
    if (!task || isTerminal(task.status) || task.status === "needs_follow_up") return;

    let closed = false;

    function connectSSE() {
      if (closed) return;
      const es = new EventSource(`/api/tasks/${taskId}/stream`);

      es.addEventListener("snapshot", (e: MessageEvent) => {
        try { const d = JSON.parse(e.data); if (d.task) setTask(d.task); } catch { /* ignore */ }
      });

      es.addEventListener("task", (e: MessageEvent) => {
        try {
          const d = JSON.parse(e.data);
          if (d.task) {
            setTask(d.task);
            fetch(`/api/tasks/${taskId}/messages`)
              .then((r) => (r.ok ? r.json() : null))
              .then((r) => { if (r?.messages) setMessages(r.messages); })
              .catch(() => { /* best-effort */ });
          }
        } catch { /* ignore */ }
      });

      es.addEventListener("done", (e: MessageEvent) => {
        try { const d = JSON.parse(e.data); if (d.task) setTask(d.task); } catch { /* ignore */ }
        es.close();
        fetch(`/api/tasks/${taskId}/messages`)
          .then((r) => (r.ok ? r.json() : null))
          .then((r) => { if (r?.messages) setMessages(r.messages); })
          .catch(() => { /* best-effort */ });
      });

      es.addEventListener("error", () => {
        es.close();
        if (!closed) setTimeout(connectSSE, 3000);
      });

      sseRef.current = { close: () => es.close() };
    }

    connectSSE();
    return () => { closed = true; sseRef.current?.close(); };
  }, [task?.status, taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  const conversationMessages = task
    ? filterConversationMessages(messages, task.prompt)
    : messages.filter((msg) => msg.role !== "system");
  const composerGuidance = task ? taskComposerGuidance(task.status) : null;

  // ---- Submit message ----
  async function submitMessage() {
    if (followUpSubmitting) return;
    const trimmed = followUpText.trim();
    if (!trimmed) { setFollowUpError("Please enter a message."); return; }

    setFollowUpSubmitting(true);
    setFollowUpError("");

    try {
      const endpoint = messageEndpoint(task?.status ?? "running");
      const res = await fetch(`/api/tasks/${taskId}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Unknown error" }));
        setFollowUpError(err.message ?? (endpoint === "follow-up" ? "Failed to send follow-up." : "Failed to send message."));
        return;
      }
      const data = await res.json();
      if (data.task) setTask(data.task);
      setFollowUpText("");
      try { sessionStorage.removeItem(draftKey); } catch { /* noop */ }
      await fetchTask();
    } catch {
      setFollowUpError("Could not reach the server.");
    } finally {
      setFollowUpSubmitting(false);
    }
  }

  function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    submitMessage();
  }

  // ---- Retry ----
  async function handleRetry() {
    if (actionBusy) return;
    setActionBusy("retry");
    setActionError("");
    try {
      const res = await fetch(`/api/tasks/${taskId}/retry`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Unknown error" }));
        setActionError(err.message ?? "Failed to retry task.");
        return;
      }
      const data = await res.json();
      if (data.task) setTask(data.task);
      if (typeof data.task_id === "string" && data.task_id !== taskId) {
        router.push(`/dashboard/tasks/${data.task_id}`);
        return;
      }
      await fetchTask();
    } catch {
      setActionError("Could not reach the server.");
    } finally {
      setActionBusy(null);
    }
  }

  // ---- Delete ----
  async function handleDelete() {
    if (actionBusy) return;
    if (!window.confirm("Delete this task? This cannot be undone.")) return;
    setActionBusy("delete");
    setActionError("");
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Unknown error" }));
        setActionError(err.message ?? "Failed to delete task.");
        return;
      }
      router.push("/dashboard/tasks");
    } catch {
      setActionError("Could not reach the server.");
    } finally {
      setActionBusy(null);
    }
  }

  // =====================================================================
  // Loading / Error states
  // =====================================================================

  if (loading) {
    return (
      <div className="flex items-center gap-3 py-16 text-sm text-zinc-500">
        <SpinnerIcon />
        Loading task&hellip;
      </div>
    );
  }

  if (error || !task) {
    return (
      <div>
        <Link
          href="/dashboard/tasks"
          className="group mb-6 inline-flex items-center gap-2 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" />
          Tasks
        </Link>
        <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-6">
          <p className="text-sm text-red-400">{error ?? "Task not found."}</p>
        </div>
      </div>
    );
  }

  // =====================================================================
  // Render
  // =====================================================================

  return (
    <div className="animate-fade-in">
      {/* Back link */}
      <Link
        href="/dashboard/tasks"
        className="group mb-6 inline-flex items-center gap-2 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
      >
        <ArrowLeftIcon className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" />
        Tasks
      </Link>

      {/* ── Header card ──────────────────────────────────────────────── */}
      <div className="mb-5 rounded-2xl border border-white/[0.06] bg-[#141414] p-4 sm:p-6">
        {/* Status row */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ${statusBgColor(task.status)}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${statusDotColor(task.status)} ${task.status === "running" ? "animate-pulse" : ""}`} />
              <span className={`text-xs font-medium ${statusColor(task.status)}`}>{statusLabel(task.status)}</span>
            </div>
            {task.status === "running" && <SpinnerIcon className="h-3.5 w-3.5 animate-spin text-blue-400" />}
            <span className="text-xs text-zinc-600" title={formatTime(task.created_at)} suppressHydrationWarning>{relativeTime(task.created_at)}</span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {isRetryable(task.status) && (
              <button
                type="button"
                onClick={handleRetry}
                disabled={actionBusy !== null}
                className="flex items-center gap-1.5 rounded-lg bg-honey-500 px-3 py-1.5 text-xs font-semibold text-[#0a0a0a] transition-colors hover:bg-honey-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {actionBusy === "retry" ? <SpinnerIcon className="h-3.5 w-3.5 animate-spin" /> : <RetryIcon className="h-3.5 w-3.5" />}
                Retry
              </button>
            )}
            {isDeletable(task.status) && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={actionBusy !== null}
                className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-red-500/20 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {actionBusy === "delete" ? <SpinnerIcon className="h-3.5 w-3.5 animate-spin" /> : <TrashIcon className="h-3.5 w-3.5" />}
                Delete
              </button>
            )}
          </div>
        </div>

        {actionError && (
          <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2">
            <p className="text-sm text-red-400">{actionError}</p>
          </div>
        )}

        {/* Prompt as title */}
        <h1 className="mt-4 text-[15px] font-medium leading-relaxed text-[#fafafa] sm:text-base">{task.prompt}</h1>

        {/* Metadata chips */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {task.repos.map((repo) => (
            <span key={repo} className="inline-flex items-center gap-1.5 rounded-md bg-white/[0.05] px-2.5 py-1 text-xs text-zinc-400">
              <RepoIcon className="h-3 w-3 text-zinc-500" />
              <span className="font-mono">{repo}</span>
            </span>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-1.5 text-xs text-zinc-600">
          <ClockIcon className="h-3 w-3 text-zinc-600" />
          <span>Timeout {formatDuration(task.timeout_secs)}</span>
        </div>

        {/* Progress (running tasks) */}
        {task.progress && !isTerminal(task.status) && task.status !== "needs_follow_up" && (
          <p className="mt-4 text-xs text-zinc-500">{task.progress}</p>
        )}

        {/* Error (terminal tasks) */}
        {task.error && isTerminal(task.status) && (
          <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2.5">
            <p className="text-sm text-red-400">{task.error}</p>
          </div>
        )}
      </div>

      {/* ── Messages ─────────────────────────────────────────────────── */}
      <div className="space-y-3 pb-24 sm:pb-28">
        {conversationMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.03]">
              <MessageSquareIcon className="h-4 w-4 text-zinc-700" />
            </div>
            <p className="text-sm text-zinc-500">No conversation yet</p>
            <p className="mt-1 text-xs text-zinc-700">Only user and agent messages appear here.</p>
          </div>
        ) : (
          conversationMessages.map((msg, i) => {
            const isUser = msg.role === "user";

            return (
              <div key={`${msg.created_at}-${i}`} className="animate-message-in" style={{ animationDelay: `${i * 40}ms` }}>
                <div className="mb-1 flex items-center gap-2">
                  <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${isUser ? "bg-honey-500/10 ring-1 ring-honey-500/20" : "bg-blue-500/10 ring-1 ring-blue-500/20"}`}>
                    {isUser ? <UserIcon className="h-3 w-3 text-honey-500" /> : <BotIcon className="h-3 w-3 text-blue-400" />}
                  </div>
                  <span className={`text-xs font-semibold ${isUser ? "text-honey-500" : "text-blue-400"}`}>
                    {isUser ? "You" : "Agent"}
                  </span>
                  <span className="text-[11px] text-zinc-600" suppressHydrationWarning>{relativeTime(msg.created_at)}</span>
                </div>

                <div className={`rounded-xl px-3 py-2 sm:ml-7 sm:px-4 sm:py-2.5 ${isUser ? "border border-honey-500/[0.08] bg-honey-500/[0.04]" : "border border-white/[0.04] bg-white/[0.02]"}`}>
                  {msg.role === "agent" ? (
                    <MarkdownContent>{msg.content}</MarkdownContent>
                  ) : (
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">{msg.content}</p>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* ── Follow-up input (sticky) ─────────────────────────────────── */}
      {canSendMessage(task.status) && (
        <div className="sticky bottom-0 z-10 -mx-4 bg-gradient-to-t from-[var(--bg-primary)] via-[var(--bg-primary)]/94 to-transparent px-4 pb-4 pt-5 sm:-mx-6 sm:px-6">
          {composerGuidance && (
            <div className="mb-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 sm:px-4">
              <p className="text-sm text-amber-400">{composerGuidance}</p>
            </div>
          )}

          {followUpError && (
            <div className="mb-3 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2">
              <p className="text-sm text-red-400">{followUpError}</p>
            </div>
          )}

          <form onSubmit={handleSendMessage}>
            <div className="relative rounded-2xl border border-white/[0.06] bg-[#111111]/92 backdrop-blur-sm transition-all focus-within:border-honey-500/30 focus-within:ring-2 focus-within:ring-honey-500/10">
              <textarea
                ref={textareaRef}
                rows={1}
                value={followUpText}
                onChange={(e) => setFollowUpText(e.target.value)}
                onKeyDown={(e) => {
                  if (isSubmitShortcut(e)) {
                    e.preventDefault();
                    submitMessage();
                  }
                }}
                placeholder={taskComposerPlaceholder(task.status)}
                className="w-full resize-none bg-transparent px-4 pb-12 pt-3.5 text-sm leading-relaxed text-[#fafafa] placeholder-zinc-600 focus:outline-none"
              />
              <div className="absolute bottom-3 right-3 flex items-center gap-2.5">
                <span className="hidden text-[11px] text-zinc-600 sm:inline">
                  {"\u2318"}Enter
                </span>
                <button
                  type="submit"
                  disabled={followUpSubmitting || !followUpText.trim()}
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-honey-500 text-[#0a0a0a] transition-all hover:bg-honey-400 disabled:opacity-30 sm:h-9 sm:w-9"
                >
                  {followUpSubmitting ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : <SendIcon className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
