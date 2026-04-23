import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BlueprintGenerator, buildBlueprintUserPrompt, truncateDiscussion } from "./blueprint.js";
import type { ImplementationPlan, IssueContext } from "./types.js";
import type { Logger } from "../logger.js";

/**
 * Tests for BlueprintGenerator
 *
 * Mirrors summarizer.test.ts structure:
 * - LLM not configured → failure
 * - No discussion from others → minimal blueprint
 * - Successful generation → structured plan
 * - Metadata mismatch → fail closed
 * - LLM API failure → failure with reason
 */

// Mock the AI SDK
vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

// Mock the provider module
vi.mock("./provider.js", () => ({
  createModelFromEnv: vi.fn(),
}));

// Mock the JSON repair module
vi.mock("./json-repair.js", () => ({
  repairMalformedJsonText: vi.fn(),
}));

describe("BlueprintGenerator", () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      group: vi.fn(),
      groupEnd: vi.fn(),
    };
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("when LLM is not configured", () => {
    it("should return failure with reason", async () => {
      const { createModelFromEnv } = await import("./provider.js");
      vi.mocked(createModelFromEnv).mockResolvedValue(null);

      const generator = new BlueprintGenerator({ logger: mockLogger });
      const context: IssueContext = {
        title: "Test Issue",
        body: "Test body",
        author: "issueAuthor",
        comments: [
          { author: "user1", body: "Comment 1", createdAt: "2024-01-01T00:00:00Z" },
        ],
      };

      const result = await generator.generate(context);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("LLM not configured");
      }
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "LLM not configured, skipping blueprint generation"
      );
    });
  });

  describe("when there is no meaningful discussion", () => {
    it("should return minimal blueprint when there are no comments", async () => {
      const generator = new BlueprintGenerator({ logger: mockLogger });
      const context: IssueContext = {
        title: "Add dark mode support",
        body: "We should add dark mode to the app",
        author: "alice",
        comments: [],
      };

      const result = await generator.generate(context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.plan.goal).toBe("Add dark mode support");
        expect(result.plan.plan).toBe("");
        expect(result.plan.decisions).toEqual([]);
        expect(result.plan.outOfScope).toEqual([]);
        expect(result.plan.openQuestions).toEqual([]);
        expect(result.plan.metadata.commentCount).toBe(0);
        expect(result.plan.metadata.participantCount).toBe(0);
      }
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "No discussion from others, using minimal blueprint"
      );
    });

    it("should return minimal blueprint with accurate metadata when all comments are from issue author", async () => {
      const generator = new BlueprintGenerator({ logger: mockLogger });
      const context: IssueContext = {
        title: "Add dark mode support",
        body: "We should add dark mode to the app",
        author: "alice",
        comments: [
          { author: "alice", body: "Here's more context", createdAt: "2024-01-01T00:00:00Z" },
          { author: "alice", body: "And another update", createdAt: "2024-01-02T00:00:00Z" },
        ],
      };

      const result = await generator.generate(context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.plan.goal).toBe("Add dark mode support");
        expect(result.plan.metadata.commentCount).toBe(2);
        expect(result.plan.metadata.participantCount).toBe(1);
      }
    });
  });

  describe("when LLM generates a blueprint", () => {
    it("should return the LLM-generated plan", async () => {
      const mockPlan: ImplementationPlan = {
        goal: "Implement OAuth 2.0 authentication with GitHub and Google providers",
        plan: "1. Install passport.js\n2. Configure OAuth strategies\n3. Add login routes",
        decisions: ["Use OAuth 2.0", "Support GitHub and Google providers"],
        outOfScope: ["Password-based auth (rejected for security)"],
        openQuestions: ["Exact UI placement TBD"],
        metadata: {
          commentCount: 5,
          participantCount: 3,
        },
      };

      const { createModelFromEnv } = await import("./provider.js");
      const { generateObject } = await import("ai");

      vi.mocked(createModelFromEnv).mockResolvedValue({
        model: {} as never,
        config: { provider: "anthropic", model: "test", maxTokens: 2000 },
      });
      vi.mocked(generateObject).mockResolvedValue({
        object: mockPlan,
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 200 },
        rawResponse: undefined,
        response: undefined,
        warnings: undefined,
        experimental_providerMetadata: undefined,
        toJsonResponse: () => new Response(),
      } as never);

      const generator = new BlueprintGenerator({ logger: mockLogger });
      const context: IssueContext = {
        title: "Add OAuth authentication",
        body: "We need user auth",
        author: "issueAuthor",
        comments: [
          { author: "user1", body: "Let's use OAuth", createdAt: "2024-01-01T00:00:00Z" },
          { author: "user2", body: "Agreed, no passwords", createdAt: "2024-01-02T00:00:00Z" },
          { author: "user1", body: "Support GitHub", createdAt: "2024-01-03T00:00:00Z" },
          { author: "user3", body: "And Google too", createdAt: "2024-01-04T00:00:00Z" },
          { author: "user2", body: "UI placement can wait", createdAt: "2024-01-05T00:00:00Z" },
        ],
      };

      const result = await generator.generate(context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.plan.goal).toBe("Implement OAuth 2.0 authentication with GitHub and Google providers");
        expect(result.plan.decisions).toContain("Use OAuth 2.0");
        expect(result.plan.metadata.commentCount).toBe(5);
        expect(result.plan.metadata.participantCount).toBe(3);
      }
      expect(generateObject).toHaveBeenCalledWith(
        expect.objectContaining({
          experimental_repairText: expect.any(Function),
        })
      );
    });

    it("should include author marking and reaction signals in the prompt", async () => {
      const mockPlan: ImplementationPlan = {
        goal: "Test",
        plan: "",
        decisions: [],
        outOfScope: [],
        openQuestions: [],
        metadata: { commentCount: 2, participantCount: 2 },
      };

      const { createModelFromEnv } = await import("./provider.js");
      const { generateObject } = await import("ai");

      vi.mocked(createModelFromEnv).mockResolvedValue({
        model: {} as never,
        config: { provider: "anthropic", model: "test", maxTokens: 2000 },
      });
      vi.mocked(generateObject).mockResolvedValue({
        object: mockPlan,
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 200 },
        rawResponse: undefined,
        response: undefined,
        warnings: undefined,
        experimental_providerMetadata: undefined,
        toJsonResponse: () => new Response(),
      } as never);

      const generator = new BlueprintGenerator({ logger: mockLogger });
      const context: IssueContext = {
        title: "Test",
        body: "Body",
        author: "alice",
        comments: [
          { author: "alice", body: "My idea", createdAt: "2024-01-01T00:00:00Z" },
          {
            author: "bob",
            body: "Great idea",
            createdAt: "2024-01-02T00:00:00Z",
            reactions: { thumbsUp: 3, thumbsDown: 0 },
          },
        ],
      };

      await generator.generate(context);

      const callArgs = vi.mocked(generateObject).mock.calls[0][0] as Record<string, unknown>;
      const prompt = callArgs.prompt as string;

      // Author marking
      expect(prompt).toContain("@alice (author)");
      // Reaction signal
      expect(prompt).toContain("[👍 3]");
    });

    it("should fail closed when LLM returns incorrect metadata (possible hallucination)", async () => {
      const mockPlan: ImplementationPlan = {
        goal: "Test proposal",
        plan: "",
        decisions: [],
        outOfScope: [],
        openQuestions: [],
        metadata: {
          commentCount: 999,
          participantCount: 999,
        },
      };

      const { createModelFromEnv } = await import("./provider.js");
      const { generateObject } = await import("ai");

      vi.mocked(createModelFromEnv).mockResolvedValue({
        model: {} as never,
        config: { provider: "openai", model: "test", maxTokens: 2000 },
      });
      vi.mocked(generateObject).mockResolvedValue({
        object: mockPlan,
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 200 },
        rawResponse: undefined,
        response: undefined,
        warnings: undefined,
        experimental_providerMetadata: undefined,
        toJsonResponse: () => new Response(),
      } as never);

      const generator = new BlueprintGenerator({ logger: mockLogger });
      const context: IssueContext = {
        title: "Test Issue",
        body: "Test body",
        author: "issueAuthor",
        comments: [
          { author: "user1", body: "Comment 1", createdAt: "2024-01-01T00:00:00Z" },
          { author: "user2", body: "Comment 2", createdAt: "2024-01-02T00:00:00Z" },
        ],
      };

      const result = await generator.generate(context);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toContain("LLM metadata mismatch");
        expect(result.reason).toContain("possible hallucination");
      }
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("LLM metadata mismatch")
      );
    });
  });

  describe("when LLM API fails", () => {
    it("should return failure with error message", async () => {
      const { createModelFromEnv } = await import("./provider.js");
      const { generateObject } = await import("ai");

      vi.mocked(createModelFromEnv).mockResolvedValue({
        model: {} as never,
        config: { provider: "anthropic", model: "test", maxTokens: 2000 },
      });
      vi.mocked(generateObject).mockRejectedValue(new Error("API rate limit exceeded"));

      const generator = new BlueprintGenerator({ logger: mockLogger });
      const context: IssueContext = {
        title: "Test Issue",
        body: "Test body",
        author: "issueAuthor",
        comments: [
          { author: "user1", body: "Comment", createdAt: "2024-01-01T00:00:00Z" },
        ],
      };

      const result = await generator.generate(context);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("API rate limit exceeded");
      }
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Blueprint generation failed: API rate limit exceeded"
      );
    });
  });

  describe("experimental_repairText callback", () => {
    it("should log when JSON repair succeeds", async () => {
      const { createModelFromEnv } = await import("./provider.js");
      const { generateObject } = await import("ai");
      const { repairMalformedJsonText } = await import("./json-repair.js");

      vi.mocked(createModelFromEnv).mockResolvedValue({
        model: {} as never,
        config: { provider: "anthropic", model: "test", maxTokens: 2000 },
      });

      // Capture the repairText callback by intercepting generateObject
      let capturedRepairFn: ((args: { text: string; error: Error }) => Promise<string | null>) | undefined;
      vi.mocked(generateObject).mockImplementation(async (opts: Record<string, unknown>) => {
        capturedRepairFn = opts.experimental_repairText as typeof capturedRepairFn;
        return {
          object: {
            goal: "Test",
            plan: "",
            decisions: [],
            outOfScope: [],
            openQuestions: [],
            metadata: { commentCount: 1, participantCount: 1 },
          },
          finishReason: "stop",
          usage: { promptTokens: 100, completionTokens: 200 },
        } as never;
      });

      const generator = new BlueprintGenerator({ logger: mockLogger });
      await generator.generate({
        title: "Test",
        body: "Body",
        author: "alice",
        comments: [{ author: "bob", body: "Comment", createdAt: "2024-01-01T00:00:00Z" }],
      });

      expect(capturedRepairFn).toBeDefined();

      // Simulate repair succeeding
      vi.mocked(repairMalformedJsonText).mockResolvedValue('{"fixed": true}');
      await capturedRepairFn!({ text: "bad json", error: new Error("parse error") });

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Repaired malformed LLM JSON output (error: parse error)"
      );
    });

    it("should not log when JSON repair returns null", async () => {
      const { createModelFromEnv } = await import("./provider.js");
      const { generateObject } = await import("ai");
      const { repairMalformedJsonText } = await import("./json-repair.js");

      vi.mocked(createModelFromEnv).mockResolvedValue({
        model: {} as never,
        config: { provider: "anthropic", model: "test", maxTokens: 2000 },
      });

      let capturedRepairFn: ((args: { text: string; error: Error }) => Promise<string | null>) | undefined;
      vi.mocked(generateObject).mockImplementation(async (opts: Record<string, unknown>) => {
        capturedRepairFn = opts.experimental_repairText as typeof capturedRepairFn;
        return {
          object: {
            goal: "Test",
            plan: "",
            decisions: [],
            outOfScope: [],
            openQuestions: [],
            metadata: { commentCount: 1, participantCount: 1 },
          },
          finishReason: "stop",
          usage: { promptTokens: 100, completionTokens: 200 },
        } as never;
      });

      const generator = new BlueprintGenerator({ logger: mockLogger });
      await generator.generate({
        title: "Test",
        body: "Body",
        author: "alice",
        comments: [{ author: "bob", body: "Comment", createdAt: "2024-01-01T00:00:00Z" }],
      });

      // Simulate repair failing (returning null)
      vi.mocked(repairMalformedJsonText).mockResolvedValue(null);
      const result = await capturedRepairFn!({ text: "bad json", error: new Error("parse error") });

      expect(result).toBeNull();
      // The "Repaired malformed" log should NOT have been called
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.stringContaining("Repaired malformed")
      );
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// buildBlueprintUserPrompt
// ───────────────────────────────────────────────────────────────────────────────

describe("buildBlueprintUserPrompt", () => {
  it("should include issue title and body", () => {
    const context: IssueContext = {
      title: "Add caching layer",
      body: "We need Redis caching for the API",
      author: "alice",
      comments: [
        { author: "bob", body: "Agreed", createdAt: "2024-01-01T00:00:00Z" },
      ],
    };

    const prompt = buildBlueprintUserPrompt(context);

    expect(prompt).toContain("## Issue: Add caching layer");
    expect(prompt).toContain("We need Redis caching for the API");
    expect(prompt).toContain("Total comments: 1");
    expect(prompt).toContain("Unique participants: 1");
  });

  it("should show fallback when body is empty", () => {
    const context: IssueContext = {
      title: "Fix bug",
      body: "",
      author: "alice",
      comments: [],
    };

    const prompt = buildBlueprintUserPrompt(context);

    expect(prompt).toContain("(No description provided)");
  });

  it("should show 'No comments yet' when comments array is empty", () => {
    const context: IssueContext = {
      title: "Test",
      body: "Body",
      author: "alice",
      comments: [],
    };

    const prompt = buildBlueprintUserPrompt(context);

    expect(prompt).toContain("(No comments yet)");
    expect(prompt).toContain("Total comments: 0");
  });

  it("should mark the issue author in comments", () => {
    const context: IssueContext = {
      title: "Test",
      body: "Body",
      author: "alice",
      comments: [
        { author: "alice", body: "My follow-up", createdAt: "2024-01-01T00:00:00Z" },
        { author: "bob", body: "My input", createdAt: "2024-01-02T00:00:00Z" },
      ],
    };

    const prompt = buildBlueprintUserPrompt(context);

    expect(prompt).toContain("**@alice (author)**");
    expect(prompt).toContain("**@bob**");
    expect(prompt).not.toContain("@bob (author)");
  });

  it("should include reaction signals when present", () => {
    const context: IssueContext = {
      title: "Test",
      body: "Body",
      author: "alice",
      comments: [
        {
          author: "bob",
          body: "Great idea",
          createdAt: "2024-01-01T00:00:00Z",
          reactions: { thumbsUp: 5, thumbsDown: 0 },
        },
        {
          author: "carol",
          body: "Not sure",
          createdAt: "2024-01-02T00:00:00Z",
          reactions: { thumbsUp: 0, thumbsDown: 2 },
        },
      ],
    };

    const prompt = buildBlueprintUserPrompt(context);

    expect(prompt).toContain("**@bob [👍 5]**");
    // thumbsDown-only shows just 👎 (no zero 👍)
    expect(prompt).not.toContain("[👍 0]");
    expect(prompt).toContain("**@carol [👎 2]**");
  });

  it("should show both thumbsUp and thumbsDown when both are present", () => {
    const context: IssueContext = {
      title: "Test",
      body: "Body",
      author: "alice",
      comments: [
        {
          author: "bob",
          body: "Controversial take",
          createdAt: "2024-01-01T00:00:00Z",
          reactions: { thumbsUp: 4, thumbsDown: 2 },
        },
      ],
    };

    const prompt = buildBlueprintUserPrompt(context);

    expect(prompt).toContain("**@bob [👍 4] [👎 2]**");
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// truncateDiscussion
// ───────────────────────────────────────────────────────────────────────────────

describe("truncateDiscussion", () => {
  const comments = [
    { author: "alice", body: "First comment", createdAt: "2024-01-01T00:00:00Z" },
    { author: "bob", body: "Second comment", createdAt: "2024-01-02T00:00:00Z" },
    { author: "carol", body: "Third comment", createdAt: "2024-01-03T00:00:00Z" },
  ];

  it("should include all comments when space permits", () => {
    const result = truncateDiscussion("Test", "Body", "alice", comments, 10_000);

    expect(result).toContain("## Issue: Test");
    expect(result).toContain("First comment");
    expect(result).toContain("Second comment");
    expect(result).toContain("Third comment");
    expect(result).not.toContain("truncated");
  });

  it("should prioritize recent comments when truncating", () => {
    // Use a small maxChars that fits the header + ~1 comment
    const result = truncateDiscussion("Test", "Body", "alice", comments, 500);

    // Should always include the most recent comment
    expect(result).toContain("Third comment");
    // May skip older comments
    if (!result.includes("First comment")) {
      expect(result).toContain("older comments truncated for length");
    }
  });

  it("should show skipped count when comments are truncated", () => {
    // Force truncation by using very small maxChars
    const result = truncateDiscussion("Test", "Body", "alice", comments, 350);

    expect(result).toContain("older comments truncated for length");
  });

  it("should show full truncation message when no space for comments", () => {
    // Header alone exceeds maxChars
    const result = truncateDiscussion("Test", "Body", "alice", comments, 10);

    expect(result).toContain("(Truncated - too many comments to include)");
    expect(result).not.toContain("First comment");
  });

  it("should mark the issue author in truncated output", () => {
    const result = truncateDiscussion("Test", "Body", "alice", comments, 10_000);

    expect(result).toContain("**@alice (author)**");
    expect(result).toContain("**@bob**");
  });

  it("should include reaction signals in truncated output", () => {
    const commentsWithReactions = [
      {
        author: "alice",
        body: "My idea",
        createdAt: "2024-01-01T00:00:00Z",
        reactions: { thumbsUp: 7, thumbsDown: 2 },
      },
      { author: "bob", body: "Comment", createdAt: "2024-01-02T00:00:00Z" },
    ];

    const result = truncateDiscussion("Test", "Body", "alice", commentsWithReactions, 10_000);

    expect(result).toContain("[👍 7]");
    expect(result).toContain("[👎 2]");
  });

  it("should show fallback when body is empty", () => {
    const result = truncateDiscussion("Test", "", "alice", comments, 10_000);

    expect(result).toContain("(No description provided)");
  });
});
