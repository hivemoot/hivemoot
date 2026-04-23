import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StandupData } from "./standup.js";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

vi.mock("./llm/provider.js", () => ({
  createModelFromEnv: vi.fn(),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("generateStandupLLMContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes JSON repair hook to generateObject", async () => {
    const { generateObject } = await import("ai");
    const { createModelFromEnv } = await import("./llm/provider.js");
    const { generateStandupLLMContent } = await import("./standup.js");

    vi.mocked(createModelFromEnv).mockResolvedValue({
      model: {} as never,
      config: {
        provider: "google",
        model: "gemini-3-flash-preview",
        maxTokens: 500,
      },
    });
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        narrative: "Colony progressed with one implementation and no blockers.",
        keyUpdates: ["Implementation PR #10 advanced through review."],
        queensTake: {
          wentWell: "Review turnaround was quick.",
          focusAreas: "Move one proposal from voting to implementation.",
          needsAttention: "No urgent risks detected.",
        },
      },
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 50 },
      rawResponse: undefined,
      response: undefined,
      warnings: undefined,
      experimental_providerMetadata: undefined,
      toJsonResponse: () => new Response(),
    } as never);

    const data: StandupData = {
      discussionPhase: [],
      votingPhase: [],
      extendedVoting: [],
      readyToImplement: [{ number: 1, title: "Feature A" }],
      implementationPRs: [{ number: 10, title: "PR #10", author: "agent" }],
      repoFullName: "hivemoot/colony",
      reportDate: "2026-02-06",
      dayNumber: 42,
    };

    const result = await generateStandupLLMContent(data);

    expect(result).not.toBeNull();
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        experimental_repairText: expect.any(Function),
      })
    );
  });

  it("logs when repair hook successfully repairs malformed JSON", async () => {
    const { generateObject } = await import("ai");
    const { createModelFromEnv } = await import("./llm/provider.js");
    const { generateStandupLLMContent } = await import("./standup.js");

    vi.mocked(createModelFromEnv).mockResolvedValue({
      model: {} as never,
      config: {
        provider: "google",
        model: "gemini-3-flash-preview",
        maxTokens: 500,
      },
    });
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        narrative: "Colony progressed.",
        keyUpdates: ["PR #10 advanced."],
        queensTake: {
          wentWell: "Quick turnaround.",
          focusAreas: "Move proposal forward.",
          needsAttention: "No risks.",
        },
      },
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 50 },
      rawResponse: undefined,
      response: undefined,
      warnings: undefined,
      experimental_providerMetadata: undefined,
      toJsonResponse: () => new Response(),
    } as never);

    const data: StandupData = {
      discussionPhase: [],
      votingPhase: [],
      extendedVoting: [],
      readyToImplement: [{ number: 1, title: "Feature A" }],
      implementationPRs: [{ number: 10, title: "PR #10", author: "agent" }],
      repoFullName: "hivemoot/colony",
      reportDate: "2026-02-06",
      dayNumber: 42,
    };

    await generateStandupLLMContent(data);

    const callArgs = vi.mocked(generateObject).mock.calls[0][0] as Record<string, unknown>;
    const repairFn = callArgs.experimental_repairText as (args: { text: string; error: { message: string } }) => Promise<string | null>;

    const repaired = await repairFn({
      text: "```json\n{\"narrative\":\"Test\"}\n```",
      error: { message: "JSON parsing failed" },
    });
    expect(repaired).toBe("{\"narrative\":\"Test\"}");
  });

  it("forwards installation context to model resolution", async () => {
    const { generateObject } = await import("ai");
    const { createModelFromEnv } = await import("./llm/provider.js");
    const { generateStandupLLMContent } = await import("./standup.js");

    vi.mocked(createModelFromEnv).mockResolvedValue({
      model: {} as never,
      config: {
        provider: "google",
        model: "gemini-3-flash-preview",
        maxTokens: 500,
      },
    });
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        narrative: "Colony progressed with one implementation and no blockers.",
        keyUpdates: ["Implementation PR #10 advanced through review."],
        queensTake: {
          wentWell: "Review turnaround was quick.",
          focusAreas: "Move one proposal from voting to implementation.",
          needsAttention: "No urgent risks detected.",
        },
      },
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 50 },
      rawResponse: undefined,
      response: undefined,
      warnings: undefined,
      experimental_providerMetadata: undefined,
      toJsonResponse: () => new Response(),
    } as never);

    const data: StandupData = {
      discussionPhase: [],
      votingPhase: [],
      extendedVoting: [],
      readyToImplement: [{ number: 1, title: "Feature A" }],
      implementationPRs: [{ number: 10, title: "PR #10", author: "agent" }],
      repoFullName: "hivemoot/colony",
      reportDate: "2026-02-06",
      dayNumber: 42,
    };

    await generateStandupLLMContent(data, { installationId: 77 });

    expect(createModelFromEnv).toHaveBeenCalledWith({ installationId: 77 });
  });

  it("returns null and logs a warning when LLM generation throws", async () => {
    const { createModelFromEnv } = await import("./llm/provider.js");
    const { logger } = await import("./logger.js");
    const { generateStandupLLMContent } = await import("./standup.js");

    vi.mocked(createModelFromEnv).mockRejectedValue(new Error("missing API key"));

    const data: StandupData = {
      discussionPhase: [],
      votingPhase: [],
      extendedVoting: [],
      readyToImplement: [],
      implementationPRs: [],
      repoFullName: "hivemoot/colony",
      reportDate: "2026-02-06",
      dayNumber: 1,
    };

    const result = await generateStandupLLMContent(data);

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "LLM standup generation failed: missing API key"
    );
  });

  it("logs BYOK runtime errors at error level and degrades gracefully", async () => {
    const { createModelFromEnv } = await import("./llm/provider.js");
    const { logger } = await import("./logger.js");
    const { generateStandupLLMContent } = await import("./standup.js");

    vi.mocked(createModelFromEnv).mockRejectedValue(
      new Error("BYOK Redis lookup failed with HTTP 503"),
    );

    const data: StandupData = {
      discussionPhase: [],
      votingPhase: [],
      extendedVoting: [],
      readyToImplement: [],
      implementationPRs: [],
      repoFullName: "hivemoot/colony",
      reportDate: "2026-02-06",
      dayNumber: 42,
    };

    const result = await generateStandupLLMContent(data, { installationId: 42 });

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      "LLM standup generation failed: BYOK Redis lookup failed with HTTP 503"
    );
  });
});
