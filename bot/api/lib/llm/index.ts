/**
 * LLM Module
 *
 * Provides LLM-powered text generation for governance:
 * - Discussion summarization for voting
 * - Implementation blueprints for /gather
 * - Commit message generation for /preflight
 */

// Types
export type {
  DiscussionSummary,
  DiscussionComment,
  IssueContext,
  ImplementationPlan,
  CommitMessage,
  PRContext,
  LLMConfig,
  LLMProvider,
} from "./types.js";
export { DiscussionSummarySchema, ImplementationPlanSchema, CommitMessageSchema, LLM_DEFAULTS } from "./types.js";

// Provider
export { isLLMConfigured, getLLMConfig, createModel, createModelFromEnv } from "./provider.js";

// Summarizer (voting)
export { DiscussionSummarizer, formatVotingMessage } from "./summarizer.js";
export type { SummarizationResult, SummarizerConfig } from "./summarizer.js";

// Blueprint generator (/gather)
export { BlueprintGenerator } from "./blueprint.js";
export type { BlueprintResult } from "./blueprint.js";

// Retry
export { withLLMRetry, isLLMRateLimitError, extractRetryDelay, LLM_RETRY_DEFAULTS } from "./retry.js";
export type { LLMRetryConfig } from "./retry.js";

// Commit message generator
export { CommitMessageGenerator, formatCommitMessage } from "./commit-message.js";
export type { CommitMessageResult, CommitMessageGeneratorConfig } from "./commit-message.js";

// Prompts (exported for testing/debugging purposes)
export { buildUserPrompt, SUMMARIZATION_SYSTEM_PROMPT } from "./prompts.js";
