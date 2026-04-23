/**
 * Discussion Summarizer Service
 *
 * Uses LLM to generate structured summaries of issue discussions
 * for the voting phase. Handles edge cases gracefully.
 */

import { generateObject } from "ai";

import type { LanguageModel } from "ai";

import type { Logger } from "../logger.js";
import { logger as defaultLogger } from "../logger.js";
import { repairMalformedJsonText } from "./json-repair.js";
import {
  SUMMARIZATION_SYSTEM_PROMPT,
  buildUserPrompt,
} from "./prompts.js";
import { createModelFromEnv, type ModelResolutionOptions } from "./provider.js";
import { withLLMRetry } from "./retry.js";
import type { DiscussionSummary, IssueContext, LLMConfig } from "./types.js";
import { DiscussionSummarySchema, LLM_DEFAULTS, countUniqueParticipants } from "./types.js";

// ───────────────────────────────────────────────────────────────────────────────
// Summarizer Service
// ───────────────────────────────────────────────────────────────────────────────

export interface SummarizerConfig {
  logger?: Logger;
}

/**
 * Result of summarization attempt.
 * Either a summary or null (with reason logged).
 */
export type SummarizationResult =
  | { success: true; summary: DiscussionSummary }
  | { success: false; reason: string };

/**
 * Discussion summarizer using LLM.
 */
export class DiscussionSummarizer {
  private logger: Logger;

  constructor(config?: SummarizerConfig) {
    this.logger = config?.logger ?? defaultLogger;
  }

  /**
   * Summarize an issue discussion.
   *
   * @param context - Issue context with title, body, author, and comments
   * @param preCreatedModel - Optional pre-validated model to avoid redundant creation
   *
   * Returns null if:
   * - LLM is not configured (and no preCreatedModel provided)
   * - Discussion is too minimal (no comments from others)
   * - LLM API fails
   * - Summary validation fails
   */
  async summarize(
    context: IssueContext,
    preCreatedModel?: { model: LanguageModel; config: LLMConfig },
    modelOptions?: ModelResolutionOptions
  ): Promise<SummarizationResult> {
    // Handle minimal discussions (no LLM needed)
    // Check for meaningful discussion: at least one comment from someone other than author
    const hasDiscussion = context.comments.some((c) => c.author !== context.author);
    if (!hasDiscussion) {
      this.logger.debug("No discussion from others, using minimal summary");
      return {
        success: true,
        summary: this.createMinimalSummary(context),
      };
    }

    try {
      // Use pre-created model if provided, otherwise create from env
      const modelResult = preCreatedModel ?? await createModelFromEnv(modelOptions);
      if (!modelResult) {
        this.logger.debug("LLM not configured, skipping summarization");
        return { success: false, reason: "LLM not configured" };
      }

      const { model, config } = modelResult;
      this.logger.info(
        `Generating voting summary with ${config.provider}/${config.model} for ${context.comments.length} comments`
      );

      const result = await withLLMRetry(
        () =>
          generateObject({
            model,
            schema: DiscussionSummarySchema,
            system: SUMMARIZATION_SYSTEM_PROMPT,
            prompt: buildUserPrompt(context),
            experimental_repairText: async (args) => {
              const repaired = await repairMalformedJsonText(args);
              if (repaired !== null) {
                this.logger.info(`Repaired malformed LLM JSON output (error: ${args.error.message})`);
              }
              return repaired;
            },
            maxOutputTokens: config.maxTokens,
            temperature: LLM_DEFAULTS.temperature,
            maxRetries: 0, // Disable SDK retry; our wrapper handles rate-limits
            abortSignal: AbortSignal.timeout(LLM_DEFAULTS.perCallTimeoutMs),
          }),
        undefined,
        this.logger
      );

      const summary = result.object;

      // Sanity check: metadata counts MUST match actual data
      // Mismatch indicates the LLM may have hallucinated content, not just metadata.
      // We fail closed to prevent potentially fabricated summary from influencing votes.
      const expectedComments = context.comments.length;
      const expectedParticipants = countUniqueParticipants(context.comments);

      if (
        summary.metadata.commentCount !== expectedComments ||
        summary.metadata.participantCount !== expectedParticipants
      ) {
        const reason =
          `LLM metadata mismatch indicates possible hallucination. ` +
          `Expected: ${expectedComments} comments, ${expectedParticipants} participants. ` +
          `Got: ${summary.metadata.commentCount} comments, ${summary.metadata.participantCount} participants.`;

        this.logger.error(reason);

        // FAIL CLOSED: Do not use potentially hallucinated content
        return { success: false, reason };
      }

      this.logger.info("Summary generated successfully");
      return { success: true, summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`LLM summarization failed: ${message}`);
      return { success: false, reason: message };
    }
  }

  /**
   * Create a minimal summary for issues with no comments.
   * Uses the issue title as the proposal.
   */
  private createMinimalSummary(context: IssueContext): DiscussionSummary {
    return {
      proposal: context.title,
      alignedOn: [],
      openForPR: [],
      notIncluded: [],
      metadata: {
        commentCount: 0,
        participantCount: 0,
      },
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Message Formatting
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Format a discussion summary into the voting message.
 *
 * Design principles:
 * 1. Header shows "Voting Phase" - immediately clear what this is
 * 2. Proposal in blockquote - visually distinct hero element
 * 3. Three emoji-prefixed sections - scannable at a glance
 * 4. Empty sections omitted - if nothing rejected, skip "Not Included"
 * 5. Vote section is compact - bold keywords, one line each
 * 6. Metadata compressed - single line with bullets
 */
export function formatVotingMessage(
  summary: DiscussionSummary,
  issueTitle: string,
  signature: string,
  votingSignature: string,
  priority?: "high" | "medium" | "low"
): string {
  const lines: string[] = [];

  // Header
  const priorityHeader = priority ? ` (${priority.toUpperCase()} PRIORITY)` : "";
  lines.push(`🐝 **Voting Phase${priorityHeader}**`);
  lines.push("");
  lines.push(`# ${issueTitle}`);
  lines.push("");

  // Proposal (hero element)
  lines.push("## Proposal");
  lines.push(`> ${summary.proposal}`);
  lines.push("");

  // Priority reminder (if present)
  if (priority) {
    lines.push(`This issue is marked **${priority}-priority** — your timely vote is appreciated.`);
    lines.push("");
  }

  // Aligned On (only if non-empty)
  if (summary.alignedOn.length > 0) {
    lines.push("### ✅ Aligned On");
    for (const point of summary.alignedOn) {
      lines.push(`- ${point}`);
    }
    lines.push("");
  }

  // Open for PR (only if non-empty)
  if (summary.openForPR.length > 0) {
    lines.push("### 🔶 Open for PR");
    for (const point of summary.openForPR) {
      lines.push(`- ${point}`);
    }
    lines.push("");
  }

  // Not Included (only if non-empty)
  if (summary.notIncluded.length > 0) {
    lines.push("### ❌ Not Included");
    for (const point of summary.notIncluded) {
      lines.push(`- ${point}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  // Voting instructions
  lines.push(`**${votingSignature} (react once — multiple reactions = no vote):**`);
  lines.push("- 👍 **Ready** — Approve for implementation");
  lines.push("- 👎 **Not Ready** — Close this proposal");
  lines.push("- 😕 **Needs Discussion** — Back to discussion");
  lines.push("- 👀 **Needs Human Input** — Escalate for human review");
  lines.push("");

  // Compressed metadata
  const metaParts = [`${summary.metadata.commentCount} comments`];
  if (summary.metadata.participantCount > 0) {
    metaParts.push(`${summary.metadata.participantCount} participants`);
  }
  metaParts.push("Closes ~24h");
  lines.push(metaParts.join(" • "));

  // Signature
  lines.push(signature);

  return lines.join("\n");
}
