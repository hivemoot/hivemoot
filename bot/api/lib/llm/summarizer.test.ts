import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiscussionSummarizer, formatVotingMessage } from "./summarizer.js";
import type { DiscussionSummary, IssueContext } from "./types.js";
import type { Logger } from "../logger.js";

/**
 * Tests for DiscussionSummarizer
 *
 * These tests verify:
 * - Graceful handling when LLM is not configured
 * - Minimal summary for issues with no comments
 * - Correct metadata in summaries
 * - Error handling for LLM failures
 */

// Mock the AI SDK
vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

// Mock the provider module
vi.mock("./provider.js", () => ({
  createModelFromEnv: vi.fn(),
}));

describe("DiscussionSummarizer", () => {
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

      const summarizer = new DiscussionSummarizer({ logger: mockLogger });
      const context: IssueContext = {
        title: "Test Issue",
        body: "Test body",
        author: "issueAuthor",
        comments: [
          { author: "user1", body: "Comment 1", createdAt: "2024-01-01T00:00:00Z" },
        ],
      };

      const result = await summarizer.summarize(context);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("LLM not configured");
      }
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "LLM not configured, skipping summarization"
      );
    });
  });

  describe("when there is no meaningful discussion", () => {
    it("should return minimal summary when there are no comments", async () => {
      const { createModelFromEnv } = await import("./provider.js");
      vi.mocked(createModelFromEnv).mockResolvedValue({
        model: {} as never,
        config: { provider: "anthropic", model: "test", maxTokens: 2000 },
      });

      const summarizer = new DiscussionSummarizer({ logger: mockLogger });
      const context: IssueContext = {
        title: "Add dark mode support",
        body: "We should add dark mode to the app",
        author: "alice",
        comments: [],
      };

      const result = await summarizer.summarize(context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.summary.proposal).toBe("Add dark mode support");
        expect(result.summary.alignedOn).toEqual([]);
        expect(result.summary.openForPR).toEqual([]);
        expect(result.summary.notIncluded).toEqual([]);
        expect(result.summary.metadata.commentCount).toBe(0);
        expect(result.summary.metadata.participantCount).toBe(0);
      }
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "No discussion from others, using minimal summary"
      );
    });

    it("should return minimal summary when all comments are from issue author", async () => {
      const { createModelFromEnv } = await import("./provider.js");
      vi.mocked(createModelFromEnv).mockResolvedValue({
        model: {} as never,
        config: { provider: "anthropic", model: "test", maxTokens: 2000 },
      });

      const summarizer = new DiscussionSummarizer({ logger: mockLogger });
      const context: IssueContext = {
        title: "Add dark mode support",
        body: "We should add dark mode to the app",
        author: "alice",
        comments: [
          { author: "alice", body: "Here's more context", createdAt: "2024-01-01T00:00:00Z" },
          { author: "alice", body: "And another update", createdAt: "2024-01-02T00:00:00Z" },
        ],
      };

      const result = await summarizer.summarize(context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.summary.proposal).toBe("Add dark mode support");
        expect(result.summary.metadata.commentCount).toBe(0);
        expect(result.summary.metadata.participantCount).toBe(0);
      }
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "No discussion from others, using minimal summary"
      );
    });
  });

  describe("when LLM generates a summary", () => {
    it("should return the LLM-generated summary", async () => {
      const mockSummary: DiscussionSummary = {
        proposal: "Implement user authentication with OAuth",
        alignedOn: ["Use OAuth 2.0", "Support GitHub and Google providers"],
        openForPR: ["Exact UI placement TBD"],
        notIncluded: ["Password-based auth (rejected for security)"],
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
        object: mockSummary,
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 200 },
        rawResponse: undefined,
        response: undefined,
        warnings: undefined,
        experimental_providerMetadata: undefined,
        toJsonResponse: () => new Response(),
      } as never);

      const summarizer = new DiscussionSummarizer({ logger: mockLogger });
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

      const result = await summarizer.summarize(context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.summary.proposal).toBe("Implement user authentication with OAuth");
        expect(result.summary.alignedOn).toContain("Use OAuth 2.0");
        expect(result.summary.metadata.commentCount).toBe(5);
        expect(result.summary.metadata.participantCount).toBe(3);
      }
      expect(generateObject).toHaveBeenCalledWith(
        expect.objectContaining({
          experimental_repairText: expect.any(Function),
        })
      );
    });

    it("should log when repair hook successfully repairs malformed JSON", async () => {
      const mockSummary: DiscussionSummary = {
        proposal: "Test proposal",
        alignedOn: [],
        openForPR: [],
        notIncluded: [],
        metadata: { commentCount: 1, participantCount: 1 },
      };

      const { createModelFromEnv } = await import("./provider.js");
      const { generateObject } = await import("ai");

      vi.mocked(createModelFromEnv).mockResolvedValue({
        model: {} as never,
        config: { provider: "anthropic", model: "test", maxTokens: 2000 },
      });
      vi.mocked(generateObject).mockResolvedValue({
        object: mockSummary,
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 200 },
        rawResponse: undefined,
        response: undefined,
        warnings: undefined,
        experimental_providerMetadata: undefined,
        toJsonResponse: () => new Response(),
      } as never);

      const summarizer = new DiscussionSummarizer({ logger: mockLogger });
      const context: IssueContext = {
        title: "Test",
        body: "Body",
        author: "issueAuthor",
        comments: [
          { author: "user1", body: "Comment", createdAt: "2024-01-01T00:00:00Z" },
        ],
      };

      await summarizer.summarize(context);

      const callArgs = vi.mocked(generateObject).mock.calls[0][0] as Record<string, unknown>;
      const repairFn = callArgs.experimental_repairText as (args: { text: string; error: { message: string } }) => Promise<string | null>;

      const repaired = await repairFn({
        text: "```json\n{\"proposal\":\"Test\"}\n```",
        error: { message: "JSON parsing failed" },
      });
      expect(repaired).toBe("{\"proposal\":\"Test\"}");
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Repaired malformed LLM JSON output")
      );
    });

    it("should fail closed when LLM returns incorrect metadata (possible hallucination)", async () => {
      const mockSummary: DiscussionSummary = {
        proposal: "Test proposal",
        alignedOn: [],
        openForPR: [],
        notIncluded: [],
        metadata: {
          commentCount: 999, // Wrong!
          participantCount: 999, // Wrong!
        },
      };

      const { createModelFromEnv } = await import("./provider.js");
      const { generateObject } = await import("ai");

      vi.mocked(createModelFromEnv).mockResolvedValue({
        model: {} as never,
        config: { provider: "openai", model: "test", maxTokens: 2000 },
      });
      vi.mocked(generateObject).mockResolvedValue({
        object: mockSummary,
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 200 },
        rawResponse: undefined,
        response: undefined,
        warnings: undefined,
        experimental_providerMetadata: undefined,
        toJsonResponse: () => new Response(),
      } as never);

      const summarizer = new DiscussionSummarizer({ logger: mockLogger });
      const context: IssueContext = {
        title: "Test Issue",
        body: "Test body",
        author: "issueAuthor",
        comments: [
          { author: "user1", body: "Comment 1", createdAt: "2024-01-01T00:00:00Z" },
          { author: "user2", body: "Comment 2", createdAt: "2024-01-02T00:00:00Z" },
        ],
      };

      const result = await summarizer.summarize(context);

      // FAIL CLOSED: Metadata mismatch indicates possible hallucination
      // Now returns failure instead of silently correcting
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toContain("LLM metadata mismatch");
        expect(result.reason).toContain("possible hallucination");
      }

      // Should log an error about incorrect metadata (not just a warning)
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

      const summarizer = new DiscussionSummarizer({ logger: mockLogger });
      const context: IssueContext = {
        title: "Test Issue",
        body: "Test body",
        author: "issueAuthor",
        comments: [
          { author: "user1", body: "Comment", createdAt: "2024-01-01T00:00:00Z" },
        ],
      };

      const result = await summarizer.summarize(context);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("API rate limit exceeded");
      }
      expect(mockLogger.error).toHaveBeenCalledWith(
        "LLM summarization failed: API rate limit exceeded"
      );
    });
  });
});

describe("formatVotingMessage", () => {
  const signature = "\n\n---\n*— Queen 👑*";
  const votingSignature = "React to THIS comment to vote";

  it("should format a complete summary with all sections", () => {
    const summary: DiscussionSummary = {
      proposal: "Add dark mode with system preference detection",
      alignedOn: ["Use CSS variables for theming", "Respect OS preference by default"],
      openForPR: ["Toggle button placement TBD"],
      notIncluded: ["Custom color themes (future work)"],
      metadata: { commentCount: 8, participantCount: 4 },
    };

    const message = formatVotingMessage(summary, "Dark Mode Feature", signature, votingSignature);

    expect(message).toContain("🐝 **Voting Phase**");
    expect(message).toContain("# Dark Mode Feature");
    expect(message).toContain("> Add dark mode with system preference detection");
    expect(message).toContain("### ✅ Aligned On");
    expect(message).toContain("- Use CSS variables for theming");
    expect(message).toContain("### 🔶 Open for PR");
    expect(message).toContain("- Toggle button placement TBD");
    expect(message).toContain("### ❌ Not Included");
    expect(message).toContain("- Custom color themes (future work)");
    expect(message).toContain("👍 **Ready** — Approve for implementation");
    expect(message).toContain("8 comments");
    expect(message).toContain("4 participants");
    expect(message).toContain(signature);
  });

  it("should omit empty sections", () => {
    const summary: DiscussionSummary = {
      proposal: "Simple fix for button alignment",
      alignedOn: ["Use flexbox"],
      openForPR: [],
      notIncluded: [],
      metadata: { commentCount: 2, participantCount: 2 },
    };

    const message = formatVotingMessage(summary, "Fix Button", signature, votingSignature);

    expect(message).toContain("### ✅ Aligned On");
    expect(message).not.toContain("### 🔶 Open for PR");
    expect(message).not.toContain("### ❌ Not Included");
  });

  it("should handle minimal summary (no comments)", () => {
    const summary: DiscussionSummary = {
      proposal: "Add logging",
      alignedOn: [],
      openForPR: [],
      notIncluded: [],
      metadata: { commentCount: 0, participantCount: 0 },
    };

    const message = formatVotingMessage(summary, "Add Logging", signature, votingSignature);

    expect(message).toContain("🐝 **Voting Phase**");
    expect(message).toContain("# Add Logging");
    expect(message).toContain("> Add logging");
    expect(message).toContain("0 comments");
    expect(message).not.toContain("0 participants"); // Should be omitted when 0
    expect(message).toContain(votingSignature);
  });
});
