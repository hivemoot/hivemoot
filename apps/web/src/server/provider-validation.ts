/**
 * Lightweight provider API key validation.
 *
 * Makes a minimal test call to verify the key is accepted by the provider.
 * No key material is included in error messages or logs.
 */

type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

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
  switch (provider) {
    case "anthropic":
      return validateAnthropic(apiKey);
    case "openai":
      return validateOpenAI(apiKey);
    default:
      return { valid: false, reason: "Unsupported provider" };
  }
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
