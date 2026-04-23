import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { APICallError } from "@ai-sdk/provider";

import type { Logger } from "../logger.js";
import {
  isLLMRateLimitError,
  extractRetryDelay,
  withLLMRetry,
} from "./retry.js";

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

function makeAPICallError(
  statusCode: number,
  opts?: { responseHeaders?: Record<string, string>; message?: string }
): APICallError {
  return new APICallError({
    message: opts?.message ?? "error",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: {},
    statusCode,
    responseHeaders: opts?.responseHeaders ?? {},
    responseBody: "",
  });
}

function mockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    group: vi.fn(),
    groupEnd: vi.fn(),
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// isLLMRateLimitError
// ───────────────────────────────────────────────────────────────────────────────

describe("isLLMRateLimitError", () => {
  it("returns true for APICallError with status 429", () => {
    const error = makeAPICallError(429);
    expect(isLLMRateLimitError(error)).toBe(true);
  });

  it("returns false for APICallError with status 400", () => {
    const error = makeAPICallError(400);
    expect(isLLMRateLimitError(error)).toBe(false);
  });

  it("returns false for APICallError with status 500", () => {
    const error = makeAPICallError(500);
    expect(isLLMRateLimitError(error)).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isLLMRateLimitError(new Error("rate limit"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isLLMRateLimitError("429")).toBe(false);
    expect(isLLMRateLimitError(null)).toBe(false);
    expect(isLLMRateLimitError(undefined)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// extractRetryDelay
// ───────────────────────────────────────────────────────────────────────────────

describe("extractRetryDelay", () => {
  it("parses Gemini 'retry in X.XXXs' message", () => {
    const error = makeAPICallError(429, {
      message: "You exceeded your current quota. Please retry in 16.566730247s.",
    });
    const delay = extractRetryDelay(error);
    expect(delay).toBe(Math.ceil(16.566730247 * 1000));
  });

  it("parses standard retry-after header (seconds)", () => {
    const error = makeAPICallError(429, {
      responseHeaders: { "retry-after": "17" },
    });
    const delay = extractRetryDelay(error);
    expect(delay).toBe(17_000);
  });

  it("prefers retry-after header over message regex", () => {
    const error = makeAPICallError(429, {
      responseHeaders: { "retry-after": "5" },
      message: "Please retry in 20.0s",
    });
    // Header takes priority
    expect(extractRetryDelay(error)).toBe(5_000);
  });

  it("returns null when no delay info is present", () => {
    const error = makeAPICallError(429, { message: "rate limited" });
    expect(extractRetryDelay(error)).toBeNull();
  });

  it("returns null for non-APICallError", () => {
    expect(extractRetryDelay(new Error("retry in 10s"))).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// withLLMRetry
// ───────────────────────────────────────────────────────────────────────────────

describe("withLLMRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes through on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withLLMRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws immediately on non-rate-limit error", async () => {
    const fn = vi.fn().mockRejectedValue(makeAPICallError(400, { message: "bad request" }));
    await expect(withLLMRetry(fn)).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws immediately on plain Error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(withLLMRetry(fn)).rejects.toThrow("network down");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on rate-limit error with correct delay", async () => {
    const rateLimitError = makeAPICallError(429, {
      message: "Please retry in 2.0s",
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce("success");

    const log = mockLogger();
    const promise = withLLMRetry(fn, undefined, log);

    // Advance past the 2s delay
    await vi.advanceTimersByTimeAsync(2_000);

    const result = await promise;
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("retrying in 2.0s")
    );
  });

  it("uses default delay when server does not suggest one", async () => {
    const rateLimitError = makeAPICallError(429, { message: "rate limited" });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce("ok");

    const log = mockLogger();
    const promise = withLLMRetry(fn, { defaultRetryDelayMs: 3_000 }, log);

    await vi.advanceTimersByTimeAsync(3_000);

    const result = await promise;
    expect(result).toBe("ok");
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("(default)")
    );
  });

  it("caps delay at maxRetryDelayMs", async () => {
    const rateLimitError = makeAPICallError(429, {
      message: "Please retry in 120.0s",
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce("ok");

    const promise = withLLMRetry(fn, { maxRetryDelayMs: 10_000 });

    // Should be capped at 10s, not 120s
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await promise;
    expect(result).toBe("ok");
  });

  it("throws after exhausting max retries", async () => {
    vi.useRealTimers();

    const rateLimitError = makeAPICallError(429, {
      message: "Please retry in 0.01s", // Use tiny delay for real-timer test
    });

    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError);

    await expect(
      withLLMRetry(fn, { maxRetries: 2, defaultRetryDelayMs: 10 })
    ).rejects.toThrow();

    // 1 initial + 2 retries = 3 total calls
    expect(fn).toHaveBeenCalledTimes(3);

    vi.useFakeTimers();
  });

  it("respects maxRetries: 0 (no retries at all)", async () => {
    const rateLimitError = makeAPICallError(429);
    const fn = vi.fn().mockRejectedValue(rateLimitError);

    await expect(withLLMRetry(fn, { maxRetries: 0 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("aborts when delay would exceed maxTotalElapsedMs budget", async () => {
    const rateLimitError = makeAPICallError(429, {
      message: "Please retry in 20.0s",
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce("should not reach");

    const log = mockLogger();

    // Budget of 10s, but server suggests 20s delay — should abort immediately
    await expect(
      withLLMRetry(fn, { maxRetries: 3, maxTotalElapsedMs: 10_000 }, log)
    ).rejects.toThrow();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("budget")
    );
  });

  it("allows retry when delay fits within maxTotalElapsedMs budget", async () => {
    const rateLimitError = makeAPICallError(429, {
      message: "Please retry in 2.0s",
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce("success");

    const log = mockLogger();
    const promise = withLLMRetry(
      fn,
      { maxRetries: 3, maxTotalElapsedMs: 10_000 },
      log
    );

    await vi.advanceTimersByTimeAsync(2_000);

    const result = await promise;
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("aborts mid-sequence when cumulative time exhausts budget", async () => {
    vi.useRealTimers();

    const rateLimitError = makeAPICallError(429, {
      message: "Please retry in 0.05s",
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce("should not reach");

    const log = mockLogger();

    await expect(
      withLLMRetry(fn, { maxRetries: 5, maxTotalElapsedMs: 100 }, log)
    ).rejects.toThrow();

    // Should have tried at most 2-3 times depending on timing
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(3);

    vi.useFakeTimers();
  });

  it("ignores maxTotalElapsedMs when undefined", async () => {
    const rateLimitError = makeAPICallError(429, {
      message: "Please retry in 1.0s",
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce("ok");

    const promise = withLLMRetry(
      fn,
      { maxRetries: 3, maxTotalElapsedMs: undefined },
    );

    await vi.advanceTimersByTimeAsync(1_000);

    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
