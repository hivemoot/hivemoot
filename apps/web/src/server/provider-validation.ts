/**
 * Lightweight provider API key validation.
 *
 * Makes a minimal test call to verify the key is accepted by the provider.
 * No key material is included in error messages or logs.
 */

type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

type ProviderValidator = (apiKey: string) => Promise<ValidationResult>;

export const PROVIDER_VALIDATION_TIMEOUT_MS = 10_000;

const PROVIDER_VALIDATION_TIMEOUT_REASON = "Provider validation timed out";

const PROVIDER_VALIDATORS: Record<string, ProviderValidator> = {
  anthropic: validateAnthropic,
  openai: validateOpenAI,
  google: validateGoogle,
};

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_VALIDATION_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Tests whether the given API key is accepted by the provider.
 * Uses the lightest possible endpoint (model listing) to minimize cost.
 */
export async function validateProviderKey(
  provider: string,
  apiKey: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _model?: string,
): Promise<ValidationResult> {
  const validator = PROVIDER_VALIDATORS[provider];
  if (!validator) {
    const supportedProviders = Object.keys(PROVIDER_VALIDATORS).join(", ");
    return {
      valid: false,
      reason: `Unsupported provider. Supported providers: ${supportedProviders}`,
    };
  }
  return validator(apiKey);
}

async function validateAnthropic(apiKey: string): Promise<ValidationResult> {
  try {
    const response = await fetchWithTimeout("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });

    if (response.ok) return { valid: true };
    if (response.status === 401) return { valid: false, reason: "Invalid API key" };
    return { valid: false, reason: `Provider returned ${response.status}` };
  } catch (error) {
    if (isAbortError(error)) {
      return { valid: false, reason: PROVIDER_VALIDATION_TIMEOUT_REASON };
    }
    return { valid: false, reason: "Failed to reach Anthropic API" };
  }
}

async function validateOpenAI(apiKey: string): Promise<ValidationResult> {
  try {
    const response = await fetchWithTimeout("https://api.openai.com/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (response.ok) return { valid: true };
    if (response.status === 401) return { valid: false, reason: "Invalid API key" };
    return { valid: false, reason: `Provider returned ${response.status}` };
  } catch (error) {
    if (isAbortError(error)) {
      return { valid: false, reason: PROVIDER_VALIDATION_TIMEOUT_REASON };
    }
    return { valid: false, reason: "Failed to reach OpenAI API" };
  }
}

async function validateGoogle(apiKey: string): Promise<ValidationResult> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const response = await fetchWithTimeout(url, {});

    if (response.ok) return { valid: true };
    if (response.status === 400 || response.status === 403) {
      return { valid: false, reason: "Invalid API key" };
    }
    return { valid: false, reason: `Provider returned ${response.status}` };
  } catch (error) {
    if (isAbortError(error)) {
      return { valid: false, reason: PROVIDER_VALIDATION_TIMEOUT_REASON };
    }
    return { valid: false, reason: "Failed to reach Google AI API" };
  }
}
