/**
 * Environment variable validation.
 *
 * In development, most vars are optional so the app can start without a full
 * infrastructure stack. In production every required var must be present —
 * the app fails closed rather than falling back to defaults.
 */

interface EnvConfig {
  /** Redis connection URL (redis:// or rediss://) */
  redisUrl: string | undefined;
  /** GitHub App numeric ID */
  githubAppId: string | undefined;
  /** GitHub App private key (PEM) */
  githubAppPrivateKey: string | undefined;
  /** GitHub App OAuth Client ID (Iv1.xxx) — for user OAuth flow */
  githubClientId: string | undefined;
  /** GitHub App OAuth Client Secret — for code exchange */
  githubClientSecret: string | undefined;
  /** Active master key version for new BYOK encryptions (e.g. "v1") */
  byokActiveKeyVersion: string | undefined;
  /** JSON keyring mapping version → 64-char hex key (e.g. {"v1":"abcd..."}) */
  byokMasterKeysJson: string | undefined;
  /** Public-facing site URL */
  siteUrl: string;
  /** Current environment */
  nodeEnv: string;
}

const REQUIRED_IN_PRODUCTION = [
  "HIVEMOOT_REDIS_URL",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "BYOK_ACTIVE_KEY_VERSION",
  "BYOK_MASTER_KEYS",
  "NEXT_PUBLIC_SITE_URL",
] as const;

export function validateEnv(): { ok: true; config: EnvConfig } | { ok: false; missing: string[] } {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const isProduction = nodeEnv === "production";

  if (isProduction) {
    const missing: string[] = REQUIRED_IN_PRODUCTION.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      return { ok: false, missing };
    }
  }

  return {
    ok: true,
    config: {
      redisUrl: process.env.HIVEMOOT_REDIS_URL,
      githubAppId: process.env.GITHUB_APP_ID,
      githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY,
      githubClientId: process.env.GITHUB_CLIENT_ID,
      githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
      byokActiveKeyVersion: process.env.BYOK_ACTIVE_KEY_VERSION,
      byokMasterKeysJson: process.env.BYOK_MASTER_KEYS,
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
      nodeEnv,
    },
  };
}
