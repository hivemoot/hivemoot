import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CommitMessageGenerator, formatCommitMessage } from "./commit-message.js";
import type { PRContext } from "./types.js";

/**
 * Tests for the commit message generator.
 *
 * Uses mocked LLM provider — tests the generator logic, prompt building,
 * and subject line enforcement, not the actual LLM API.
 */

// Mock the provider to prevent actual API calls
vi.mock("./provider.js", () => ({
  createModelFromEnv: vi.fn().mockResolvedValue(null),
}));

// Mock the ai package
vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

const sampleContext: PRContext = {
  prNumber: 42,
  title: "Add merge-readiness evaluation for PRs",
  body: "Evaluates whether a PR meets all conditions for merge.",
  diffStat: "5 files changed, 200 insertions(+), 10 deletions(-)",
  commitMessages: ["initial implementation", "add tests", "fix linting"],
};

describe("CommitMessageGenerator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_MODEL;
  });

  it("should return failure when LLM is not configured", async () => {
    const generator = new CommitMessageGenerator({ logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn() } });
    const result = await generator.generate(sampleContext);

    expect(result).toEqual({
      success: false,
      reason: "LLM not configured",
      kind: "not_configured",
    });
  });

  it("should succeed when pre-created model is provided", async () => {
    const { generateObject } = await import("ai");
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: {
        subject: "Add merge-readiness evaluation for PRs",
        body: "Evaluates whether a PR meets all conditions for merge and manages the merge-ready label.",
      },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: "stop",
      warnings: [],
      rawResponse: undefined,
      response: { id: "test", timestamp: new Date(), modelId: "test-model" },
      request: {},
      toJsonResponse: vi.fn(),
      experimental_providerMetadata: {},
      providerMetadata: {},
    } as never);

    const mockModel = {} as never;
    const mockConfig = { provider: "openai" as const, model: "gpt-4o-mini", maxTokens: 1200 };

    const generator = new CommitMessageGenerator({ logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn() } });
    const result = await generator.generate(sampleContext, { model: mockModel, config: mockConfig });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.message.subject).toBe("Add merge-readiness evaluation for PRs");
      expect(result.message.body).toContain("merge-ready label");
    }
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 1200,
        experimental_repairText: expect.any(Function),
      })
    );
  });

  it("should log when repair hook successfully repairs malformed JSON", async () => {
    const { generateObject } = await import("ai");
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: { subject: "Add feature", body: "Implements feature." },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: "stop",
      warnings: [],
      rawResponse: undefined,
      response: { id: "test", timestamp: new Date(), modelId: "test-model" },
      request: {},
      toJsonResponse: vi.fn(),
      experimental_providerMetadata: {},
      providerMetadata: {},
    } as never);

    const mockModel = {} as never;
    const mockConfig = { provider: "openai" as const, model: "gpt-4o-mini", maxTokens: 500 };
    const loggerSpy = { info: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const generator = new CommitMessageGenerator({ logger: loggerSpy });
    await generator.generate(sampleContext, { model: mockModel, config: mockConfig });

    const callArgs = vi.mocked(generateObject).mock.calls[0][0] as Record<string, unknown>;
    const repairFn = callArgs.experimental_repairText as (args: { text: string; error: { message: string } }) => Promise<string | null>;

    const repaired = await repairFn({
      text: "```json\n{\"subject\":\"Fix\",\"body\":\"Why\"}\n```",
      error: { message: "JSON parsing failed" },
    });
    expect(repaired).toBe("{\"subject\":\"Fix\",\"body\":\"Why\"}");
    expect(loggerSpy.info).toHaveBeenCalledWith(
      expect.stringContaining("Repaired malformed LLM JSON output")
    );

    const unchanged = await repairFn({
      text: "{\"subject\":\"Fix\",\"body\":\"Why\"}",
      error: { message: "JSON parsing failed" },
    });
    expect(unchanged).toBeNull();
  });

  it("should truncate subject line to 72 characters", async () => {
    const { generateObject } = await import("ai");
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: {
        subject: "A very long subject line that definitely exceeds the seventy-two character limit for commit messages",
        body: "Short body.",
      },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: "stop",
      warnings: [],
      rawResponse: undefined,
      response: { id: "test", timestamp: new Date(), modelId: "test-model" },
      request: {},
      toJsonResponse: vi.fn(),
      experimental_providerMetadata: {},
      providerMetadata: {},
    } as never);

    const mockModel = {} as never;
    const mockConfig = { provider: "openai" as const, model: "gpt-4o-mini", maxTokens: 500 };

    const generator = new CommitMessageGenerator({ logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn() } });
    const result = await generator.generate(sampleContext, { model: mockModel, config: mockConfig });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.message.subject.length).toBeLessThanOrEqual(72);
      expect(result.message.subject.endsWith("...")).toBe(true);
    }
  });

  it("should return failure on LLM error", async () => {
    const { generateObject } = await import("ai");
    vi.mocked(generateObject).mockRejectedValueOnce(new Error("API rate limited"));

    const mockModel = {} as never;
    const mockConfig = { provider: "openai" as const, model: "gpt-4o-mini", maxTokens: 500 };

    const generator = new CommitMessageGenerator({ logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn() } });
    const result = await generator.generate(sampleContext, { model: mockModel, config: mockConfig });

    expect(result).toEqual({
      success: false,
      reason: "API rate limited",
      kind: "generation_failed",
    });
  });
});

describe("formatCommitMessage", () => {
  it("should format message with subject, body, and PR number", () => {
    const result = formatCommitMessage(
      { subject: "Add feature X", body: "Implements the feature." },
      42
    );

    expect(result).toBe("Add feature X\n\nImplements the feature.\n\nPR: #42");
  });
});
