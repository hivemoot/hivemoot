/**
 * Tests for `AiSdkSynthesizer` (G'.3). Mocks the AI SDK's
 * `generateText` so the tests don't make network calls or depend
 * on provider credentials.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted, so any references inside its factory must be
// declared via vi.hoisted() to avoid temporal-dead-zone errors.
const { generateTextMock, createModelFromEnvMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  createModelFromEnvMock: vi.fn(),
}));

vi.mock("ai", async () => ({
  ...(await vi.importActual<typeof import("ai")>("ai")),
  generateText: generateTextMock,
}));

vi.mock("../llm/provider.js", () => ({
  createModelFromEnv: createModelFromEnvMock,
}));

import {
  AiSdkSynthesizer,
  QUEEN_SYNTHESIS_TARGET_BYTES,
  createSynthesizer,
} from "./ai-sdk-synthesizer.js";
import { StubSynthesizer } from "./synthesizer.js";
import type { SynthesisInput } from "./synthesizer.js";
import type {
  RoomCoreResponse,
  RoomParticipant,
} from "../war-room-client.js";
import type { LanguageModel } from "ai";

const ROOM: RoomCoreResponse = {
  manager: "bot-queen",
  subject_type: "pr_review",
  subject_ref: "owner/repo#42",
  status: "deciding",
  opened_at: "2026-04-28T20:00:00Z",
};

const RESOLVED: RoomParticipant = {
  agent_id: "guard-runner",
  role: "guard",
  status: "resolved",
  rsvp_at: "2026-04-28T20:01:00Z",
  resolved_at: "2026-04-28T20:05:00Z",
};

const FAKE_MODEL = { provider: "fake" } as unknown as LanguageModel;

const SAMPLE_INPUT: SynthesisInput = {
  roomId: "01234567-89ab-4cde-9012-3456789abcde",
  room: ROOM,
  participants: { guard: RESOLVED },
  contributions: { guard: { raw_md: "LGTM" } },
  throughSequence: 7,
};

beforeEach(() => {
  generateTextMock.mockReset();
  createModelFromEnvMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("AiSdkSynthesizer.synthesize", () => {
  it("calls generateText with the system + user prompts", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "## Synthesis\n\nLGTM." });
    const synth = new AiSdkSynthesizer({ model: FAKE_MODEL });
    const out = await synth.synthesize(SAMPLE_INPUT);
    expect(out.content).toBe("## Synthesis\n\nLGTM.");
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0][0];
    expect(call.system).toContain("Hivemoot queen");
    expect(call.prompt).toContain("01234567-89ab-4cde-9012-3456789abcde");
    expect(call.prompt).toContain("LGTM");
  });

  it("forwards maxOutputTokens + temperature + abortSignal", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "## ok" });
    const synth = new AiSdkSynthesizer({
      model: FAKE_MODEL,
      maxOutputTokens: 1234,
    });
    await synth.synthesize(SAMPLE_INPUT);
    const call = generateTextMock.mock.calls[0][0];
    expect(call.maxOutputTokens).toBe(1234);
    expect(call.temperature).toBeDefined();
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
    expect(call.maxRetries).toBe(0);
  });

  it("propagates LLM errors (caller's manager loop maps to errors++)", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("upstream timeout"));
    const synth = new AiSdkSynthesizer({ model: FAKE_MODEL });
    await expect(synth.synthesize(SAMPLE_INPUT)).rejects.toThrow(
      /upstream timeout/,
    );
  });

  it("truncates output that exceeds QUEEN_SYNTHESIS_TARGET_BYTES", async () => {
    // Generate a body well above the cap. enforceByteCap should
    // trim and append the truncation marker so the storage layer's
    // 64 KiB cap (which the target sits below) is never exceeded.
    const oversized = "A".repeat(QUEEN_SYNTHESIS_TARGET_BYTES + 5_000) + "\nend";
    generateTextMock.mockResolvedValueOnce({ text: oversized });
    const synth = new AiSdkSynthesizer({ model: FAKE_MODEL });
    const out = await synth.synthesize(SAMPLE_INPUT);
    const bytes = new TextEncoder().encode(out.content).length;
    expect(bytes).toBeLessThanOrEqual(QUEEN_SYNTHESIS_TARGET_BYTES);
    expect(out.content).toContain("[truncated to fit storage cap]");
  });

  it("does NOT truncate output below the cap", async () => {
    const small = "## Synthesis\n\nShort body.";
    generateTextMock.mockResolvedValueOnce({ text: small });
    const synth = new AiSdkSynthesizer({ model: FAKE_MODEL });
    const out = await synth.synthesize(SAMPLE_INPUT);
    expect(out.content).toBe(small);
    expect(out.content).not.toContain("[truncated");
  });

  it("truncates on a newline boundary so fenced code blocks don't split mid-line", async () => {
    // Build a body where the cap falls inside a long line, so
    // enforceByteCap's last-newline trim is exercised.
    const head = "A".repeat(QUEEN_SYNTHESIS_TARGET_BYTES - 200);
    const body = head + "\n" + "B".repeat(500);
    generateTextMock.mockResolvedValueOnce({ text: body });
    const synth = new AiSdkSynthesizer({ model: FAKE_MODEL });
    const out = await synth.synthesize(SAMPLE_INPUT);
    // Should have cut at the newline boundary, not mid-line.
    expect(out.content.split("\n").pop()?.startsWith("_[truncated")).toBe(true);
  });
});

describe("createSynthesizer factory", () => {
  it("returns a StubSynthesizer when no LLM is configured", async () => {
    createModelFromEnvMock.mockResolvedValueOnce(null);
    const synth = await createSynthesizer();
    expect(synth).toBeInstanceOf(StubSynthesizer);
  });

  it("returns an AiSdkSynthesizer when LLM is configured", async () => {
    createModelFromEnvMock.mockResolvedValueOnce({
      model: FAKE_MODEL,
      config: { provider: "anthropic", model: "claude-x", maxTokens: 4096 },
    });
    const synth = await createSynthesizer();
    expect(synth).toBeInstanceOf(AiSdkSynthesizer);
  });

  it("forwards installationId to createModelFromEnv (BYOK lookup)", async () => {
    createModelFromEnvMock.mockResolvedValueOnce(null);
    await createSynthesizer({ installationId: 12345 });
    expect(createModelFromEnvMock).toHaveBeenCalledWith({
      installationId: 12345,
    });
  });

  it("forwards model.config.maxTokens to AiSdkSynthesizer construction", async () => {
    createModelFromEnvMock.mockResolvedValueOnce({
      model: FAKE_MODEL,
      config: { provider: "openai", model: "gpt-x", maxTokens: 2048 },
    });
    generateTextMock.mockResolvedValueOnce({ text: "## ok" });
    const synth = await createSynthesizer();
    await synth.synthesize(SAMPLE_INPUT);
    expect(generateTextMock.mock.calls[0][0].maxOutputTokens).toBe(2048);
  });
});
