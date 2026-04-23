import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    group: vi.fn(),
    groupEnd: vi.fn(),
  },
}));

import { IssueOperations, createIssueOperations, getErrorStatus } from "./github-client.js";
import { logger as mockLogger } from "./logger.js";
import type { GitHubClient } from "./github-client.js";
import type { IssueRef } from "./types.js";
import {
  SIGNATURES,
  buildVotingComment,
  buildAlignmentComment,
  buildHumanHelpComment,
  buildNotificationComment,
  buildDiscussionComment,
  NOTIFICATION_TYPES,
} from "./bot-comments.js";

/**
 * Helper to create a voting comment body with proper metadata.
 * Required since isVotingComment now requires metadata, not just signature.
 */
function createVotingCommentBody(issueNumber: number, cycle: number = 1): string {
  return buildVotingComment(`${SIGNATURES.VOTING} - cycle ${cycle}`, issueNumber, cycle);
}

/**
 * Tests for IssueOperations
 *
 * These tests verify the GitHub client abstraction:
 * - Label operations
 * - Comment operations
 * - Timeline API usage
 * - Error handling
 * - Runtime validation
 */

const TEST_APP_ID = 12345;

describe("createIssueOperations", () => {
  it("should create IssueOperations from valid client", () => {
    const validClient = {
      rest: {
        issues: {
          get: vi.fn(),
          addLabels: vi.fn(),
          removeLabel: vi.fn(),
          createComment: vi.fn(),
          update: vi.fn(),
          lock: vi.fn(),
          unlock: vi.fn(),
          listEventsForTimeline: vi.fn(),
          listComments: vi.fn(),
        },
        reactions: {
          listForIssueComment: vi.fn(),
          listForIssue: vi.fn(),
        },
      },
      paginate: {
        iterator: vi.fn(),
      },
    };

    const ops = createIssueOperations(validClient, { appId: TEST_APP_ID });
    expect(ops).toBeInstanceOf(IssueOperations);
  });

  it("should throw for null input", () => {
    expect(() => createIssueOperations(null, { appId: TEST_APP_ID })).toThrow("Invalid GitHub client");
  });

  it("should throw for undefined input", () => {
    expect(() => createIssueOperations(undefined, { appId: TEST_APP_ID })).toThrow("Invalid GitHub client");
  });

  it("should throw for object missing rest property", () => {
    expect(() => createIssueOperations({ paginate: { iterator: vi.fn() } }, { appId: TEST_APP_ID })).toThrow(
      "Invalid GitHub client"
    );
  });

  it("should throw for object missing paginate.iterator", () => {
    const invalidClient = {
      rest: {
        issues: {
          get: vi.fn(),
          addLabels: vi.fn(),
          removeLabel: vi.fn(),
          createComment: vi.fn(),
          update: vi.fn(),
          lock: vi.fn(),
        },
      },
      paginate: {},
    };
    expect(() => createIssueOperations(invalidClient, { appId: TEST_APP_ID })).toThrow("Invalid GitHub client");
  });

  it("should throw for object missing required issues methods", () => {
    const invalidClient = {
      rest: {
        issues: {
          get: vi.fn(),
          // missing addLabels, removeLabel, etc.
        },
      },
      paginate: {
        iterator: vi.fn(),
      },
    };
    expect(() => createIssueOperations(invalidClient, { appId: TEST_APP_ID })).toThrow("Invalid GitHub client");
  });

  it("should throw for object missing rest.reactions", () => {
    const invalidClient = {
      rest: {
        issues: {
          get: vi.fn(),
          addLabels: vi.fn(),
          removeLabel: vi.fn(),
          createComment: vi.fn(),
          update: vi.fn(),
          lock: vi.fn(),
          unlock: vi.fn(),
        },
      },
      paginate: {
        iterator: vi.fn(),
      },
    };
    expect(() => createIssueOperations(invalidClient, { appId: TEST_APP_ID })).toThrow("Invalid GitHub client");
  });

  it("should throw for object missing reactions.listForIssue", () => {
    const invalidClient = {
      rest: {
        issues: {
          get: vi.fn(),
          addLabels: vi.fn(),
          removeLabel: vi.fn(),
          createComment: vi.fn(),
          update: vi.fn(),
          lock: vi.fn(),
          unlock: vi.fn(),
        },
        reactions: {
          listForIssueComment: vi.fn(),
          // missing listForIssue
        },
      },
      paginate: {
        iterator: vi.fn(),
      },
    };
    expect(() => createIssueOperations(invalidClient, { appId: TEST_APP_ID })).toThrow("Invalid GitHub client");
  });

  it("should accept paginate as a function with iterator property (octokit v5+ style)", () => {
    // In octokit v5+, paginate is a callable function with an iterator property attached
    const paginateFunction = vi.fn() as ReturnType<typeof vi.fn> & { iterator: ReturnType<typeof vi.fn> };
    paginateFunction.iterator = vi.fn();

    const validClient = {
      rest: {
        issues: {
          get: vi.fn(),
          addLabels: vi.fn(),
          removeLabel: vi.fn(),
          createComment: vi.fn(),
          update: vi.fn(),
          lock: vi.fn(),
          unlock: vi.fn(),
          listEventsForTimeline: vi.fn(),
          listComments: vi.fn(),
        },
        reactions: {
          listForIssueComment: vi.fn(),
          listForIssue: vi.fn(),
        },
      },
      paginate: paginateFunction,
    };

    const ops = createIssueOperations(validClient, { appId: TEST_APP_ID });
    expect(ops).toBeInstanceOf(IssueOperations);
  });

  it("should throw for null paginate", () => {
    const invalidClient = {
      rest: {
        issues: {
          get: vi.fn(),
          addLabels: vi.fn(),
          removeLabel: vi.fn(),
          createComment: vi.fn(),
          update: vi.fn(),
          lock: vi.fn(),
        },
      },
      paginate: null,
    };
    expect(() => createIssueOperations(invalidClient, { appId: TEST_APP_ID })).toThrow("Invalid GitHub client");
  });
});

describe("IssueOperations", () => {
  let mockClient: GitHubClient;
  let issueOps: IssueOperations;
  const testRef: IssueRef = { owner: "test-org", repo: "test-repo", issueNumber: 42 };

  beforeEach(() => {
    mockClient = {
      rest: {
        issues: {
          get: vi.fn().mockResolvedValue({ data: { reactions: { "+1": 5, "-1": 2, confused: 1 } } }),
          addLabels: vi.fn().mockResolvedValue({}),
          removeLabel: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
          listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          lock: vi.fn().mockResolvedValue({}),
          unlock: vi.fn().mockResolvedValue({}),
        },
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
          listForIssue: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      paginate: {
        iterator: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() {
            yield { data: [] };
          },
        }),
      },
      request: vi.fn().mockResolvedValue({}),
    } as unknown as GitHubClient;

    issueOps = new IssueOperations(mockClient, TEST_APP_ID);
  });

  describe("addLabels", () => {
    it("should call GitHub API with correct parameters", async () => {
      await issueOps.addLabels(testRef, ["bug", "help-wanted"]);

      expect(mockClient.rest.issues.addLabels).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        labels: ["bug", "help-wanted"],
      });
    });
  });

  describe("removeLabel", () => {
    it("should call GitHub API with correct parameters", async () => {
      await issueOps.removeLabel(testRef, "hivemoot:discussion");

      expect(mockClient.rest.issues.removeLabel).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        name: "hivemoot:discussion",
      });
    });

    it("should ignore 404 errors (label not found)", async () => {
      const error = new Error("Not Found") as Error & { status: number };
      error.status = 404;
      vi.mocked(mockClient.rest.issues.removeLabel).mockRejectedValue(error);

      // Should not throw
      await expect(issueOps.removeLabel(testRef, "nonexistent")).resolves.toBeUndefined();
    });

    it("should rethrow non-404 errors", async () => {
      const error = new Error("Server Error") as Error & { status: number };
      error.status = 500;
      vi.mocked(mockClient.rest.issues.removeLabel).mockRejectedValue(error);

      await expect(issueOps.removeLabel(testRef, "label")).rejects.toThrow("Server Error");
    });

    it("should fall back to legacy alias when canonical returns 404", async () => {
      const notFound = new Error("Not Found") as Error & { status: number };
      notFound.status = 404;

      // First call (canonical "hivemoot:voting") → 404
      // Second call (legacy "phase:voting") → success
      vi.mocked(mockClient.rest.issues.removeLabel)
        .mockRejectedValueOnce(notFound)
        .mockResolvedValueOnce({});

      await issueOps.removeLabel(testRef, "hivemoot:voting");

      expect(mockClient.rest.issues.removeLabel).toHaveBeenCalledTimes(2);
      expect(mockClient.rest.issues.removeLabel).toHaveBeenNthCalledWith(1, {
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        name: "hivemoot:voting",
      });
      expect(mockClient.rest.issues.removeLabel).toHaveBeenNthCalledWith(2, {
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        name: "phase:voting",
      });
    });

    it("should silently ignore when neither canonical nor legacy labels exist", async () => {
      const notFound = new Error("Not Found") as Error & { status: number };
      notFound.status = 404;

      vi.mocked(mockClient.rest.issues.removeLabel).mockRejectedValue(notFound);

      await expect(issueOps.removeLabel(testRef, "hivemoot:voting")).resolves.toBeUndefined();
    });

    it("should rethrow non-404 errors from alias fallback", async () => {
      const notFound = new Error("Not Found") as Error & { status: number };
      notFound.status = 404;
      const serverError = new Error("Gateway Timeout") as Error & { status: number };
      serverError.status = 504;

      // Canonical call → 404 triggers alias loop; alias call → 504 should propagate
      vi.mocked(mockClient.rest.issues.removeLabel)
        .mockRejectedValueOnce(notFound)
        .mockRejectedValueOnce(serverError);

      await expect(issueOps.removeLabel(testRef, "hivemoot:voting")).rejects.toThrow(
        "Gateway Timeout"
      );
    });
  });

  describe("comment", () => {
    it("should post comment with correct body", async () => {
      await issueOps.comment(testRef, "Hello world!");

      expect(mockClient.rest.issues.createComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        body: "Hello world!",
      });
    });
  });

  describe("pinComment", () => {
    it("should call request with correct route and parameters", async () => {
      await issueOps.pinComment(testRef, 99);

      expect(mockClient.request).toHaveBeenCalledWith(
        "PUT /repos/{owner}/{repo}/issues/comments/{comment_id}/pin",
        { owner: "test-org", repo: "test-repo", comment_id: 99 }
      );
    });
  });

  describe("close", () => {
    it("should close with default reason (not_planned)", async () => {
      await issueOps.close(testRef);

      expect(mockClient.rest.issues.update).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        state: "closed",
        state_reason: "not_planned",
      });
    });

    it("should close with specified reason", async () => {
      await issueOps.close(testRef, "completed");

      expect(mockClient.rest.issues.update).toHaveBeenCalledWith(
        expect.objectContaining({ state_reason: "completed" })
      );
    });
  });

  describe("lock", () => {
    it("should lock with default reason (resolved)", async () => {
      await issueOps.lock(testRef);

      expect(mockClient.rest.issues.lock).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        lock_reason: "resolved",
      });
    });

    it("should lock with specified reason", async () => {
      await issueOps.lock(testRef, "spam");

      expect(mockClient.rest.issues.lock).toHaveBeenCalledWith(
        expect.objectContaining({ lock_reason: "spam" })
      );
    });
  });

  describe("getVoteCounts", () => {
    it("should return reaction counts from issue", async () => {
      const votes = await issueOps.getVoteCounts(testRef);

      expect(votes).toEqual({ thumbsUp: 5, thumbsDown: 2, confused: 1, eyes: 0 });
    });

    it("should return zeros when no reactions", async () => {
      vi.mocked(mockClient.rest.issues.get).mockResolvedValue({
        data: { reactions: undefined },
      });

      const votes = await issueOps.getVoteCounts(testRef);

      expect(votes).toEqual({ thumbsUp: 0, thumbsDown: 0, confused: 0, eyes: 0 });
    });
  });

  describe("findVotingCommentId", () => {
    it("should return comment ID when voting comment found with matching app ID", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: "Some other comment", performed_via_github_app: null },
              { id: 200, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: TEST_APP_ID } },
              { id: 300, body: "Another comment", performed_via_github_app: null },
            ],
          };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      expect(commentId).toBe(200);
    });

    it("should return null when voting comment not found", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: "Some comment", performed_via_github_app: null },
              { id: 200, body: "Another comment", performed_via_github_app: null },
            ],
          };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      expect(commentId).toBeNull();
    });

    it("should return null when comments have no body", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [{ id: 100, body: undefined, performed_via_github_app: { id: TEST_APP_ID } }],
          };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      expect(commentId).toBeNull();
    });

    it("should handle pagination across multiple pages", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [{ id: 100, body: "Page 1 comment", performed_via_github_app: null }] };
          yield { data: [{ id: 200, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: TEST_APP_ID } }] };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      expect(commentId).toBe(200);
    });

    it("should ignore voting comments from different app IDs (spoofing protection)", async () => {
      const DIFFERENT_APP_ID = 99999;
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              // Spoofed comment - has signature but wrong app ID
              { id: 100, body: `${SIGNATURES.VOTING} - spoofed!`, performed_via_github_app: { id: DIFFERENT_APP_ID } },
              // User comment with signature text (no app)
              { id: 200, body: `${SIGNATURES.VOTING} - user post`, performed_via_github_app: null },
            ],
          };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      expect(commentId).toBeNull();
    });

    it("should find legitimate comment even when spoofed comment exists", async () => {
      const DIFFERENT_APP_ID = 99999;
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              // Spoofed comment first (has metadata but wrong app ID)
              { id: 100, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: DIFFERENT_APP_ID } },
              // Real bot comment
              { id: 200, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: TEST_APP_ID } },
            ],
          };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      expect(commentId).toBe(200);
    });

    it("should return highest cycle comment when multiple voting comments exist with metadata", async () => {
      // Simulates: issue went through discussion → voting (cycle 1) → needs-more-discussion → voting (cycle 2)
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              // Cycle 1 voting comment (older)
              {
                id: 100,
                body: `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->\n${SIGNATURES.VOTING} - cycle 1`,
                created_at: "2024-01-15T10:00:00.000Z",
                performed_via_github_app: { id: TEST_APP_ID },
              },
              // Cycle 2 voting comment (newer)
              {
                id: 200,
                body: `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":2,"createdAt":"2024-01-20T10:00:00.000Z","issueNumber":42} -->\n${SIGNATURES.VOTING} - cycle 2`,
                created_at: "2024-01-20T10:00:00.000Z",
                performed_via_github_app: { id: TEST_APP_ID },
              },
            ],
          };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      // Should return cycle 2 comment (highest cycle)
      expect(commentId).toBe(200);
    });

    it("should return first comment when multiple comments have same cycle", async () => {
      // Test edge case: same cycle number (shouldn't happen in practice)
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 100,
                body: createVotingCommentBody(42, 1),
                created_at: "2024-01-15T10:00:00.000Z",
                performed_via_github_app: { id: TEST_APP_ID },
              },
              {
                id: 200,
                body: createVotingCommentBody(42, 1),
                created_at: "2024-01-20T10:00:00.000Z",
                performed_via_github_app: { id: TEST_APP_ID },
              },
            ],
          };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      // With same cycle, returns first one in array order after sort
      expect(commentId).toBe(100);
    });

    it("should handle three voting cycles correctly", async () => {
      // Three cycles: initial → needs-more-discussion → voting → needs-more-discussion → voting
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 100,
                body: `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-10T10:00:00.000Z","issueNumber":42} -->\n${SIGNATURES.VOTING}`,
                created_at: "2024-01-10T10:00:00.000Z",
                performed_via_github_app: { id: TEST_APP_ID },
              },
              {
                id: 200,
                body: `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":2,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->\n${SIGNATURES.VOTING}`,
                created_at: "2024-01-15T10:00:00.000Z",
                performed_via_github_app: { id: TEST_APP_ID },
              },
              {
                id: 300,
                body: `<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":3,"createdAt":"2024-01-20T10:00:00.000Z","issueNumber":42} -->\n${SIGNATURES.VOTING}`,
                created_at: "2024-01-20T10:00:00.000Z",
                performed_via_github_app: { id: TEST_APP_ID },
              },
            ],
          };
        },
      });

      const commentId = await issueOps.findVotingCommentId(testRef);

      // Should return cycle 3 comment
      expect(commentId).toBe(300);
    });
  });

  describe("countVotingComments", () => {
    it("should return 0 when no voting comments exist", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: "Regular comment", performed_via_github_app: null },
              { id: 200, body: "Another comment", performed_via_github_app: null },
            ],
          };
        },
      });

      const count = await issueOps.countVotingComments(testRef);

      expect(count).toBe(0);
    });

    it("should count single voting comment", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: TEST_APP_ID } },
              { id: 200, body: "Regular comment", performed_via_github_app: null },
            ],
          };
        },
      });

      const count = await issueOps.countVotingComments(testRef);

      expect(count).toBe(1);
    });

    it("should count multiple voting comments", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: TEST_APP_ID } },
              { id: 200, body: createVotingCommentBody(42, 2), performed_via_github_app: { id: TEST_APP_ID } },
              { id: 300, body: createVotingCommentBody(42, 3), performed_via_github_app: { id: TEST_APP_ID } },
            ],
          };
        },
      });

      const count = await issueOps.countVotingComments(testRef);

      expect(count).toBe(3);
    });

    it("should ignore voting comments from different app IDs", async () => {
      const DIFFERENT_APP_ID = 99999;
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: TEST_APP_ID } },
              { id: 200, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: DIFFERENT_APP_ID } },
              { id: 300, body: createVotingCommentBody(42, 1), performed_via_github_app: null },
            ],
          };
        },
      });

      const count = await issueOps.countVotingComments(testRef);

      expect(count).toBe(1);
    });

    it("should handle pagination across multiple pages", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [{ id: 100, body: createVotingCommentBody(42, 1), performed_via_github_app: { id: TEST_APP_ID } }],
          };
          yield {
            data: [{ id: 200, body: createVotingCommentBody(42, 2), performed_via_github_app: { id: TEST_APP_ID } }],
          };
        },
      });

      const count = await issueOps.countVotingComments(testRef);

      expect(count).toBe(2);
    });
  });

  describe("findAlignmentCommentId", () => {
    it("should return alignment comment ID when found with matching app ID", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: "Regular comment", performed_via_github_app: null },
              { id: 200, body: buildAlignmentComment(SIGNATURES.ALIGNMENT, 42), performed_via_github_app: { id: TEST_APP_ID } },
            ],
          };
        },
      });

      const commentId = await issueOps.findAlignmentCommentId(testRef);
      expect(commentId).toBe(200);
    });

    it("should return null when no alignment comment exists", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [{ id: 100, body: "Regular comment", performed_via_github_app: { id: TEST_APP_ID } }],
          };
        },
      });

      const commentId = await issueOps.findAlignmentCommentId(testRef);
      expect(commentId).toBeNull();
    });

    it("should ignore alignment-shaped comments from different app IDs", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: buildAlignmentComment(SIGNATURES.ALIGNMENT, 42), performed_via_github_app: { id: 99999 } },
            ],
          };
        },
      });

      const commentId = await issueOps.findAlignmentCommentId(testRef);
      expect(commentId).toBeNull();
    });
  });

  describe("findAlignmentCommentInfo", () => {
    it("should return id and createdAt from alignment comment metadata", async () => {
      const createdAt = "2024-01-15T10:00:00.000Z";
      const body = `<!-- hivemoot-metadata: {"version":1,"type":"alignment","createdAt":"${createdAt}","issueNumber":42} -->\n# Blueprint`;
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: "Regular comment", performed_via_github_app: null },
              { id: 200, body, performed_via_github_app: { id: TEST_APP_ID } },
            ],
          };
        },
      });

      const result = await issueOps.findAlignmentCommentInfo(testRef);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(200);
      expect(result!.createdAt).toBe(createdAt);
    });

    it("should return null when no alignment comment exists", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [{ id: 100, body: "Regular comment", performed_via_github_app: null }] };
        },
      });

      const result = await issueOps.findAlignmentCommentInfo(testRef);
      expect(result).toBeNull();
    });
  });

  describe("countNonBotCommentsSince", () => {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago

    it("should count only comments after the given timestamp", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 1, body: "Old comment", created_at: old, user: { login: "alice", type: "User" }, performed_via_github_app: null },
              { id: 2, body: "New comment", created_at: recent, user: { login: "alice", type: "User" }, performed_via_github_app: null },
            ],
          };
        },
      });

      const count = await issueOps.countNonBotCommentsSince(testRef, since);
      expect(count).toBe(1);
    });

    it("should skip queen app comments", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 1, body: "Queen comment", created_at: recent, user: { login: "hivemoot[bot]", type: "Bot" }, performed_via_github_app: { id: TEST_APP_ID } },
              { id: 2, body: "Human comment", created_at: recent, user: { login: "alice", type: "User" }, performed_via_github_app: null },
            ],
          };
        },
      });

      const count = await issueOps.countNonBotCommentsSince(testRef, since);
      expect(count).toBe(1);
    });

    it("should skip Bot-type user accounts", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 1, body: "Leaderboard update", created_at: recent, user: { login: "some-bot", type: "Bot" }, performed_via_github_app: null },
              { id: 2, body: "Human comment", created_at: recent, user: { login: "alice", type: "User" }, performed_via_github_app: null },
            ],
          };
        },
      });

      const count = await issueOps.countNonBotCommentsSince(testRef, since);
      expect(count).toBe(1);
    });

    it("should skip command comments starting with /", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 1, body: "/gather", created_at: recent, user: { login: "alice", type: "User" }, performed_via_github_app: null },
              { id: 2, body: "Discussion content", created_at: recent, user: { login: "bob", type: "User" }, performed_via_github_app: null },
            ],
          };
        },
      });

      const count = await issueOps.countNonBotCommentsSince(testRef, since);
      expect(count).toBe(1);
    });

    it("should skip command comments starting with @hivemoot", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 1, body: "@hivemoot implement", created_at: recent, user: { login: "alice", type: "User" }, performed_via_github_app: null },
              { id: 2, body: "Discussion content", created_at: recent, user: { login: "bob", type: "User" }, performed_via_github_app: null },
            ],
          };
        },
      });

      const count = await issueOps.countNonBotCommentsSince(testRef, since);
      expect(count).toBe(1);
    });

    it("should return 0 when all comments are filtered", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 1, body: "/gather", created_at: recent, user: { login: "alice", type: "User" }, performed_via_github_app: null },
              { id: 2, body: "Bot message", created_at: recent, user: { login: "some-bot", type: "Bot" }, performed_via_github_app: null },
            ],
          };
        },
      });

      const count = await issueOps.countNonBotCommentsSince(testRef, since);
      expect(count).toBe(0);
    });
  });

  describe("hasHumanHelpComment", () => {
    it("should return true when human help comment with matching error code exists", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: "Regular comment", performed_via_github_app: null },
              {
                id: 200,
                body: buildHumanHelpComment("Help needed!", 42, "VOTING_COMMENT_NOT_FOUND"),
                performed_via_github_app: { id: TEST_APP_ID },
              },
            ],
          };
        },
      });

      const result = await issueOps.hasHumanHelpComment(testRef, "VOTING_COMMENT_NOT_FOUND");

      expect(result).toBe(true);
    });

    it("should return false when no comments exist", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [] };
        },
      });

      const result = await issueOps.hasHumanHelpComment(testRef, "VOTING_COMMENT_NOT_FOUND");

      expect(result).toBe(false);
    });

    it("should return false when human help comment has different error code", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 100,
                body: buildHumanHelpComment("Help!", 42, "OTHER_ERROR"),
                performed_via_github_app: { id: TEST_APP_ID },
              },
            ],
          };
        },
      });

      const result = await issueOps.hasHumanHelpComment(testRef, "VOTING_COMMENT_NOT_FOUND");

      expect(result).toBe(false);
    });

    it("should return false when human help comment has wrong app ID (spoofing protection)", async () => {
      const DIFFERENT_APP_ID = 99999;
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 100,
                body: buildHumanHelpComment("Spoofed!", 42, "VOTING_COMMENT_NOT_FOUND"),
                performed_via_github_app: { id: DIFFERENT_APP_ID },
              },
            ],
          };
        },
      });

      const result = await issueOps.hasHumanHelpComment(testRef, "VOTING_COMMENT_NOT_FOUND");

      expect(result).toBe(false);
    });

    it("should return false when human help comment has no app ID", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 100,
                body: buildHumanHelpComment("User posted!", 42, "VOTING_COMMENT_NOT_FOUND"),
                performed_via_github_app: null,
              },
            ],
          };
        },
      });

      const result = await issueOps.hasHumanHelpComment(testRef, "VOTING_COMMENT_NOT_FOUND");

      expect(result).toBe(false);
    });

    it("should handle pagination across multiple pages", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [{ id: 100, body: "Page 1 comment", performed_via_github_app: null }] };
          yield {
            data: [
              {
                id: 200,
                body: buildHumanHelpComment("Found on page 2!", 42, "VOTING_COMMENT_NOT_FOUND"),
                performed_via_github_app: { id: TEST_APP_ID },
              },
            ],
          };
        },
      });

      const result = await issueOps.hasHumanHelpComment(testRef, "VOTING_COMMENT_NOT_FOUND");

      expect(result).toBe(true);
    });

    it("should return false when only regular comments exist", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: "Just a regular comment", performed_via_github_app: null },
              { id: 200, body: "Another regular comment", performed_via_github_app: { id: TEST_APP_ID } },
            ],
          };
        },
      });

      const result = await issueOps.hasHumanHelpComment(testRef, "VOTING_COMMENT_NOT_FOUND");

      expect(result).toBe(false);
    });

    it("should return false when comment body is null or undefined", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: null, performed_via_github_app: { id: TEST_APP_ID } },
              { id: 200, body: undefined, performed_via_github_app: { id: TEST_APP_ID } },
            ],
          };
        },
      });

      const result = await issueOps.hasHumanHelpComment(testRef, "VOTING_COMMENT_NOT_FOUND");

      expect(result).toBe(false);
    });
  });

  describe("hasNotificationComment", () => {
    it("should return true when matching notification comment exists", async () => {
      const notificationBody = buildNotificationComment(
        "Test notification content",
        42,
        NOTIFICATION_TYPES.IMPLEMENTATION_WELCOME
      );

      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: notificationBody, performed_via_github_app: { id: TEST_APP_ID } },
            ],
          };
        },
      });

      const result = await issueOps.hasNotificationComment(
        testRef,
        NOTIFICATION_TYPES.IMPLEMENTATION_WELCOME,
        42
      );

      expect(result).toBe(true);
    });

    it("should return false when no matching notification exists", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: "Just a regular comment", performed_via_github_app: { id: TEST_APP_ID } },
            ],
          };
        },
      });

      const result = await issueOps.hasNotificationComment(
        testRef,
        NOTIFICATION_TYPES.IMPLEMENTATION_WELCOME,
        42
      );

      expect(result).toBe(false);
    });

    it("should return false when notification type differs", async () => {
      const notificationBody = buildNotificationComment(
        "Test notification content",
        42,
        NOTIFICATION_TYPES.VOTING_PASSED
      );

      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: notificationBody, performed_via_github_app: { id: TEST_APP_ID } },
            ],
          };
        },
      });

      const result = await issueOps.hasNotificationComment(
        testRef,
        NOTIFICATION_TYPES.IMPLEMENTATION_WELCOME,
        42
      );

      expect(result).toBe(false);
    });

    it("should return false when issueNumber differs", async () => {
      const notificationBody = buildNotificationComment(
        "Test notification content",
        99,
        NOTIFICATION_TYPES.ISSUE_NEW_PR
      );

      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: notificationBody, performed_via_github_app: { id: TEST_APP_ID } },
            ],
          };
        },
      });

      const result = await issueOps.hasNotificationComment(
        testRef,
        NOTIFICATION_TYPES.ISSUE_NEW_PR,
        42
      );

      expect(result).toBe(false);
    });

    it("should return false when comment is from a different app", async () => {
      const notificationBody = buildNotificationComment(
        "Test notification content",
        42,
        NOTIFICATION_TYPES.IMPLEMENTATION_WELCOME
      );

      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: notificationBody, performed_via_github_app: { id: 99999 } },
            ],
          };
        },
      });

      const result = await issueOps.hasNotificationComment(
        testRef,
        NOTIFICATION_TYPES.IMPLEMENTATION_WELCOME,
        42
      );

      expect(result).toBe(false);
    });
  });

  describe("hasWelcomeComment", () => {
    it("should return true when welcome comment from our app exists", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 100, body: "Regular comment", performed_via_github_app: null },
              {
                id: 200,
                body: buildDiscussionComment("Welcome to hivemoot!", 42),
                performed_via_github_app: { id: TEST_APP_ID },
              },
            ],
          };
        },
      });

      const result = await issueOps.hasWelcomeComment(testRef);

      expect(result).toBe(true);
    });

    it("should return false when no comments exist", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [] };
        },
      });

      const result = await issueOps.hasWelcomeComment(testRef);

      expect(result).toBe(false);
    });

    it("should return false when welcome comment has wrong app ID (spoofing protection)", async () => {
      const DIFFERENT_APP_ID = 99999;
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 100,
                body: buildDiscussionComment("Spoofed welcome!", 42),
                performed_via_github_app: { id: DIFFERENT_APP_ID },
              },
            ],
          };
        },
      });

      const result = await issueOps.hasWelcomeComment(testRef);

      expect(result).toBe(false);
    });

    it("should return false when comment has wrong metadata type", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 100,
                body: buildVotingComment(42, 1),
                performed_via_github_app: { id: TEST_APP_ID },
              },
            ],
          };
        },
      });

      const result = await issueOps.hasWelcomeComment(testRef);

      expect(result).toBe(false);
    });
  });

  describe("getValidatedVoteCounts", () => {
    it("should return valid votes and voters for single-reaction users", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: { login: "Alice" } },
              { content: "-1", user: { login: "Bob" } },
              { content: "confused", user: { login: "Charlie" } },
            ],
          };
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      expect(result.votes).toEqual({ thumbsUp: 1, thumbsDown: 1, confused: 1, eyes: 0 });
      expect(result.voters).toEqual(expect.arrayContaining(["alice", "bob", "charlie"]));
      expect(result.voters).toHaveLength(3);
      expect(result.participants).toEqual(expect.arrayContaining(["alice", "bob", "charlie"]));
      expect(result.participants).toHaveLength(3);
    });

    it("should count duplicate identical reactions as a single vote", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: { login: "Alice" } },
              { content: "+1", user: { login: "Alice" } }, // duplicate identical reaction
              { content: "+1", user: { login: "Bob" } },
            ],
          };
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      expect(result.votes).toEqual({ thumbsUp: 2, thumbsDown: 0, confused: 0, eyes: 0 });
      expect(result.voters).toEqual(expect.arrayContaining(["alice", "bob"]));
      expect(result.voters).toHaveLength(2);
      expect(result.participants).toEqual(expect.arrayContaining(["alice", "bob"]));
      expect(result.participants).toHaveLength(2);
    });

    it("should discard votes from users with multiple reaction types", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: { login: "Alice" } },
              { content: "-1", user: { login: "Alice" } }, // Alice has two reaction types — discard
              { content: "+1", user: { login: "Bob" } },   // Bob has only one — counts
            ],
          };
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      expect(result.votes).toEqual({ thumbsUp: 1, thumbsDown: 0, confused: 0, eyes: 0 }); // only Bob
      expect(result.voters).toEqual(["bob"]);
      expect(result.participants).toEqual(expect.arrayContaining(["alice", "bob"]));
      expect(result.participants).toHaveLength(2);
    });

    it("should discard user with all three reaction types", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: { login: "Spammer" } },
              { content: "-1", user: { login: "Spammer" } },
              { content: "confused", user: { login: "Spammer" } },
            ],
          };
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      expect(result.votes).toEqual({ thumbsUp: 0, thumbsDown: 0, confused: 0, eyes: 0 });
      expect(result.voters).toEqual([]);
      expect(result.participants).toEqual(["spammer"]);
    });

    it("should count eyes reactions", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: { login: "Alice" } },
              { content: "eyes", user: { login: "Bob" } },
              { content: "eyes", user: { login: "Charlie" } },
            ],
          };
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      expect(result.votes).toEqual({ thumbsUp: 1, thumbsDown: 0, confused: 0, eyes: 2 });
      expect(result.voters).toEqual(expect.arrayContaining(["alice", "bob", "charlie"]));
      expect(result.voters).toHaveLength(3);
    });

    it("should discard user who reacts with both eyes and thumbsUp", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: { login: "Alice" } },
              { content: "eyes", user: { login: "Alice" } },  // multi-reaction — discard
              { content: "eyes", user: { login: "Bob" } },     // single reaction — counts
            ],
          };
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      expect(result.votes).toEqual({ thumbsUp: 0, thumbsDown: 0, confused: 0, eyes: 1 }); // only Bob
      expect(result.voters).toEqual(["bob"]);
      expect(result.participants).toEqual(expect.arrayContaining(["alice", "bob"]));
      expect(result.participants).toHaveLength(2);
    });

    it("should ignore non-voting reactions", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: { login: "Alice" } },
              { content: "heart", user: { login: "Alice" } },  // non-voting, ignored
              { content: "rocket", user: { login: "Bob" } },   // non-voting, ignored
            ],
          };
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      expect(result.votes).toEqual({ thumbsUp: 1, thumbsDown: 0, confused: 0, eyes: 0 });
      expect(result.voters).toEqual(["alice"]);
      expect(result.participants).toEqual(["alice"]); // Bob has no voting reactions
    });

    it("should skip reactions without user", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: null },
              { content: "+1", user: { login: "Alice" } },
            ],
          };
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      expect(result.votes).toEqual({ thumbsUp: 1, thumbsDown: 0, confused: 0, eyes: 0 });
      expect(result.voters).toEqual(["alice"]);
    });

    it("should handle pagination across multiple pages", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [{ content: "+1", user: { login: "Alice" } }] };
          yield { data: [{ content: "-1", user: { login: "Alice" } }] }; // multi-reaction across pages
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      // Alice reacted with both +1 and -1 across pages — should be discarded
      expect(result.votes).toEqual({ thumbsUp: 0, thumbsDown: 0, confused: 0, eyes: 0 });
      expect(result.voters).toEqual([]);
      expect(result.participants).toEqual(["alice"]);
    });

    it("should return empty results when no reactions", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [] };
        },
      });

      const result = await issueOps.getValidatedVoteCounts(testRef, 200);

      expect(result.votes).toEqual({ thumbsUp: 0, thumbsDown: 0, confused: 0, eyes: 0 });
      expect(result.voters).toEqual([]);
      expect(result.participants).toEqual([]);
    });
  });

  describe("getLabelAddedTime", () => {
    it("should return date when label event found", async () => {
      const labeledDate = "2024-01-15T10:30:00Z";

      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { event: "opened", created_at: "2024-01-15T10:00:00Z" },
              { event: "labeled", label: { name: "hivemoot:discussion" }, created_at: labeledDate },
              { event: "commented", created_at: "2024-01-15T11:00:00Z" },
            ],
          };
        },
      });

      const result = await issueOps.getLabelAddedTime(testRef, "hivemoot:discussion");

      expect(result).toEqual(new Date(labeledDate));
    });

    it("should match legacy label name when searching for canonical name", async () => {
      const labeledDate = "2024-01-15T10:30:00Z";

      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { event: "opened", created_at: "2024-01-15T10:00:00Z" },
              { event: "labeled", label: { name: "phase:discussion" }, created_at: labeledDate },
            ],
          };
        },
      });

      // Search by canonical name, but timeline has legacy name
      const result = await issueOps.getLabelAddedTime(testRef, "hivemoot:discussion");

      expect(result).toEqual(new Date(labeledDate));
    });

    it("should return null when label not found", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { event: "opened", created_at: "2024-01-15T10:00:00Z" },
              { event: "labeled", label: { name: "other-label" }, created_at: "2024-01-15T10:30:00Z" },
            ],
          };
        },
      });

      const result = await issueOps.getLabelAddedTime(testRef, "hivemoot:discussion");

      expect(result).toBeNull();
    });
  });

  describe("transition", () => {
    it("should add label and comment", async () => {
      await issueOps.transition(testRef, {
        addLabel: "hivemoot:voting",
        comment: "Voting has started!",
      });

      expect(mockClient.rest.issues.addLabels).toHaveBeenCalled();
      expect(mockClient.rest.issues.createComment).toHaveBeenCalled();
    });

    it("should remove label when specified", async () => {
      await issueOps.transition(testRef, {
        removeLabel: "hivemoot:discussion",
        addLabel: "hivemoot:voting",
        comment: "Moving to voting",
      });

      expect(mockClient.rest.issues.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: "hivemoot:discussion" })
      );
    });

    it("should close issue when specified", async () => {
      await issueOps.transition(testRef, {
        addLabel: "hivemoot:rejected",
        comment: "Rejected",
        close: true,
        closeReason: "not_planned",
      });

      expect(mockClient.rest.issues.update).toHaveBeenCalledWith(
        expect.objectContaining({ state: "closed" })
      );
    });

    it("should lock issue when specified", async () => {
      await issueOps.transition(testRef, {
        addLabel: "hivemoot:ready-to-implement",
        comment: "Ready to implement",
        lock: true,
        lockReason: "resolved",
      });

      expect(mockClient.rest.issues.lock).toHaveBeenCalledWith(
        expect.objectContaining({ lock_reason: "resolved" })
      );
    });

    it("should run operations sequentially to prevent race conditions", async () => {
      const callOrder: string[] = [];

      vi.mocked(mockClient.rest.issues.removeLabel).mockImplementation(async () => {
        callOrder.push("removeLabel");
      });
      vi.mocked(mockClient.rest.issues.addLabels).mockImplementation(async () => {
        callOrder.push("addLabels");
      });
      vi.mocked(mockClient.rest.issues.createComment).mockImplementation(async () => {
        callOrder.push("createComment");
      });
      vi.mocked(mockClient.rest.issues.update).mockImplementation(async () => {
        callOrder.push("close");
      });
      vi.mocked(mockClient.rest.issues.lock).mockImplementation(async () => {
        callOrder.push("lock");
      });

      await issueOps.transition(testRef, {
        removeLabel: "old",
        addLabel: "new",
        comment: "Transitioning",
        close: true,
        lock: true,
      });

      // Verify add-before-remove order: new label is added first so that
      // if a later step fails, the issue still has the old label for cron retry.
      expect(callOrder).toEqual(["addLabels", "createComment", "close", "removeLabel", "lock"]);
    });

    it("should complete comment before lock so users can see the message", async () => {
      let commentCompleted = false;
      let lockCalledBeforeComment = false;

      vi.mocked(mockClient.rest.issues.createComment).mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        commentCompleted = true;
      });

      vi.mocked(mockClient.rest.issues.lock).mockImplementation(async () => {
        if (!commentCompleted) {
          lockCalledBeforeComment = true;
        }
      });

      await issueOps.transition(testRef, {
        addLabel: "hivemoot:rejected",
        comment: "Rejected",
        lock: true,
      });

      expect(lockCalledBeforeComment).toBe(false);
      expect(commentCompleted).toBe(true);
    });

    it("should preserve old label when addLabels fails (issue remains findable by cron)", async () => {
      vi.mocked(mockClient.rest.issues.addLabels).mockRejectedValue(
        new Error("API Error"),
      );

      await expect(
        issueOps.transition(testRef, {
          removeLabel: "hivemoot:discussion",
          addLabel: "hivemoot:voting",
          comment: "Moving to voting",
        }),
      ).rejects.toThrow("API Error");

      // removeLabel must NOT be called — old label stays so cron can retry
      expect(mockClient.rest.issues.removeLabel).not.toHaveBeenCalled();
    });

    it("should skip removeLabel when same as addLabel (self-transition guard)", async () => {
      await issueOps.transition(testRef, {
        removeLabel: "same-label",
        addLabel: "same-label",
        comment: "Self-transition test",
        close: true,
        lock: true,
      });

      expect(mockClient.rest.issues.addLabels).toHaveBeenCalled();
      expect(mockClient.rest.issues.removeLabel).not.toHaveBeenCalled();
      expect(mockClient.rest.issues.update).toHaveBeenCalledWith(
        expect.objectContaining({ state: "closed" }),
      );
    });

    it("should unlock before addLabels in add-before-remove order", async () => {
      const callOrder: string[] = [];

      vi.mocked(mockClient.rest.issues.unlock).mockImplementation(async () => {
        callOrder.push("unlock");
      });
      vi.mocked(mockClient.rest.issues.addLabels).mockImplementation(async () => {
        callOrder.push("addLabels");
      });
      vi.mocked(mockClient.rest.issues.createComment).mockImplementation(async () => {
        callOrder.push("createComment");
      });
      vi.mocked(mockClient.rest.issues.removeLabel).mockImplementation(async () => {
        callOrder.push("removeLabel");
      });

      await issueOps.transition(testRef, {
        removeLabel: "hivemoot:voting",
        addLabel: "hivemoot:discussion",
        comment: "Needs more discussion",
        unlock: true,
      });

      expect(callOrder).toEqual(["unlock", "addLabels", "createComment", "removeLabel"]);
    });
  });

  describe("getIssueDetails", () => {
    it("should return issue title, body, and author", async () => {
      mockClient.rest.issues.get = vi.fn().mockResolvedValue({
        data: {
          title: "Add feature X",
          body: "We need feature X for better UX",
          user: { login: "alice" },
        },
      });

      const details = await issueOps.getIssueDetails(testRef);

      expect(details).toEqual({
        title: "Add feature X",
        body: "We need feature X for better UX",
        author: "alice",
      });
    });

    it("should handle null body", async () => {
      mockClient.rest.issues.get = vi.fn().mockResolvedValue({
        data: {
          title: "Quick fix",
          body: null,
          user: { login: "bob" },
        },
      });

      const details = await issueOps.getIssueDetails(testRef);

      expect(details.body).toBe("");
    });

    it("should handle null user", async () => {
      mockClient.rest.issues.get = vi.fn().mockResolvedValue({
        data: {
          title: "No author",
          body: "Some body",
          user: null,
        },
      });

      const details = await issueOps.getIssueDetails(testRef);

      expect(details.author).toBe("");
    });
  });

  describe("getDiscussionComments", () => {
    it("should return human comments with author info", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 1,
                body: "Great idea!",
                user: { login: "alice", type: "User" },
                created_at: "2024-01-15T10:00:00Z",
              },
              {
                id: 2,
                body: "I agree",
                user: { login: "bob", type: "User" },
                created_at: "2024-01-15T11:00:00Z",
              },
            ],
          };
        },
      });

      const comments = await issueOps.getDiscussionComments(testRef);

      expect(comments).toHaveLength(2);
      expect(comments[0]).toEqual({
        author: "alice",
        body: "Great idea!",
        createdAt: "2024-01-15T10:00:00Z",
      });
    });

    it("should filter out Queen bot comments (performed_via_github_app)", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 1,
                body: "Human comment",
                user: { login: "alice", type: "User" },
                created_at: "2024-01-15T10:00:00Z",
              },
              {
                id: 2,
                body: "Bot welcome message",
                user: { login: "queen-bot[bot]", type: "Bot" },
                created_at: "2024-01-15T10:01:00Z",
                performed_via_github_app: { id: TEST_APP_ID },
              },
            ],
          };
        },
      });

      const comments = await issueOps.getDiscussionComments(testRef);

      expect(comments).toHaveLength(1);
      expect(comments[0].author).toBe("alice");
    });

    it("should INCLUDE comments from other bots (only filter our own app)", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 1,
                body: "Human comment",
                user: { login: "alice", type: "User" },
                created_at: "2024-01-15T10:00:00Z",
              },
              {
                id: 2,
                body: "Dependabot update",
                user: { login: "dependabot", type: "Bot" },
                created_at: "2024-01-15T10:01:00Z",
              },
              {
                id: 3,
                body: "GitHub Actions message",
                user: { login: "github-actions[bot]", type: "Bot" },
                created_at: "2024-01-15T10:02:00Z",
              },
            ],
          };
        },
      });

      const comments = await issueOps.getDiscussionComments(testRef);

      // All comments included - we only filter our own app's comments
      expect(comments).toHaveLength(3);
      expect(comments[0].author).toBe("alice");
      expect(comments[1].author).toBe("dependabot");
      expect(comments[2].author).toBe("github-actions[bot]");
    });

    it("should skip comments without user or body", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 1,
                body: "Valid comment",
                user: { login: "alice", type: "User" },
                created_at: "2024-01-15T10:00:00Z",
              },
              {
                id: 2,
                body: null,
                user: { login: "bob", type: "User" },
                created_at: "2024-01-15T10:01:00Z",
              },
              {
                id: 3,
                body: "Missing user",
                user: null,
                created_at: "2024-01-15T10:02:00Z",
              },
            ],
          };
        },
      });

      const comments = await issueOps.getDiscussionComments(testRef);

      expect(comments).toHaveLength(1);
      expect(comments[0].author).toBe("alice");
    });

    it("should handle pagination across multiple pages", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 1, body: "Page 1", user: { login: "alice" }, created_at: "2024-01-01T00:00:00Z" },
            ],
          };
          yield {
            data: [
              { id: 2, body: "Page 2", user: { login: "bob" }, created_at: "2024-01-02T00:00:00Z" },
            ],
          };
        },
      });

      const comments = await issueOps.getDiscussionComments(testRef);

      expect(comments).toHaveLength(2);
    });

    it("should include thumbsUp/thumbsDown reactions from inline comment data", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              {
                id: 1,
                body: "Strong support",
                user: { login: "alice" },
                created_at: "2024-01-15T10:00:00Z",
                reactions: { "+1": 5, "-1": 1 },
              },
              {
                id: 2,
                body: "No reactions here",
                user: { login: "bob" },
                created_at: "2024-01-15T11:00:00Z",
                reactions: { "+1": 0, "-1": 0 },
              },
              {
                id: 3,
                body: "No reactions field",
                user: { login: "carol" },
                created_at: "2024-01-15T12:00:00Z",
              },
            ],
          };
        },
      });

      const comments = await issueOps.getDiscussionComments(testRef);

      expect(comments).toHaveLength(3);
      expect(comments[0].reactions).toEqual({ thumbsUp: 5, thumbsDown: 1 });
      expect(comments[1].reactions).toBeUndefined();
      expect(comments[2].reactions).toBeUndefined();
    });

  });

  describe("getIssueContext", () => {
    it("should combine issue details and comments", async () => {
      mockClient.rest.issues.get = vi.fn().mockResolvedValue({
        data: {
          title: "Feature Request",
          body: "Please add this feature",
          user: { login: "bob" },
        },
      });

      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { id: 1, body: "Good idea!", user: { login: "alice" }, created_at: "2024-01-15T10:00:00Z" },
            ],
          };
        },
      });

      const context = await issueOps.getIssueContext(testRef);

      expect(context.title).toBe("Feature Request");
      expect(context.body).toBe("Please add this feature");
      expect(context.author).toBe("bob");
      expect(context.comments).toHaveLength(1);
      expect(context.comments[0].author).toBe("alice");
    });

    it("should fetch details and comments in parallel", async () => {
      // Use fake timers for deterministic test execution
      vi.useFakeTimers();

      try {
        // Track execution order to verify parallel execution
        const executionOrder: string[] = [];

        mockClient.rest.issues.get = vi.fn().mockImplementation(async () => {
          executionOrder.push("get-start");
          await new Promise((r) => setTimeout(r, 100));
          executionOrder.push("get-end");
          return { data: { title: "Test", body: "Body", user: { login: "testAuthor" } } };
        });

        mockClient.paginate.iterator = vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() {
            executionOrder.push("list-start");
            await new Promise((r) => setTimeout(r, 100));
            executionOrder.push("list-end");
            yield { data: [] };
          },
        });

        // Start the operation but don't await yet
        const resultPromise = issueOps.getIssueContext(testRef);

        // Allow microtasks to process (both operations should start)
        await vi.advanceTimersByTimeAsync(0);

        // Verify both operations started before advancing timers
        expect(executionOrder).toContain("get-start");
        expect(executionOrder).toContain("list-start");
        expect(executionOrder).not.toContain("get-end");
        expect(executionOrder).not.toContain("list-end");

        // Now advance timers to complete both operations
        await vi.advanceTimersByTimeAsync(100);

        // Wait for the result
        await resultPromise;

        // Both operations should start before either finishes (parallel execution)
        // If sequential: get-start, get-end, list-start, list-end
        // If parallel: get-start, list-start, (get-end|list-end in any order)
        expect(executionOrder[0]).toBe("get-start");
        expect(executionOrder[1]).toBe("list-start");
        // Both started before first ended = parallel execution confirmed
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // getDiscussionReadiness
  // ─────────────────────────────────────────────────────────────────────────────

  describe("getDiscussionReadiness", () => {
    it("should return 👍 reactors as lowercased set", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: { login: "Alice" } },
              { content: "+1", user: { login: "Bob" } },
            ],
          };
        },
      });

      const result = await issueOps.getDiscussionReadiness(testRef);
      expect(result).toEqual(new Set(["alice", "bob"]));
    });

    it("should ignore non-👍 reactions", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: { login: "Alice" } },
              { content: "-1", user: { login: "Bob" } },
              { content: "confused", user: { login: "Charlie" } },
              { content: "heart", user: { login: "Dave" } },
            ],
          };
        },
      });

      const result = await issueOps.getDiscussionReadiness(testRef);
      expect(result).toEqual(new Set(["alice"]));
    });

    it("should return empty set when no reactions", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { data: [] };
        },
      });

      const result = await issueOps.getDiscussionReadiness(testRef);
      expect(result.size).toBe(0);
    });

    it("should skip reactions without user info", async () => {
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: { login: "Alice" } },
              { content: "+1", user: null },
              { content: "+1" },
            ],
          };
        },
      });

      const result = await issueOps.getDiscussionReadiness(testRef);
      expect(result).toEqual(new Set(["alice"]));
    });

    it("should log info for null-user readiness reactions", async () => {
      mockLogger.info.mockClear();
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: { login: "Alice" } },
              { content: "+1", user: null },
              { content: "+1", user: null },
            ],
          };
        },
      });

      const result = await issueOps.getDiscussionReadiness(testRef);
      expect(result).toEqual(new Set(["alice"]));
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Issue #42: skipped 2 readiness reaction(s) without users (likely deleted accounts).",
      );
    });

    it("should not log when all reactions have users", async () => {
      mockLogger.info.mockClear();
      mockClient.paginate.iterator = vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            data: [
              { content: "+1", user: { login: "Alice" } },
              { content: "+1", user: { login: "Bob" } },
            ],
          };
        },
      });

      await issueOps.getDiscussionReadiness(testRef);
      expect(mockLogger.info).not.toHaveBeenCalled();
    });
  });
});

describe("getErrorStatus", () => {
  it("returns null for non-object values", () => {
    expect(getErrorStatus("string error")).toBeNull();
    expect(getErrorStatus(42)).toBeNull();
    expect(getErrorStatus(undefined)).toBeNull();
    expect(getErrorStatus(true)).toBeNull();
  });

  it("returns null for null", () => {
    expect(getErrorStatus(null)).toBeNull();
  });

  it("returns null when error has no status field", () => {
    expect(getErrorStatus({ message: "not found" })).toBeNull();
    expect(getErrorStatus({})).toBeNull();
  });

  it("returns null when status is not a number", () => {
    expect(getErrorStatus({ status: "404" })).toBeNull();
    expect(getErrorStatus({ status: null })).toBeNull();
    expect(getErrorStatus({ status: undefined })).toBeNull();
  });

  it("returns the numeric status code", () => {
    expect(getErrorStatus({ status: 404 })).toBe(404);
    expect(getErrorStatus({ status: 422 })).toBe(422);
    expect(getErrorStatus({ status: 500 })).toBe(500);
  });
});
