import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateEnv } from "./env";

// process.env typed as mutable for test manipulation
type MutableEnv = Record<string, string | undefined>;
const ENCRYPTION_KEY_FORMAT_ERROR = "ENCRYPTION_KEY (must be 64 hex chars for AES-256-GCM)";

describe("validateEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv } as typeof process.env;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const env = () => process.env as MutableEnv;

  describe("in development", () => {
    it("returns ok when no vars are set", () => {
      delete env().NODE_ENV;
      delete env().REDIS_URL;
      delete env().GITHUB_APP_ID;

      const result = validateEnv();
      expect(result.ok).toBe(true);
    });

    it("defaults siteUrl to localhost", () => {
      delete env().NODE_ENV;
      delete env().NEXT_PUBLIC_SITE_URL;

      const result = validateEnv();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.siteUrl).toBe("http://localhost:3000");
      }
    });

    it("uses NEXT_PUBLIC_SITE_URL when set", () => {
      delete env().NODE_ENV;
      env().NEXT_PUBLIC_SITE_URL = "https://hivemoot.dev";

      const result = validateEnv();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.siteUrl).toBe("https://hivemoot.dev");
      }
    });

    it("passes through optional vars when present", () => {
      delete env().NODE_ENV;
      env().REDIS_URL = "redis://localhost:6379";
      env().GITHUB_APP_ID = "12345";

      const result = validateEnv();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.redisUrl).toBe("redis://localhost:6379");
        expect(result.config.githubAppId).toBe("12345");
      }
    });
  });

  describe("in production", () => {
    beforeEach(() => {
      env().NODE_ENV = "production";
    });

    it("fails when all required vars are missing", () => {
      delete env().REDIS_URL;
      delete env().GITHUB_APP_ID;
      delete env().GITHUB_APP_PRIVATE_KEY;
      delete env().GITHUB_CLIENT_ID;
      delete env().GITHUB_CLIENT_SECRET;
      delete env().ENCRYPTION_KEY;
      delete env().NEXT_PUBLIC_SITE_URL;

      const result = validateEnv();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.missing).toEqual([
          "REDIS_URL",
          "GITHUB_APP_ID",
          "GITHUB_APP_PRIVATE_KEY",
          "GITHUB_CLIENT_ID",
          "GITHUB_CLIENT_SECRET",
          "ENCRYPTION_KEY",
          "NEXT_PUBLIC_SITE_URL",
        ]);
      }
    });

    it("fails when some required vars are missing", () => {
      env().REDIS_URL = "redis://prod:6379";
      env().GITHUB_APP_ID = "99";
      delete env().GITHUB_APP_PRIVATE_KEY;
      delete env().GITHUB_CLIENT_ID;
      delete env().GITHUB_CLIENT_SECRET;
      delete env().ENCRYPTION_KEY;
      delete env().NEXT_PUBLIC_SITE_URL;

      const result = validateEnv();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.missing).toEqual([
          "GITHUB_APP_PRIVATE_KEY",
          "GITHUB_CLIENT_ID",
          "GITHUB_CLIENT_SECRET",
          "ENCRYPTION_KEY",
          "NEXT_PUBLIC_SITE_URL",
        ]);
      }
    });

    it("fails when NEXT_PUBLIC_SITE_URL is missing in production", () => {
      env().REDIS_URL = "redis://prod:6379";
      env().GITHUB_APP_ID = "99";
      env().GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----";
      env().GITHUB_CLIENT_ID = "Iv1.test";
      env().GITHUB_CLIENT_SECRET = "secret";
      env().ENCRYPTION_KEY = "a".repeat(64);
      delete env().NEXT_PUBLIC_SITE_URL;

      const result = validateEnv();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.missing).toContain("NEXT_PUBLIC_SITE_URL");
      }
    });

    it("fails when ENCRYPTION_KEY is not 64 hex chars", () => {
      env().REDIS_URL = "redis://prod:6379";
      env().GITHUB_APP_ID = "99";
      env().GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----";
      env().GITHUB_CLIENT_ID = "Iv1.test";
      env().GITHUB_CLIENT_SECRET = "secret";
      env().ENCRYPTION_KEY = "invalid-key";
      env().NEXT_PUBLIC_SITE_URL = "https://hivemoot.dev";

      const result = validateEnv();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.missing).toEqual([ENCRYPTION_KEY_FORMAT_ERROR]);
      }
    });

    it("succeeds when all required vars are present", () => {
      env().REDIS_URL = "redis://prod:6379";
      env().GITHUB_APP_ID = "99";
      env().GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----";
      env().GITHUB_CLIENT_ID = "Iv1.test";
      env().GITHUB_CLIENT_SECRET = "secret";
      env().ENCRYPTION_KEY = "a".repeat(64);
      env().NEXT_PUBLIC_SITE_URL = "https://hivemoot.dev";

      const result = validateEnv();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.nodeEnv).toBe("production");
        expect(result.config.redisUrl).toBe("redis://prod:6379");
        expect(result.config.githubClientId).toBe("Iv1.test");
        expect(result.config.siteUrl).toBe("https://hivemoot.dev");
      }
    });
  });
});
