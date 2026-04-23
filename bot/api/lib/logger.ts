/**
 * Logging Abstraction
 *
 * Provides consistent logging across:
 * - GitHub Actions workflows (uses @actions/core)
 * - Local development (uses console)
 *
 * Automatically detects environment and uses appropriate output.
 */

import * as core from "@actions/core";

/**
 * Check if running in GitHub Actions environment
 */
const isGitHubActions = (): boolean => {
  return process.env.GITHUB_ACTIONS === "true";
};

/**
 * Logger interface for governance operations
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: Error): void;
  debug(message: string): void;
  group(name: string): void;
  groupEnd(): void;
}

/**
 * GitHub Actions logger using @actions/core
 */
class ActionsLogger implements Logger {
  info(message: string): void {
    core.info(message);
  }

  warn(message: string): void {
    core.warning(message);
  }

  error(message: string, error?: Error): void {
    if (error) {
      core.error(`${message}: ${error.message}`);
      if (error.stack) {
        core.debug(error.stack);
      }
    } else {
      core.error(message);
    }
  }

  debug(message: string): void {
    core.debug(message);
  }

  group(name: string): void {
    core.startGroup(name);
  }

  groupEnd(): void {
    core.endGroup();
  }
}

/**
 * Console logger for local development
 */
class ConsoleLogger implements Logger {
  info(message: string): void {
    console.log(message);
  }

  warn(message: string): void {
    console.warn(`⚠️  ${message}`);
  }

  error(message: string, error?: Error): void {
    if (error) {
      console.error(`❌ ${message}:`, error);
    } else {
      console.error(`❌ ${message}`);
    }
  }

  debug(message: string): void {
    if (process.env.DEBUG) {
      console.log(`🔍 ${message}`);
    }
  }

  group(name: string): void {
    console.group(name);
  }

  groupEnd(): void {
    console.groupEnd();
  }
}

/**
 * Create appropriate logger for current environment
 */
export function createLogger(): Logger {
  return isGitHubActions() ? new ActionsLogger() : new ConsoleLogger();
}

/**
 * Default logger instance
 */
export const logger = createLogger();
