/**
 * LLM Provider Factory
 *
 * Creates LLM model instances using Vercel AI SDK.
 * Supports multiple providers via environment configuration.
 *
 * Environment Variables:
 * - LLM_PROVIDER: openai | anthropic | google | gemini | mistral | openrouter
 *     ("gemini" is accepted as an alias for "google")
 * - LLM_MODEL: Model name (e.g., claude-3-haiku-20240307, gpt-4o-mini, openai/gpt-4o-mini)
 * - ANTHROPIC_API_KEY / OPENAI_API_KEY / etc: Provider-specific API keys
 *     (Google accepts GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY)
 * - LLM_MAX_TOKENS: Optional requested output budget, defaults to 4096
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

import type { LLMConfig, LLMProvider, LLMReadiness } from "./types.js";
import { resolveInstallationBYOKConfig } from "./byok.js";
import { LLM_DEFAULTS } from "./types.js";
import { CONFIG_BOUNDS } from "../../config.js";
import { normalizeEnvString } from "./env.js";

export interface ModelResolutionOptions {
  installationId?: number;
}

// ───────────────────────────────────────────────────────────────────────────────
// Environment Parsing
// ───────────────────────────────────────────────────────────────────────────────

const PROVIDER_ALIASES: Readonly<Record<string, LLMProvider>> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  gemini: "google",
  mistral: "mistral",
  openrouter: "openrouter",
};

function normalizeProvider(provider: string | undefined): LLMProvider | undefined {
  const normalized = normalizeEnvString(provider, "LLM_PROVIDER")?.toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return PROVIDER_ALIASES[normalized];
}

/**
 * Check if LLM is configured (provider and model set).
 */
export function isLLMConfigured(): boolean {
  return getLLMConfig() !== null;
}

// Map each provider to its accepted API key env vars.
const API_KEY_VARS: Readonly<Record<LLMProvider, readonly string[]>> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
};

const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://github.com/hivemoot/hivemoot-bot",
  "X-OpenRouter-Title": "Hivemoot Bot",
  "X-Title": "Hivemoot Bot",
} as const;

function parseRequestedMaxTokensFromEnv(): number {
  const rawMaxTokens = normalizeEnvString(process.env.LLM_MAX_TOKENS, "LLM_MAX_TOKENS");
  const parsedMaxTokens = parseInt(rawMaxTokens ?? "", 10);
  const hasExplicitPositiveValue = Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0;

  if (hasExplicitPositiveValue) {
    const { min, max } = CONFIG_BOUNDS.llmMaxTokens;
    return Math.max(min, Math.min(max, parsedMaxTokens));
  }

  return LLM_DEFAULTS.maxTokens;
}

/**
 * Lightweight check for whether the provider's API key env var is present.
 * Does not instantiate any SDK client.
 */
function hasApiKey(provider: LLMProvider): boolean {
  return API_KEY_VARS[provider].some(
    (key) => !!normalizeEnvString(process.env[key])
  );
}

/**
 * Determine LLM readiness for health-check purposes.
 *
 * Returns `{ ready: true }` when provider, model, and API key are all present.
 * Otherwise returns a reason code — no secrets or internal details are exposed.
 */
export function getLLMReadiness(): LLMReadiness {
  const config = getLLMConfig();
  if (!config) {
    return { ready: false, reason: "not_configured" };
  }
  if (!hasApiKey(config.provider)) {
    return { ready: false, reason: "api_key_missing" };
  }
  return { ready: true };
}

/**
 * Get LLM configuration from environment variables.
 * Returns null if not configured.
 */
export function getLLMConfig(): LLMConfig | null {
  const provider = normalizeProvider(process.env.LLM_PROVIDER);
  const model = normalizeEnvString(process.env.LLM_MODEL, "LLM_MODEL");

  if (!provider || !model) {
    return null;
  }

  const maxTokens = parseRequestedMaxTokensFromEnv();

  return {
    provider,
    model,
    maxTokens,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Provider Factory
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Create a language model instance for the configured provider.
 *
 * @param config - LLM configuration
 * @returns LanguageModel instance
 * @throws Error if API key is missing for the provider
 */
function createModelWithApiKey(config: LLMConfig, apiKey: string): LanguageModel {
  switch (config.provider) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(config.model);
    }

    case "openai": {
      const openai = createOpenAI({ apiKey });
      return openai(config.model);
    }

    case "openrouter": {
      const openrouter = createOpenRouter({
        apiKey,
        compatibility: "strict",
        headers: OPENROUTER_HEADERS,
      });
      return openrouter.chat(config.model);
    }

    case "google": {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(config.model);
    }

    case "mistral": {
      const mistral = createMistral({ apiKey });
      return mistral(config.model);
    }

    default: {
      // TypeScript exhaustiveness check
      const _exhaustive: never = config.provider;
      throw new Error(`Unsupported LLM provider: ${_exhaustive}`);
    }
  }
}

function getApiKeyFromEnv(provider: LLMProvider): string {
  switch (provider) {
    case "anthropic": {
      const apiKey = normalizeEnvString(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY");
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY environment variable is not set");
      }
      return apiKey;
    }
    case "openai": {
      const apiKey = normalizeEnvString(process.env.OPENAI_API_KEY, "OPENAI_API_KEY");
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY environment variable is not set");
      }
      return apiKey;
    }
    case "google": {
      // GOOGLE_API_KEY takes priority for backward compat with existing deployments.
      // GOOGLE_GENERATIVE_AI_API_KEY is the AI SDK default, accepted as fallback
      // so users following Vercel AI SDK docs don't need a separate var.
      const apiKey =
        normalizeEnvString(process.env.GOOGLE_API_KEY, "GOOGLE_API_KEY") ??
        normalizeEnvString(process.env.GOOGLE_GENERATIVE_AI_API_KEY, "GOOGLE_GENERATIVE_AI_API_KEY");
      if (!apiKey) {
        throw new Error("GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY environment variable is not set");
      }
      return apiKey;
    }
    case "mistral": {
      const apiKey = normalizeEnvString(process.env.MISTRAL_API_KEY, "MISTRAL_API_KEY");
      if (!apiKey) {
        throw new Error("MISTRAL_API_KEY environment variable is not set");
      }
      return apiKey;
    }
    case "openrouter": {
      const apiKey = normalizeEnvString(process.env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY");
      if (!apiKey) {
        throw new Error("OPENROUTER_API_KEY environment variable is not set");
      }
      return apiKey;
    }
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported LLM provider: ${_exhaustive}`);
    }
  }
}

export function createModel(config: LLMConfig): LanguageModel {
  const apiKey = getApiKeyFromEnv(config.provider);
  return createModelWithApiKey(config, apiKey);
}

/**
 * Create a model from environment configuration.
 *
 * Without installation context: returns null if LLM is not configured or if
 * model creation fails (missing API key, unsupported provider). Degrades
 * gracefully so callers don't need their own try/catch.
 *
 * With installation context: resolves per-installation BYOK material from
 * Redis and does not fall back to shared env keys. Returns null when the
 * installation has no BYOK record. Throws on Redis/decryption failures so
 * callers can distinguish "no key" from "key resolution broken".
 */
export async function createModelFromEnv(
  options?: ModelResolutionOptions
): Promise<{ model: LanguageModel; config: LLMConfig } | null> {
  if (options?.installationId !== undefined) {
    const byokConfig = await resolveInstallationBYOKConfig(options.installationId);
    if (!byokConfig) {
      return null;
    }

    const model = byokConfig.model ?? normalizeEnvString(process.env.LLM_MODEL, "LLM_MODEL");
    if (!model) {
      throw new Error(
        `BYOK record for installation ${options.installationId} does not include a model and LLM_MODEL is not set`
      );
    }

    const config: LLMConfig = {
      provider: byokConfig.provider,
      model,
      maxTokens: parseRequestedMaxTokensFromEnv(),
    };

    return {
      model: createModelWithApiKey(config, byokConfig.apiKey),
      config,
    };
  }

  const config = getLLMConfig();
  if (!config) {
    return null;
  }

  try {
    return {
      model: createModel(config),
      config,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[llm] createModelFromEnv: model creation failed, degrading to no-LLM: ${message}`);
    return null;
  }
}
