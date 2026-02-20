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

const PROVIDER_VALIDATORS: Record<string, ProviderValidator> = {
  anthropic: validateAnthropic,
  openai: validateOpenAI,
};

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
    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });

    if (response.ok) return { valid: true };
    if (response.status === 401) return { valid: false, reason: "Invalid API key" };
    return { valid: false, reason: `Provider returned ${response.status}` };
  } catch {
    return { valid: false, reason: "Failed to reach Anthropic API" };
  }
}

async function validateOpenAI(apiKey: string): Promise<ValidationResult> {
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (response.ok) return { valid: true };
    if (response.status === 401) return { valid: false, reason: "Invalid API key" };
    return { valid: false, reason: `Provider returned ${response.status}` };
  } catch {
    return { valid: false, reason: "Failed to reach OpenAI API" };
  }
}
