import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { isLLMConfigured, getLLMConfig, createModel, createModelFromEnv, getLLMReadiness } from "./provider.js";
import { _resetMasterKeysCache } from "./byok.js";
import type { LLMConfig, LLMProvider } from "./types.js";

vi.mock("@openrouter/ai-sdk-provider", async () => {
  const actual = await vi.importActual<typeof import("@openrouter/ai-sdk-provider")>("@openrouter/ai-sdk-provider");
  return {
    ...actual,
    createOpenRouter: vi.fn(actual.createOpenRouter),
  };
});

/**
 * Tests for LLM Provider Factory
 */

describe("LLM Provider", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = originalEnv;
    _resetMasterKeysCache();
  });

  describe("isLLMConfigured", () => {
    it("should return false when neither provider nor model is set", () => {
      delete process.env.LLM_PROVIDER;
      delete process.env.LLM_MODEL;

      expect(isLLMConfigured()).toBe(false);
    });

    it("should return false when only provider is set", () => {
      process.env.LLM_PROVIDER = "anthropic";
      delete process.env.LLM_MODEL;

      expect(isLLMConfigured()).toBe(false);
    });

    it("should return false when only model is set", () => {
      delete process.env.LLM_PROVIDER;
      process.env.LLM_MODEL = "claude-3-haiku";

      expect(isLLMConfigured()).toBe(false);
    });

    it("should return false for invalid provider", () => {
      process.env.LLM_PROVIDER = "invalid-provider";
      process.env.LLM_MODEL = "some-model";

      expect(isLLMConfigured()).toBe(false);
    });

    it("should return true when valid provider and model are set", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";

      expect(isLLMConfigured()).toBe(true);
    });

    it("should normalize provider casing and whitespace", () => {
      process.env.LLM_PROVIDER = "  Google ";
      process.env.LLM_MODEL = " gemini-2.0-flash ";

      expect(isLLMConfigured()).toBe(true);
    });

    it("should accept gemini alias as google provider", () => {
      process.env.LLM_PROVIDER = "gemini";
      process.env.LLM_MODEL = "gemini-2.0-flash";

      expect(isLLMConfigured()).toBe(true);
    });

    it.each(["openai", "anthropic", "google", "mistral", "openrouter"])(
      "should return true for valid provider: %s",
      (provider) => {
        process.env.LLM_PROVIDER = provider;
        process.env.LLM_MODEL = "some-model";

        expect(isLLMConfigured()).toBe(true);
      }
    );
  });

  describe("getLLMConfig", () => {
    it("should return null when not configured", () => {
      delete process.env.LLM_PROVIDER;
      delete process.env.LLM_MODEL;

      expect(getLLMConfig()).toBe(null);
    });

    it("should return null for invalid provider", () => {
      process.env.LLM_PROVIDER = "not-a-provider";
      process.env.LLM_MODEL = "model";

      expect(getLLMConfig()).toBe(null);
    });

    it("should return config with defaults when optional vars not set", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";
      delete process.env.LLM_MAX_TOKENS;

      const config = getLLMConfig();

      expect(config).toEqual({
        provider: "anthropic",
        model: "claude-3-haiku",
        maxTokens: 4_096,
      });
    });

    it("should normalize quoted provider/model values", () => {
      process.env.LLM_PROVIDER = ' "OpenAI" ';
      process.env.LLM_MODEL = " 'gpt-4o-mini' ";

      const config = getLLMConfig();

      expect(config).toEqual({
        provider: "openai",
        model: "gpt-4o-mini",
        maxTokens: 4_096,
      });
    });

    it("should return null when model is blank after trimming", () => {
      process.env.LLM_PROVIDER = "google";
      process.env.LLM_MODEL = "   ";

      expect(getLLMConfig()).toBeNull();
    });

    it("should parse custom maxTokens", () => {
      process.env.LLM_PROVIDER = "openai";
      process.env.LLM_MODEL = "gpt-4o-mini";
      process.env.LLM_MAX_TOKENS = "4000";

      const config = getLLMConfig();

      expect(config).toEqual({
        provider: "openai",
        model: "gpt-4o-mini",
        maxTokens: 4000,
      });
    });

    it("should use defaults for invalid maxTokens", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";
      process.env.LLM_MAX_TOKENS = "not-a-number";

      const config = getLLMConfig();

      expect(config?.maxTokens).toBe(4_096);
    });

    it("should use defaults for non-positive maxTokens", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";
      process.env.LLM_MAX_TOKENS = "0";

      const zeroConfig = getLLMConfig();
      expect(zeroConfig?.maxTokens).toBe(4_096);

      process.env.LLM_MAX_TOKENS = "-100";
      const negativeConfig = getLLMConfig();
      expect(negativeConfig?.maxTokens).toBe(4_096);
    });

    it("should clamp LLM_MAX_TOKENS below minimum to minimum", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";
      process.env.LLM_MAX_TOKENS = "499";

      const config = getLLMConfig();
      expect(config?.maxTokens).toBe(500);
    });

    it("should clamp LLM_MAX_TOKENS above maximum to maximum", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";
      process.env.LLM_MAX_TOKENS = "50001";

      const config = getLLMConfig();
      expect(config?.maxTokens).toBe(32_768);
    });

    it("should allow LLM_MAX_TOKENS at exact minimum boundary", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";
      process.env.LLM_MAX_TOKENS = "500";

      const config = getLLMConfig();
      expect(config?.maxTokens).toBe(500);
    });

    it("should allow LLM_MAX_TOKENS at exact maximum boundary", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";
      process.env.LLM_MAX_TOKENS = "32768";

      const config = getLLMConfig();
      expect(config?.maxTokens).toBe(32_768);
    });

  });

  describe("createModel", () => {
    it("should throw when Anthropic API key is missing", () => {
      delete process.env.ANTHROPIC_API_KEY;
      const config: LLMConfig = {
        provider: "anthropic",
        model: "claude-3-haiku",
        maxTokens: 2000,
      };

      expect(() => createModel(config)).toThrow(
        "ANTHROPIC_API_KEY environment variable is not set"
      );
    });

    it("should throw when OpenAI API key is missing", () => {
      delete process.env.OPENAI_API_KEY;
      const config: LLMConfig = {
        provider: "openai",
        model: "gpt-4o-mini",
        maxTokens: 2000,
      };

      expect(() => createModel(config)).toThrow(
        "OPENAI_API_KEY environment variable is not set"
      );
    });

    it("should throw when Google API key is missing", () => {
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      const config: LLMConfig = {
        provider: "google",
        model: "gemini-pro",
        maxTokens: 2000,
      };

      expect(() => createModel(config)).toThrow(
        "GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY environment variable is not set"
      );
    });

    it("should throw when Mistral API key is missing", () => {
      delete process.env.MISTRAL_API_KEY;
      const config: LLMConfig = {
        provider: "mistral",
        model: "mistral-small",
        maxTokens: 2000,
      };

      expect(() => createModel(config)).toThrow(
        "MISTRAL_API_KEY environment variable is not set"
      );
    });

    it("should throw when OpenRouter API key is missing", () => {
      delete process.env.OPENROUTER_API_KEY;
      const config: LLMConfig = {
        provider: "openrouter",
        model: "openai/gpt-4o-mini",
        maxTokens: 2000,
      };

      expect(() => createModel(config)).toThrow(
        "OPENROUTER_API_KEY environment variable is not set"
      );
    });

    it("should throw when provider is unsupported at runtime", () => {
      const config: LLMConfig = {
        provider: "unsupported-provider" as LLMProvider,
        model: "model-id",
        maxTokens: 1000,
      };

      expect(() => createModel(config)).toThrow(
        "Unsupported LLM provider: unsupported-provider",
      );
    });

    it("should create Anthropic model when API key is set", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
      const config: LLMConfig = {
        provider: "anthropic",
        model: "claude-3-haiku",
        maxTokens: 2000,
      };

      const model = createModel(config);

      expect(model).toBeDefined();
      expect(model.modelId).toBe("claude-3-haiku");
    });

    it("should create OpenAI model when API key is set", () => {
      process.env.OPENAI_API_KEY = "sk-test-key";
      const config: LLMConfig = {
        provider: "openai",
        model: "gpt-4o-mini",
        maxTokens: 2000,
      };

      const model = createModel(config);

      expect(model).toBeDefined();
      expect(model.modelId).toBe("gpt-4o-mini");
    });

    it("should create Google model when API key is set", () => {
      process.env.GOOGLE_API_KEY = "google-test-key";
      const config: LLMConfig = {
        provider: "google",
        model: "gemini-pro",
        maxTokens: 2000,
      };

      const model = createModel(config);

      expect(model).toBeDefined();
      expect(model.modelId).toBe("gemini-pro");
    });

    it("should create Google model from GOOGLE_GENERATIVE_AI_API_KEY", () => {
      delete process.env.GOOGLE_API_KEY;
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-alt-test-key";
      const config: LLMConfig = {
        provider: "google",
        model: "gemini-pro",
        maxTokens: 2000,
      };

      const model = createModel(config);

      expect(model).toBeDefined();
      expect(model.modelId).toBe("gemini-pro");
    });

    it("should create Mistral model when API key is set", () => {
      process.env.MISTRAL_API_KEY = "mistral-test-key";
      const config: LLMConfig = {
        provider: "mistral",
        model: "mistral-small",
        maxTokens: 2000,
      };

      const model = createModel(config);

      expect(model).toBeDefined();
      expect(model.modelId).toBe("mistral-small");
    });

    it("should create OpenRouter model with official routing, attribution headers, and tool-based object generation", () => {
      process.env.OPENROUTER_API_KEY = "openrouter-test-key";
      const config: LLMConfig = {
        provider: "openrouter",
        model: "openai/gpt-4o-mini",
        maxTokens: 2000,
      };

      const model = createModel(config);

      expect(model).toBeDefined();
      expect(model.modelId).toBe("openai/gpt-4o-mini");
      expect(model.defaultObjectGenerationMode).toBe("tool");
      expect(createOpenRouter).toHaveBeenCalledWith({
        apiKey: "openrouter-test-key",
        compatibility: "strict",
        headers: {
          "HTTP-Referer": "https://github.com/hivemoot/hivemoot-bot",
          "X-OpenRouter-Title": "Hivemoot Bot",
          "X-Title": "Hivemoot Bot",
        },
      });
    });
  });

  describe("getLLMReadiness", () => {
    it("should return not_configured when provider is missing", () => {
      delete process.env.LLM_PROVIDER;
      delete process.env.LLM_MODEL;

      expect(getLLMReadiness()).toEqual({ ready: false, reason: "not_configured" });
    });

    it("should return not_configured for invalid provider", () => {
      process.env.LLM_PROVIDER = "invalid";
      process.env.LLM_MODEL = "some-model";

      expect(getLLMReadiness()).toEqual({ ready: false, reason: "not_configured" });
    });

    it("should return api_key_missing when provider+model set but key absent", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";
      delete process.env.ANTHROPIC_API_KEY;

      expect(getLLMReadiness()).toEqual({ ready: false, reason: "api_key_missing" });
    });

    it("should return api_key_missing for google when both key vars are absent", () => {
      process.env.LLM_PROVIDER = "google";
      process.env.LLM_MODEL = "gemini-pro";
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

      expect(getLLMReadiness()).toEqual({ ready: false, reason: "api_key_missing" });
    });

    it("should return api_key_missing for openrouter when key is absent", () => {
      process.env.LLM_PROVIDER = "openrouter";
      process.env.LLM_MODEL = "openai/gpt-4o-mini";
      delete process.env.OPENROUTER_API_KEY;

      expect(getLLMReadiness()).toEqual({ ready: false, reason: "api_key_missing" });
    });

    it("should return ready when provider, model, and key are present", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";

      expect(getLLMReadiness()).toEqual({ ready: true });
    });

    it("should return ready for google with GOOGLE_GENERATIVE_AI_API_KEY fallback", () => {
      process.env.LLM_PROVIDER = "google";
      process.env.LLM_MODEL = "gemini-pro";
      delete process.env.GOOGLE_API_KEY;
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-alt-key";

      expect(getLLMReadiness()).toEqual({ ready: true });
    });

    it("should treat whitespace-only API key as missing", () => {
      process.env.LLM_PROVIDER = "openai";
      process.env.LLM_MODEL = "gpt-4o-mini";
      process.env.OPENAI_API_KEY = "   ";

      expect(getLLMReadiness()).toEqual({ ready: false, reason: "api_key_missing" });
    });

    it("should return ready for openrouter when provider, model, and key are present", () => {
      process.env.LLM_PROVIDER = "openrouter";
      process.env.LLM_MODEL = "openai/gpt-4o-mini";
      process.env.OPENROUTER_API_KEY = "openrouter-key";

      expect(getLLMReadiness()).toEqual({ ready: true });
    });
  });

  describe("createModelFromEnv", () => {
    function encryptPayload(
      payload: Record<string, string>,
      masterKey: Buffer,
    ): { ciphertext: string; iv: string; tag: string } {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
      const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();

      return {
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
      };
    }

    function mockRedisLookup(result: string | null): void {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ result }),
      });
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    }

    it("should return null when LLM not configured", async () => {
      delete process.env.LLM_PROVIDER;
      delete process.env.LLM_MODEL;

      await expect(createModelFromEnv()).resolves.toBeNull();
    });

    it("should return model and config when configured", async () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";

      const result = await createModelFromEnv();

      expect(result).not.toBeNull();
      expect(result?.model).toBeDefined();
      expect(result?.model.modelId).toBe("claude-3-haiku");
      expect(result?.config.provider).toBe("anthropic");
      expect(result?.config.model).toBe("claude-3-haiku");
    });

    it("should return model and normalized config for gemini alias", async () => {
      process.env.LLM_PROVIDER = "Gemini";
      process.env.LLM_MODEL = "gemini-2.0-flash";
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-test";

      const result = await createModelFromEnv();

      expect(result).not.toBeNull();
      expect(result?.config.provider).toBe("google");
      expect(result?.config.model).toBe("gemini-2.0-flash");
    });

    it("should return null and warn when model creation fails (e.g. missing API key)", async () => {
      // Provider and model are set but API key is absent — createModel() would throw.
      // createModelFromEnv() must catch this and degrade to null so callers don't
      // need their own try-catch for BYOK or other config errors.
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_MODEL = "claude-3-haiku";
      delete process.env.ANTHROPIC_API_KEY;

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await createModelFromEnv();

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("createModelFromEnv: model creation failed, degrading to no-LLM")
      );

      warnSpy.mockRestore();
    });

    it("should resolve installation-scoped BYOK config from Redis", async () => {
      const masterKey = randomBytes(32);
      const { ciphertext, iv, tag } = encryptPayload(
        { apiKey: "sk-byok", provider: "openai", model: "gpt-4o-mini" },
        masterKey,
      );

      process.env.HIVEMOOT_REDIS_REST_URL = "https://example-redis.upstash.io";
      process.env.HIVEMOOT_REDIS_REST_TOKEN = "byok-token";
      process.env.BYOK_MASTER_KEYS = JSON.stringify({
        v1: masterKey.toString("hex"),
      });
      process.env.LLM_MAX_TOKENS = "2500";

      mockRedisLookup(
        JSON.stringify({
          ciphertext,
          iv,
          tag,
          keyVersion: "v1",
          status: "active",
        }),
      );

      const result = await createModelFromEnv({ installationId: 42 });
      expect(result).not.toBeNull();
      expect(result?.config.provider).toBe("openai");
      expect(result?.config.model).toBe("gpt-4o-mini");
      expect(result?.config.maxTokens).toBe(2500);
      expect(result?.model.modelId).toBe("gpt-4o-mini");

      const fetchMock = vi.mocked(fetch);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        "https://example-redis.upstash.io/get/hive%3Abyok%3A42",
      );
    });

    it("should route installation-scoped OpenRouter BYOK config through the official provider", async () => {
      const masterKey = randomBytes(32);
      const { ciphertext, iv, tag } = encryptPayload(
        { apiKey: "sk-openrouter", provider: "openrouter", model: "openai/gpt-4o-mini" },
        masterKey,
      );

      process.env.HIVEMOOT_REDIS_REST_URL = "https://example-redis.upstash.io";
      process.env.HIVEMOOT_REDIS_REST_TOKEN = "byok-token";
      process.env.BYOK_MASTER_KEYS = JSON.stringify({
        v1: masterKey.toString("hex"),
      });

      mockRedisLookup(
        JSON.stringify({
          ciphertext,
          iv,
          tag,
          keyVersion: "v1",
          status: "active",
        }),
      );

      const result = await createModelFromEnv({ installationId: 42 });

      expect(result).not.toBeNull();
      expect(result?.config.provider).toBe("openrouter");
      expect(result?.config.model).toBe("openai/gpt-4o-mini");
      expect(result?.model.modelId).toBe("openai/gpt-4o-mini");
      expect(result?.model.defaultObjectGenerationMode).toBe("tool");
      expect(createOpenRouter).toHaveBeenCalledWith({
        apiKey: "sk-openrouter",
        compatibility: "strict",
        headers: {
          "HTTP-Referer": "https://github.com/hivemoot/hivemoot-bot",
          "X-OpenRouter-Title": "Hivemoot Bot",
          "X-Title": "Hivemoot Bot",
        },
      });
    });

    it("should return null when BYOK record is missing for installation", async () => {
      process.env.HIVEMOOT_REDIS_REST_URL = "https://example-redis.upstash.io";
      process.env.HIVEMOOT_REDIS_REST_TOKEN = "byok-token";
      process.env.BYOK_MASTER_KEYS = JSON.stringify({
        v1: randomBytes(32).toString("hex"),
      });
      process.env.OPENAI_API_KEY = "shared-key-should-not-be-used";
      process.env.LLM_PROVIDER = "openai";
      process.env.LLM_MODEL = "gpt-4o-mini";

      mockRedisLookup(null);

      await expect(createModelFromEnv({ installationId: 42 })).resolves.toBeNull();
    });

    it("should throw when BYOK key version is unavailable", async () => {
      const masterKey = randomBytes(32);
      const { ciphertext, iv, tag } = encryptPayload(
        { apiKey: "sk-byok", provider: "openai", model: "gpt-4o-mini" },
        masterKey,
      );

      process.env.HIVEMOOT_REDIS_REST_URL = "https://example-redis.upstash.io";
      process.env.HIVEMOOT_REDIS_REST_TOKEN = "byok-token";
      process.env.BYOK_MASTER_KEYS = JSON.stringify({
        v2: randomBytes(32).toString("hex"),
      });

      mockRedisLookup(
        JSON.stringify({
          ciphertext,
          iv,
          tag,
          keyVersion: "v1",
          status: "active",
        }),
      );

      await expect(createModelFromEnv({ installationId: 42 })).rejects.toThrow(
        "BYOK key version 'v1' is unavailable",
      );
    });

    it("should throw when BYOK payload cannot be decrypted", async () => {
      process.env.HIVEMOOT_REDIS_REST_URL = "https://example-redis.upstash.io";
      process.env.HIVEMOOT_REDIS_REST_TOKEN = "byok-token";
      process.env.BYOK_MASTER_KEYS = JSON.stringify({
        v1: randomBytes(32).toString("hex"),
      });

      mockRedisLookup(
        JSON.stringify({
          ciphertext: "aW52YWxpZA==",
          iv: randomBytes(12).toString("base64"),
          tag: randomBytes(16).toString("base64"),
          keyVersion: "v1",
          status: "active",
        }),
      );

      await expect(createModelFromEnv({ installationId: 42 })).rejects.toThrow(
        "BYOK key material could not be decrypted",
      );
    });

    it("should throw when BYOK model is missing and LLM_MODEL is unset", async () => {
      const masterKey = randomBytes(32);
      const { ciphertext, iv, tag } = encryptPayload(
        { apiKey: "sk-byok", provider: "openai" },
        masterKey,
      );

      process.env.HIVEMOOT_REDIS_REST_URL = "https://example-redis.upstash.io";
      process.env.HIVEMOOT_REDIS_REST_TOKEN = "byok-token";
      process.env.BYOK_MASTER_KEYS = JSON.stringify({
        v1: masterKey.toString("hex"),
      });
      delete process.env.LLM_MODEL;

      mockRedisLookup(
        JSON.stringify({
          ciphertext,
          iv,
          tag,
          keyVersion: "v1",
          status: "active",
        }),
      );

      await expect(createModelFromEnv({ installationId: 42 })).rejects.toThrow(
        "BYOK record for installation 42 does not include a model and LLM_MODEL is not set",
      );
    });

    it("should throw when BYOK returns an unsupported provider at runtime", async () => {
      vi.resetModules();
      vi.doMock("./byok.js", () => ({
        resolveInstallationBYOKConfig: vi.fn().mockResolvedValue({
          provider: "unsupported-provider",
          model: "model-id",
          apiKey: "sk-byok",
        }),
      }));

      const { createModelFromEnv: createModelFromEnvWithMock } = await import("./provider.js");

      await expect(
        createModelFromEnvWithMock({ installationId: 42 }),
      ).rejects.toThrow("Unsupported LLM provider: unsupported-provider");

      vi.doUnmock("./byok.js");
    });
  });
});
