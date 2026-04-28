/**
 * AiSdkSynthesizer — production synthesizer that calls a real LLM
 * via the existing Vercel AI SDK plumbing in `bot/api/lib/llm/`.
 *
 * Same `Synthesizer` interface as `StubSynthesizer`, so the manager
 * loop (G'.2) doesn't change. The factory below decides which to
 * instantiate based on whether LLM credentials are configured —
 * deployments without an LLM key fall back to stub mode cleanly.
 *
 * Defensive truncation: the storage layer caps decision payload at
 * 64 KiB (`RoomDecisionTooLargeError` at the close path). We target
 * ≤ 16 KiB to leave room for envelope metadata and to avoid
 * borderline failures that the manager loop would surface as
 * `decision_too_large` 400s. If the LLM produces more, we trim with
 * a clear "[truncated]" marker rather than re-prompting (re-prompting
 * doubles cost on a path already failing once).
 */

import { generateText } from "ai";
import type { LanguageModel } from "ai";

import type { Logger } from "../logger.js";
import { logger as defaultLogger } from "../logger.js";
import { withLLMRetry } from "../llm/retry.js";
import { LLM_DEFAULTS } from "../llm/types.js";
import { createModelFromEnv, type ModelResolutionOptions } from "../llm/provider.js";

import {
  QUEEN_SYNTHESIS_SYSTEM_PROMPT,
  buildSynthesisPrompt,
} from "./prompts.js";
import { StubSynthesizer } from "./synthesizer.js";
import type { SynthesisInput, SynthesisOutput, Synthesizer } from "./synthesizer.js";

/** Target byte cap; well below storage's 64 KiB to leave envelope headroom. */
export const QUEEN_SYNTHESIS_TARGET_BYTES = 16 * 1024;

/** Truncation marker when the LLM exceeds the target. */
const TRUNCATION_MARKER = "\n\n_[truncated to fit storage cap]_";

export interface AiSdkSynthesizerConfig {
  model: LanguageModel;
  /** Model's max output tokens (passed straight to AI SDK). Defaults
   * to LLM_DEFAULTS.maxTokens (4096) — enough for a typical
   * synthesis, well below the storage cap. */
  maxOutputTokens?: number;
  /** Logger; falls back to module default. */
  logger?: Logger;
  /** Per-call deadline (ms). Defaults to LLM_DEFAULTS.perCallTimeoutMs. */
  perCallTimeoutMs?: number;
}

export class AiSdkSynthesizer implements Synthesizer {
  private model: LanguageModel;
  private maxOutputTokens: number;
  private logger: Logger;
  private perCallTimeoutMs: number;

  constructor(config: AiSdkSynthesizerConfig) {
    this.model = config.model;
    this.maxOutputTokens = config.maxOutputTokens ?? LLM_DEFAULTS.maxTokens;
    this.logger = config.logger ?? defaultLogger;
    this.perCallTimeoutMs = config.perCallTimeoutMs ?? LLM_DEFAULTS.perCallTimeoutMs;
  }

  async synthesize(input: SynthesisInput): Promise<SynthesisOutput> {
    const userPrompt = buildSynthesisPrompt(input);

    this.logger.info(
      `[queen.synth] start roomId=${input.roomId} throughSequence=${input.throughSequence} participants=${Object.keys(input.participants).length} contributions=${Object.keys(input.contributions).length}`,
    );

    const result = await withLLMRetry(
      () =>
        generateText({
          model: this.model,
          system: QUEEN_SYNTHESIS_SYSTEM_PROMPT,
          prompt: userPrompt,
          maxOutputTokens: this.maxOutputTokens,
          temperature: LLM_DEFAULTS.temperature,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(this.perCallTimeoutMs),
        }),
      undefined,
      this.logger,
    );

    const trimmed = enforceByteCap(result.text);
    const truncated = trimmed.length < result.text.length;
    this.logger.info(
      `[queen.synth] done roomId=${input.roomId} bytesProduced=${byteLength(result.text)} bytesEmitted=${byteLength(trimmed)} truncated=${truncated}`,
    );

    return { content: trimmed };
  }
}

/**
 * Factory: returns the configured synthesizer for the queen runtime.
 * Encapsulates the "real LLM if configured, stub otherwise" choice
 * so the manager-loop wiring at G'.5 stays a one-liner.
 *
 * Returns the stub when:
 *   - No `LLM_PROVIDER` / `LLM_MODEL` configured (dev / pre-G'.5 staging)
 *   - Configured but no API key (graceful degradation; surfaced via
 *     log line — closed-room decisions in stub mode are visibly stub)
 *   - Per-installation BYOK lookup returns null (no per-installation key)
 *
 * Throws on unexpected provider errors during model creation — the
 * caller (G'.5) decides whether to fail-the-tick or fall back.
 */
export async function createSynthesizer(
  options: { installationId?: number; logger?: Logger } = {},
): Promise<Synthesizer> {
  const log = options.logger ?? defaultLogger;
  const modelResult = await createModelFromEnv({
    installationId: options.installationId,
  } as ModelResolutionOptions);

  if (!modelResult) {
    log.info(
      `[queen.synth] factory fallback_to_stub reason=llm_not_configured installationId=${options.installationId ?? "n/a"}`,
    );
    return new StubSynthesizer();
  }

  log.info(
    `[queen.synth] factory using_llm provider=${modelResult.config.provider} model=${modelResult.config.model} installationId=${options.installationId ?? "n/a"}`,
  );
  return new AiSdkSynthesizer({
    model: modelResult.model,
    maxOutputTokens: modelResult.config.maxTokens,
    logger: log,
  });
}

/** Trim text to QUEEN_SYNTHESIS_TARGET_BYTES UTF-8 bytes. Markdown-
 * safe truncation cuts at the last newline before the cap so we
 * don't split a fenced code block in half. Appends the truncation
 * marker. */
function enforceByteCap(text: string): string {
  const cap = QUEEN_SYNTHESIS_TARGET_BYTES - byteLength(TRUNCATION_MARKER);
  if (byteLength(text) <= QUEEN_SYNTHESIS_TARGET_BYTES) {
    return text;
  }
  // Encode and trim by bytes. Find last newline in the trimmed slice
  // (UTF-8 boundary safe — newline is single-byte).
  const encoded = new TextEncoder().encode(text);
  const sliced = encoded.slice(0, cap);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
  // Trim back to last newline so we don't split mid-code-fence.
  const lastNewline = decoded.lastIndexOf("\n");
  const cleanCut = lastNewline > 0 ? decoded.slice(0, lastNewline) : decoded;
  return cleanCut + TRUNCATION_MARKER;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
