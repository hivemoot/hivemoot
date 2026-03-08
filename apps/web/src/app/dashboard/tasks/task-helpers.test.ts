import { describe, it, expect } from "vitest";
import {
  DRAFT_PROMPT_KEY,
  DRAFT_REPOS_KEY,
  draftStorageKey,
  filterConversationMessages,
  filterDuplicatePrompt,
  isSubmitShortcut,
  taskComposerGuidance,
  taskComposerPlaceholder,
  type TaskMessage,
} from "./task-helpers";

// ---------------------------------------------------------------------------
// filterDuplicatePrompt
// ---------------------------------------------------------------------------

describe("filterDuplicatePrompt", () => {
  const agentMsg: TaskMessage = { role: "agent", content: "Working on it.", created_at: "2026-01-01T00:00:01Z" };
  const systemMsg: TaskMessage = { role: "system", content: "Task completed.", created_at: "2026-01-01T00:00:02Z" };

  it("filters the first user message when it matches the prompt exactly", () => {
    const messages: TaskMessage[] = [
      { role: "user", content: "Fix the bug", created_at: "2026-01-01T00:00:00Z" },
      agentMsg,
    ];
    const result = filterDuplicatePrompt(messages, "Fix the bug");
    expect(result).toEqual([agentMsg]);
  });

  it("filters when prompt and message differ only in whitespace", () => {
    const messages: TaskMessage[] = [
      { role: "user", content: "  Fix the bug  ", created_at: "2026-01-01T00:00:00Z" },
      agentMsg,
    ];
    const result = filterDuplicatePrompt(messages, "Fix the bug");
    expect(result).toEqual([agentMsg]);
  });

  it("keeps the first user message when content differs from prompt", () => {
    const userMsg: TaskMessage = { role: "user", content: "Something else", created_at: "2026-01-01T00:00:00Z" };
    const messages: TaskMessage[] = [userMsg, agentMsg];
    const result = filterDuplicatePrompt(messages, "Fix the bug");
    expect(result).toEqual([userMsg, agentMsg]);
  });

  it("keeps the first message when its role is not user", () => {
    const messages: TaskMessage[] = [agentMsg, systemMsg];
    const result = filterDuplicatePrompt(messages, agentMsg.content);
    expect(result).toEqual([agentMsg, systemMsg]);
  });

  it("only filters index 0 — later duplicates are kept", () => {
    const dup: TaskMessage = { role: "user", content: "Fix the bug", created_at: "2026-01-01T00:00:03Z" };
    const messages: TaskMessage[] = [
      { role: "user", content: "Fix the bug", created_at: "2026-01-01T00:00:00Z" },
      agentMsg,
      dup,
    ];
    const result = filterDuplicatePrompt(messages, "Fix the bug");
    expect(result).toEqual([agentMsg, dup]);
  });

  it("returns empty array when given empty messages", () => {
    expect(filterDuplicatePrompt([], "anything")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// filterConversationMessages
// ---------------------------------------------------------------------------

describe("filterConversationMessages", () => {
  const agentMsg: TaskMessage = { role: "agent", content: "Working on it.", created_at: "2026-01-01T00:00:01Z" };
  const systemMsg: TaskMessage = { role: "system", content: "Task completed.", created_at: "2026-01-01T00:00:02Z" };

  it("removes lifecycle system rows after filtering the duplicate prompt", () => {
    const messages: TaskMessage[] = [
      { role: "user", content: "Fix the bug", created_at: "2026-01-01T00:00:00Z" },
      agentMsg,
      systemMsg,
    ];

    expect(filterConversationMessages(messages, "Fix the bug")).toEqual([agentMsg]);
  });

  it("keeps non-duplicate user and agent chat messages", () => {
    const userMsg: TaskMessage = { role: "user", content: "One more detail", created_at: "2026-01-01T00:00:03Z" };
    const messages: TaskMessage[] = [agentMsg, systemMsg, userMsg];

    expect(filterConversationMessages(messages, "Different prompt")).toEqual([agentMsg, userMsg]);
  });

  it("returns empty array when the timeline only contains the prompt echo and system rows", () => {
    const messages: TaskMessage[] = [
      { role: "user", content: "Fix the bug", created_at: "2026-01-01T00:00:00Z" },
      systemMsg,
    ];

    expect(filterConversationMessages(messages, "Fix the bug")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isSubmitShortcut
// ---------------------------------------------------------------------------

describe("isSubmitShortcut", () => {
  it("returns true for Cmd+Enter (Mac)", () => {
    expect(isSubmitShortcut({ key: "Enter", metaKey: true, ctrlKey: false })).toBe(true);
  });

  it("returns true for Ctrl+Enter (Windows/Linux)", () => {
    expect(isSubmitShortcut({ key: "Enter", metaKey: false, ctrlKey: true })).toBe(true);
  });

  it("returns false for Enter alone", () => {
    expect(isSubmitShortcut({ key: "Enter", metaKey: false, ctrlKey: false })).toBe(false);
  });

  it("returns false for Cmd without Enter", () => {
    expect(isSubmitShortcut({ key: "a", metaKey: true, ctrlKey: false })).toBe(false);
  });

  it("returns false for Ctrl without Enter", () => {
    expect(isSubmitShortcut({ key: "Shift", metaKey: false, ctrlKey: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// draftStorageKey
// ---------------------------------------------------------------------------

describe("draftStorageKey", () => {
  it("returns a key scoped to the task ID", () => {
    expect(draftStorageKey("abc-123")).toBe("task-draft-abc-123");
  });

  it("produces distinct keys for distinct task IDs", () => {
    expect(draftStorageKey("a")).not.toBe(draftStorageKey("b"));
  });
});

// ---------------------------------------------------------------------------
// Composer copy
// ---------------------------------------------------------------------------

describe("taskComposerPlaceholder", () => {
  it("returns follow-up-specific placeholder text", () => {
    expect(taskComposerPlaceholder("needs_follow_up")).toBe("Answer the agent to continue this task…");
  });

  it("returns retry/reopen copy for terminal and queued states", () => {
    expect(taskComposerPlaceholder("pending")).toBe("Add more context while this task is queued…");
    expect(taskComposerPlaceholder("completed")).toBe("Send a message to reopen this completed task…");
    expect(taskComposerPlaceholder("failed")).toBe("Send a message to retry this failed task…");
    expect(taskComposerPlaceholder("timed_out")).toBe("Send a message to retry this timed-out task…");
  });

  it("falls back to the default composer copy for other states", () => {
    expect(taskComposerPlaceholder("running")).toBe("Type a message…");
  });
});

describe("taskComposerGuidance", () => {
  it("only returns inline guidance when the agent is waiting for follow-up", () => {
    expect(taskComposerGuidance("needs_follow_up")).toBe(
      "The agent is waiting for your input to continue working on this task.",
    );
    expect(taskComposerGuidance("completed")).toBeNull();
    expect(taskComposerGuidance("pending")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Draft constants
// ---------------------------------------------------------------------------

describe("draft storage constants", () => {
  it("DRAFT_PROMPT_KEY is a non-empty string", () => {
    expect(typeof DRAFT_PROMPT_KEY).toBe("string");
    expect(DRAFT_PROMPT_KEY.length).toBeGreaterThan(0);
  });

  it("DRAFT_REPOS_KEY is a non-empty string", () => {
    expect(typeof DRAFT_REPOS_KEY).toBe("string");
    expect(DRAFT_REPOS_KEY.length).toBeGreaterThan(0);
  });

  it("prompt and repos keys are distinct", () => {
    expect(DRAFT_PROMPT_KEY).not.toBe(DRAFT_REPOS_KEY);
  });
});
