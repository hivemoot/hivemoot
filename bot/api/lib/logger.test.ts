import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as core from "@actions/core";
import { createLogger, type Logger } from "./logger.js";

// Mock @actions/core
vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
}));

/**
 * Tests for Logger abstraction
 *
 * Verifies logging behavior in both:
 * - GitHub Actions environment (uses @actions/core)
 * - Local development environment (uses console)
 */

describe("logger", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("createLogger in GitHub Actions", () => {
    let logger: Logger;

    beforeEach(async () => {
      process.env.GITHUB_ACTIONS = "true";
      // Need to re-import to pick up the new env
      const loggerModule = await import("./logger.js");
      logger = loggerModule.createLogger();
    });

    it("should use @actions/core for info", () => {
      logger.info("test message");
      expect(core.info).toHaveBeenCalledWith("test message");
    });

    it("should use @actions/core warning for warn", () => {
      logger.warn("warning message");
      expect(core.warning).toHaveBeenCalledWith("warning message");
    });

    it("should use @actions/core error without Error object", () => {
      logger.error("error message");
      expect(core.error).toHaveBeenCalledWith("error message");
    });

    it("should use @actions/core error with Error object", () => {
      const error = new Error("test error");
      error.stack = "test stack";
      logger.error("error message", error);
      expect(core.error).toHaveBeenCalledWith("error message: test error");
      expect(core.debug).toHaveBeenCalledWith("test stack");
    });

    it("should use @actions/core error with Error without stack", () => {
      const error = new Error("test error");
      delete error.stack;
      logger.error("error message", error);
      expect(core.error).toHaveBeenCalledWith("error message: test error");
    });

    it("should use @actions/core for debug", () => {
      logger.debug("debug message");
      expect(core.debug).toHaveBeenCalledWith("debug message");
    });

    it("should use @actions/core startGroup for group", () => {
      logger.group("group name");
      expect(core.startGroup).toHaveBeenCalledWith("group name");
    });

    it("should use @actions/core endGroup for groupEnd", () => {
      logger.groupEnd();
      expect(core.endGroup).toHaveBeenCalled();
    });
  });

  describe("createLogger in local environment", () => {
    let logger: Logger;
    let consoleSpy: {
      log: ReturnType<typeof vi.spyOn>;
      warn: ReturnType<typeof vi.spyOn>;
      error: ReturnType<typeof vi.spyOn>;
      group: ReturnType<typeof vi.spyOn>;
      groupEnd: ReturnType<typeof vi.spyOn>;
    };

    beforeEach(async () => {
      delete process.env.GITHUB_ACTIONS;
      consoleSpy = {
        log: vi.spyOn(console, "log").mockImplementation(() => {}),
        warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
        error: vi.spyOn(console, "error").mockImplementation(() => {}),
        group: vi.spyOn(console, "group").mockImplementation(() => {}),
        groupEnd: vi.spyOn(console, "groupEnd").mockImplementation(() => {}),
      };
      const loggerModule = await import("./logger.js");
      logger = loggerModule.createLogger();
    });

    afterEach(() => {
      Object.values(consoleSpy).forEach((spy) => spy.mockRestore());
    });

    it("should use console.log for info", () => {
      logger.info("test message");
      expect(consoleSpy.log).toHaveBeenCalledWith("test message");
    });

    it("should use console.warn with emoji for warn", () => {
      logger.warn("warning message");
      expect(consoleSpy.warn).toHaveBeenCalledWith("⚠️  warning message");
    });

    it("should use console.error with emoji without Error object", () => {
      logger.error("error message");
      expect(consoleSpy.error).toHaveBeenCalledWith("❌ error message");
    });

    it("should use console.error with emoji and Error object", () => {
      const error = new Error("test error");
      logger.error("error message", error);
      expect(consoleSpy.error).toHaveBeenCalledWith("❌ error message:", error);
    });

    it("should not log debug when DEBUG env is not set", () => {
      delete process.env.DEBUG;
      logger.debug("debug message");
      expect(consoleSpy.log).not.toHaveBeenCalled();
    });

    it("should log debug when DEBUG env is set", async () => {
      process.env.DEBUG = "true";
      // Re-create logger to pick up env change
      const loggerModule = await import("./logger.js");
      const debugLogger = loggerModule.createLogger();
      debugLogger.debug("debug message");
      expect(consoleSpy.log).toHaveBeenCalledWith("🔍 debug message");
    });

    it("should use console.group for group", () => {
      logger.group("group name");
      expect(consoleSpy.group).toHaveBeenCalledWith("group name");
    });

    it("should use console.groupEnd for groupEnd", () => {
      logger.groupEnd();
      expect(consoleSpy.groupEnd).toHaveBeenCalled();
    });
  });

  describe("default logger export", () => {
    it("should export a logger instance", async () => {
      const loggerModule = await import("./logger.js");
      expect(loggerModule.logger).toBeDefined();
      expect(typeof loggerModule.logger.info).toBe("function");
      expect(typeof loggerModule.logger.warn).toBe("function");
      expect(typeof loggerModule.logger.error).toBe("function");
      expect(typeof loggerModule.logger.debug).toBe("function");
      expect(typeof loggerModule.logger.group).toBe("function");
      expect(typeof loggerModule.logger.groupEnd).toBe("function");
    });
  });
});
