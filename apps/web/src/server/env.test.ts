import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateEnv } from "./env";

describe("validateEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Isolate env mutations per test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("in development", () => {
    it("returns ok when no vars are set", () => {
      delete process.env.NODE_ENV;
      delete process.env.REDIS_URL;
      delete process.env.GITHUB_APP_ID;

      const result = validateEnv();
      expect(result.ok).toBe(true);
    });

    it("defaults siteUrl to localhost", () => {
      delete process.env.NODE_ENV;
      delete process.env.NEXT_PUBLIC_SITE_URL;

      const result = validateEnv();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.siteUrl).toBe("http://localhost:3000");
      }
    });

    it("uses NEXT_PUBLIC_SITE_URL when set", () => {
      delete process.env.NODE_ENV;
      process.env.NEXT_PUBLIC_SITE_URL = "https://hivemoot.dev";

      const result = validateEnv();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.siteUrl).toBe("https://hivemoot.dev");
      }
    });

    it("passes through optional vars when present", () => {
      delete process.env.NODE_ENV;
      process.env.REDIS_URL = "redis://localhost:6379";
      process.env.GITHUB_APP_ID = "12345";

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
      process.env.NODE_ENV = "production";
    });

    it("fails when all required vars are missing", () => {
      delete process.env.REDIS_URL;
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      delete process.env.ENCRYPTION_KEY;

      const result = validateEnv();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.missing).toEqual([
          "REDIS_URL",
          "GITHUB_APP_ID",
          "GITHUB_APP_PRIVATE_KEY",
          "ENCRYPTION_KEY",
        ]);
      }
    });

    it("fails when some required vars are missing", () => {
      process.env.REDIS_URL = "redis://prod:6379";
      process.env.GITHUB_APP_ID = "99";
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      delete process.env.ENCRYPTION_KEY;

      const result = validateEnv();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.missing).toEqual([
          "GITHUB_APP_PRIVATE_KEY",
          "ENCRYPTION_KEY",
        ]);
      }
    });

    it("succeeds when all required vars are present", () => {
      process.env.REDIS_URL = "redis://prod:6379";
      process.env.GITHUB_APP_ID = "99";
      process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----";
      process.env.ENCRYPTION_KEY = "a".repeat(64);

      const result = validateEnv();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.nodeEnv).toBe("production");
        expect(result.config.redisUrl).toBe("redis://prod:6379");
      }
    });
  });
});
