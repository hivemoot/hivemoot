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

/** SessionStorage key for the create-task prompt draft. */
export const DRAFT_PROMPT_KEY = "create-task-draft-prompt";

/** SessionStorage key for the create-task repos draft. */
export const DRAFT_REPOS_KEY = "create-task-draft-repos";
