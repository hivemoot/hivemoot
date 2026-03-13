// Pure helpers shared by TaskDetail and TasksDashboard.
// Extracted so they can be unit-tested without a DOM environment.
import type { TaskMessage } from "./types";
export type { TaskMessage } from "./types";

// ---------------------------------------------------------------------------
// First-message deduplication
// ---------------------------------------------------------------------------

/**
 * Filters out the first timeline message when it's a user message that
 * duplicates the task prompt (the prompt is already shown in the header).
 */
export function filterDuplicatePrompt(
  messages: TaskMessage[],
  prompt: string,
): TaskMessage[] {
  return messages.filter((msg, i) => {
    if (i === 0 && msg.role === "user" && msg.content.trim() === prompt.trim()) return false;
    return true;
  });
}

/**
 * Keeps only user/agent chat rows after removing the duplicated prompt.
 * System lifecycle rows belong in task state/progress, not the conversation.
 */
export function filterConversationMessages(
  messages: TaskMessage[],
  prompt: string,
): TaskMessage[] {
  return filterDuplicatePrompt(messages, prompt).filter((msg) => msg.role !== "system");
}

// ---------------------------------------------------------------------------
// Keyboard shortcut detection
// ---------------------------------------------------------------------------

/** Returns true when the user pressed Cmd+Enter (Mac) or Ctrl+Enter. */
export function isSubmitShortcut(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey);
}

// ---------------------------------------------------------------------------
// Draft persistence keys
// ---------------------------------------------------------------------------

/** Per-task draft key for the follow-up textarea in TaskDetail. */
export function draftStorageKey(taskId: string): string {
  return `task-draft-${taskId}`;
}

/**
 * Status-aware placeholder text keeps the sticky composer useful without
 * duplicating the task state as a second status banner.
 */
export function taskComposerPlaceholder(status: string): string {
  switch (status) {
    case "needs_follow_up":
      return "Answer the agent to continue this task…";
    case "pending":
      return "Add more context while this task is queued…";
    case "completed":
      return "Send a message to reopen this completed task…";
    case "failed":
      return "Send a message to retry this failed task…";
    case "timed_out":
      return "Send a message to retry this timed-out task…";
    default:
      return "Type a message…";
  }
}

/** Inline composer guidance is only needed when the agent is actively waiting. */
export function taskComposerGuidance(status: string): string | null {
  return status === "needs_follow_up"
    ? "The agent is waiting for your input to continue working on this task."
    : null;
}

/** SessionStorage key for the create-task prompt draft. */
export const DRAFT_PROMPT_KEY = "create-task-draft-prompt";

/** SessionStorage key for the create-task repos draft. */
export const DRAFT_REPOS_KEY = "create-task-draft-repos";
