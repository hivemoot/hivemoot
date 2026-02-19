import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateProviderKey } from "./provider-validation";

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
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
});

// ---------------------------------------------------------------------------
// Unknown provider
// ---------------------------------------------------------------------------

describe("validateProviderKey — unknown provider", () => {
  it("rejects unknown providers", async () => {
    const result = await validateProviderKey("deepseek", "key");
    expect(result).toEqual({ valid: false, reason: "Unsupported provider" });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
