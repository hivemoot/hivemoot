"use client";

import Link from "next/link";
import Markdown, { type ExtraProps } from "react-markdown";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskRecord {
  task_id: string;
  status: string;
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
}

interface TaskMessage {
  role: "user" | "agent" | "system";
  content: string;
  created_at: string;
}

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

const TERMINAL_SYSTEM_MESSAGES = new Set([
  "Task completed.",
  "Task timed out.",
]);

function isTerminalSystemMessage(msg: TaskMessage): boolean {
  return msg.role === "system" && (
    TERMINAL_SYSTEM_MESSAGES.has(msg.content) || msg.content.startsWith("Task failed:")
  );
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

function messageBannerText(status: string): string | null {
  switch (status) {
    case "needs_follow_up":
      return "The agent is waiting for your input to continue working on this task.";
    case "pending":
      return "This task is queued. Add a message to provide more context before the agent picks it up.";
    case "completed":
      return "This task is complete. Send a message to reopen it with new instructions.";
    case "failed":
    case "timed_out":
      return "This task did not succeed. Send a message to retry with additional context.";
    default:
      return null;
  }
}

function messageBannerColor(status: string): string {
  switch (status) {
    case "needs_follow_up":
      return "border-amber-500/20 bg-amber-500/5";
    case "pending":
      return "border-zinc-500/20 bg-zinc-500/5";
    case "completed":
      return "border-green-500/20 bg-green-500/5";
    case "failed":
    case "timed_out":
      return "border-red-500/20 bg-red-500/5";
    default:
      return "border-white/[0.06] bg-white/[0.02]";
  }
}

function messageBannerTextColor(status: string): string {
  switch (status) {
    case "needs_follow_up":
      return "text-amber-400";
    case "pending":
      return "text-zinc-400";
    case "completed":
      return "text-green-400";
    case "failed":
    case "timed_out":
      return "text-red-400";
    default:
      return "text-zinc-400";
  }
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

const InPre = createContext(false);

function MdPre({ children }: React.ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  return (
    <InPre.Provider value={true}>
      <pre className="my-2.5 overflow-auto rounded-lg bg-black/40 p-3.5 text-[13px] leading-relaxed">{children}</pre>
    </InPre.Provider>
  );
}

function MdCode({ className, children }: React.ComponentPropsWithoutRef<"code"> & ExtraProps) {
  const inPre = useContext(InPre);
  if (inPre) {
    return <code className={`${className ?? ""} font-mono text-[13px]`}>{children}</code>;
  }
  return <code className="rounded bg-white/[0.08] px-1.5 py-0.5 font-mono text-[13px]">{children}</code>;
}

function MarkdownContent({ children, className }: { children: string; className?: string }) {
  return (
    <div className={`text-sm leading-relaxed text-zinc-300 ${className ?? ""}`}>
      <Markdown
        components={{
          h1: ({ children: c }) => <h1 className="mb-2 mt-4 text-base font-bold text-[#fafafa]">{c}</h1>,
          h2: ({ children: c }) => <h2 className="mb-1.5 mt-3 text-sm font-bold text-[#fafafa]">{c}</h2>,
          h3: ({ children: c }) => <h3 className="mb-1 mt-2 text-sm font-semibold text-zinc-200">{c}</h3>,
          p: ({ children: c }) => <p className="my-1.5">{c}</p>,
          ul: ({ children: c }) => <ul className="my-1.5 ml-5 list-disc">{c}</ul>,
          ol: ({ children: c }) => <ol className="my-1.5 ml-5 list-decimal">{c}</ol>,
          li: ({ children: c }) => <li className="mt-0.5">{c}</li>,
          code: MdCode,
          pre: MdPre,
          a: ({ href, children: c }) => (
            <a href={href} className="text-honey-500 hover:underline" target="_blank" rel="noopener noreferrer">{c}</a>
          ),
          strong: ({ children: c }) => <strong className="font-semibold text-[#fafafa]">{c}</strong>,
          em: ({ children: c }) => <em className="italic text-zinc-400">{c}</em>,
          blockquote: ({ children: c }) => (
            <blockquote className="my-2 border-l-2 border-zinc-700 pl-3 italic text-zinc-500">{c}</blockquote>
          ),
          hr: () => <hr className="my-3 border-white/10" />,
        }}
      >
        {children}
      </Markdown>
    </div>
  );
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
  const sseRef = useRef<{ close: () => void } | null>(null);

  // Fetch task + messages
  const fetchTask = useCallback(async () => {
    try {
      const [taskRes, msgRes] = await Promise.all([
        fetch(`/api/tasks/${taskId}`),
        fetch(`/api/tasks/${taskId}/messages`),
      ]);

      if (!taskRes.ok) {
        if (taskRes.status === 401) {
          setError("Session expired — please log in again.");
          return;
        }
        if (taskRes.status === 404) {
          setError("Task not found.");
          return;
        }
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
      setError("Network error — could not reach server.");
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchTask();
  }, [fetchTask]);

  // Auto-scroll messages when new ones arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // SSE streaming for live updates
  useEffect(() => {
    if (!task || isTerminal(task.status) || task.status === "needs_follow_up") return;

    let closed = false;

    function connectSSE() {
      if (closed) return;

      const eventSource = new EventSource(`/api/tasks/${taskId}/stream`);

      eventSource.addEventListener("snapshot", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          if (data.task) setTask(data.task);
        } catch {
          // Ignore malformed SSE data.
        }
      });

      eventSource.addEventListener("task", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          if (data.task) {
            setTask(data.task);
            fetch(`/api/tasks/${taskId}/messages`)
              .then((res) => (res.ok ? res.json() : null))
              .then((data) => {
                if (data?.messages) setMessages(data.messages);
              })
              .catch(() => {
                // Best-effort message refresh.
              });
          }
        } catch {
          // Ignore malformed SSE data.
        }
      });

      eventSource.addEventListener("done", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          if (data.task) setTask(data.task);
        } catch {
          // Ignore malformed SSE data.
        }
        eventSource.close();
        fetch(`/api/tasks/${taskId}/messages`)
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (data?.messages) setMessages(data.messages);
          })
          .catch(() => {
            // Best-effort.
          });
      });

      eventSource.addEventListener("error", () => {
        eventSource.close();
        if (!closed) {
          setTimeout(connectSSE, 3000);
        }
      });

      sseRef.current = { close: () => eventSource.close() };
    }

    connectSSE();

    return () => {
      closed = true;
      sseRef.current?.close();
    };
  }, [task?.status, taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Message submission (uses follow-up route for needs_follow_up, messages route otherwise)
  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (followUpSubmitting) return;

    const trimmed = followUpText.trim();
    if (!trimmed) {
      setFollowUpError("Please enter a message.");
      return;
    }

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
        setFollowUpError(
          err.message
          ?? (endpoint === "follow-up" ? "Failed to send follow-up." : "Failed to send message."),
        );
        return;
      }

      const data = await res.json();
      if (data.task) setTask(data.task);
      setFollowUpText("");
      // Refresh messages to show the new message in the timeline.
      await fetchTask();
    } catch {
      setFollowUpError("Could not reach the server.");
    } finally {
      setFollowUpSubmitting(false);
    }
  }

  // Retry handler
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
      router.push(`/dashboard/tasks/${data.task_id}`);
    } catch {
      setActionError("Could not reach the server.");
    } finally {
      setActionBusy(null);
    }
  }

  // Delete handler
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

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center gap-3 py-16 text-sm text-zinc-500">
        <SpinnerIcon />
        Loading task...
      </div>
    );
  }

  if (error || !task) {
    return (
      <div>
        <Link
          href="/dashboard/tasks"
          className="group mb-8 inline-flex items-center gap-2 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" />
          Back to tasks
        </Link>
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6">
          <p className="text-sm text-red-400">{error ?? "Task not found."}</p>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div>
      {/* Back link */}
      <Link
        href="/dashboard/tasks"
        className="group mb-8 inline-flex items-center gap-2 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
      >
        <ArrowLeftIcon className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" />
        Back to tasks
      </Link>

      {/* Task header */}
      <div className="mb-6 rounded-xl border border-white/[0.06] bg-[#141414] p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            {/* Status pill */}
            <div className="flex items-center gap-3">
              <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 ${statusBgColor(task.status)}`}>
                <span className={`h-2 w-2 rounded-full ${statusDotColor(task.status)} ${
                  task.status === "running" ? "animate-pulse" : ""
                }`} />
                <span className={`text-xs font-semibold ${statusColor(task.status)}`}>
                  {statusLabel(task.status)}
                </span>
              </div>
              {task.status === "running" && (
                <SpinnerIcon className="h-3.5 w-3.5 animate-spin text-blue-400" />
              )}
            </div>

            {/* Prompt */}
            <p className="mt-4 text-[15px] leading-relaxed text-zinc-200">{task.prompt}</p>
          </div>

          {/* Action buttons */}
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
                className="flex items-center gap-1.5 rounded-lg border border-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-400 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {actionBusy === "delete" ? <SpinnerIcon className="h-3.5 w-3.5 animate-spin" /> : <TrashIcon className="h-3.5 w-3.5" />}
                Delete
              </button>
            )}
          </div>
        </div>

        {/* Action error */}
        {actionError && (
          <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2">
            <p className="text-sm text-red-400">{actionError}</p>
          </div>
        )}

        {/* Metadata */}
        <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-white/[0.06] pt-5 sm:grid-cols-3">
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">Repos</dt>
            <dd className="mt-1 font-mono text-xs text-zinc-400">{task.repos.join(", ")}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">Created</dt>
            <dd className="mt-1 text-xs text-zinc-400" title={formatTime(task.created_at)}>
              {relativeTime(task.created_at)}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">Timeout</dt>
            <dd className="mt-1 text-xs text-zinc-400">{task.timeout_secs}s</dd>
          </div>
        </dl>

        {/* Progress */}
        {task.progress && !isTerminal(task.status) && task.status !== "needs_follow_up" && (
          <div className="mt-4 border-t border-white/[0.06] pt-4">
            <p className="text-xs text-zinc-500">{task.progress}</p>
          </div>
        )}

        {/* Error display */}
        {task.error && isTerminal(task.status) && (
          <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
            <p className="text-sm text-red-400">{task.error}</p>
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="rounded-xl border border-white/[0.06] bg-[#141414] p-6">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.04]">
              <MessageSquareIcon className="h-4 w-4 text-zinc-600" />
            </div>
            <p className="text-sm text-zinc-500">No messages yet</p>
            <p className="mt-1 text-xs text-zinc-700">
              Messages will appear here once the task starts.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {messages.map((msg, i) => {
              const isTermSys = isTerminalSystemMessage(msg);
              const isSuccess = isTermSys && msg.content === "Task completed.";
              const isFailure = isTermSys && !isSuccess;

              // System messages render as centered status dividers
              if (msg.role === "system") {
                return (
                  <div key={`${msg.created_at}-${i}`} className="flex items-center gap-3 py-1">
                    <div className="h-px flex-1 bg-white/[0.06]" />
                    <div className="flex shrink-0 items-center gap-2.5">
                      <span className={`h-2.5 w-2.5 rounded-full ${
                        isSuccess ? "bg-green-400" : isFailure ? "bg-red-400" : "bg-zinc-600"
                      }`} />
                      <span className={`text-xs font-medium ${
                        isSuccess ? "text-green-400" : isFailure ? "text-red-400" : "text-zinc-500"
                      }`}>
                        {msg.content}
                      </span>
                      <span className="text-xs text-zinc-600">{relativeTime(msg.created_at)}</span>
                    </div>
                    <div className="h-px flex-1 bg-white/[0.06]" />
                  </div>
                );
              }

              // User / agent messages render as chat bubbles
              const isUser = msg.role === "user";

              return (
                <div key={`${msg.created_at}-${i}`} className="flex gap-3.5">
                  {/* Avatar */}
                  <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                    isUser
                      ? "bg-honey-500/10 ring-1 ring-honey-500/20"
                      : "bg-blue-500/10 ring-1 ring-blue-500/20"
                  }`}>
                    {isUser ? (
                      <UserIcon className="h-3.5 w-3.5 text-honey-500" />
                    ) : (
                      <BotIcon className="h-3.5 w-3.5 text-blue-400" />
                    )}
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex items-baseline gap-2">
                      <span className={`text-[13px] font-semibold ${
                        isUser ? "text-honey-500" : "text-blue-400"
                      }`}>
                        {isUser ? "You" : "Agent"}
                      </span>
                      <span className="text-xs text-zinc-600">{relativeTime(msg.created_at)}</span>
                    </div>
                    <div className={`rounded-lg px-4 py-3 ${
                      isUser
                        ? "bg-honey-500/[0.06]"
                        : "bg-blue-500/[0.04]"
                    }`}>
                      {msg.role === "agent" ? (
                        <div className="max-h-[32rem] overflow-auto">
                          <MarkdownContent>{msg.content}</MarkdownContent>
                        </div>
                      ) : (
                        <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">
                          {msg.content}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        )}

        {/* Message input */}
        {canSendMessage(task.status) && (
          <div className="mt-6 border-t border-white/[0.06] pt-5">
            {messageBannerText(task.status) && (
              <div className={`mb-4 rounded-lg border px-4 py-3 ${messageBannerColor(task.status)}`}>
                <p className={`text-sm ${messageBannerTextColor(task.status)}`}>
                  {messageBannerText(task.status)}
                </p>
              </div>
            )}

            {followUpError && (
              <div className="mb-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2.5">
                <p className="text-sm text-red-400">{followUpError}</p>
              </div>
            )}

            <form onSubmit={handleSendMessage} className="flex items-end gap-3">
              <textarea
                rows={2}
                value={followUpText}
                onChange={(e) => setFollowUpText(e.target.value)}
                placeholder={
                  task.status === "needs_follow_up"
                    ? "Type your follow-up message..."
                    : "Type a message..."
                }
                className="flex-1 resize-y rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm text-[#fafafa] placeholder-zinc-600 transition-all focus:border-honey-500/30 focus:outline-none focus:ring-2 focus:ring-honey-500/10"
              />
              <button
                type="submit"
                disabled={followUpSubmitting}
                className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-honey-500 text-[#0a0a0a] transition-colors hover:bg-honey-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {followUpSubmitting ? (
                  <SpinnerIcon className="h-4 w-4 animate-spin" />
                ) : (
                  <SendIcon className="h-4 w-4" />
                )}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
