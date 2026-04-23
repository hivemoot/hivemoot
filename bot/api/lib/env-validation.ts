/**
 * Environment Variable Validation
 *
 * Provides consistent validation of required environment variables
 * across webhooks and scheduled scripts.
 */

/**
 * Result of environment validation
 */
export interface EnvValidationResult {
  valid: boolean;
  missing: string[];
}

/**
 * Validated environment configuration
 */
export interface AppConfig {
  appId: number;
  privateKey: string;
  webhookSecret?: string;
}

/**
 * Required environment variables for GitHub App authentication
 */
const APP_REQUIRED_VARS = ["APP_ID"] as const;

/**
 * Private key can be provided via either name (Probot default or our standardized name)
 */
const PRIVATE_KEY_VARS = ["PRIVATE_KEY", "APP_PRIVATE_KEY"] as const;

/**
 * Check if private key is available (accepts either naming convention)
 */
export function hasPrivateKey(): boolean {
  return PRIVATE_KEY_VARS.some((key) => !!process.env[key]);
}

/**
 * Get private key value (checks both naming conventions)
 * Empty strings are treated as unset to be consistent with hasPrivateKey()
 */
export function getPrivateKey(): string | undefined {
  return process.env.PRIVATE_KEY || process.env.APP_PRIVATE_KEY || undefined;
}

/**
 * Validate that all required environment variables for the app are set.
 *
 * @param requireWebhookSecret - Whether WEBHOOK_SECRET is required (true for webhooks)
 */
export function validateEnv(requireWebhookSecret = false): EnvValidationResult {
  const missing: string[] = [];

  // Check required vars
  for (const varName of APP_REQUIRED_VARS) {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  }

  // Check for private key (accepts either naming convention)
  if (!hasPrivateKey()) {
    missing.push("PRIVATE_KEY or APP_PRIVATE_KEY");
  }

  // Check webhook secret if required
  if (requireWebhookSecret && !process.env.WEBHOOK_SECRET) {
    missing.push("WEBHOOK_SECRET");
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Get the App ID from environment variables.
 * Returns the numeric ID for API operations.
 *
 * @throws Error if APP_ID is missing or invalid
 */
export function getAppId(): number {
  const appIdStr = process.env.APP_ID;
  if (!appIdStr) {
    throw new Error("APP_ID environment variable is not set");
  }

  const appId = Number(appIdStr);
  if (isNaN(appId) || appId <= 0) {
    throw new Error(`APP_ID must be a positive number, got: ${appIdStr}`);
  }

  return appId;
}

/**
 * Validate private key format (basic PEM check)
 *
 * @throws Error if key doesn't appear to be PEM-encoded
 */
export function validatePrivateKeyFormat(key: string): void {
  if (!key.includes("-----BEGIN") || !key.includes("-----END")) {
    throw new Error(
      "Private key does not appear to be a valid PEM-encoded key"
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// App Configuration
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Get validated app configuration.
 * Throws descriptive errors if configuration is invalid.
 *
 * @param requireWebhookSecret - Whether WEBHOOK_SECRET is required
 * @throws Error with details about missing/invalid configuration
 */
export function getAppConfig(requireWebhookSecret = false): AppConfig {
  const validation = validateEnv(requireWebhookSecret);
  if (!validation.valid) {
    throw new Error(
      `Missing required environment variables: ${validation.missing.join(", ")}`
    );
  }

  const appId = getAppId();
  const privateKey = getPrivateKey();

  if (!privateKey) {
    // This should not happen after validateEnv passes, but TypeScript doesn't know that
    throw new Error("Private key is not set");
  }

  validatePrivateKeyFormat(privateKey);

  return {
    appId,
    privateKey,
    webhookSecret: process.env.WEBHOOK_SECRET,
  };
}
