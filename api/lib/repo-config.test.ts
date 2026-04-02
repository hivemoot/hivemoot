import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadRepositoryConfig, getDefaultConfig } from "./repo-config.js";
import {
  CONFIG_BOUNDS,
  MAX_PRS_PER_ISSUE,
  PR_STALE_THRESHOLD_DAYS,
} from "../config.js";
import { logger } from "./logger.js";

/**
 * Tests for repo-config.ts
 *
 * Verifies config loading from .github/hivemoot.yml, including:
 * - Valid config parsing (new format)
 * - Partial configs with defaults
 * - Missing files (404)
 * - Invalid YAML
 * - Boundary clamping
 * - requiredVoters (minCount/voters) and exits validation
 */

const MS = 60 * 1000;
// Helper to encode content as base64
function encodeBase64(content: string): string {
  return Buffer.from(content).toString("base64");
}

// Helper to create a mock Octokit client
function createMockOctokit(response: {
  data?: { type?: string; content?: string; encoding?: string };
  error?: { status: number; message: string };
}) {
  return {
    rest: {
      repos: {
        getContent: vi.fn().mockImplementation(() => {
          if (response.error) {
            const error = new Error(response.error.message) as Error & { status: number };
            error.status = response.error.status;
            return Promise.reject(error);
          }
          return Promise.resolve({ data: response.data });
        }),
      },
    },
  };
}

function getAutoVotingExit(
  exit: ReturnType<typeof getDefaultConfig>["governance"]["proposals"]["voting"]["exits"][number]
) {
  expect(exit.type).toBe("auto");
  if (exit.type !== "auto") {
    throw new Error("Expected an auto voting exit");
  }
  return exit;
}

function getAutoDiscussionExit(
  exit: ReturnType<typeof getDefaultConfig>["governance"]["proposals"]["discussion"]["exits"][number]
) {
  expect(exit.type).toBe("auto");
  if (exit.type !== "auto") {
    throw new Error("Expected an auto discussion exit");
  }
  return exit;
}

describe("repo-config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getDefaultConfig", () => {
    it("should return default values from env-derived config", () => {
      const defaults = getDefaultConfig();

      expect(defaults.governance.proposals.discussion.exits).toEqual([{ type: "manual" }]);
      expect(defaults.governance.proposals.discussion.durationMs).toBe(0);
      expect(defaults.governance.proposals.voting.exits).toEqual([{ type: "manual" }]);
      expect(defaults.governance.proposals.voting.durationMs).toBe(0);
      expect(defaults.governance.proposals.extendedVoting.exits).toEqual([{ type: "manual" }]);
      expect(defaults.governance.proposals.extendedVoting.durationMs).toBe(0);
    });

    it("should return null for pr (disabled by default)", () => {
      const defaults = getDefaultConfig();
      expect(defaults.governance.pr).toBeNull();
    });
  });

  describe("loadRepositoryConfig", () => {
    describe("new format config parsing", () => {
      it("should parse complete new format config with exits", async () => {
        const configYaml = `
version: 1
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: 30
          minReady: 3
          requiredReady:
            mode: all
            users:
              - seed-scout
              - seed-worker
        - type: auto
          afterMinutes: 120
    voting:
      exits:
        - type: auto
          afterMinutes: 15
          requires: unanimous
          minVoters: 3
          requiredVoters:
            mode: all
            voters:
              - seed-scout
              - seed-worker
        - type: auto
          afterMinutes: 60
          minVoters: 2
          requiredVoters:
            mode: any
            voters:
              - seed-scout
              - seed-worker
        - type: auto
          afterMinutes: 360
          minVoters: 3
          requiredVoters:
            mode: all
            voters:
              - seed-scout
              - seed-worker
  pr:
    staleDays: 3
    maxPRsPerIssue: 3
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.version).toBe(1);
        // Discussion exits parsed and sorted, durationMs from last exit
        // mode: "all" → minCount = users.length (backward compat)
        expect(config.governance.proposals.discussion.exits).toEqual([
          { type: "auto", afterMs: 30 * MS, minReady: 3, requiredReady: { minCount: 2, users: ["seed-scout", "seed-worker"] } },
          { type: "auto", afterMs: 120 * MS, minReady: 0, requiredReady: { minCount: 0, users: [] } },
        ]);
        expect(config.governance.proposals.discussion.durationMs).toBe(120 * MS);
        // mode: "all" → minCount = voters.length, mode: "any" → minCount = 1
        expect(config.governance.proposals.voting.exits).toEqual([
          { type: "auto", afterMs: 15 * MS, requires: "unanimous", minVoters: 3, requiredVoters: { minCount: 2, voters: ["seed-scout", "seed-worker"] } },
          { type: "auto", afterMs: 60 * MS, requires: "majority", minVoters: 2, requiredVoters: { minCount: 1, voters: ["seed-scout", "seed-worker"] } },
          { type: "auto", afterMs: 360 * MS, requires: "majority", minVoters: 3, requiredVoters: { minCount: 2, voters: ["seed-scout", "seed-worker"] } },
        ]);
        // durationMs derived from last exit
        expect(config.governance.proposals.voting.durationMs).toBe(360 * MS);
        expect(config.governance.proposals.extendedVoting.exits).toEqual([{ type: "manual" }]);
        expect(config.governance.proposals.extendedVoting.durationMs).toBe(0);
        expect(config.governance.pr.staleDays).toBe(3);
        expect(config.governance.pr.maxPRsPerIssue).toBe(3);
      });

      it("should default requiredVoters to minCount:0, voters:[] when not specified", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        // Default exit should inherit the default requiredVoters
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requiredVoters).toEqual({
          minCount: 0,
          voters: [],
        });
      });

      it("should convert mode: any to minCount: 1 (backward compat)", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
          requiredVoters:
            mode: any
            voters:
              - alice
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requiredVoters).toEqual({
          minCount: 1,
          voters: ["alice"],
        });
      });

      it("should default invalid mode to minCount = voters.length (backward compat)", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
          requiredVoters:
            mode: invalid
            voters:
              - alice
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        // Invalid mode defaults to "all" → minCount = voters.length
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requiredVoters.minCount).toBe(1);
      });

      it("should default to minCount = voters.length when neither minCount nor mode specified", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
          requiredVoters:
            voters:
              - alice
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requiredVoters.minCount).toBe(1);
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requiredVoters.voters).toEqual([
          "alice",
        ]);
      });

      it("should handle array shorthand for requiredVoters", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
          requiredVoters:
            - seed-scout
            - seed-worker
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requiredVoters).toEqual({
          minCount: 2,
          voters: ["seed-scout", "seed-worker"],
        });
      });

      it("should lowercase and deduplicate requiredVoters", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
          requiredVoters:
            mode: all
            voters:
              - Seed-Scout
              - seed-scout
              - SEED-WORKER
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requiredVoters.voters).toEqual(["seed-scout", "seed-worker"]);
      });

      it("should strip leading @ from requiredVoters entries", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
          requiredVoters:
            voters:
              - "@seed-scout"
              - "@Seed-Worker"
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requiredVoters.voters).toEqual(["seed-scout", "seed-worker"]);
      });

      it("should trim whitespace from requiredVoters entries", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
          requiredVoters:
            voters:
              - "  seed-scout  "
              - "seed-worker "
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requiredVoters.voters).toEqual(["seed-scout", "seed-worker"]);
      });

      it("should skip entries that are only @ or whitespace", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
          requiredVoters:
            voters:
              - "@"
              - "  "
              - valid-user
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requiredVoters.voters).toEqual(["valid-user"]);
      });

      it("should skip invalid GitHub usernames in requiredVoters", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
          requiredVoters:
            voters:
              - "-bad"
              - "bad-"
              - "bad..name"
              - "valid-user"
              - "also--bad"
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requiredVoters.voters).toEqual(["valid-user"]);
      });

      it("should skip requiredVoters entries that exceed max username length", async () => {
        const tooLong = "a".repeat(CONFIG_BOUNDS.requiredVoters.maxUsernameLength + 1);
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
          requiredVoters:
            voters:
              - ${tooLong}
              - valid-user
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requiredVoters.voters).toEqual(["valid-user"]);
      });

      it("should skip non-string entries in requiredVoters", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
          requiredVoters:
            voters:
              - valid-user
              - 123
              - ""
              - another-user
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requiredVoters.voters).toEqual(["valid-user", "another-user"]);
      });

    });

    describe("exits parsing", () => {
      it("should parse single exit and derive durationMs", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 120
          minVoters: 2
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits).toHaveLength(1);
        expect(config.governance.proposals.voting.exits[0]).toEqual({
          type: "auto",
          afterMs: 120 * MS,
          requires: "majority",
          minVoters: 2,
          requiredVoters: { minCount: 0, voters: [] },
        });
        expect(config.governance.proposals.voting.durationMs).toBe(120 * MS);
      });

      it("should default extendedVoting to manual when extendedVoting.exits is missing", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 120
          minVoters: 2
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.extendedVoting.exits).toEqual([{ type: "manual" }]);
        expect(config.governance.proposals.extendedVoting.durationMs).toBe(0);
      });

      it("should parse extendedVoting exits independently when configured", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
          minVoters: 2
    extendedVoting:
      exits:
        - type: auto
          afterMinutes: 120
          minVoters: 3
        - type: auto
          afterMinutes: 2880
          minVoters: 1
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.durationMs).toBe(60 * MS);
        expect(config.governance.proposals.extendedVoting.exits).toEqual([
          { type: "auto", afterMs: 120 * MS, requires: "majority", minVoters: 3, requiredVoters: { minCount: 0, voters: [] } },
          { type: "auto", afterMs: 2880 * MS, requires: "majority", minVoters: 1, requiredVoters: { minCount: 0, voters: [] } },
        ]);
        expect(config.governance.proposals.extendedVoting.durationMs).toBe(2880 * MS);
      });

      it("should sort multiple exits ascending by afterMinutes", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 360
        - type: auto
          afterMinutes: 15
        - type: auto
          afterMinutes: 60
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits).toHaveLength(3);
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).afterMs).toBe(15 * MS);
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[1]).afterMs).toBe(60 * MS);
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[2]).afterMs).toBe(360 * MS);
        // deadline = last exit
        expect(config.governance.proposals.voting.durationMs).toBe(360 * MS);
      });

      it("should preserve requires: unanimous", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 15
          requires: unanimous
        - type: auto
          afterMinutes: 360
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requires).toBe("unanimous");
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[1]).requires).toBe("majority");
      });

      it("should default missing requires to majority", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requires).toBe("majority");
      });

      it("should default invalid requires to majority", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
          requires: supermajority
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requires).toBe("majority");
      });

      it("should parse per-exit requiredVoters and minVoters", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
          minVoters: 5
          requiredVoters:
            mode: any
            voters:
              - alice
              - bob
        - type: auto
          afterMinutes: 360
          minVoters: 2
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requiredVoters).toEqual({
          minCount: 1,
          voters: ["alice", "bob"],
        });
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).minVoters).toBe(5);
        // Second exit: no requiredVoters specified, inherits default
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[1]).requiredVoters).toEqual({ minCount: 0, voters: [] });
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[1]).minVoters).toBe(2);
      });

      it("should allow different exits with different minVoters/requiredVoters", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 15
          requires: unanimous
          minVoters: 3
          requiredVoters:
            mode: all
            voters:
              - alice
              - bob
        - type: auto
          afterMinutes: 360
          minVoters: 1
          requiredVoters:
            mode: any
            voters:
              - alice
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).minVoters).toBe(3);
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requiredVoters.minCount).toBe(2); // mode: all → voters.length
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[1]).minVoters).toBe(1);
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[1]).requiredVoters.minCount).toBe(1); // mode: any → 1
      });

      it("should clamp exit afterMinutes per exit", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 0
        - type: auto
          afterMinutes: 999999999
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        const minMs = CONFIG_BOUNDS.phaseDurationMinutes.min * MS;
        const maxMs = CONFIG_BOUNDS.phaseDurationMinutes.max * MS;
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).afterMs).toBe(minMs);
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[1]).afterMs).toBe(maxMs);
      });

      it("should use manual exit for empty array", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits: []
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits).toEqual([{ type: "manual" }]);
        expect(config.governance.proposals.voting.durationMs).toBe(0);
      });

      it("should resolve mixed manual and auto voting exits to manual", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: manual
        - type: auto
          afterMinutes: 60
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits).toEqual([{ type: "manual" }]);
        expect(config.governance.proposals.voting.durationMs).toBe(0);
      });

      it("should skip voting exit entries with invalid type", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: invalid
        - type: auto
          afterMinutes: 60
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits).toHaveLength(1);
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).afterMs).toBe(60 * MS);
      });

      it("should skip non-object voting exit entries", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - "not-an-object"
        - type: auto
          afterMinutes: 60
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits).toHaveLength(1);
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).afterMs).toBe(60 * MS);
      });

      it("should fall back to manual when all voting exit entries are invalid", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: invalid
        - type: bogus
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits).toEqual([{ type: "manual" }]);
        expect(config.governance.proposals.voting.durationMs).toBe(0);
      });

      it("should collapse multiple manual voting exits to a single manual exit", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: manual
        - type: manual
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits).toEqual([{ type: "manual" }]);
        expect(config.governance.proposals.voting.durationMs).toBe(0);
      });

      it("should skip auto voting exit with missing afterMinutes", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
        - type: auto
          afterMinutes: 60
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.voting.exits).toHaveLength(1);
        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).afterMs).toBe(60 * MS);
      });
    });

    describe("discussion exits parsing", () => {
      it("should parse discussion exits with all fields", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: 30
          minReady: 3
          requiredReady:
            mode: all
            users:
              - seed-scout
              - seed-worker
              - seed-analyst
        - type: auto
          afterMinutes: 120
          minReady: 2
          requiredReady:
            mode: any
            users:
              - seed-scout
              - seed-worker
        - type: auto
          afterMinutes: 1440
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.discussion.exits).toEqual([
          { type: "auto", afterMs: 30 * MS, minReady: 3, requiredReady: { minCount: 3, users: ["seed-scout", "seed-worker", "seed-analyst"] } },
          { type: "auto", afterMs: 120 * MS, minReady: 2, requiredReady: { minCount: 1, users: ["seed-scout", "seed-worker"] } },
          { type: "auto", afterMs: 1440 * MS, minReady: 0, requiredReady: { minCount: 0, users: [] } },
        ]);
        expect(config.governance.proposals.discussion.durationMs).toBe(1440 * MS);
      });

      it("should default discussion to manual when no exits configured", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.discussion.exits).toEqual([{ type: "manual" }]);
        expect(config.governance.proposals.discussion.durationMs).toBe(0);
      });

      it("should default discussion to manual when exits are empty", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits: []
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.discussion.exits).toEqual([{ type: "manual" }]);
        expect(config.governance.proposals.discussion.durationMs).toBe(0);
      });

      it("should resolve mixed manual and auto discussion exits to manual", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: 30
        - type: manual
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.discussion.exits).toEqual([{ type: "manual" }]);
        expect(config.governance.proposals.discussion.durationMs).toBe(0);
      });

      it("should skip discussion exit entries with invalid type", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: invalid
        - type: auto
          afterMinutes: 60
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.discussion.exits).toHaveLength(1);
        expect(getAutoDiscussionExit(config.governance.proposals.discussion.exits[0]).afterMs).toBe(60 * MS);
      });

      it("should skip non-object discussion exit entries", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - "not-an-object"
        - type: auto
          afterMinutes: 60
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.discussion.exits).toHaveLength(1);
        expect(getAutoDiscussionExit(config.governance.proposals.discussion.exits[0]).afterMs).toBe(60 * MS);
      });

      it("should fall back to manual when all discussion exit entries are invalid", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: invalid
        - type: bogus
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.discussion.exits).toEqual([{ type: "manual" }]);
        expect(config.governance.proposals.discussion.durationMs).toBe(0);
      });

      it("should collapse multiple manual discussion exits to a single manual exit", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: manual
        - type: manual
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.discussion.exits).toEqual([{ type: "manual" }]);
        expect(config.governance.proposals.discussion.durationMs).toBe(0);
      });

      it("should skip auto discussion exit with missing afterMinutes", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: auto
        - type: auto
          afterMinutes: 60
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.discussion.exits).toHaveLength(1);
        expect(getAutoDiscussionExit(config.governance.proposals.discussion.exits[0]).afterMs).toBe(60 * MS);
      });

      it("should default minReady to 0 and requiredReady to empty when not specified", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: 60
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoDiscussionExit(config.governance.proposals.discussion.exits[0]).minReady).toBe(0);
        expect(getAutoDiscussionExit(config.governance.proposals.discussion.exits[0]).requiredReady).toEqual({ minCount: 0, users: [] });
      });

      it("should handle array shorthand for requiredReady", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: 60
          requiredReady:
            - alice
            - bob
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoDiscussionExit(config.governance.proposals.discussion.exits[0]).requiredReady).toEqual({
          minCount: 2,
          users: ["alice", "bob"],
        });
      });

      it("should convert mode: any to minCount: 1 for requiredReady (backward compat)", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: 60
          requiredReady:
            mode: any
            users:
              - alice
              - bob
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoDiscussionExit(config.governance.proposals.discussion.exits[0]).requiredReady).toEqual({
          minCount: 1,
          users: ["alice", "bob"],
        });
      });

      it("should parse explicit minCount for requiredReady", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: 60
          requiredReady:
            minCount: 3
            users:
              - alice
              - bob
              - charlie
              - dave
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoDiscussionExit(config.governance.proposals.discussion.exits[0]).requiredReady).toEqual({
          minCount: 3,
          users: ["alice", "bob", "charlie", "dave"],
        });
      });

      it("should clamp minCount to voters.length when too large", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: 60
          requiredReady:
            minCount: 10
            users:
              - alice
              - bob
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoDiscussionExit(config.governance.proposals.discussion.exits[0]).requiredReady.minCount).toBe(2);
      });

      it("should clamp minCount to 0 when negative", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: 60
          requiredReady:
            minCount: -1
            users:
              - alice
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoDiscussionExit(config.governance.proposals.discussion.exits[0]).requiredReady.minCount).toBe(0);
      });

      it("should sort discussion exits ascending by afterMs", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: 120
        - type: auto
          afterMinutes: 30
        - type: auto
          afterMinutes: 60
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        const afterMsValues = config.governance.proposals.discussion.exits.map((e) => getAutoDiscussionExit(e).afterMs);
        expect(afterMsValues).toEqual([30 * MS, 60 * MS, 120 * MS]);
      });

      it("should clamp discussion exit afterMinutes", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: -5
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoDiscussionExit(config.governance.proposals.discussion.exits[0]).afterMs).toBe(
          CONFIG_BOUNDS.phaseDurationMinutes.min * MS
        );
      });
    });

    describe("missing file handling", () => {
      it("should return null when config file not found (404)", async () => {
        const octokit = createMockOctokit({
          error: { status: 404, message: "Not Found" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config).toBeNull();
      });

      it("should return defaults for empty file", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(""),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config).toEqual(getDefaultConfig());
      });

      it("should return defaults when path is a directory", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "dir",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config).toEqual(getDefaultConfig());
      });
    });

    describe("invalid YAML handling", () => {
      it("should return defaults for invalid YAML syntax", async () => {
        const invalidYaml = `
governance:
  proposals:
    discussion:
      durationMinutes: 60
  - this is invalid
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(invalidYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config).toEqual(getDefaultConfig());
      });

      it("should return defaults when YAML is not an object", async () => {
        const arrayYaml = `
- item1
- item2
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(arrayYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config).toEqual(getDefaultConfig());
      });

      it("should return defaults when YAML is a string", async () => {
        const stringYaml = "just a string";
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(stringYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config).toEqual(getDefaultConfig());
      });
    });

    describe("invalid value types", () => {
      it("should ignore legacy discussion.durationMinutes and keep manual default", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      durationMinutes: "not a number"
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.discussion.exits).toEqual([{ type: "manual" }]);
        expect(config.governance.proposals.discussion.durationMs).toBe(0);
      });

      it("should return pr: null when governance exists but pr: section is absent", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: manual
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.pr).toBeNull();
      });

      it.each([
        ["string", "\"not-an-object\""],
        ["numeric", "42"],
        ["boolean", "true"],
      ])("should return pr: null without warnings when governance is a %s scalar", async (_type, governanceValue) => {
        const configYaml = `
governance: ${governanceValue}
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });
        const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

        try {
          const config = await loadRepositoryConfig(octokit, "owner", "repo");

          expect(config).not.toBeNull();
          expect(config?.governance.pr).toBeNull();
          expect(warnSpy).not.toHaveBeenCalled();
        } finally {
          warnSpy.mockRestore();
        }
      });

      it("should return pr config with stale cleanup disabled when pr: section is present but empty", async () => {
        const configYaml = `
governance:
  pr: {}
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.pr).not.toBeNull();
        expect(config.governance.pr!.staleDays).toBeNull();
        expect(config.governance.pr!.maxPRsPerIssue).toBe(MAX_PRS_PER_ISSUE);
        expect(config.governance.pr!.intake).toEqual([{ method: "auto" }]);
      });

      it("should keep stale cleanup disabled when staleDays is explicitly set to null", async () => {
        const configYaml = `
governance:
  pr:
    staleDays: null
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.pr).not.toBeNull();
        expect(config.governance.pr!.staleDays).toBeNull();
      });

      it("should keep stale cleanup disabled when other pr settings are configured without staleDays", async () => {
        const configYaml = `
governance:
  pr:
    maxPRsPerIssue: 5
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.pr).not.toBeNull();
        expect(config.governance.pr!.staleDays).toBeNull();
        expect(config.governance.pr!.maxPRsPerIssue).toBe(5);
      });

      it("should use default when staleDays is an object", async () => {
        const configYaml = `
governance:
  pr:
    staleDays:
      min: 1
      max: 10
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.pr.staleDays).toBe(PR_STALE_THRESHOLD_DAYS);
      });

      it("should use default when requiredVoters is a plain string", async () => {
        const configYaml = `
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 60
          requiredVoters: "not-valid"
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(getAutoVotingExit(config.governance.proposals.voting.exits[0]).requiredVoters).toEqual({ minCount: 0, voters: [] });
      });
    });

    describe("boundary clamping", () => {
      it("should clamp discussion exit afterMinutes below minimum to minimum", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: 0
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        const minMs = CONFIG_BOUNDS.phaseDurationMinutes.min * MS;
        expect(config.governance.proposals.discussion.durationMs).toBe(minMs);
        expect(getAutoDiscussionExit(config.governance.proposals.discussion.exits[0]).afterMs).toBe(minMs);
      });

      it("should clamp discussion exit afterMinutes above maximum to maximum", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: 999999999
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        const maxMs = CONFIG_BOUNDS.phaseDurationMinutes.max * MS;
        expect(config.governance.proposals.discussion.durationMs).toBe(maxMs);
        expect(getAutoDiscussionExit(config.governance.proposals.discussion.exits[0]).afterMs).toBe(maxMs);
      });

      it("should clamp staleDays to boundaries", async () => {
        const configYaml = `
governance:
  pr:
    staleDays: 0
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.pr.staleDays).toBe(CONFIG_BOUNDS.prStaleDays.min);
      });

      it("should clamp maxPRsPerIssue above maximum to maximum", async () => {
        const configYaml = `
governance:
  pr:
    maxPRsPerIssue: 100
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.pr.maxPRsPerIssue).toBe(CONFIG_BOUNDS.maxPRsPerIssue.max);
      });

      it("should allow values at exact boundaries", async () => {
        const configYaml = `
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: ${CONFIG_BOUNDS.phaseDurationMinutes.min}
  pr:
    staleDays: ${CONFIG_BOUNDS.prStaleDays.max}
    maxPRsPerIssue: ${CONFIG_BOUNDS.maxPRsPerIssue.min}
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.proposals.discussion.durationMs).toBe(
          CONFIG_BOUNDS.phaseDurationMinutes.min * MS
        );
        expect(config.governance.pr.staleDays).toBe(CONFIG_BOUNDS.prStaleDays.max);
        expect(config.governance.pr.maxPRsPerIssue).toBe(CONFIG_BOUNDS.maxPRsPerIssue.min);
      });

      it("should round non-integer staleDays to nearest integer", async () => {
        const configYaml = `
governance:
  pr:
    staleDays: 3.7
`;
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(configYaml),
            encoding: "base64",
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config.governance.pr.staleDays).toBe(4);
      });
    });

    describe("API error handling", () => {
      it("should return defaults on 403 forbidden error", async () => {
        const octokit = createMockOctokit({
          error: { status: 403, message: "Forbidden" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config).toEqual(getDefaultConfig());
      });

      it("should return defaults on 500 server error", async () => {
        const octokit = createMockOctokit({
          error: { status: 500, message: "Internal Server Error" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");

        expect(config).toEqual(getDefaultConfig());
      });
    });

    describe("trustedReviewers parsing", () => {
      it("should parse trustedReviewers as array of usernames", async () => {
        const configYaml = `
governance:
  pr:
    trustedReviewers:
      - alice
      - bob
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.trustedReviewers).toEqual(["alice", "bob"]);
      });

      it("should filter invalid entries from trustedReviewers", async () => {
        const configYaml = `
governance:
  pr:
    trustedReviewers:
      - alice
      - 123
      - ""
      - bob
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        // "123" is a valid username, "" is filtered, numeric 123 filtered as non-string
        expect(config.governance.pr.trustedReviewers).toContain("alice");
        expect(config.governance.pr.trustedReviewers).toContain("bob");
      });

      it("should default trustedReviewers to empty array when missing", async () => {
        const configYaml = `
governance:
  pr:
    staleDays: 5
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.trustedReviewers).toEqual([]);
      });

      it("should strip @ prefix and normalize to lowercase", async () => {
        const configYaml = `
governance:
  pr:
    trustedReviewers:
      - "@Alice"
      - BOB
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.trustedReviewers).toEqual(["alice", "bob"]);
      });
    });

    describe("intake parsing", () => {
      it("should parse intake with single update method", async () => {
        const configYaml = `
governance:
  pr:
    intake:
      - method: update
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.intake).toEqual([{ method: "update" }]);
      });

      it("should parse intake with update + approval methods", async () => {
        const configYaml = `
governance:
  pr:
    trustedReviewers:
      - alice
      - bob
    intake:
      - method: update
      - method: approval
        minApprovals: 1
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.intake).toEqual([
          { method: "update" },
          { method: "approval", minApprovals: 1 },
        ]);
      });

      it("should clamp minApprovals to [1, trustedReviewers.length]", async () => {
        const configYaml = `
governance:
  pr:
    trustedReviewers:
      - alice
      - bob
    intake:
      - method: approval
        minApprovals: 10
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.intake).toEqual([
          { method: "approval", minApprovals: 2 },
        ]);
      });

      it("should clamp minApprovals minimum to 1", async () => {
        const configYaml = `
governance:
  pr:
    trustedReviewers:
      - alice
    intake:
      - method: approval
        minApprovals: 0
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.intake).toEqual([
          { method: "approval", minApprovals: 1 },
        ]);
      });

      it("should default intake to [auto] when missing", async () => {
        const configYaml = `
governance:
  pr:
    staleDays: 5
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.intake).toEqual([{ method: "auto" }]);
      });

      it("should filter out invalid entries with warning", async () => {
        const configYaml = `
governance:
  pr:
    intake:
      - method: update
      - "invalid"
      - method: unknown_method
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.intake).toEqual([{ method: "update" }]);
      });

      it("should fall back to default when all entries are invalid", async () => {
        const configYaml = `
governance:
  pr:
    intake:
      - method: bogus
      - method: nope
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.intake).toEqual([{ method: "auto" }]);
      });

      it("should skip approval method with empty trustedReviewers", async () => {
        const configYaml = `
governance:
  pr:
    intake:
      - method: approval
        minApprovals: 1
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        // approval method skipped (empty trustedReviewers), falls back to default
        expect(config.governance.pr.intake).toEqual([{ method: "auto" }]);
      });

      it("should default minApprovals to 1 when not specified", async () => {
        const configYaml = `
governance:
  pr:
    trustedReviewers:
      - alice
    intake:
      - method: approval
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.intake).toEqual([
          { method: "approval", minApprovals: 1 },
        ]);
      });

      it("should fall back to default on empty intake array", async () => {
        const configYaml = `
governance:
  pr:
    intake: []
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.intake).toEqual([{ method: "auto" }]);
      });

      it("should parse intake with auto method", async () => {
        const configYaml = `
governance:
  pr:
    intake:
      - method: auto
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.intake).toEqual([{ method: "auto" }]);
      });

      it("should parse intake with auto + update methods", async () => {
        const configYaml = `
governance:
  pr:
    intake:
      - method: auto
      - method: update
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.intake).toEqual([
          { method: "auto" },
          { method: "update" },
        ]);
      });

      it("should parse intake with auto + approval methods", async () => {
        const configYaml = `
governance:
  pr:
    trustedReviewers:
      - alice
    intake:
      - method: auto
      - method: approval
        minApprovals: 1
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.intake).toEqual([
          { method: "auto" },
          { method: "approval", minApprovals: 1 },
        ]);
      });

      it("should fall back to default on non-array intake", async () => {
        const configYaml = `
governance:
  pr:
    intake: "update"
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.intake).toEqual([{ method: "auto" }]);
      });
    });

    describe("mergeReady parsing", () => {
      it("should default to null when mergeReady is not configured", async () => {
        const configYaml = `
governance:
  pr:
    staleDays: 5
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.mergeReady).toBeNull();
      });

      it("should parse mergeReady with minApprovals", async () => {
        const configYaml = `
governance:
  pr:
    trustedReviewers:
      - alice
      - bob
    mergeReady:
      minApprovals: 2
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.mergeReady).toEqual({ minApprovals: 2 });
      });

      it("should default minApprovals to 1 when not specified", async () => {
        const configYaml = `
governance:
  pr:
    trustedReviewers:
      - alice
    mergeReady: {}
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.mergeReady).toEqual({ minApprovals: 1 });
      });

      it("should clamp minApprovals to trustedReviewers.length", async () => {
        const configYaml = `
governance:
  pr:
    trustedReviewers:
      - alice
      - bob
    mergeReady:
      minApprovals: 10
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.mergeReady).toEqual({ minApprovals: 2 });
      });

      it("should clamp minApprovals minimum to 1", async () => {
        const configYaml = `
governance:
  pr:
    trustedReviewers:
      - alice
    mergeReady:
      minApprovals: 0
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.mergeReady).toEqual({ minApprovals: 1 });
      });

      it("should disable feature when trustedReviewers is empty", async () => {
        const configYaml = `
governance:
  pr:
    mergeReady:
      minApprovals: 1
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.mergeReady).toBeNull();
      });

      it("should disable feature when mergeReady is not an object", async () => {
        const configYaml = `
governance:
  pr:
    trustedReviewers:
      - alice
    mergeReady: "enabled"
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.mergeReady).toBeNull();
      });

      it("should disable feature when mergeReady is an array", async () => {
        const configYaml = `
governance:
  pr:
    trustedReviewers:
      - alice
    mergeReady:
      - minApprovals: 1
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.mergeReady).toBeNull();
      });

      it("should default minApprovals when value is not a number", async () => {
        const configYaml = `
governance:
  pr:
    trustedReviewers:
      - alice
    mergeReady:
      minApprovals: "one"
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config.governance.pr.mergeReady).toEqual({ minApprovals: 1 });
      });

      it("should return null pr in default config (PR workflows disabled)", () => {
        const defaults = getDefaultConfig();
        expect(defaults.governance.pr).toBeNull();
      });
    });

    describe("automerge config", () => {
      it("should return null automerge when automerge section is absent", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config).not.toBeNull();
        expect(config!.governance.pr).not.toBeNull();
        expect(config!.governance.pr!.automerge).toBeNull();
      });

      it("should return null automerge when enabled is false", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      enabled: false
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge).toBeNull();
      });

      it("should return null automerge when trustedReviewers is empty", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    automerge:
      enabled: true
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge).toBeNull();
      });

      it("should parse automerge with defaults when section is present", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice", "bob"]
    automerge:
      enabled: true
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        const automerge = config!.governance.pr!.automerge;
        expect(automerge).not.toBeNull();
        expect(automerge!.dryRun).toBe(true);
        expect(automerge!.requireChecks).toBe(true);
        expect(automerge!.maxFiles).toBe(5);
        expect(automerge!.maxChangedLines).toBe(80);
        expect(automerge!.minApprovals).toBe(2);
        expect(automerge!.allowedPaths).toEqual(["**/*.md", "**/*.txt", "docs/**"]);
        expect(automerge!.denyPaths).toContain("package.json");
        expect(automerge!.denyPaths).toContain(".github/**");
      });

      it("should parse custom paths", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      allowedPaths: ["**/*.yml", "config/**"]
      denyPaths: ["secrets/**"]
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        const automerge = config!.governance.pr!.automerge;
        expect(automerge!.allowedPaths).toEqual(["**/*.yml", "config/**"]);
        expect(automerge!.denyPaths).toEqual(["secrets/**"]);
      });

      it("should accept excludedPaths as an alias for denyPaths", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      excludedPaths: ["secrets/**", ".github/**"]
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        const automerge = config!.governance.pr!.automerge;
        expect(automerge!.denyPaths).toEqual(["secrets/**", ".github/**"]);
      });

      it("should prefer denyPaths when both denyPaths and excludedPaths are set", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      denyPaths: ["deny/**"]
      excludedPaths: ["excluded/**"]
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        const automerge = config!.governance.pr!.automerge;
        expect(automerge!.denyPaths).toEqual(["deny/**"]);
      });

      it("should parse dryRun as false", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      dryRun: false
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.dryRun).toBe(false);
      });

      it("should parse requireChecks as false", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      requireChecks: false
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.requireChecks).toBe(false);
      });

      it("should clamp maxFiles to bounds", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      maxFiles: 999
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.maxFiles).toBe(50);
      });

      it("should clamp maxChangedLines to bounds", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      maxChangedLines: 5000
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.maxChangedLines).toBe(1000);
      });

      it("should clamp minApprovals to trustedReviewers length", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      minApprovals: 5
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        // Only 1 trusted reviewer, so clamped to 1
        expect(config!.governance.pr!.automerge!.minApprovals).toBe(1);
      });

      it("should treat enabled as true by default when section is present", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      maxFiles: 10
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge).not.toBeNull();
        expect(config!.governance.pr!.automerge!.maxFiles).toBe(10);
      });

      it("should return null when enabled is non-boolean", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      enabled: "yes"
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge).toBeNull();
      });

      it("should use default when dryRun is non-boolean", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      dryRun: "yes"
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.dryRun).toBe(true);
      });

      it("should use default when requireChecks is non-boolean", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      requireChecks: "always"
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.requireChecks).toBe(true);
      });

      it("should use defaults when allowedPaths is not an array", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      allowedPaths: "**/*.md"
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.allowedPaths).toEqual(["**/*.md", "**/*.txt", "docs/**"]);
      });

      it("should filter out non-string entries from path patterns", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      allowedPaths: ["**/*.md", 42, "", "docs/**"]
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.allowedPaths).toEqual(["**/*.md", "docs/**"]);
      });

      it("should return null for non-object automerge value", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge: "yes"
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge).toBeNull();
      });

      it("should default mergeMethod to squash", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      enabled: true
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.mergeMethod).toBe("squash");
      });

      it("should parse mergeMethod: rebase", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      mergeMethod: rebase
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.mergeMethod).toBe("rebase");
      });

      it("should default mergeMethod to squash when invalid value provided", async () => {
        const octokit = createMockOctokit({
          data: {
            type: "file",
            content: encodeBase64(`
governance:
  pr:
    trustedReviewers: ["alice"]
    automerge:
      mergeMethod: fast-forward
`),
          },
        });

        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.mergeMethod).toBe("squash");
      });
    });

    describe("automerge.commitHeadline and automerge.commitBody", () => {
      it("should parse valid commitHeadline and commitBody strings", async () => {
        const configYaml = `
version: 1
governance:
  pr:
    trustedReviewers: [alice]
    automerge:
      dryRun: false
      allowedPaths: ["**/*.md"]
      commitHeadline: "Auto-merge: {{title}}"
      commitBody: "Merged via hivemoot automerge."
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });
        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.commitHeadline).toBe("Auto-merge: {{title}}");
        expect(config!.governance.pr!.automerge!.commitBody).toBe("Merged via hivemoot automerge.");
      });

      it("should accept empty string for commitBody (clears the body)", async () => {
        const configYaml = `
version: 1
governance:
  pr:
    trustedReviewers: [alice]
    automerge:
      dryRun: false
      allowedPaths: ["**/*.md"]
      commitBody: ""
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });
        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.commitBody).toBe("");
      });

      it("should ignore empty string commitHeadline and leave it undefined", async () => {
        const configYaml = `
version: 1
governance:
  pr:
    trustedReviewers: [alice]
    automerge:
      dryRun: false
      allowedPaths: ["**/*.md"]
      commitHeadline: ""
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });
        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.commitHeadline).toBeUndefined();
      });

      it("should ignore whitespace-only commitHeadline and leave it undefined", async () => {
        const configYaml = `
version: 1
governance:
  pr:
    trustedReviewers: [alice]
    automerge:
      dryRun: false
      allowedPaths: ["**/*.md"]
      commitHeadline: "   "
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });
        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.commitHeadline).toBeUndefined();
      });

      it("should trim leading/trailing whitespace from valid commitHeadline", async () => {
        const configYaml = `
version: 1
governance:
  pr:
    trustedReviewers: [alice]
    automerge:
      dryRun: false
      allowedPaths: ["**/*.md"]
      commitHeadline: "  Auto-merge: title  "
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });
        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.commitHeadline).toBe("Auto-merge: title");
      });

      it("should ignore non-string commitHeadline and leave it undefined", async () => {
        const configYaml = `
version: 1
governance:
  pr:
    trustedReviewers: [alice]
    automerge:
      dryRun: false
      allowedPaths: ["**/*.md"]
      commitHeadline: 42
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });
        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.commitHeadline).toBeUndefined();
      });

      it("should ignore non-string commitBody and leave it undefined", async () => {
        const configYaml = `
version: 1
governance:
  pr:
    trustedReviewers: [alice]
    automerge:
      dryRun: false
      allowedPaths: ["**/*.md"]
      commitBody: true
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });
        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.pr!.automerge!.commitBody).toBeUndefined();
      });
    });

    describe("proposals.discussion.autoGather", () => {
      it("should default to disabled when not configured", async () => {
        const configYaml = `version: 1\n`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });
        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.proposals.discussion.autoGather).toEqual({
          enabled: false,
          minNewComments: CONFIG_BOUNDS.autoGather.minNewComments.default,
          cooldownMinutes: CONFIG_BOUNDS.autoGather.cooldownMinutes.default,
        });
      });

      it("should default to disabled in getDefaultConfig", () => {
        const defaults = getDefaultConfig();
        expect(defaults.governance.proposals.discussion.autoGather.enabled).toBe(false);
      });

      it("should parse enabled auto-gather with custom values", async () => {
        const configYaml = `
version: 1
governance:
  proposals:
    discussion:
      autoGather:
        enabled: true
        minNewComments: 3
        cooldownMinutes: 30
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });
        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.proposals.discussion.autoGather).toEqual({
          enabled: true,
          minNewComments: 3,
          cooldownMinutes: 30,
        });
      });

      it("should use defaults for omitted fields when enabled", async () => {
        const configYaml = `
version: 1
governance:
  proposals:
    discussion:
      autoGather:
        enabled: true
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });
        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.proposals.discussion.autoGather.enabled).toBe(true);
        expect(config!.governance.proposals.discussion.autoGather.minNewComments).toBe(
          CONFIG_BOUNDS.autoGather.minNewComments.default
        );
        expect(config!.governance.proposals.discussion.autoGather.cooldownMinutes).toBe(
          CONFIG_BOUNDS.autoGather.cooldownMinutes.default
        );
      });

      it("should clamp minNewComments to bounds", async () => {
        const configYaml = `
version: 1
governance:
  proposals:
    discussion:
      autoGather:
        enabled: true
        minNewComments: 9999
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });
        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.proposals.discussion.autoGather.minNewComments).toBe(
          CONFIG_BOUNDS.autoGather.minNewComments.max
        );
      });

      it("should clamp cooldownMinutes to bounds", async () => {
        const configYaml = `
version: 1
governance:
  proposals:
    discussion:
      autoGather:
        enabled: true
        cooldownMinutes: 0
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });
        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.proposals.discussion.autoGather.cooldownMinutes).toBe(
          CONFIG_BOUNDS.autoGather.cooldownMinutes.min
        );
      });

      it("should disable when enabled is not boolean", async () => {
        const configYaml = `
version: 1
governance:
  proposals:
    discussion:
      autoGather:
        enabled: "yes"
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });
        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.proposals.discussion.autoGather.enabled).toBe(false);
      });

      it("should disable when autoGather is not an object", async () => {
        const configYaml = `
version: 1
governance:
  proposals:
    discussion:
      autoGather: "invalid"
`;
        const octokit = createMockOctokit({
          data: { type: "file", content: encodeBase64(configYaml), encoding: "base64" },
        });
        const config = await loadRepositoryConfig(octokit, "owner", "repo");
        expect(config!.governance.proposals.discussion.autoGather.enabled).toBe(false);
      });
    });
  });
});
