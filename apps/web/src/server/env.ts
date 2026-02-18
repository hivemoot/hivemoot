/**
 * Environment variable validation.
 *
 * In development, most vars are optional so the app can start without a full
 * infrastructure stack. In production every required var must be present —
 * the app fails closed rather than falling back to defaults.
 */

interface EnvConfig {
  /** Redis connection string for BYOK key storage */
  redisUrl: string | undefined;
  /** GitHub App numeric ID */
  githubAppId: string | undefined;
  /** GitHub App private key (PEM) */
  githubAppPrivateKey: string | undefined;
  /** 32-byte hex string for AES-256-GCM envelope encryption */
  encryptionKey: string | undefined;
  /** Public-facing site URL */
  siteUrl: string;
  /** Current environment */
  nodeEnv: string;
}

const REQUIRED_IN_PRODUCTION = [
  "REDIS_URL",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "ENCRYPTION_KEY",
] as const;
const ENCRYPTION_KEY_PATTERN = /^[0-9a-f]{64}$/i;
const ENCRYPTION_KEY_FORMAT_ERROR = "ENCRYPTION_KEY (must be 64 hex chars for AES-256-GCM)";

export function validateEnv(): { ok: true; config: EnvConfig } | { ok: false; missing: string[] } {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const isProduction = nodeEnv === "production";

  if (isProduction) {
    const missing: string[] = REQUIRED_IN_PRODUCTION.filter((key) => !process.env[key]);
    const encryptionKey = process.env.ENCRYPTION_KEY;
    if (encryptionKey && !ENCRYPTION_KEY_PATTERN.test(encryptionKey)) {
      missing.push(ENCRYPTION_KEY_FORMAT_ERROR);
    }

    if (missing.length > 0) {
      return { ok: false, missing };
    }
  }

  return {
    ok: true,
    config: {
      redisUrl: process.env.REDIS_URL,
      githubAppId: process.env.GITHUB_APP_ID,
      githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY,
      encryptionKey: process.env.ENCRYPTION_KEY,
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
      nodeEnv,
    },
  };
}
