import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateProviderKey,
  PROVIDER_VALIDATION_TIMEOUT_MS,
} from "./provider-validation";

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
  vi.useRealTimers();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
});

function mockFetchResponse(status: number, body: unknown = {}) {
  vi.mocked(global.fetch).mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

function mockFetchError() {
  vi.mocked(global.fetch).mockRejectedValue(new Error("network error"));
}

function mockFetchHangUntilAbort() {
  vi.mocked(global.fetch).mockImplementation((_, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;

      const abortError = new Error("aborted");
      abortError.name = "AbortError";

      if (signal.aborted) {
        reject(abortError);
        return;
      }

      signal.addEventListener(
        "abort",
        () => {
          reject(abortError);
        },
        { once: true },
      );
    }) as Promise<Response>;
  });
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe("validateProviderKey — anthropic", () => {
  it("returns valid when Anthropic API responds 200", async () => {
    mockFetchResponse(200, { data: [] });
    const result = await validateProviderKey("anthropic", "sk-ant-test");
    expect(result).toEqual({ valid: true });

    // Verify correct endpoint and headers
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-api-key": "sk-ant-test" }),
      }),
    );
  });

  it("returns invalid with reason on 401", async () => {
    mockFetchResponse(401);
    const result = await validateProviderKey("anthropic", "bad-key");
    expect(result).toEqual({ valid: false, reason: "Invalid API key" });
  });

  it("returns invalid with status on other errors", async () => {
    mockFetchResponse(500);
    const result = await validateProviderKey("anthropic", "sk-ant-test");
    expect(result).toEqual({ valid: false, reason: "Provider returned 500" });
  });

  it("handles network errors gracefully", async () => {
    mockFetchError();
    const result = await validateProviderKey("anthropic", "sk-ant-test");
    expect(result).toEqual({ valid: false, reason: "Failed to reach Anthropic API" });
  });

  it("times out when Anthropic API does not respond", async () => {
    vi.useFakeTimers();
    mockFetchHangUntilAbort();

    const resultPromise = validateProviderKey("anthropic", "sk-ant-test");
    await vi.advanceTimersByTimeAsync(PROVIDER_VALIDATION_TIMEOUT_MS);
    const result = await resultPromise;

    expect(result).toEqual({ valid: false, reason: "Provider validation timed out" });
  });
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe("validateProviderKey — openai", () => {
  it("returns valid when OpenAI API responds 200", async () => {
    mockFetchResponse(200, { data: [] });
    const result = await validateProviderKey("openai", "sk-test-openai");
    expect(result).toEqual({ valid: true });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-test-openai" }),
      }),
    );
  });

  it("returns invalid with reason on 401", async () => {
    mockFetchResponse(401);
    const result = await validateProviderKey("openai", "bad-key");
    expect(result).toEqual({ valid: false, reason: "Invalid API key" });
  });

  it("handles network errors gracefully", async () => {
    mockFetchError();
    const result = await validateProviderKey("openai", "sk-test");
    expect(result).toEqual({ valid: false, reason: "Failed to reach OpenAI API" });
  });

  it("times out when OpenAI API does not respond", async () => {
    vi.useFakeTimers();
    mockFetchHangUntilAbort();

    const resultPromise = validateProviderKey("openai", "sk-test");
    await vi.advanceTimersByTimeAsync(PROVIDER_VALIDATION_TIMEOUT_MS);
    const result = await resultPromise;

    expect(result).toEqual({ valid: false, reason: "Provider validation timed out" });
  });
});

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

describe("validateProviderKey — google", () => {
  it("returns valid when Google AI API responds 200", async () => {
    mockFetchResponse(200, { models: [] });
    const result = await validateProviderKey("google", "AIzaTest123");
    expect(result).toEqual({ valid: true });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("generativelanguage.googleapis.com/v1beta/models?key=AIzaTest123"),
      expect.any(Object),
    );
  });

  it("returns invalid with reason on 400", async () => {
    mockFetchResponse(400);
    const result = await validateProviderKey("google", "bad-key");
    expect(result).toEqual({ valid: false, reason: "Invalid API key" });
  });

  it("returns invalid with reason on 403", async () => {
    mockFetchResponse(403);
    const result = await validateProviderKey("google", "bad-key");
    expect(result).toEqual({ valid: false, reason: "Invalid API key" });
  });

  it("returns invalid with status on other errors", async () => {
    mockFetchResponse(500);
    const result = await validateProviderKey("google", "AIzaTest123");
    expect(result).toEqual({ valid: false, reason: "Provider returned 500" });
  });

  it("handles network errors gracefully", async () => {
    mockFetchError();
    const result = await validateProviderKey("google", "AIzaTest123");
    expect(result).toEqual({ valid: false, reason: "Failed to reach Google AI API" });
  });

  it("times out when Google AI API does not respond", async () => {
    vi.useFakeTimers();
    mockFetchHangUntilAbort();

    const resultPromise = validateProviderKey("google", "AIzaTest123");
    await vi.advanceTimersByTimeAsync(PROVIDER_VALIDATION_TIMEOUT_MS);
    const result = await resultPromise;

    expect(result).toEqual({ valid: false, reason: "Provider validation timed out" });
  });
});

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------

describe("validateProviderKey — openrouter", () => {
  it("returns valid when OpenRouter API responds 200", async () => {
    mockFetchResponse(200, { data: { label: "test-key" } });
    const result = await validateProviderKey("openrouter", "sk-or-v1-test");
    expect(result).toEqual({ valid: true });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/auth/key",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-or-v1-test" }),
      }),
    );
  });

  it("returns invalid with reason on 401", async () => {
    mockFetchResponse(401);
    const result = await validateProviderKey("openrouter", "bad-key");
    expect(result).toEqual({ valid: false, reason: "Invalid API key" });
  });

  it("returns invalid with status on other errors", async () => {
    mockFetchResponse(500);
    const result = await validateProviderKey("openrouter", "sk-or-v1-test");
    expect(result).toEqual({ valid: false, reason: "Provider returned 500" });
  });

  it("handles network errors gracefully", async () => {
    mockFetchError();
    const result = await validateProviderKey("openrouter", "sk-or-v1-test");
    expect(result).toEqual({ valid: false, reason: "Failed to reach OpenRouter API" });
  });

  it("times out when OpenRouter API does not respond", async () => {
    vi.useFakeTimers();
    mockFetchHangUntilAbort();

    const resultPromise = validateProviderKey("openrouter", "sk-or-v1-test");
    await vi.advanceTimersByTimeAsync(PROVIDER_VALIDATION_TIMEOUT_MS);
    const result = await resultPromise;

    expect(result).toEqual({ valid: false, reason: "Provider validation timed out" });
  });
});

// ---------------------------------------------------------------------------
// Unknown provider
// ---------------------------------------------------------------------------

describe("validateProviderKey — unknown provider", () => {
  it.each(["deepseek", "mistral"])("rejects unsupported provider %s", async (provider) => {
    const result = await validateProviderKey(provider, "key");
    expect(result).toEqual({
      valid: false,
      reason: "Unsupported provider. Supported providers: anthropic, openai, google, openrouter",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
