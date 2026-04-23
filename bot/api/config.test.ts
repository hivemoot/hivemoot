import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SIGNATURES, parseMetadata, NOTIFICATION_TYPES, type NotificationMetadata } from "./lib/bot-comments.js";
import { isLabelMatch, getLabelQueryAliases, LEGACY_LABEL_MAP, LABELS } from "./config.js";

/**
 * Tests for config.ts
 *
 * These tests verify environment variable parsing behavior,
 * particularly the handling of invalid/non-numeric values
 * and the validation bounds (1 minute to 30 days).
 */

describe("config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset module cache to allow re-importing with different env vars
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("phase duration parsing", () => {
    it("should use default duration when env var is undefined", async () => {
      delete process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES;
      delete process.env.HIVEMOOT_VOTING_DURATION_MINUTES;

      const config = await import("./config.js");

      // Default is 24 hours = 24 * 60 minutes = 1440 minutes = 86,400,000 ms
      const expectedMs = 24 * 60 * 60 * 1000;
      expect(config.DISCUSSION_DURATION_MS).toBe(expectedMs);
      expect(config.VOTING_DURATION_MS).toBe(expectedMs);
    });

    it("should parse valid numeric env var", async () => {
      process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES = "30";
      process.env.HIVEMOOT_VOTING_DURATION_MINUTES = "60";

      const config = await import("./config.js");

      expect(config.DISCUSSION_DURATION_MS).toBe(30 * 60 * 1000);
      expect(config.VOTING_DURATION_MS).toBe(60 * 60 * 1000);
    });

    it("should fall back to default for invalid non-numeric env var", async () => {
      process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES = "invalid";
      process.env.HIVEMOOT_VOTING_DURATION_MINUTES = "abc123";

      const config = await import("./config.js");

      // Should use default (24 hours) instead of NaN
      const expectedMs = 24 * 60 * 60 * 1000;
      expect(config.DISCUSSION_DURATION_MS).toBe(expectedMs);
      expect(config.VOTING_DURATION_MS).toBe(expectedMs);
    });

    it("should fall back to default for empty string env var", async () => {
      process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES = "";

      const config = await import("./config.js");

      const expectedMs = 24 * 60 * 60 * 1000;
      expect(config.DISCUSSION_DURATION_MS).toBe(expectedMs);
    });

    it("should clamp zero to minimum (1 minute)", async () => {
      process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES = "0";

      const config = await import("./config.js");

      // Zero should be clamped to minimum of 1 minute
      expect(config.DISCUSSION_DURATION_MS).toBe(1 * 60 * 1000);
    });

    it("should clamp negative values to minimum (1 minute)", async () => {
      process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES = "-100";

      const config = await import("./config.js");

      // Negative should be clamped to minimum of 1 minute
      expect(config.DISCUSSION_DURATION_MS).toBe(1 * 60 * 1000);
    });

    it("should clamp extremely large values to maximum (30 days)", async () => {
      // 999999999 minutes is way more than 30 days
      process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES = "999999999";

      const config = await import("./config.js");

      // Should be clamped to 30 days max
      const maxMinutes = 30 * 24 * 60; // 43200 minutes
      expect(config.DISCUSSION_DURATION_MS).toBe(maxMinutes * 60 * 1000);
    });

    it("should allow values at the boundaries", async () => {
      // Minimum: 1 minute
      process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES = "1";

      let config = await import("./config.js");
      expect(config.DISCUSSION_DURATION_MS).toBe(1 * 60 * 1000);

      // Reset and test maximum: 30 days = 43200 minutes
      vi.resetModules();
      process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES = "43200";

      config = await import("./config.js");
      expect(config.DISCUSSION_DURATION_MS).toBe(43200 * 60 * 1000);
    });
  });

  describe("voting comment signature", () => {
    it("should include SIGNATURES.VOTING in VOTING_START message", async () => {
      const config = await import("./config.js");

      expect(config.MESSAGES.VOTING_START).toContain(SIGNATURES.VOTING);
    });

    it("should list all four voting reactions in VOTING_START message", async () => {
      const config = await import("./config.js");

      expect(config.MESSAGES.VOTING_START).toContain("👍");
      expect(config.MESSAGES.VOTING_START).toContain("👎");
      expect(config.MESSAGES.VOTING_START).toContain("😕");
      expect(config.MESSAGES.VOTING_START).toContain("👀");
    });
  });

  describe("labels", () => {
    it("should export READY_TO_IMPLEMENT label (not ACCEPTED)", async () => {
      const config = await import("./config.js");

      expect(config.LABELS.READY_TO_IMPLEMENT).toBe("hivemoot:ready-to-implement");
      expect((config.LABELS as Record<string, string>).ACCEPTED).toBeUndefined();
    });

    it("should define metadata for all required repository labels", async () => {
      const config = await import("./config.js");

      const labelNames = new Set(config.REQUIRED_REPOSITORY_LABELS.map((label) => label.name));
      const allLabels = new Set([...Object.values(config.LABELS), ...Object.values(config.PRIORITY_LABELS)]);
      expect(labelNames).toEqual(allLabels);

      for (const label of config.REQUIRED_REPOSITORY_LABELS) {
        expect(label.color).toMatch(/^[0-9a-f]{6}$/);
        expect(label.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe("isLabelMatch", () => {
    it("should match canonical label names exactly", () => {
      expect(isLabelMatch("hivemoot:discussion", LABELS.DISCUSSION)).toBe(true);
      expect(isLabelMatch("hivemoot:voting", LABELS.VOTING)).toBe(true);
      expect(isLabelMatch("hivemoot:ready-to-implement", LABELS.READY_TO_IMPLEMENT)).toBe(true);
      expect(isLabelMatch("hivemoot:candidate", LABELS.IMPLEMENTATION)).toBe(true);
      expect(isLabelMatch("hivemoot:merge-ready", LABELS.MERGE_READY)).toBe(true);
    });

    it("should match legacy label names via LEGACY_LABEL_MAP", () => {
      expect(isLabelMatch("phase:discussion", LABELS.DISCUSSION)).toBe(true);
      expect(isLabelMatch("phase:voting", LABELS.VOTING)).toBe(true);
      expect(isLabelMatch("phase:extended-voting", LABELS.EXTENDED_VOTING)).toBe(true);
      expect(isLabelMatch("ready-to-implement", LABELS.READY_TO_IMPLEMENT)).toBe(true);
      expect(isLabelMatch("phase:ready-to-implement", LABELS.READY_TO_IMPLEMENT)).toBe(true);
      expect(isLabelMatch("rejected", LABELS.REJECTED)).toBe(true);
      expect(isLabelMatch("inconclusive", LABELS.INCONCLUSIVE)).toBe(true);
      expect(isLabelMatch("implementation", LABELS.IMPLEMENTATION)).toBe(true);
      expect(isLabelMatch("stale", LABELS.STALE)).toBe(true);
      expect(isLabelMatch("implemented", LABELS.IMPLEMENTED)).toBe(true);
      expect(isLabelMatch("needs:human", LABELS.NEEDS_HUMAN)).toBe(true);
      expect(isLabelMatch("merge-ready", LABELS.MERGE_READY)).toBe(true);
    });

    it("should return false for unrelated label names", () => {
      expect(isLabelMatch("bug", LABELS.DISCUSSION)).toBe(false);
      expect(isLabelMatch("enhancement", LABELS.VOTING)).toBe(false);
      expect(isLabelMatch("random-label", LABELS.IMPLEMENTATION)).toBe(false);
    });

    it("should return false for undefined name", () => {
      expect(isLabelMatch(undefined, LABELS.DISCUSSION)).toBe(false);
    });

    it("should return false when legacy name is compared against wrong canonical label", () => {
      // "phase:discussion" maps to LABELS.DISCUSSION, not LABELS.VOTING
      expect(isLabelMatch("phase:discussion", LABELS.VOTING)).toBe(false);
      expect(isLabelMatch("implementation", LABELS.STALE)).toBe(false);
    });
  });

  describe("getLabelQueryAliases", () => {
    it("should return canonical label as the first element", () => {
      const aliases = getLabelQueryAliases(LABELS.DISCUSSION);
      expect(aliases[0]).toBe(LABELS.DISCUSSION);
    });

    it("should include all legacy aliases for a canonical label", () => {
      const aliases = getLabelQueryAliases(LABELS.DISCUSSION);
      expect(aliases).toContain("phase:discussion");
      expect(aliases).toHaveLength(2); // canonical + one legacy
    });

    it("should include all legacy aliases for labels with multiple mappings", () => {
      // READY_TO_IMPLEMENT has two legacy aliases: "ready-to-implement" and "phase:ready-to-implement"
      const aliases = getLabelQueryAliases(LABELS.READY_TO_IMPLEMENT);
      expect(aliases).toContain(LABELS.READY_TO_IMPLEMENT);
      expect(aliases).toContain("ready-to-implement");
      expect(aliases).toContain("phase:ready-to-implement");
    });

    it("should return just the canonical name when no legacy aliases exist", () => {
      const aliases = getLabelQueryAliases("some-unknown-label");
      expect(aliases).toEqual(["some-unknown-label"]);
    });

    it("should return aliases for every canonical label", () => {
      for (const label of Object.values(LABELS)) {
        const aliases = getLabelQueryAliases(label);
        expect(aliases[0]).toBe(label);
        expect(aliases.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe("LEGACY_LABEL_MAP", () => {
    it("should map every legacy name to a valid LABELS value", () => {
      const validLabelValues = new Set(Object.values(LABELS));

      for (const [legacyName, canonicalName] of Object.entries(LEGACY_LABEL_MAP)) {
        expect(validLabelValues.has(canonicalName as typeof LABELS[keyof typeof LABELS])).toBe(true);
        // Sanity check: the legacy name must differ from the canonical name
        // (otherwise it wouldn't need a mapping)
        expect(legacyName).not.toBe(canonicalName);
      }
    });

    it("should cover all known legacy label names", () => {
      const expectedLegacyNames = [
        "phase:discussion",
        "phase:voting",
        "phase:extended-voting",
        "ready-to-implement",
        "phase:ready-to-implement",
        "rejected",
        "inconclusive",
        "implementation",
        "stale",
        "implemented",
        "needs:human",
        "merge-ready",
      ];

      for (const legacyName of expectedLegacyNames) {
        expect(LEGACY_LABEL_MAP).toHaveProperty(legacyName);
      }
    });

    it("should map to the correct canonical name for each legacy name", () => {
      expect(LEGACY_LABEL_MAP["phase:discussion"]).toBe(LABELS.DISCUSSION);
      expect(LEGACY_LABEL_MAP["phase:voting"]).toBe(LABELS.VOTING);
      expect(LEGACY_LABEL_MAP["phase:extended-voting"]).toBe(LABELS.EXTENDED_VOTING);
      expect(LEGACY_LABEL_MAP["ready-to-implement"]).toBe(LABELS.READY_TO_IMPLEMENT);
      expect(LEGACY_LABEL_MAP["phase:ready-to-implement"]).toBe(LABELS.READY_TO_IMPLEMENT);
      expect(LEGACY_LABEL_MAP["rejected"]).toBe(LABELS.REJECTED);
      expect(LEGACY_LABEL_MAP["inconclusive"]).toBe(LABELS.INCONCLUSIVE);
      expect(LEGACY_LABEL_MAP["implementation"]).toBe(LABELS.IMPLEMENTATION);
      expect(LEGACY_LABEL_MAP["stale"]).toBe(LABELS.STALE);
      expect(LEGACY_LABEL_MAP["implemented"]).toBe(LABELS.IMPLEMENTED);
      expect(LEGACY_LABEL_MAP["needs:human"]).toBe(LABELS.NEEDS_HUMAN);
      expect(LEGACY_LABEL_MAP["merge-ready"]).toBe(LABELS.MERGE_READY);
    });
  });

  describe("MESSAGES.votingStart", () => {
    it("should return basic voting message without priority", async () => {
      const config = await import("./config.js");

      const message = config.MESSAGES.votingStart();
      expect(message).toContain("# 🐝 Voting Phase");
      expect(message).not.toContain("PRIORITY");
      expect(message).not.toContain("priority");
      expect(message).toContain(SIGNATURES.VOTING);
      expect(message).toContain("👍");
      expect(message).toContain("👎");
      expect(message).toContain("😕");
      expect(message).toContain("👀");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should include HIGH PRIORITY header and reminder for high priority", async () => {
      const config = await import("./config.js");

      const message = config.MESSAGES.votingStart("high");
      expect(message).toContain("# 🐝 Voting Phase (HIGH PRIORITY)");
      expect(message).toContain("**high-priority**");
      expect(message).toContain("timely vote is appreciated");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should include MEDIUM PRIORITY header and reminder for medium priority", async () => {
      const config = await import("./config.js");

      const message = config.MESSAGES.votingStart("medium");
      expect(message).toContain("# 🐝 Voting Phase (MEDIUM PRIORITY)");
      expect(message).toContain("**medium-priority**");
      expect(message).toContain("timely vote is appreciated");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should include LOW PRIORITY header and reminder for low priority", async () => {
      const config = await import("./config.js");

      const message = config.MESSAGES.votingStart("low");
      expect(message).toContain("# 🐝 Voting Phase (LOW PRIORITY)");
      expect(message).toContain("**low-priority**");
      expect(message).toContain("timely vote is appreciated");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should still include all voting reactions when priority is set", async () => {
      const config = await import("./config.js");

      const message = config.MESSAGES.votingStart("high");
      expect(message).toContain("👍");
      expect(message).toContain("👎");
      expect(message).toContain("😕");
      expect(message).toContain("👀");
      expect(message).toContain(SIGNATURES.VOTING);
    });
  });

  describe("PR_MESSAGES", () => {
    it("should format issueNotReadyToImplement correctly", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.issueNotReadyToImplement(42);
      expect(message).toContain("Issue #42");
      expect(message).toContain("hasn't passed voting");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should format issueReadyNeedsUpdate correctly", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.issueReadyNeedsUpdate(42);
      expect(message).toContain("Issue #42");
      expect(message).toContain("opened before approval");
      expect(message).toContain("fresh post-vote signal");
      expect(message).toContain("trusted-reviewer approval requirements");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should format prNoRoomYet correctly", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.prNoRoomYet(2, [10, 11]);
      expect(message).toContain("2 active implementation PRs");
      expect(message).toContain("#10");
      expect(message).toContain("#11");
      expect(message).toContain("slot opens");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should format prSuperseded correctly", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.prSuperseded(123);
      expect(message).toContain("#123");
      expect(message).toContain("Implemented");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should format approvalReminder correctly", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.approvalReminder([1, 2, 3]);
      expect(message).toContain("3 competing implementations");
      expect(message).toContain("#1");
      expect(message).toContain("#2");
      expect(message).toContain("#3");
      expect(message).toContain("Review and approve");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should format prStaleWarning correctly", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.prStaleWarning(14, 7);
      expect(message).toContain("14 days");
      expect(message).toContain("7 days");
      expect(message).toContain("Stale Warning");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should format prStaleClosed correctly", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.prStaleClosed(21);
      expect(message).toContain("21 days");
      expect(message).toContain("Auto-Closed");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should embed notification metadata in IMPLEMENTATION_WELCOME", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.IMPLEMENTATION_WELCOME(42);

      expect(message).toContain("hivemoot-metadata:");

      const metadata = parseMetadata(message);
      expect(metadata?.type).toBe("notification");
      expect((metadata as NotificationMetadata)?.notificationType).toBe(NOTIFICATION_TYPES.IMPLEMENTATION_WELCOME);
      expect(metadata?.issueNumber).toBe(42);

      expect(message).toContain("Implementation PR");
      expect(message).toContain("#42");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should include priority in IMPLEMENTATION_WELCOME when provided", async () => {
      const config = await import("./config.js");

      const highMessage = config.PR_MESSAGES.IMPLEMENTATION_WELCOME(42, "high");
      expect(highMessage).toContain("# 🐝 Implementation PR (HIGH PRIORITY)");
      expect(highMessage).toContain("**high-priority**");
      expect(highMessage).toContain("timely implementation and review");

      const mediumMessage = config.PR_MESSAGES.IMPLEMENTATION_WELCOME(42, "medium");
      expect(mediumMessage).toContain("# 🐝 Implementation PR (MEDIUM PRIORITY)");
      expect(mediumMessage).toContain("**medium-priority**");

      const lowMessage = config.PR_MESSAGES.IMPLEMENTATION_WELCOME(42, "low");
      expect(lowMessage).toContain("# 🐝 Implementation PR (LOW PRIORITY)");
      expect(lowMessage).toContain("**low-priority**");
    });

    it("should not include priority in IMPLEMENTATION_WELCOME when not provided", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.IMPLEMENTATION_WELCOME(42);
      expect(message).not.toContain("PRIORITY");
      expect(message).not.toContain("priority");
      expect(message).toContain("# 🐝 Implementation PR");
    });

    it("should embed notification metadata in issueNewPR", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.issueNewPR(101, 3);

      expect(message).toContain("hivemoot-metadata:");

      const metadata = parseMetadata(message);
      expect(metadata?.type).toBe("notification");
      expect((metadata as NotificationMetadata)?.notificationType).toBe(NOTIFICATION_TYPES.ISSUE_NEW_PR);
      // issueNewPR uses prNumber as the reference number for dedup keying
      expect(metadata?.issueNumber).toBe(101);

      expect(message).toContain("#101");
      expect(message).toContain("3 competing implementations");
      expect(message).toContain(config.SIGNATURE);
    });

    it("should embed notification metadata in issueReadyToImplement", async () => {
      const config = await import("./config.js");

      const message = config.PR_MESSAGES.issueReadyToImplement(42, "agent-alice");

      // Should contain metadata tag
      expect(message).toContain("hivemoot-metadata:");

      // Should parse to notification type with correct fields
      const metadata = parseMetadata(message);
      expect(metadata?.type).toBe("notification");
      expect((metadata as NotificationMetadata)?.notificationType).toBe(NOTIFICATION_TYPES.VOTING_PASSED);
      expect(metadata?.issueNumber).toBe(42);

      // Content should still be present
      expect(message).toContain("is ready for implementation");
      expect(message).toContain("@agent-alice");
      expect(message).toContain(config.SIGNATURE);
    });
  });
});
