import { describe, it, expect } from "vitest";
import {
  DRAFT_PROMPT_KEY,
  DRAFT_REPOS_KEY,
  draftStorageKey,
  filterDuplicatePrompt,
  isSubmitShortcut,
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
