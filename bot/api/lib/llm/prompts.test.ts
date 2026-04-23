import { describe, it, expect } from "vitest";
import { buildUserPrompt } from "./prompts.js";
import type { IssueContext } from "./types.js";

/**
 * Tests for LLM Prompts
 */

describe("buildUserPrompt", () => {
  it("should include issue title and body", () => {
    const context: IssueContext = {
      title: "Add dark mode support",
      body: "We should add a dark mode toggle to the settings page.",
      author: "alice",
      comments: [],
    };

    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("## Issue: Add dark mode support");
    expect(prompt).toContain("We should add a dark mode toggle to the settings page.");
  });

  it("should handle empty body", () => {
    const context: IssueContext = {
      title: "Quick fix",
      body: "",
      author: "alice",
      comments: [],
    };

    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("(No description provided)");
  });

  it("should indicate no comments when empty", () => {
    const context: IssueContext = {
      title: "Test",
      body: "Body",
      author: "alice",
      comments: [],
    };

    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("Total comments: 0");
    expect(prompt).toContain("Unique participants: 0");
    expect(prompt).toContain("(No comments yet)");
  });

  it("should format comments with author and timestamp", () => {
    const context: IssueContext = {
      title: "Feature request",
      body: "Add feature X",
      author: "issueAuthor",
      comments: [
        { author: "alice", body: "I support this!", createdAt: "2024-01-15T10:30:00Z" },
        { author: "bob", body: "Me too", createdAt: "2024-01-16T14:00:00Z" },
      ],
    };

    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("**@alice** (2024-01-15T10:30:00Z):");
    expect(prompt).toContain("I support this!");
    expect(prompt).toContain("**@bob** (2024-01-16T14:00:00Z):");
    expect(prompt).toContain("Me too");
  });

  it("should count unique participants correctly", () => {
    const context: IssueContext = {
      title: "Discussion",
      body: "Let's discuss",
      author: "issueAuthor",
      comments: [
        { author: "alice", body: "Comment 1", createdAt: "2024-01-01T00:00:00Z" },
        { author: "bob", body: "Comment 2", createdAt: "2024-01-02T00:00:00Z" },
        { author: "alice", body: "Comment 3", createdAt: "2024-01-03T00:00:00Z" },
        { author: "charlie", body: "Comment 4", createdAt: "2024-01-04T00:00:00Z" },
      ],
    };

    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("Total comments: 4");
    expect(prompt).toContain("Unique participants: 3");
  });

  it("should include voting context reminder", () => {
    const context: IssueContext = {
      title: "Test",
      body: "Body",
      author: "alice",
      comments: [],
    };

    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("READY TO IMPLEMENT");
    expect(prompt).toContain("governance vote");
  });

  describe("truncation", () => {
    it("should truncate very long discussions, keeping recent comments", () => {
      // Create a context with many long comments
      const comments = Array.from({ length: 200 }, (_, i) => ({
        author: `user${i % 10}`,
        body: `This is comment number ${i}. `.repeat(100), // ~2500 chars each
        createdAt: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      }));

      const context: IssueContext = {
        title: "Long discussion",
        body: "Original proposal",
        author: "issueAuthor",
        comments,
      };

      const prompt = buildUserPrompt(context);

      // Should be truncated to ~100k chars
      expect(prompt.length).toBeLessThanOrEqual(110000);

      // Should indicate truncation
      expect(prompt).toContain("older comments truncated");

      // Should include metadata about original count
      expect(prompt).toContain("Total comments: 200");

      // Recent comments should be included (last ones)
      expect(prompt).toContain("comment number 199");
    });

    it("should preserve issue body even with long discussions", () => {
      const longBody = "Important context. ".repeat(500);
      const comments = Array.from({ length: 100 }, (_, i) => ({
        author: "user",
        body: `Comment ${i}. `.repeat(200),
        createdAt: "2024-01-01T00:00:00Z",
      }));

      const context: IssueContext = {
        title: "Issue with long body",
        body: longBody,
        author: "issueAuthor",
        comments,
      };

      const prompt = buildUserPrompt(context);

      // Issue body should be preserved
      expect(prompt).toContain("Important context.");
      expect(prompt).toContain("### Original Description");
    });
  });
});
