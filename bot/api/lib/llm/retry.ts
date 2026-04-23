/**
 * Rate-Limit-Aware Retry for LLM Calls
 *
 * The Vercel AI SDK's built-in retry (~2s/4s backoff) is too fast for
 * Gemini's rate-limit window (~17s). This module disables SDK retry and
 * implements our own that respects server-suggested delays.
 *
 * Strategy:
 * - On 429 (rate limit): wait the server-suggested delay, then retry
 * - On any other error: fail immediately (no retry)
 */

import { APICallError } from "@ai-sdk/provider";

import type { Logger } from "../logger.js";

// ───────────────────────────────────────────────────────────────────────────────
// Types & Defaults
// ───────────────────────────────────────────────────────────────────────────────

export interface LLMRetryConfig {
  /** Maximum number of retries on rate-limit errors */
  maxRetries: number;
  /** Cap on any single retry delay (ms) */
  maxRetryDelayMs: number;
  /** Fallback delay when server doesn't suggest one (ms) */
  defaultRetryDelayMs: number;
  /**
   * Wall-clock budget for the entire retry sequence (ms).
   * When set, the loop aborts before starting a retry whose delay would
   * exceed the remaining budget. Prevents unbounded total elapsed time
   * in serverless environments (e.g. Vercel function timeouts).
   * `undefined` means no total-time limit (attempt-count only).
   */
  maxTotalElapsedMs?: number;
}

export const LLM_RETRY_DEFAULTS: LLMRetryConfig = {
  maxRetries: 3,
  maxRetryDelayMs: 60_000,
  defaultRetryDelayMs: 5_000,
  // 105s leaves ~15s headroom within a 120s Vercel function budget for
  // GitHub API calls around the LLM invocation.
  //
  // ⚠️  Budget alignment (update together):
  //   vercel.json  maxDuration .............. 120s (hard ceiling)
  //   retry.ts     maxTotalElapsedMs ........ 105s (retry sequence budget)
  //   types.ts     perCallTimeoutMs ......... 90s  (single LLM call)
  maxTotalElapsedMs: 105_000,
};

// ───────────────────────────────────────────────────────────────────────────────
// Error Detection
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Detect whether an error is an LLM rate-limit (HTTP 429).
 *
 * Uses APICallError.isInstance() rather than instanceof to handle
 * multiple package versions safely.
 */
export function isLLMRateLimitError(error: unknown): boolean {
  return APICallError.isInstance(error) && error.statusCode === 429;
}

// ───────────────────────────────────────────────────────────────────────────────
// Delay Extraction
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Extract the server-suggested retry delay from a rate-limit error.
 *
 * Checks two sources:
 * 1. `retry-after` response header (OpenAI/Anthropic standard) — value in seconds
 * 2. Error message regex for "retry in X.XXXs" (Gemini style)
 *
 * Returns delay in milliseconds, or null if not parseable.
 */
export function extractRetryDelay(error: unknown): number | null {
  if (!APICallError.isInstance(error)) return null;

  // Source 1: Standard retry-after header (value in seconds)
  const retryAfterHeader =
    error.responseHeaders?.["retry-after"] ?? error.responseHeaders?.["Retry-After"];
  if (retryAfterHeader) {
    const seconds = parseFloat(retryAfterHeader);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }

  // Source 2: Gemini-style message — "retry in 16.566730247s"
  const match = error.message.match(/retry\s+in\s+([\d.]+)s/i);
  if (match) {
    const seconds = parseFloat(match[1]);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }

  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Retry Wrapper
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Execute an async function with rate-limit-aware retry.
 *
 * - On rate-limit (429): waits the server-suggested delay (capped), then retries
 * - On any other error: throws immediately — no retry
 * - Respects a wall-clock budget (maxTotalElapsedMs) to prevent unbounded
 *   total duration in serverless environments
 * - Logs each retry with delay info via the optional logger
 */
export async function withLLMRetry<T>(
  fn: () => Promise<T>,
  config?: Partial<LLMRetryConfig>,
  logger?: Logger
): Promise<T> {
  const { maxRetries, maxRetryDelayMs, defaultRetryDelayMs, maxTotalElapsedMs } = {
    ...LLM_RETRY_DEFAULTS,
    ...config,
  };

  const startTime = Date.now();
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Only retry on rate-limit errors
      if (!isLLMRateLimitError(error)) {
        throw error;
      }

      // Exhausted retries
      if (attempt >= maxRetries) {
        break;
      }

      const suggestedDelay = extractRetryDelay(error);
      const delay = Math.min(suggestedDelay ?? defaultRetryDelayMs, maxRetryDelayMs);

      // Check wall-clock budget before sleeping
      if (maxTotalElapsedMs !== undefined) {
        const elapsed = Date.now() - startTime;
        if (elapsed + delay > maxTotalElapsedMs) {
          logger?.warn(
            `Rate-limited but total elapsed ${(elapsed / 1000).toFixed(1)}s + ` +
              `${(delay / 1000).toFixed(1)}s delay would exceed ` +
              `${(maxTotalElapsedMs / 1000).toFixed(1)}s budget — aborting`
          );
          break;
        }
      }

      logger?.info(
        `Rate-limited (attempt ${attempt + 1}/${maxRetries + 1}), ` +
          `retrying in ${(delay / 1000).toFixed(1)}s` +
          (suggestedDelay ? " (server-suggested)" : " (default)")
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
