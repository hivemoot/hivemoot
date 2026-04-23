/**
 * Commit Message Generator
 *
 * Uses LLM to generate high-quality squash commit messages from PR context.
 * Follows the same pattern as DiscussionSummarizer for consistency.
 */

import { generateObject } from "ai";
import type { LanguageModel } from "ai";

import type { Logger } from "../logger.js";
import { logger as defaultLogger } from "../logger.js";
import { repairMalformedJsonText } from "./json-repair.js";
import { createModelFromEnv, type ModelResolutionOptions } from "./provider.js";
import { withLLMRetry } from "./retry.js";
import type { CommitMessage, LLMConfig, PRContext } from "./types.js";
import { CommitMessageSchema, LLM_DEFAULTS } from "./types.js";

// ───────────────────────────────────────────────────────────────────────────────
// System Prompt
// ───────────────────────────────────────────────────────────────────────────────

const COMMIT_MESSAGE_SYSTEM_PROMPT = `You are a commit message generator for squash-merged pull requests. Generate a concise, informative commit message from the PR context.

SUBJECT LINE RULES:
- Use imperative mood ("Add", "Fix", "Update", "Remove" — not "Added", "Fixes", "Updates")
- Maximum 72 characters
- No trailing period
- Be specific about what changed, not generic ("Add merge-readiness evaluation" not "Update code")

BODY RULES:
- 1-3 sentences explaining WHY this change was made
- Focus on the problem solved or feature added, not implementation details
- Only mention key implementation details if they are non-obvious or important for future readers
- Do not repeat the subject line
- Do not include PR number (it will be appended separately)

IMPORTANT:
- Base the message on the actual changes (diff stat, commits) not just the PR title
- If the PR has a linked issue, the "why" should reference the problem described there
- Keep it concise — this is a commit message, not documentation`;

// ───────────────────────────────────────────────────────────────────────────────
// Prompt Builder
// ───────────────────────────────────────────────────────────────────────────────

/** Maximum characters of PR context to include. */
const MAX_CONTEXT_CHARS = 50_000;

function buildCommitMessagePrompt(context: PRContext): string {
  const lines: string[] = [];

  lines.push(`Generate a squash commit message for PR #${context.prNumber}.`);
  lines.push("");

  lines.push(`## PR Title`);
  lines.push(context.title);
  lines.push("");

  if (context.body) {
    lines.push(`## PR Description`);
    lines.push(context.body.slice(0, 10_000));
    lines.push("");
  }

  if (context.linkedIssue) {
    lines.push(`## Linked Issue #${context.linkedIssue.number}: ${context.linkedIssue.title}`);
    lines.push(context.linkedIssue.body.slice(0, 10_000));
    lines.push("");
  }

  if (context.diffStat) {
    lines.push(`## Files Changed`);
    lines.push(context.diffStat.slice(0, 5_000));
    lines.push("");
  }

  if (context.commitMessages.length > 0) {
    lines.push(`## Commits (${context.commitMessages.length})`);
    for (const msg of context.commitMessages.slice(0, 50)) {
      lines.push(`- ${msg}`);
    }
    lines.push("");
  }

  let prompt = lines.join("\n");
  if (prompt.length > MAX_CONTEXT_CHARS) {
    prompt = prompt.slice(0, MAX_CONTEXT_CHARS) + "\n\n[truncated]";
  }
  return prompt;
}

// ───────────────────────────────────────────────────────────────────────────────
// Generator
// ───────────────────────────────────────────────────────────────────────────────

export type CommitMessageResult =
  | { success: true; message: CommitMessage }
  | {
      success: false;
      reason: string;
      kind: "not_configured" | "generation_failed";
    };

export interface CommitMessageGeneratorConfig {
  logger?: Logger;
}

export class CommitMessageGenerator {
  private logger: Logger;

  constructor(config?: CommitMessageGeneratorConfig) {
    this.logger = config?.logger ?? defaultLogger;
  }

  async generate(
    context: PRContext,
    preCreatedModel?: { model: LanguageModel; config: LLMConfig },
    modelOptions?: ModelResolutionOptions
  ): Promise<CommitMessageResult> {
    try {
      const modelResult = preCreatedModel ?? await createModelFromEnv(modelOptions);
      if (!modelResult) {
        return {
          success: false,
          reason: "LLM not configured",
          kind: "not_configured",
        };
      }

      const { model, config } = modelResult;
      this.logger.info(
        `Generating commit message with ${config.provider}/${config.model} for PR #${context.prNumber}`
      );

      const result = await withLLMRetry(
        () =>
          generateObject({
            model,
            schema: CommitMessageSchema,
            system: COMMIT_MESSAGE_SYSTEM_PROMPT,
            prompt: buildCommitMessagePrompt(context),
            experimental_repairText: async (args) => {
              const repaired = await repairMalformedJsonText(args);
              if (repaired !== null) {
                this.logger.info(`Repaired malformed LLM JSON output (error: ${args.error.message})`);
              }
              return repaired;
            },
            maxOutputTokens: config.maxTokens,
            temperature: LLM_DEFAULTS.temperature,
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(LLM_DEFAULTS.perCallTimeoutMs),
          }),
        undefined,
        this.logger
      );

      const message = result.object;

      // Enforce subject line length constraint
      if (message.subject.length > 72) {
        message.subject = message.subject.slice(0, 69) + "...";
      }

      this.logger.info("Commit message generated successfully");
      return { success: true, message };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Commit message generation failed: ${reason}`);
      return { success: false, reason, kind: "generation_failed" };
    }
  }
}

/**
 * Format a CommitMessage into the final commit message string.
 * Appends PR number as a footer.
 */
export function formatCommitMessage(message: CommitMessage, prNumber: number): string {
  return `${message.subject}\n\n${message.body}\n\nPR: #${prNumber}`;
}
