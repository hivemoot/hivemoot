import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LeaderboardService,
  createLeaderboardService,
  formatLeaderboard,
  type LeaderboardClient,
} from "./leaderboard.js";
import { SIGNATURE } from "../config.js";
import { SIGNATURES } from "./bot-comments.js";
import type { IssueRef, PRWithApprovals } from "./types.js";

/**
 * Tests for Leaderboard Service
 *
 * These tests verify the leaderboard functionality:
 * - Client validation
 * - Leaderboard formatting and sorting
 * - Finding existing leaderboard comments
 * - Creating and updating leaderboard comments
 */

const TEST_APP_ID = 12345;

/** Helper to create a mock leaderboard comment body with proper metadata */
function makeLeaderboardBody(content: string, issueNumber = 42): string {
  const metadata = {
    version: 1,
    type: "leaderboard",
    createdAt: "2024-01-15T10:00:00.000Z",
    issueNumber,
  };
  return `<!-- hivemoot-metadata: ${JSON.stringify(metadata)} -->\n${SIGNATURES.LEADERBOARD}\n${content}`;
}

describe("createLeaderboardService", () => {
  const createValidClient = () => ({
    rest: {
      issues: {
        listComments: vi.fn(),
        createComment: vi.fn(),
        updateComment: vi.fn(),
      },
    },
    paginate: {
      iterator: vi.fn(),
    },
  });

  it("should create LeaderboardService from valid client", () => {
    const validClient = createValidClient();
    const service = createLeaderboardService(validClient, { appId: TEST_APP_ID });
    expect(service).toBeInstanceOf(LeaderboardService);
  });

  it("should throw for null input", () => {
    expect(() => createLeaderboardService(null, { appId: TEST_APP_ID })).toThrow("Invalid GitHub client");
  });

  it("should throw for undefined input", () => {
    expect(() => createLeaderboardService(undefined, { appId: TEST_APP_ID })).toThrow("Invalid GitHub client");
  });

  it("should throw for object missing rest property", () => {
    expect(() => createLeaderboardService({ paginate: { iterator: vi.fn() } }, { appId: TEST_APP_ID })).toThrow(
      "Invalid GitHub client"
    );
  });

  it("should throw for object with null rest property", () => {
    expect(() => createLeaderboardService({ rest: null, paginate: { iterator: vi.fn() } }, { appId: TEST_APP_ID })).toThrow(
      "Invalid GitHub client"
    );
  });

  it("should throw for object missing rest.issues", () => {
    const invalidClient = {
      rest: {},
      paginate: { iterator: vi.fn() },
    };
    expect(() => createLeaderboardService(invalidClient, { appId: TEST_APP_ID })).toThrow("Invalid GitHub client");
  });

  it("should throw for object missing required issues methods", () => {
    const invalidClient = {
      rest: {
        issues: {
          listComments: vi.fn(),
          // missing createComment and updateComment
        },
      },
      paginate: { iterator: vi.fn() },
    };
    expect(() => createLeaderboardService(invalidClient, { appId: TEST_APP_ID })).toThrow("Invalid GitHub client");
  });

  it("should throw for object missing paginate.iterator", () => {
    const invalidClient = {
      rest: {
        issues: {
          listComments: vi.fn(),
          createComment: vi.fn(),
          updateComment: vi.fn(),
        },
      },
      paginate: {},
    };
    expect(() => createLeaderboardService(invalidClient, { appId: TEST_APP_ID })).toThrow("Invalid GitHub client");
  });
});

describe("formatLeaderboard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should sort by approvals descending", () => {
    const scores: PRWithApprovals[] = [
      { number: 1, title: "PR 1", author: "user1", approvals: 2 },
      { number: 2, title: "PR 2", author: "user2", approvals: 5 },
      { number: 3, title: "PR 3", author: "user3", approvals: 1 },
    ];

    const result = formatLeaderboard(scores);

    // PR #2 (5 approvals) should be first, then PR #1 (2), then PR #3 (1)
    const lines = result.split("\n");
    const dataLines = lines.filter((line) => line.startsWith("| #"));

    expect(dataLines[0]).toContain("#2");
    expect(dataLines[1]).toContain("#1");
    expect(dataLines[2]).toContain("#3");
  });

  it("should use PR number as tiebreaker (older/lower number first)", () => {
    const scores: PRWithApprovals[] = [
      { number: 5, title: "Newer PR", author: "user1", approvals: 3 },
      { number: 2, title: "Older PR", author: "user2", approvals: 3 },
      { number: 8, title: "Newest PR", author: "user3", approvals: 3 },
    ];

    const result = formatLeaderboard(scores);

    const lines = result.split("\n");
    const dataLines = lines.filter((line) => line.startsWith("| #"));

    // Same approvals, so sort by PR number ascending
    expect(dataLines[0]).toContain("#2");
    expect(dataLines[1]).toContain("#5");
    expect(dataLines[2]).toContain("#8");
  });

  it("should format markdown table correctly", () => {
    const scores: PRWithApprovals[] = [
      { number: 42, title: "Test PR", author: "developer", approvals: 3 },
    ];

    const result = formatLeaderboard(scores);

    expect(result).toContain("| PR | Author | Approvals |");
    expect(result).toContain("|----|--------|-----------|");
    expect(result).toContain("| #42 | @developer | 3 |");
  });

  it("should include signature", () => {
    const scores: PRWithApprovals[] = [
      { number: 1, title: "PR", author: "user", approvals: 1 },
    ];

    const result = formatLeaderboard(scores);

    expect(result).toContain(SIGNATURES.LEADERBOARD);
    expect(result).toContain(SIGNATURE);
  });

  it("should include merge note", () => {
    const scores: PRWithApprovals[] = [
      { number: 1, title: "PR", author: "user", approvals: 1 },
    ];

    const result = formatLeaderboard(scores);

    expect(result).toContain("Best implementation gets merged.");
  });

  it("should encourage readiness when scores exist", () => {
    const scores: PRWithApprovals[] = [
      { number: 1, title: "PR", author: "user", approvals: 1 },
    ];

    const result = formatLeaderboard(scores);

    expect(result).toContain("make sure checks pass");
  });

  it("should handle empty scores array", () => {
    const scores: PRWithApprovals[] = [];

    const result = formatLeaderboard(scores);

    // Should still produce valid markdown structure
    expect(result).toContain(SIGNATURES.LEADERBOARD);
    expect(result).toContain("No linked PRs are eligible for the implementation leaderboard yet.");
    expect(result).toContain("| PR | Author | Approvals |");
  });

  it("should handle authors with special characters", () => {
    const scores: PRWithApprovals[] = [
      { number: 1, title: "PR", author: "user-with-dash", approvals: 1 },
      { number: 2, title: "PR", author: "user_with_underscore", approvals: 1 },
    ];

    const result = formatLeaderboard(scores);

    expect(result).toContain("@user-with-dash");
    expect(result).toContain("@user_with_underscore");
  });
});

describe("LeaderboardService", () => {
  let mockClient: LeaderboardClient;
  let service: LeaderboardService;
  const testRef: IssueRef = { owner: "test-org", repo: "test-repo", issueNumber: 42 };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-20T12:00:00.000Z"));

    mockClient = {
      rest: {
        issues: {
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          createComment: vi.fn().mockResolvedValue({}),
          updateComment: vi.fn().mockResolvedValue({}),
        },
      },
      paginate: {
        iterator: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() {
            yield { data: [] };
          },
        }),
      },
    } as unknown as LeaderboardClient;

    service = new LeaderboardService(mockClient, TEST_APP_ID);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("findLeaderboardCommentId", () => {
    it("should return comment ID when leaderboard comment exists with matching app ID", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: "Some comment", performed_via_github_app: null },
              { id: 200, body: makeLeaderboardBody("| PR | Author |"), performed_via_github_app: { id: TEST_APP_ID } },
              { id: 300, body: "Another comment", performed_via_github_app: null },
            ],
          };
        },
      });

      const commentId = await service.findLeaderboardCommentId(testRef);

      expect(commentId).toBe(200);
    });

    it("should return null when no leaderboard comment exists", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: "Random comment", performed_via_github_app: null },
              { id: 200, body: "Another comment", performed_via_github_app: null },
            ],
          };
        },
      });

      const commentId = await service.findLeaderboardCommentId(testRef);

      expect(commentId).toBeNull();
    });

    it("should handle pagination (find comment in later pages)", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [{ id: 100, body: "Page 1 comment", performed_via_github_app: null }] };
          yield { data: [{ id: 200, body: "Page 2 comment", performed_via_github_app: null }] };
          yield { data: [{ id: 300, body: makeLeaderboardBody("| PR |"), performed_via_github_app: { id: TEST_APP_ID } }] };
        },
      });

      const commentId = await service.findLeaderboardCommentId(testRef);

      expect(commentId).toBe(300);
    });

    it("should handle comments with undefined body", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: undefined, performed_via_github_app: { id: TEST_APP_ID } },
              { id: 200, body: null, performed_via_github_app: { id: TEST_APP_ID } },
            ],
          };
        },
      });

      const commentId = await service.findLeaderboardCommentId(testRef);

      expect(commentId).toBeNull();
    });

    it("should call paginate.iterator with correct parameters", async () => {
      await service.findLeaderboardCommentId(testRef);

      expect(mockClient.paginate.iterator).toHaveBeenCalledWith(
        mockClient.rest.issues.listComments,
        {
          owner: "test-org",
          repo: "test-repo",
          issue_number: 42,
          per_page: 100,
        }
      );
    });

    it("should ignore leaderboard comments from different app IDs (spoofing protection)", async () => {
      const DIFFERENT_APP_ID = 99999;
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              // Spoofed comment - has signature but wrong app ID
              { id: 100, body: `${SIGNATURES.LEADERBOARD}\n| PR | Author |`, performed_via_github_app: { id: DIFFERENT_APP_ID } },
              // User comment with signature text (no app)
              { id: 200, body: `${SIGNATURES.LEADERBOARD}\n| Fake |`, performed_via_github_app: null },
            ],
          };
        },
      });

      const commentId = await service.findLeaderboardCommentId(testRef);

      expect(commentId).toBeNull();
    });

    it("should find legitimate comment even when spoofed comment exists", async () => {
      const DIFFERENT_APP_ID = 99999;
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              // Spoofed comment first (has metadata but wrong app ID)
              { id: 100, body: makeLeaderboardBody("| Fake |"), performed_via_github_app: { id: DIFFERENT_APP_ID } },
              // Real bot comment
              { id: 200, body: makeLeaderboardBody("| PR | Author |"), performed_via_github_app: { id: TEST_APP_ID } },
            ],
          };
        },
      });

      const commentId = await service.findLeaderboardCommentId(testRef);

      expect(commentId).toBe(200);
    });
  });

  describe("upsertLeaderboard", () => {
    const testScores: PRWithApprovals[] = [
      { number: 1, title: "PR 1", author: "user1", approvals: 3 },
      { number: 2, title: "PR 2", author: "user2", approvals: 5 },
    ];

    it("should create new comment when none exists", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [] };
        },
      });

      await service.upsertLeaderboard(testRef, testScores);

      expect(mockClient.rest.issues.createComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        body: expect.stringContaining(SIGNATURES.LEADERBOARD),
      });
      expect(mockClient.rest.issues.updateComment).not.toHaveBeenCalled();
    });

    it("should update existing comment when found", async () => {
      const existingCommentId = 999;
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [{ id: existingCommentId, body: makeLeaderboardBody("Old content"), performed_via_github_app: { id: TEST_APP_ID } }],
          };
        },
      });

      await service.upsertLeaderboard(testRef, testScores);

      expect(mockClient.rest.issues.updateComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        comment_id: existingCommentId,
        body: expect.stringContaining(SIGNATURES.LEADERBOARD),
      });
      expect(mockClient.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it("should format scores correctly in new comment", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [] };
        },
      });

      await service.upsertLeaderboard(testRef, testScores);

      const createCall = vi.mocked(mockClient.rest.issues.createComment).mock.calls[0][0];
      const body = createCall.body;

      // PR #2 has 5 approvals, should be first
      expect(body).toContain("| #2 | @user2 | 5 |");
      expect(body).toContain("| #1 | @user1 | 3 |");
    });

    it("should format scores correctly in updated comment", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [{ id: 123, body: makeLeaderboardBody("Old"), performed_via_github_app: { id: TEST_APP_ID } }],
          };
        },
      });

      await service.upsertLeaderboard(testRef, testScores);

      const updateCall = vi.mocked(mockClient.rest.issues.updateComment).mock.calls[0][0];
      const body = updateCall.body;

      expect(body).toContain("| #2 | @user2 | 5 |");
      expect(body).toContain("| #1 | @user1 | 3 |");
    });

    it("should handle single PR score", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [] };
        },
      });

      const singleScore: PRWithApprovals[] = [
        { number: 42, title: "Only PR", author: "solo", approvals: 1 },
      ];

      await service.upsertLeaderboard(testRef, singleScore);

      const createCall = vi.mocked(mockClient.rest.issues.createComment).mock.calls[0][0];
      expect(createCall.body).toContain("| #42 | @solo | 1 |");
    });
  });
});
