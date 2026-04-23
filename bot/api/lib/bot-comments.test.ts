import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SIGNATURES,
  ERROR_CODES,
  NOTIFICATION_TYPES,
  parseMetadata,
  createVotingMetadata,
  createLeaderboardMetadata,
  createWelcomeMetadata,
  createAlignmentMetadata,
  createStatusMetadata,
  createHumanHelpMetadata,
  createNotificationMetadata,
  buildVotingComment,
  buildLeaderboardComment,
  buildDiscussionComment,
  buildAlignmentComment,
  buildHumanHelpComment,
  buildNotificationComment,
  isVotingComment,
  isLeaderboardComment,
  isAlignmentComment,
  isWelcomeComment,
  isHumanHelpComment,
  isNotificationComment,
  selectCurrentVotingComment,
  createStandupMetadata,
  generateMetadataTag,
  type CommentMetadata,
  type VotingMetadata,
  type HumanHelpMetadata,
  type NotificationMetadata,
  type StandupMetadata,
  type VotingCommentInfo,
} from "./bot-comments.js";

/**
 * Tests for Bot Comments Module
 *
 * Verifies:
 * - Signatures are defined correctly
 * - Metadata creation for all comment types
 * - Comment builders embed metadata properly
 * - Comment type detection works correctly
 * - Voting comment selection prioritizes by cycle
 */

const TEST_APP_ID = 12345;

describe("SIGNATURES", () => {
  it("should have VOTING signature", () => {
    expect(SIGNATURES.VOTING).toBe("React to THIS comment to vote");
  });

  it("should have LEADERBOARD signature", () => {
    expect(SIGNATURES.LEADERBOARD).toBe("# 🐝 Implementation Leaderboard 📊");
  });

  it("should have ALIGNMENT signature", () => {
    expect(SIGNATURES.ALIGNMENT).toBe("# 🐝 Blueprint");
  });

  it("should have HUMAN_HELP signature", () => {
    expect(SIGNATURES.HUMAN_HELP).toBe("# 🐝 Summoning the Humans");
  });
});

describe("createVotingMetadata", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should create metadata with correct structure", () => {
    const result = createVotingMetadata(42, 1);

    expect(result).toEqual({
      version: 1,
      type: "voting",
      cycle: 1,
      createdAt: "2024-01-20T12:00:00.000Z",
      issueNumber: 42,
    });
  });

  it("should track cycle number", () => {
    expect(createVotingMetadata(42, 1).cycle).toBe(1);
    expect(createVotingMetadata(42, 2).cycle).toBe(2);
    expect(createVotingMetadata(42, 3).cycle).toBe(3);
  });
});

describe("createLeaderboardMetadata", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should create metadata with correct structure", () => {
    const result = createLeaderboardMetadata(123);

    expect(result).toEqual({
      version: 1,
      type: "leaderboard",
      createdAt: "2024-01-20T12:00:00.000Z",
      issueNumber: 123,
    });
  });
});

describe("createWelcomeMetadata", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should create metadata with correct structure", () => {
    const result = createWelcomeMetadata(99);

    expect(result).toEqual({
      version: 1,
      type: "welcome",
      createdAt: "2024-01-20T12:00:00.000Z",
      issueNumber: 99,
    });
  });
});

describe("createAlignmentMetadata", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should create metadata with correct structure", () => {
    const result = createAlignmentMetadata(73);

    expect(result).toEqual({
      version: 1,
      type: "alignment",
      createdAt: "2024-01-20T12:00:00.000Z",
      issueNumber: 73,
    });
  });
});

describe("createStatusMetadata", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should create metadata with correct structure", () => {
    const result = createStatusMetadata(77);

    expect(result).toEqual({
      version: 1,
      type: "status",
      createdAt: "2024-01-20T12:00:00.000Z",
      issueNumber: 77,
    });
  });
});

describe("createHumanHelpMetadata", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should create metadata with correct structure", () => {
    const result = createHumanHelpMetadata(15, ERROR_CODES.VOTING_COMMENT_NOT_FOUND);

    expect(result).toEqual({
      version: 1,
      type: "error",
      errorCode: ERROR_CODES.VOTING_COMMENT_NOT_FOUND,
      createdAt: "2024-01-20T12:00:00.000Z",
      issueNumber: 15,
    });
  });

  it("should track different error codes", () => {
    expect(createHumanHelpMetadata(1, "ERR_A").errorCode).toBe("ERR_A");
    expect(createHumanHelpMetadata(1, "ERR_B").errorCode).toBe("ERR_B");
  });
});

describe("buildVotingComment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should embed metadata at start of comment", () => {
    const result = buildVotingComment("Vote content here", 42, 1);

    expect(result).toMatch(/^<!-- hivemoot-metadata:/);
    expect(result).toContain("Vote content here");
  });

  it("should include cycle in metadata", () => {
    const result = buildVotingComment("Content", 42, 3);

    expect(result).toContain('"cycle":3');
  });

  it("should include issue number in metadata", () => {
    const result = buildVotingComment("Content", 99, 1);

    expect(result).toContain('"issueNumber":99');
  });
});

describe("buildLeaderboardComment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should embed metadata at start of comment", () => {
    const result = buildLeaderboardComment("Leaderboard content", 42);

    expect(result).toMatch(/^<!-- hivemoot-metadata:/);
    expect(result).toContain("Leaderboard content");
  });

  it("should include type as leaderboard", () => {
    const result = buildLeaderboardComment("Content", 42);

    expect(result).toContain('"type":"leaderboard"');
  });
});

describe("buildHumanHelpComment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should embed metadata at start of comment", () => {
    const result = buildHumanHelpComment("Help needed content", 15, "TEST_ERROR");

    expect(result).toMatch(/^<!-- hivemoot-metadata:/);
    expect(result).toContain("Help needed content");
  });

  it("should include type as error", () => {
    const result = buildHumanHelpComment("Content", 15, "TEST_ERROR");

    expect(result).toContain('"type":"error"');
  });

  it("should include error code in metadata", () => {
    const result = buildHumanHelpComment("Content", 15, ERROR_CODES.VOTING_COMMENT_NOT_FOUND);

    expect(result).toContain(`"errorCode":"${ERROR_CODES.VOTING_COMMENT_NOT_FOUND}"`);
  });

  it("should include issue number in metadata", () => {
    const result = buildHumanHelpComment("Content", 42, "TEST_ERROR");

    expect(result).toContain('"issueNumber":42');
  });
});

describe("parseMetadata", () => {
  it("should parse valid voting metadata", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":2,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->
Some content`;

    const result = parseMetadata(body);

    expect(result).toEqual({
      version: 1,
      type: "voting",
      cycle: 2,
      createdAt: "2024-01-15T10:00:00.000Z",
      issueNumber: 42,
    });
  });

  it("should parse valid leaderboard metadata", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"leaderboard","createdAt":"2024-01-15T10:00:00.000Z","issueNumber":123} -->`;

    const result = parseMetadata(body);

    expect(result?.type).toBe("leaderboard");
    expect(result?.issueNumber).toBe(123);
  });

  it("should return null for body without metadata", () => {
    expect(parseMetadata("Regular comment")).toBeNull();
  });

  it("should return null for null body", () => {
    expect(parseMetadata(null)).toBeNull();
  });

  it("should return null for undefined body", () => {
    expect(parseMetadata(undefined)).toBeNull();
  });

  it("should return null for empty string", () => {
    expect(parseMetadata("")).toBeNull();
  });

  it("should return null for malformed JSON", () => {
    expect(parseMetadata("<!-- hivemoot-metadata: {invalid} -->")).toBeNull();
  });

  it("should return null for missing version field", () => {
    expect(parseMetadata('<!-- hivemoot-metadata: {"type":"voting"} -->')).toBeNull();
  });

  it("should return null for missing type field", () => {
    expect(parseMetadata('<!-- hivemoot-metadata: {"version":1} -->')).toBeNull();
  });

  it("should handle whitespace in comment", () => {
    const body = '<!--   hivemoot-metadata:   {"version":1,"type":"voting","createdAt":"2024-01-15T10:00:00.000Z","issueNumber":1}   -->';

    expect(parseMetadata(body)?.type).toBe("voting");
  });

  it("should ignore spoofed metadata with different prefix", () => {
    expect(parseMetadata('<!-- fake-metadata: {"version":1,"type":"voting"} -->')).toBeNull();
  });

  it("should return null for unknown type", () => {
    expect(parseMetadata('<!-- hivemoot-metadata: {"version":1,"type":"unknown-type","issueNumber":42} -->')).toBeNull();
  });

  it("should return null for notification with non-string notificationType", () => {
    expect(parseMetadata('<!-- hivemoot-metadata: {"version":1,"type":"notification","notificationType":123,"issueNumber":42} -->')).toBeNull();
  });

  it("should return null for notification with non-number issueNumber", () => {
    expect(parseMetadata('<!-- hivemoot-metadata: {"version":1,"type":"notification","notificationType":"voting-passed","issueNumber":"not-a-number"} -->')).toBeNull();
  });
});

describe("isVotingComment", () => {
  it("should return true for comment with voting metadata", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->
${SIGNATURES.VOTING}
Vote here`;

    expect(isVotingComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(true);
  });

  it("should return true for comment with voting metadata but no signature", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->
New voting format without old signature`;

    expect(isVotingComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(true);
  });

  it("should return false when metadata missing (signature alone not enough)", () => {
    const body = `${SIGNATURES.VOTING}
Vote here`;

    expect(isVotingComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false for wrong metadata type", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"leaderboard","createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->
${SIGNATURES.VOTING}`;

    expect(isVotingComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false when app ID doesn't match", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->`;
    expect(isVotingComment(body, TEST_APP_ID, 99999)).toBe(false);
  });

  it("should return false when performedViaAppId is null", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->`;
    expect(isVotingComment(body, TEST_APP_ID, null)).toBe(false);
  });

  it("should return false for null body", () => {
    expect(isVotingComment(null, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false for undefined body", () => {
    expect(isVotingComment(undefined, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false for malformed metadata", () => {
    const body = `<!-- hivemoot-metadata: {invalid-json} -->
${SIGNATURES.VOTING}`;

    expect(isVotingComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });
});

describe("isLeaderboardComment", () => {
  it("should return true for comment with leaderboard metadata", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"leaderboard","createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->
${SIGNATURES.LEADERBOARD}
| PR | Author | Approvals |`;

    expect(isLeaderboardComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(true);
  });

  it("should return true for comment with leaderboard metadata but no signature", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"leaderboard","createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->
New leaderboard format`;

    expect(isLeaderboardComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(true);
  });

  it("should return false when metadata missing (signature alone not enough)", () => {
    const body = `${SIGNATURES.LEADERBOARD}
| PR | Author | Approvals |`;

    expect(isLeaderboardComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false for wrong metadata type", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->
${SIGNATURES.LEADERBOARD}`;

    expect(isLeaderboardComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false when app ID doesn't match", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"leaderboard","createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->`;
    expect(isLeaderboardComment(body, TEST_APP_ID, 99999)).toBe(false);
  });

  it("should return false for null body", () => {
    expect(isLeaderboardComment(null, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false for undefined body", () => {
    expect(isLeaderboardComment(undefined, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });
});

describe("isAlignmentComment", () => {
  it("should return true for comment with alignment metadata", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"alignment","createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->
${SIGNATURES.ALIGNMENT}`;

    expect(isAlignmentComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(true);
  });

  it("should return false when metadata missing", () => {
    expect(isAlignmentComment(SIGNATURES.ALIGNMENT, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false for wrong metadata type", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"welcome","createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->`;
    expect(isAlignmentComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false when app ID doesn't match", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"alignment","createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->`;
    expect(isAlignmentComment(body, TEST_APP_ID, 99999)).toBe(false);
  });
});

describe("isWelcomeComment", () => {
  it("should return true for comment with welcome metadata", () => {
    const body = buildDiscussionComment("Welcome to hivemoot!", 42);
    expect(isWelcomeComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(true);
  });

  it("should return true for raw welcome metadata without body text", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"welcome","createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->`;
    expect(isWelcomeComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(true);
  });

  it("should return false when metadata missing", () => {
    expect(isWelcomeComment("plain text, no metadata", TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false for wrong metadata type", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->`;
    expect(isWelcomeComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false when app ID doesn't match", () => {
    const body = buildDiscussionComment("Welcome!", 42);
    expect(isWelcomeComment(body, TEST_APP_ID, 99999)).toBe(false);
  });

  it("should return false when performedViaAppId is null", () => {
    const body = buildDiscussionComment("Welcome!", 42);
    expect(isWelcomeComment(body, TEST_APP_ID, null)).toBe(false);
  });

  it("should return false for null body", () => {
    expect(isWelcomeComment(null, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false for undefined body", () => {
    expect(isWelcomeComment(undefined, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });
});

describe("isHumanHelpComment", () => {
  it("should return true for comment with error metadata", () => {
    const body = buildHumanHelpComment(
      `${SIGNATURES.HUMAN_HELP}\n\nI need help!`,
      15,
      ERROR_CODES.VOTING_COMMENT_NOT_FOUND
    );

    expect(isHumanHelpComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(true);
  });

  it("should return true for comment with error metadata but no signature", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"error","errorCode":"TEST_ERROR","createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->
New error format without old signature`;

    expect(isHumanHelpComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(true);
  });

  it("should return false when metadata missing (signature alone not enough)", () => {
    const body = `${SIGNATURES.HUMAN_HELP}\n\nNo metadata`;

    expect(isHumanHelpComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false for wrong metadata type", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->
${SIGNATURES.HUMAN_HELP}`;

    expect(isHumanHelpComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false when app ID doesn't match", () => {
    const body = buildHumanHelpComment("Content", 15, "TEST_ERROR");
    expect(isHumanHelpComment(body, TEST_APP_ID, 99999)).toBe(false);
  });

  it("should return false when performedViaAppId is null", () => {
    const body = buildHumanHelpComment("Content", 15, "TEST_ERROR");
    expect(isHumanHelpComment(body, TEST_APP_ID, null)).toBe(false);
  });

  it("should return false for null body", () => {
    expect(isHumanHelpComment(null, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false for undefined body", () => {
    expect(isHumanHelpComment(undefined, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  describe("with errorCode filter", () => {
    it("should return true when error code matches", () => {
      const body = buildHumanHelpComment(
        `${SIGNATURES.HUMAN_HELP}\n\nHelp!`,
        15,
        ERROR_CODES.VOTING_COMMENT_NOT_FOUND
      );

      expect(isHumanHelpComment(body, TEST_APP_ID, TEST_APP_ID, ERROR_CODES.VOTING_COMMENT_NOT_FOUND)).toBe(true);
    });

    it("should return false when error code doesn't match", () => {
      const body = buildHumanHelpComment(
        `${SIGNATURES.HUMAN_HELP}\n\nHelp!`,
        15,
        ERROR_CODES.VOTING_COMMENT_NOT_FOUND
      );

      expect(isHumanHelpComment(body, TEST_APP_ID, TEST_APP_ID, "OTHER_ERROR")).toBe(false);
    });

    it("should return false when no metadata (cannot verify errorCode)", () => {
      const body = `${SIGNATURES.HUMAN_HELP}\n\nNo metadata`;

      expect(isHumanHelpComment(body, TEST_APP_ID, TEST_APP_ID, ERROR_CODES.VOTING_COMMENT_NOT_FOUND)).toBe(false);
    });
  });
});

describe("NOTIFICATION_TYPES", () => {
  it("should have VOTING_PASSED type", () => {
    expect(NOTIFICATION_TYPES.VOTING_PASSED).toBe("voting-passed");
  });
});

describe("createNotificationMetadata", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should create metadata with correct structure", () => {
    const result = createNotificationMetadata(42, NOTIFICATION_TYPES.VOTING_PASSED);

    expect(result).toEqual({
      version: 1,
      type: "notification",
      notificationType: "voting-passed",
      createdAt: "2024-01-20T12:00:00.000Z",
      issueNumber: 42,
    });
  });

  it("should set notificationType from parameter", () => {
    const result = createNotificationMetadata(1, NOTIFICATION_TYPES.VOTING_PASSED);
    expect(result.notificationType).toBe(NOTIFICATION_TYPES.VOTING_PASSED);
  });
});

describe("buildNotificationComment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should embed metadata at start of comment", () => {
    const result = buildNotificationComment("Notification content", 42, "voting-passed");

    expect(result).toMatch(/^<!-- hivemoot-metadata:/);
    expect(result).toContain("Notification content");
  });

  it("should include type as notification", () => {
    const result = buildNotificationComment("Content", 42, "voting-passed");

    expect(result).toContain('"type":"notification"');
  });

  it("should include notificationType in metadata", () => {
    const result = buildNotificationComment("Content", 42, NOTIFICATION_TYPES.VOTING_PASSED);

    expect(result).toContain(`"notificationType":"${NOTIFICATION_TYPES.VOTING_PASSED}"`);
  });

  it("should include issue number in metadata", () => {
    const result = buildNotificationComment("Content", 99, "voting-passed");

    expect(result).toContain('"issueNumber":99');
  });
});

describe("isNotificationComment", () => {
  it("should return true for comment with notification metadata", () => {
    const body = buildNotificationComment("Voting passed!", 42, NOTIFICATION_TYPES.VOTING_PASSED);

    expect(isNotificationComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(true);
  });

  it("should return false when metadata missing", () => {
    expect(isNotificationComment("Regular comment", TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false for wrong metadata type", () => {
    const body = `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->
Notification content`;

    expect(isNotificationComment(body, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false when app ID doesn't match", () => {
    const body = buildNotificationComment("Content", 42, "voting-passed");
    expect(isNotificationComment(body, TEST_APP_ID, 99999)).toBe(false);
  });

  it("should return false when performedViaAppId is null", () => {
    const body = buildNotificationComment("Content", 42, "voting-passed");
    expect(isNotificationComment(body, TEST_APP_ID, null)).toBe(false);
  });

  it("should return false for null body", () => {
    expect(isNotificationComment(null, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  it("should return false for undefined body", () => {
    expect(isNotificationComment(undefined, TEST_APP_ID, TEST_APP_ID)).toBe(false);
  });

  describe("with notificationType filter", () => {
    it("should return true when notification type matches", () => {
      const body = buildNotificationComment("Content", 42, NOTIFICATION_TYPES.VOTING_PASSED);

      expect(isNotificationComment(body, TEST_APP_ID, TEST_APP_ID, NOTIFICATION_TYPES.VOTING_PASSED)).toBe(true);
    });

    it("should return false when notification type doesn't match", () => {
      const body = buildNotificationComment("Content", 42, NOTIFICATION_TYPES.VOTING_PASSED);

      expect(isNotificationComment(body, TEST_APP_ID, TEST_APP_ID, "other-type")).toBe(false);
    });
  });

  describe("with issueNumber filter", () => {
    it("should return true when issue number matches", () => {
      const body = buildNotificationComment("Content", 42, NOTIFICATION_TYPES.VOTING_PASSED);

      expect(isNotificationComment(body, TEST_APP_ID, TEST_APP_ID, undefined, 42)).toBe(true);
    });

    it("should return false when issue number doesn't match", () => {
      const body = buildNotificationComment("Content", 42, NOTIFICATION_TYPES.VOTING_PASSED);

      expect(isNotificationComment(body, TEST_APP_ID, TEST_APP_ID, undefined, 99)).toBe(false);
    });
  });

  describe("with both filters", () => {
    it("should return true when both match", () => {
      const body = buildNotificationComment("Content", 42, NOTIFICATION_TYPES.VOTING_PASSED);

      expect(isNotificationComment(body, TEST_APP_ID, TEST_APP_ID, NOTIFICATION_TYPES.VOTING_PASSED, 42)).toBe(true);
    });

    it("should return false when notification type matches but issue doesn't", () => {
      const body = buildNotificationComment("Content", 42, NOTIFICATION_TYPES.VOTING_PASSED);

      expect(isNotificationComment(body, TEST_APP_ID, TEST_APP_ID, NOTIFICATION_TYPES.VOTING_PASSED, 99)).toBe(false);
    });
  });
});

describe("selectCurrentVotingComment", () => {
  it("should return null for empty array", () => {
    expect(selectCurrentVotingComment([])).toBeNull();
  });

  it("should return single comment", () => {
    const comments: VotingCommentInfo[] = [
      { id: 100, cycle: 1, createdAt: "2024-01-15T10:00:00.000Z" },
    ];

    expect(selectCurrentVotingComment(comments)?.id).toBe(100);
  });

  it("should return highest cycle comment", () => {
    const comments: VotingCommentInfo[] = [
      { id: 100, cycle: 1, createdAt: "2024-01-15T10:00:00.000Z" },
      { id: 200, cycle: 3, createdAt: "2024-01-20T10:00:00.000Z" },
      { id: 300, cycle: 2, createdAt: "2024-01-18T10:00:00.000Z" },
    ];

    expect(selectCurrentVotingComment(comments)?.id).toBe(200);
  });

  it("should prefer comments with cycle over those without", () => {
    const comments: VotingCommentInfo[] = [
      { id: 100, cycle: null, createdAt: "2024-01-25T10:00:00.000Z" },
      { id: 200, cycle: 1, createdAt: "2024-01-15T10:00:00.000Z" },
    ];

    expect(selectCurrentVotingComment(comments)?.id).toBe(200);
  });
});

describe("round-trip: build → parse", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should preserve voting metadata through round-trip", () => {
    const comment = buildVotingComment("Content", 42, 3);
    const parsed = parseMetadata(comment);

    expect(parsed?.type).toBe("voting");
    expect((parsed as VotingMetadata)?.cycle).toBe(3);
    expect(parsed?.issueNumber).toBe(42);
  });

  it("should preserve leaderboard metadata through round-trip", () => {
    const comment = buildLeaderboardComment("Content", 99);
    const parsed = parseMetadata(comment);

    expect(parsed?.type).toBe("leaderboard");
    expect(parsed?.issueNumber).toBe(99);
  });

  it("should preserve alignment metadata through round-trip", () => {
    const comment = buildAlignmentComment("Content", 88);
    const parsed = parseMetadata(comment);

    expect(parsed?.type).toBe("alignment");
    expect(parsed?.issueNumber).toBe(88);
  });

  it("should preserve human help metadata through round-trip", () => {
    const comment = buildHumanHelpComment("Content", 15, ERROR_CODES.VOTING_COMMENT_NOT_FOUND);
    const parsed = parseMetadata(comment);

    expect(parsed?.type).toBe("error");
    expect((parsed as HumanHelpMetadata)?.errorCode).toBe(ERROR_CODES.VOTING_COMMENT_NOT_FOUND);
    expect(parsed?.issueNumber).toBe(15);
  });

  it("should preserve notification metadata through round-trip", () => {
    const comment = buildNotificationComment("Content", 42, NOTIFICATION_TYPES.VOTING_PASSED);
    const parsed = parseMetadata(comment);

    expect(parsed?.type).toBe("notification");
    expect((parsed as NotificationMetadata)?.notificationType).toBe(NOTIFICATION_TYPES.VOTING_PASSED);
    expect(parsed?.issueNumber).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Discussion Comment Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("buildDiscussionComment", () => {
  it("should wrap content with welcome metadata", () => {
    const content = "# Discussion Phase\n\nWelcome!";
    const result = buildDiscussionComment(content, 42);

    expect(result).toContain("hivemoot-metadata:");
    expect(result).toContain('"type":"welcome"');
    expect(result).toContain('"issueNumber":42');
    expect(result).toContain(content);
  });

  it("should place metadata before content", () => {
    const content = "Test content";
    const result = buildDiscussionComment(content, 1);

    const metadataIndex = result.indexOf("<!--");
    const contentIndex = result.indexOf(content);
    expect(metadataIndex).toBeLessThan(contentIndex);
  });

  it("should preserve metadata through round-trip parsing", () => {
    const comment = buildDiscussionComment("Content", 99);
    const parsed = parseMetadata(comment);

    expect(parsed?.type).toBe("welcome");
    expect(parsed?.issueNumber).toBe(99);
    expect(parsed?.version).toBe(1);
  });
});

describe("buildAlignmentComment", () => {
  it("should wrap content with alignment metadata", () => {
    const content = "# 🐝 Blueprint\n\nInitial alignment placeholder.";
    const result = buildAlignmentComment(content, 42);

    expect(result).toContain("hivemoot-metadata:");
    expect(result).toContain('"type":"alignment"');
    expect(result).toContain('"issueNumber":42');
    expect(result).toContain(content);
  });

  it("should place metadata before content", () => {
    const content = "Test content";
    const result = buildAlignmentComment(content, 1);

    const metadataIndex = result.indexOf("<!--");
    const contentIndex = result.indexOf(content);
    expect(metadataIndex).toBeLessThan(contentIndex);
  });
});

describe("createStandupMetadata", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-07T00:05:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should create metadata with correct structure", () => {
    const result = createStandupMetadata(42, "2026-02-06", "hivemoot/colony");

    expect(result).toEqual({
      version: 1,
      type: "standup",
      day: 42,
      date: "2026-02-06",
      repo: "hivemoot/colony",
      createdAt: "2026-02-07T00:05:00.000Z",
      issueNumber: 0,
    });
  });

  it("should set issueNumber to 0", () => {
    const result = createStandupMetadata(1, "2026-01-01", "org/repo");
    expect(result.issueNumber).toBe(0);
  });
});

describe("parseMetadata with standup type", () => {
  it("should parse standup metadata", () => {
    const body = '<!-- hivemoot-metadata: {"version":1,"type":"standup","day":42,"date":"2026-02-06","repo":"hivemoot/colony","issueNumber":0,"createdAt":"2026-02-07T00:05:00Z"} -->';

    const result = parseMetadata(body);

    expect(result?.type).toBe("standup");
    expect((result as StandupMetadata).day).toBe(42);
    expect((result as StandupMetadata).date).toBe("2026-02-06");
    expect((result as StandupMetadata).repo).toBe("hivemoot/colony");
  });

  it("should reject standup metadata missing day field", () => {
    const body = '<!-- hivemoot-metadata: {"version":1,"type":"standup","date":"2026-02-06","repo":"hivemoot/colony","issueNumber":0,"createdAt":"2026-02-07T00:05:00Z"} -->';

    const result = parseMetadata(body);

    expect(result).toBeNull();
  });

  it("should reject standup metadata missing date field", () => {
    const body = '<!-- hivemoot-metadata: {"version":1,"type":"standup","day":42,"repo":"hivemoot/colony","issueNumber":0,"createdAt":"2026-02-07T00:05:00Z"} -->';

    const result = parseMetadata(body);

    expect(result).toBeNull();
  });

  it("should reject standup metadata missing repo field", () => {
    const body = '<!-- hivemoot-metadata: {"version":1,"type":"standup","day":42,"date":"2026-02-06","issueNumber":0,"createdAt":"2026-02-07T00:05:00Z"} -->';

    const result = parseMetadata(body);

    expect(result).toBeNull();
  });

  it("should round-trip standup metadata through generateMetadataTag", () => {
    const metadata = createStandupMetadata(42, "2026-02-06", "hivemoot/colony");
    const tag = generateMetadataTag(metadata);
    const parsed = parseMetadata(tag);

    expect(parsed?.type).toBe("standup");
    expect((parsed as StandupMetadata).day).toBe(42);
    expect((parsed as StandupMetadata).date).toBe("2026-02-06");
    expect((parsed as StandupMetadata).repo).toBe("hivemoot/colony");
  });
});
