/**
 * Blueprint Generator Service
 *
 * Uses LLM to generate implementation blueprints from issue discussions.
 * Separate from DiscussionSummarizer — different schema, different purpose.
 *
 * The blueprint is designed for an implementing agent who has NOT read the
 * discussion thread. It extracts concrete steps, decisions, and scope
 * boundaries from the conversation.
 */

import { generateObject } from "ai";

import type { LanguageModel } from "ai";

import type { Logger } from "../logger.js";
import { logger as defaultLogger } from "../logger.js";
import { repairMalformedJsonText } from "./json-repair.js";
import { createModelFromEnv, type ModelResolutionOptions } from "./provider.js";
import { withLLMRetry } from "./retry.js";
import type { ImplementationPlan, IssueContext, LLMConfig } from "./types.js";
import { ImplementationPlanSchema, LLM_DEFAULTS, countUniqueParticipants } from "./types.js";

// ───────────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────────

export type BlueprintResult =
  | { success: true; plan: ImplementationPlan }
  | { success: false; reason: string };

// ───────────────────────────────────────────────────────────────────────────────
// System Prompt
// ───────────────────────────────────────────────────────────────────────────────

export const BLUEPRINT_SYSTEM_PROMPT = `You are an implementation architect. Extract a brief, actionable blueprint from a GitHub issue discussion.

<context>
- The reader has NOT read the discussion thread
- 👍/👎 counts on comments indicate community endorsement or pushback
- Comments marked "(author)" carry the original intent
</context>

<output>
- goal: 1-2 sentences — what will be built
- plan: Concise numbered steps an engineer can follow. Use code snippets only when essential.
- decisions: Design choices from the discussion (keep each to one line)
- outOfScope: Items explicitly ruled out
- openQuestions: Unresolved items or active disagreements
</output>

<rules>
- Be objective — report what the discussion concluded, do not inject your own opinions
- When the discussion is ambiguous or lacks consensus, lean towards the author's original proposal
- When participants clearly disagree, list the disagreement under openQuestions rather than picking a side
- Only include information present in the discussion
- Keep every section as short as possible — brevity over completeness
- Empty sections are fine; omit rather than pad
- Metadata counts must be accurate
</rules>`;

// ───────────────────────────────────────────────────────────────────────────────
// User Prompt Builder
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Maximum characters to include from discussion content.
 * ~25k tokens ≈ ~100k characters, leaves room for response.
 */
const MAX_CONTENT_CHARS = 100_000;

/**
 * Build an author label with role and reaction signals.
 * e.g. **@alice (author) [👍 3] [👎 1]**
 */
function formatAuthorLabel(
  author: string,
  issueAuthor: string,
  reactions?: { thumbsUp: number; thumbsDown: number },
): string {
  const parts = [`@${author}`];
  if (author === issueAuthor) parts.push("(author)");
  if (reactions?.thumbsUp && reactions.thumbsUp > 0) {
    parts.push(`[👍 ${reactions.thumbsUp}]`);
  }
  if (reactions?.thumbsDown && reactions.thumbsDown > 0) {
    parts.push(`[👎 ${reactions.thumbsDown}]`);
  }
  return `**${parts.join(" ")}**`;
}

/**
 * Build the user prompt with enriched comment formatting.
 *
 * Enrichments over the voting prompt:
 * - Author's comments marked: **@alice (author)**
 * - Reaction signals: **@scout [👍 3] [👎 1]**
 */
export function buildBlueprintUserPrompt(context: IssueContext): string {
  const { title, body, comments } = context;

  let discussionText = `## Issue: ${title}\n\n`;
  discussionText += `### Original Description\n${body || "(No description provided)"}\n\n`;

  if (comments.length === 0) {
    discussionText += "### Discussion\n(No comments yet)\n";
  } else {
    discussionText += "### Discussion\n\n";
    for (const comment of comments) {
      const authorLabel = formatAuthorLabel(comment.author, context.author, comment.reactions);
      discussionText += `${authorLabel} (${comment.createdAt}):\n${comment.body}\n\n---\n\n`;
    }
  }

  // Truncate if too long, keeping issue body and recent comments
  if (discussionText.length > MAX_CONTENT_CHARS) {
    discussionText = truncateDiscussion(title, body, context.author, comments, MAX_CONTENT_CHARS);
  }

  const participantCount = countUniqueParticipants(comments);

  return `Extract an implementation blueprint from this GitHub issue discussion.

METADATA:
- Total comments: ${comments.length}
- Unique participants: ${participantCount}

${discussionText}

Generate a structured implementation blueprint. Focus on concrete steps, design decisions, and scope boundaries.`;
}

/**
 * Truncate discussion content, preserving issue body and prioritizing recent comments.
 */
export function truncateDiscussion(
  title: string,
  body: string,
  author: string,
  comments: ReadonlyArray<{ author: string; body: string; createdAt: string; reactions?: { thumbsUp: number; thumbsDown: number } }>,
  maxChars: number
): string {
  let result = `## Issue: ${title}\n\n`;
  result += `### Original Description\n${body || "(No description provided)"}\n\n`;

  const headerLen = result.length + 200;
  const availableForComments = maxChars - headerLen;

  if (availableForComments <= 0) {
    return result + "### Discussion\n(Truncated - too many comments to include)\n";
  }

  const includedComments: string[] = [];
  let usedChars = 0;
  let skippedCount = 0;

  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    const authorLabel = formatAuthorLabel(comment.author, author, comment.reactions);
    const commentText = `${authorLabel} (${comment.createdAt}):\n${comment.body}\n\n---\n\n`;

    if (usedChars + commentText.length <= availableForComments) {
      includedComments.unshift(commentText);
      usedChars += commentText.length;
    } else {
      skippedCount = i + 1;
      break;
    }
  }

  result += "### Discussion\n\n";

  if (skippedCount > 0) {
    result += `*[${skippedCount} older comments truncated for length]*\n\n`;
  }

  result += includedComments.join("");

  return result;
}

// ───────────────────────────────────────────────────────────────────────────────
// Minimal Plan Factory
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Create a minimal blueprint from issue context alone (no LLM).
 * Used when there's no meaningful discussion and as the fallback shape.
 */
export function createMinimalPlan(context: IssueContext): ImplementationPlan {
  return {
    goal: context.title,
    plan: "",
    decisions: [],
    outOfScope: [],
    openQuestions: [],
    metadata: {
      commentCount: context.comments.length,
      participantCount: countUniqueParticipants(context.comments),
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Blueprint Generator
// ───────────────────────────────────────────────────────────────────────────────

export interface BlueprintGeneratorConfig {
  logger?: Logger;
}

/**
 * Implementation blueprint generator using LLM.
 */
export class BlueprintGenerator {
  private logger: Logger;

  constructor(config?: BlueprintGeneratorConfig) {
    this.logger = config?.logger ?? defaultLogger;
  }

  /**
   * Generate an implementation blueprint from an issue discussion.
   *
   * Returns failure if:
   * - LLM is not configured (and no preCreatedModel provided)
   * - Discussion is too minimal (no comments from others)
   * - LLM API fails
   * - Metadata validation fails (possible hallucination)
   */
  async generate(
    context: IssueContext,
    preCreatedModel?: { model: LanguageModel; config: LLMConfig },
    modelOptions?: ModelResolutionOptions
  ): Promise<BlueprintResult> {
    // Minimal discussions: no LLM needed
    const hasDiscussion = context.comments.some((c) => c.author !== context.author);
    if (!hasDiscussion) {
      this.logger.debug("No discussion from others, using minimal blueprint");
      return {
        success: true,
        plan: this.createMinimalPlan(context),
      };
    }

    try {
      const modelResult = preCreatedModel ?? await createModelFromEnv(modelOptions);
      if (!modelResult) {
        this.logger.debug("LLM not configured, skipping blueprint generation");
        return { success: false, reason: "LLM not configured" };
      }

      const { model, config } = modelResult;
      const userPrompt = buildBlueprintUserPrompt(context);

      this.logger.info(
        `Generating blueprint with ${config.provider}/${config.model} for ${context.comments.length} comments`
      );

      const result = await withLLMRetry(
        () =>
          generateObject({
            model,
            schema: ImplementationPlanSchema,
            system: BLUEPRINT_SYSTEM_PROMPT,
            prompt: userPrompt,
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

      const plan = result.object;

      // Fail-closed metadata validation: reject if LLM hallucinates counts
      const expectedComments = context.comments.length;
      const expectedParticipants = countUniqueParticipants(context.comments);

      if (
        plan.metadata.commentCount !== expectedComments ||
        plan.metadata.participantCount !== expectedParticipants
      ) {
        const reason =
          `LLM metadata mismatch indicates possible hallucination. ` +
          `Expected: ${expectedComments} comments, ${expectedParticipants} participants. ` +
          `Got: ${plan.metadata.commentCount} comments, ${plan.metadata.participantCount} participants.`;

        this.logger.error(reason);
        return { success: false, reason };
      }

      this.logger.info("Blueprint generated successfully");
      return { success: true, plan };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Blueprint generation failed: ${message}`);
      return { success: false, reason: message };
    }
  }

  private createMinimalPlan(context: IssueContext): ImplementationPlan {
    return createMinimalPlan(context);
  }
}
