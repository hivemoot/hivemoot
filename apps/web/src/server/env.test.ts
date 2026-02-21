import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateEnv } from "./env";

// process.env typed as mutable for test manipulation
type MutableEnv = Record<string, string | undefined>;

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
      delete env().HIVEMOOT_REDIS_URL;
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
      env().HIVEMOOT_REDIS_URL = "redis://localhost:6379";
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
      delete env().HIVEMOOT_REDIS_URL;
      delete env().GITHUB_APP_ID;
      delete env().GITHUB_APP_PRIVATE_KEY;
      delete env().GITHUB_CLIENT_ID;
      delete env().GITHUB_CLIENT_SECRET;
      delete env().BYOK_ACTIVE_KEY_VERSION;
      delete env().BYOK_MASTER_KEYS;
      delete env().NEXT_PUBLIC_SITE_URL;

      const result = validateEnv();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.missing).toEqual([
          "HIVEMOOT_REDIS_URL",
          "GITHUB_APP_ID",
          "GITHUB_APP_PRIVATE_KEY",
          "GITHUB_CLIENT_ID",
          "GITHUB_CLIENT_SECRET",
          "BYOK_ACTIVE_KEY_VERSION",
          "BYOK_MASTER_KEYS",
          "NEXT_PUBLIC_SITE_URL",
        ]);
      }
    });

    it("fails when some required vars are missing", () => {
      env().HIVEMOOT_REDIS_URL = "redis://prod:6379";
      env().GITHUB_APP_ID = "99";
      delete env().GITHUB_APP_PRIVATE_KEY;
      delete env().GITHUB_CLIENT_ID;
      delete env().GITHUB_CLIENT_SECRET;
      delete env().BYOK_ACTIVE_KEY_VERSION;
      delete env().BYOK_MASTER_KEYS;
      delete env().NEXT_PUBLIC_SITE_URL;

      const result = validateEnv();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.missing).toEqual([
          "GITHUB_APP_PRIVATE_KEY",
          "GITHUB_CLIENT_ID",
          "GITHUB_CLIENT_SECRET",
          "BYOK_ACTIVE_KEY_VERSION",
          "BYOK_MASTER_KEYS",
          "NEXT_PUBLIC_SITE_URL",
        ]);
      }
    });

    it("fails when NEXT_PUBLIC_SITE_URL is missing in production", () => {
      env().HIVEMOOT_REDIS_URL = "redis://prod:6379";
      env().GITHUB_APP_ID = "99";
      env().GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----";
      env().GITHUB_CLIENT_ID = "Iv1.test";
      env().GITHUB_CLIENT_SECRET = "secret";
      env().BYOK_ACTIVE_KEY_VERSION = "v1";
      env().BYOK_MASTER_KEYS = '{"v1":"' + "a".repeat(64) + '"}';

      delete env().NEXT_PUBLIC_SITE_URL;

      const result = validateEnv();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.missing).toContain("NEXT_PUBLIC_SITE_URL");
      }
    });

    it("succeeds when all required vars are present", () => {
      env().HIVEMOOT_REDIS_URL = "redis://prod:6379";
      env().GITHUB_APP_ID = "99";
      env().GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----";
      env().GITHUB_CLIENT_ID = "Iv1.test";
      env().GITHUB_CLIENT_SECRET = "secret";
      env().BYOK_ACTIVE_KEY_VERSION = "v1";
      env().BYOK_MASTER_KEYS = '{"v1":"' + "a".repeat(64) + '"}';

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
