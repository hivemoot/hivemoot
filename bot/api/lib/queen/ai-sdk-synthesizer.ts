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
  aggregateWorkerVerdicts,
  buildSynthesisPrompt,
  type WorkerVerdict,
} from "./prompts.js";
import { StubSynthesizer } from "./synthesizer.js";
import type { SynthesisInput, SynthesisOutput, Synthesizer } from "./synthesizer.js";

/** Target byte cap for the FULL assembled output (header + verdict +
 * LLM prose + footer). The LLM prose budget is the cap minus the
 * fixed bot-controlled sections — see assembleOutput. Storage caps
 * decision payload at 64 KiB; we stay well under to leave envelope
 * headroom. */
export const QUEEN_SYNTHESIS_TARGET_BYTES = 16 * 1024;

/** Truncation marker when the LLM exceeds its prose budget. */
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
    // Compute the structural verdict floor BEFORE the LLM call —
    // closes #538 builder R1 (synthesis safety model). The LLM is
    // told the verdict is fixed; the final output is assembled
    // deterministically with the verdict in a bot-controlled header.
    const structuralVerdict = aggregateWorkerVerdicts(input.contributions);
    const userPrompt = buildSynthesisPrompt(input);

    this.logger.info(
      `[queen.synth] start roomId=${input.roomId} throughSequence=${input.throughSequence} participants=${Object.keys(input.participants).length} contributions=${Object.keys(input.contributions).length} verdict=${structuralVerdict}`,
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

    const assembled = assembleOutput({
      subjectRef: input.room.subject_ref,
      structuralVerdict,
      llmProse: result.text,
      contributionCount: countNonWithdrawn(input.contributions),
      withdrewCount: countWithdrawn(input.contributions),
    });
    const truncated = byteLength(assembled) < byteLength(buildOutputForLogging(result.text, structuralVerdict, input.room.subject_ref));

    this.logger.info(
      `[queen.synth] done roomId=${input.roomId} bytesProduced=${byteLength(result.text)} bytesEmitted=${byteLength(assembled)} truncated=${truncated} verdict=${structuralVerdict}`,
    );

    return { content: assembled };
  }
}

/**
 * Assemble the final synthesis output. Bot-controlled header (with
 * verdict from code, never the LLM) + LLM prose + bot-controlled
 * footer attribution. Truncates the LLM prose section to fit within
 * `QUEEN_SYNTHESIS_TARGET_BYTES` after accounting for the fixed
 * sections.
 *
 * The structural verdict is part of the deterministic header — it
 * survives any prompt-injection in the LLM prose because the LLM
 * never gets a chance to write it.
 */
function assembleOutput(args: {
  subjectRef: string;
  structuralVerdict: WorkerVerdict;
  llmProse: string;
  contributionCount: number;
  withdrewCount: number;
}): string {
  const header =
    `## Synthesis — ${args.subjectRef}\n\n` +
    `**Verdict:** \`${args.structuralVerdict}\` ` +
    `_(aggregated from ${args.contributionCount} contribution${args.contributionCount === 1 ? "" : "s"}` +
    (args.withdrewCount > 0 ? `, ${args.withdrewCount} withdrawn` : "") +
    `, downgrade-only floor per WAR_ROOM_DESIGN.md §S2)_\n\n` +
    `---\n\n`;
  const footer =
    `\n\n---\n\n` +
    `_Synthesized by the Hivemoot queen. Verdict computed structurally from validated worker `+
    `\`body.verdict\` fields; LLM prose summarizes contributions but does not determine the verdict._`;

  // Budget LLM prose to fit within the byte cap after fixed sections.
  const fixedBytes = byteLength(header) + byteLength(footer);
  const proseCap = QUEEN_SYNTHESIS_TARGET_BYTES - fixedBytes - byteLength(TRUNCATION_MARKER);
  const trimmedProse = trimToBytes(args.llmProse, proseCap);
  const truncated = trimmedProse.length < args.llmProse.length;
  const proseBlock = trimmedProse + (truncated ? TRUNCATION_MARKER : "");

  return header + proseBlock + footer;
}

/** Trim a string to at most `maxBytes` UTF-8 bytes, ending on a
 * newline boundary so fenced code blocks don't split mid-line. */
function trimToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const encoded = new TextEncoder().encode(text);
  const sliced = encoded.slice(0, maxBytes);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
  const lastNewline = decoded.lastIndexOf("\n");
  return lastNewline > 0 ? decoded.slice(0, lastNewline) : decoded;
}

function countNonWithdrawn(
  contributions: Record<string, { withdrawn?: boolean }>,
): number {
  return Object.values(contributions).filter((c) => !c.withdrawn).length;
}

function countWithdrawn(
  contributions: Record<string, { withdrawn?: boolean }>,
): number {
  return Object.values(contributions).filter((c) => c.withdrawn).length;
}

/** Just for logging: predict what assembleOutput would have emitted
 * if no truncation occurred. Used to compute the `truncated` flag
 * for log lines. */
function buildOutputForLogging(
  llmProse: string,
  verdict: WorkerVerdict,
  subjectRef: string,
): string {
  return `## Synthesis — ${subjectRef}\n\n**Verdict:** \`${verdict}\`\n\n---\n\n${llmProse}\n\n---\n\nfooter`;
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

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
