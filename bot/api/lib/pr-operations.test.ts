import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROperations, createPROperations } from "./pr-operations.js";
import type { PRClient } from "./pr-operations.js";
import type { PRRef } from "./types.js";
import { buildNotificationComment, NOTIFICATION_TYPES } from "./bot-comments.js";
import { LABELS } from "../config.js";

/**
 * Tests for PROperations
 *
 * These tests verify PR-specific operations:
 * - Client validation
 * - PR retrieval and transformation
 * - Label operations
 * - Comment operations
 * - Finding PRs by label
 * - Approval counting
 */

describe("createPROperations", () => {
  const testConfig = { appId: 12345 };

  const createValidClient = () => ({
    rest: {
      pulls: {
        get: vi.fn(),
        update: vi.fn(),
        listReviews: vi.fn(),
        listCommits: vi.fn(),
        listReviewComments: vi.fn(),
        listFiles: vi.fn(),
      },
      issues: {
        get: vi.fn(),
        addLabels: vi.fn(),
        removeLabel: vi.fn(),
        createComment: vi.fn(),
        listForRepo: vi.fn(),
        listComments: vi.fn(),
      },
      checks: {
        listForRef: vi.fn(),
      },
      repos: {
        getCombinedStatusForRef: vi.fn(),
      },
    },
  });

  it("should create PROperations from valid client with config", () => {
    const validClient = createValidClient();
    const ops = createPROperations(validClient, testConfig);
    expect(ops).toBeInstanceOf(PROperations);
  });

  it("should throw for null input", () => {
    expect(() => createPROperations(null, testConfig)).toThrow("Invalid GitHub client");
  });

  it("should throw for undefined input", () => {
    expect(() => createPROperations(undefined, testConfig)).toThrow("Invalid GitHub client");
  });

  it("should throw for object missing rest property", () => {
    expect(() => createPROperations({}, testConfig)).toThrow("Invalid GitHub client");
  });

  it("should throw for object with null rest property", () => {
    expect(() => createPROperations({ rest: null }, testConfig)).toThrow("Invalid GitHub client");
  });

  it("should throw for object missing rest.pulls", () => {
    const invalidClient = {
      rest: {
        issues: {
          addLabels: vi.fn(),
          removeLabel: vi.fn(),
          createComment: vi.fn(),
          listForRepo: vi.fn(),
          listComments: vi.fn(),
        },
      },
    };
    expect(() => createPROperations(invalidClient, testConfig)).toThrow("Invalid GitHub client");
  });

  it("should throw for object missing rest.pulls.get", () => {
    const invalidClient = {
      rest: {
        pulls: {
          update: vi.fn(),
          listReviews: vi.fn(),
          listCommits: vi.fn(),
          listReviewComments: vi.fn(),
          // missing get
        },
        issues: {
          addLabels: vi.fn(),
          removeLabel: vi.fn(),
          createComment: vi.fn(),
          listForRepo: vi.fn(),
          listComments: vi.fn(),
        },
      },
    };
    expect(() => createPROperations(invalidClient, testConfig)).toThrow("Invalid GitHub client");
  });

  it("should throw for object missing rest.issues", () => {
    const invalidClient = {
      rest: {
        pulls: {
          get: vi.fn(),
          update: vi.fn(),
          listReviews: vi.fn(),
          listCommits: vi.fn(),
          listReviewComments: vi.fn(),
        },
      },
    };
    expect(() => createPROperations(invalidClient, testConfig)).toThrow("Invalid GitHub client");
  });

  it("should throw for object missing required issues methods", () => {
    const invalidClient = {
      rest: {
        pulls: {
          get: vi.fn(),
          update: vi.fn(),
          listReviews: vi.fn(),
          listCommits: vi.fn(),
          listReviewComments: vi.fn(),
        },
        issues: {
          get: vi.fn(),
          addLabels: vi.fn(),
          // missing removeLabel, createComment, listForRepo, listComments
        },
      },
    };
    expect(() => createPROperations(invalidClient, testConfig)).toThrow("Invalid GitHub client");
  });

  it("should throw for object missing listComments method", () => {
    const invalidClient = {
      rest: {
        pulls: {
          get: vi.fn(),
          update: vi.fn(),
          listReviews: vi.fn(),
          listCommits: vi.fn(),
          listReviewComments: vi.fn(),
        },
        issues: {
          get: vi.fn(),
          addLabels: vi.fn(),
          removeLabel: vi.fn(),
          createComment: vi.fn(),
          listForRepo: vi.fn(),
          // missing listComments
        },
      },
    };
    expect(() => createPROperations(invalidClient, testConfig)).toThrow("Invalid GitHub client");
  });

  it("should throw for object missing listCommits method", () => {
    const invalidClient = {
      rest: {
        pulls: {
          get: vi.fn(),
          update: vi.fn(),
          listReviews: vi.fn(),
          // missing listCommits
          listReviewComments: vi.fn(),
        },
        issues: {
          get: vi.fn(),
          addLabels: vi.fn(),
          removeLabel: vi.fn(),
          createComment: vi.fn(),
          listForRepo: vi.fn(),
          listComments: vi.fn(),
        },
      },
    };
    expect(() => createPROperations(invalidClient, testConfig)).toThrow("Invalid GitHub client");
  });

  it("should throw for object missing listReviewComments method", () => {
    const invalidClient = {
      rest: {
        pulls: {
          get: vi.fn(),
          update: vi.fn(),
          listReviews: vi.fn(),
          listCommits: vi.fn(),
          // missing listReviewComments
        },
        issues: {
          get: vi.fn(),
          addLabels: vi.fn(),
          removeLabel: vi.fn(),
          createComment: vi.fn(),
          listForRepo: vi.fn(),
          listComments: vi.fn(),
        },
      },
    };
    expect(() => createPROperations(invalidClient, testConfig)).toThrow("Invalid GitHub client");
  });
});

describe("PROperations", () => {
  let mockClient: PRClient;
  let prOps: PROperations;
  const testRef: PRRef = { owner: "test-org", repo: "test-repo", prNumber: 42 };
  const testAppId = 12345;

  beforeEach(() => {
    mockClient = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              number: 42,
              node_id: "PR_kwNode42",
              state: "open",
              merged: false,
              created_at: "2024-01-10T08:00:00Z",
              updated_at: "2024-01-15T10:30:00Z",
              user: { login: "test-author" },
              head: { sha: "abc123def456" },
              mergeable: true,
              draft: false,
            },
          }),
          update: vi.fn().mockResolvedValue({}),
          listReviews: vi.fn().mockResolvedValue({ data: [] }),
          listCommits: vi.fn().mockResolvedValue({ data: [] }),
          listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
          listFiles: vi.fn().mockResolvedValue({ data: [] }),
        },
        issues: {
          get: vi.fn().mockResolvedValue({ data: { labels: [] } }),
          addLabels: vi.fn().mockResolvedValue({}),
          removeLabel: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
          listForRepo: vi.fn().mockResolvedValue({ data: [] }),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
        },
        checks: {
          listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }),
        },
        repos: {
          getCombinedStatusForRef: vi.fn().mockResolvedValue({ data: { state: "pending", total_count: 0, statuses: [] } }),
        },
      },
    } as unknown as PRClient;

    prOps = new PROperations(mockClient, testAppId);
  });

  describe("get", () => {
    it("should return transformed PR data with correct fields", async () => {
      const result = await prOps.get(testRef);

      expect(result).toEqual({
        number: 42,
        nodeId: "PR_kwNode42",
        state: "open",
        merged: false,
        createdAt: new Date("2024-01-10T08:00:00Z"),
        updatedAt: new Date("2024-01-15T10:30:00Z"),
        author: "test-author",
        headSha: "abc123def456",
        mergeable: true,
        draft: false,
      });
      expect(mockClient.rest.pulls.get).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        pull_number: 42,
      });
    });

    it("should return 'unknown' for author when user is null", async () => {
      vi.mocked(mockClient.rest.pulls.get).mockResolvedValue({
        data: {
          number: 42,
          state: "open",
          merged: false,
          created_at: "2024-01-10T08:00:00Z",
          updated_at: "2024-01-15T10:30:00Z",
          user: null,
          head: { sha: "abc123" },
        },
      });

      const result = await prOps.get(testRef);

      expect(result.author).toBe("unknown");
    });

    it("should correctly transform merged state", async () => {
      vi.mocked(mockClient.rest.pulls.get).mockResolvedValue({
        data: {
          number: 42,
          state: "closed",
          merged: true,
          created_at: "2024-01-10T08:00:00Z",
          updated_at: "2024-01-15T10:30:00Z",
          user: { login: "author" },
          head: { sha: "abc123" },
        },
      });

      const result = await prOps.get(testRef);

      expect(result.state).toBe("closed");
      expect(result.merged).toBe(true);
    });

    it("maps node_id from REST response to nodeId on the returned object", async () => {
      vi.mocked(mockClient.rest.pulls.get).mockResolvedValue({
        data: {
          number: 42,
          node_id: "PR_kwABCDEF123",
          state: "open",
          merged: false,
          created_at: "2024-01-10T08:00:00Z",
          updated_at: "2024-01-15T10:30:00Z",
          user: { login: "author" },
          head: { sha: "sha1" },
          draft: false,
          mergeable: true,
        },
      });

      const result = await prOps.get(testRef);

      expect(result.nodeId).toBe("PR_kwABCDEF123");
    });
  });

  describe("close", () => {
    it("should call pulls.update with state closed", async () => {
      await prOps.close(testRef);

      expect(mockClient.rest.pulls.update).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        pull_number: 42,
        state: "closed",
      });
    });
  });

  describe("getCombinedStatus", () => {
    it("returns the combined state, count, and legacy status contexts", async () => {
      vi.mocked(mockClient.rest.repos.getCombinedStatusForRef).mockResolvedValueOnce({
        data: {
          state: "pending",
          total_count: 2,
          statuses: [
            { state: "pending", context: "legacy / build" },
            { state: "success", context: "legacy / lint" },
          ],
        },
      });

      const result = await prOps.getCombinedStatus("test-org", "test-repo", "abc123");

      expect(result).toEqual({
        state: "pending",
        totalCount: 2,
        statuses: [
          { state: "pending", context: "legacy / build" },
          { state: "success", context: "legacy / lint" },
        ],
      });
      expect(mockClient.rest.repos.getCombinedStatusForRef).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        ref: "abc123",
      });
    });
  });

  describe("addLabels", () => {
    it("should call issues.addLabels with correct parameters", async () => {
      await prOps.addLabels(testRef, ["bug", "hivemoot:candidate"]);

      expect(mockClient.rest.issues.addLabels).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        labels: ["bug", "hivemoot:candidate"],
      });
    });

    it("should handle single label", async () => {
      await prOps.addLabels(testRef, ["hivemoot:stale"]);

      expect(mockClient.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ["hivemoot:stale"] })
      );
    });
  });

  describe("removeLabel", () => {
    it("should call issues.removeLabel with correct parameters", async () => {
      await prOps.removeLabel(testRef, "hivemoot:stale");

      expect(mockClient.rest.issues.removeLabel).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        name: "hivemoot:stale",
      });
    });

    it("should ignore 404 errors (label does not exist)", async () => {
      const error = new Error("Not Found") as Error & { status: number };
      error.status = 404;
      vi.mocked(mockClient.rest.issues.removeLabel).mockRejectedValue(error);

      // Should not throw
      await expect(prOps.removeLabel(testRef, "nonexistent")).resolves.toBeUndefined();
    });

    it("should rethrow non-404 errors", async () => {
      const error = new Error("Server Error") as Error & { status: number };
      error.status = 500;
      vi.mocked(mockClient.rest.issues.removeLabel).mockRejectedValue(error);

      await expect(prOps.removeLabel(testRef, "label")).rejects.toThrow("Server Error");
    });

    it("should rethrow errors without status", async () => {
      const error = new Error("Network Error");
      vi.mocked(mockClient.rest.issues.removeLabel).mockRejectedValue(error);

      await expect(prOps.removeLabel(testRef, "label")).rejects.toThrow("Network Error");
    });
  });

  describe("removeGovernanceLabels", () => {
    it("should remove implementation, merge-ready, squash-queued, and automerge labels", async () => {
      await prOps.removeGovernanceLabels(testRef);

      expect(mockClient.rest.issues.removeLabel).toHaveBeenCalledTimes(4);
      expect(mockClient.rest.issues.removeLabel).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        name: LABELS.IMPLEMENTATION,
      });
      expect(mockClient.rest.issues.removeLabel).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        name: LABELS.MERGE_READY,
      });
      expect(mockClient.rest.issues.removeLabel).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        name: LABELS.SQUASH_QUEUED,
      });
      expect(mockClient.rest.issues.removeLabel).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        name: LABELS.AUTOMERGE,
      });
    });

    it("should succeed even when labels are not present (404s)", async () => {
      const error = new Error("Not Found") as Error & { status: number };
      error.status = 404;
      vi.mocked(mockClient.rest.issues.removeLabel).mockRejectedValue(error);

      await expect(prOps.removeGovernanceLabels(testRef)).resolves.toBeUndefined();
    });

    it("should propagate non-404 errors from the first label", async () => {
      const error = new Error("Server Error") as Error & { status: number };
      error.status = 500;
      vi.mocked(mockClient.rest.issues.removeLabel).mockRejectedValue(error);

      await expect(prOps.removeGovernanceLabels(testRef)).rejects.toThrow("Server Error");
    });
  });

  describe("comment", () => {
    it("should call issues.createComment with correct body", async () => {
      await prOps.comment(testRef, "This PR looks good!");

      expect(mockClient.rest.issues.createComment).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        body: "This PR looks good!",
      });
    });
  });

  describe("getLabels", () => {
    it("should return label names for a PR", async () => {
      vi.mocked(mockClient.rest.issues.get).mockResolvedValue({
        data: { labels: [{ name: "hivemoot:candidate" }, { name: "bug" }] },
      });

      const labels = await prOps.getLabels(testRef);

      expect(labels).toEqual(["hivemoot:candidate", "bug"]);
      expect(mockClient.rest.issues.get).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
      });
    });
  });

  describe("hasLabel", () => {
    it("should return true when label exists", () => {
      const pr = { labels: [{ name: "bug" }, { name: "hivemoot:candidate" }] };

      expect(prOps.hasLabel(pr, "hivemoot:candidate")).toBe(true);
    });

    it("should return false when label is missing", () => {
      const pr = { labels: [{ name: "bug" }] };

      expect(prOps.hasLabel(pr, "hivemoot:candidate")).toBe(false);
    });

    it("should return false when labels array is empty", () => {
      const pr = { labels: [] };

      expect(prOps.hasLabel(pr, "any-label")).toBe(false);
    });

    it("should be case-sensitive", () => {
      const pr = { labels: [{ name: "Bug" }] };

      expect(prOps.hasLabel(pr, "bug")).toBe(false);
      expect(prOps.hasLabel(pr, "Bug")).toBe(true);
    });
  });

  describe("findPRsWithLabel", () => {
    it("should return only items with pull_request property (filter out issues)", async () => {
      vi.mocked(mockClient.rest.issues.listForRepo).mockResolvedValue({
        data: [
          { number: 1, pull_request: {}, created_at: "2024-01-10T10:00:00Z", updated_at: "2024-01-15T10:00:00Z", labels: [] },
          { number: 2, created_at: "2024-01-10T11:00:00Z", updated_at: "2024-01-15T11:00:00Z", labels: [] }, // No pull_request - this is an issue
          { number: 3, pull_request: {}, created_at: "2024-01-10T12:00:00Z", updated_at: "2024-01-15T12:00:00Z", labels: [] },
        ],
      });

      const result = await prOps.findPRsWithLabel("test-org", "test-repo", "hivemoot:candidate");

      expect(result).toHaveLength(2);
      expect(result.map((pr) => pr.number)).toEqual([1, 3]);
    });

    it("should transform data correctly including createdAt", async () => {
      vi.mocked(mockClient.rest.issues.listForRepo).mockResolvedValue({
        data: [
          {
            number: 42,
            pull_request: {},
            created_at: "2024-01-10T08:00:00Z",
            updated_at: "2024-01-15T10:30:00Z",
            labels: [{ name: "hivemoot:candidate" }, { name: "bug" }],
          },
        ],
      });

      const result = await prOps.findPRsWithLabel("test-org", "test-repo", "hivemoot:candidate");

      expect(result).toEqual([
        {
          number: 42,
          createdAt: new Date("2024-01-10T08:00:00Z"),
          updatedAt: new Date("2024-01-15T10:30:00Z"),
          labels: [{ name: "hivemoot:candidate" }, { name: "bug" }],
        },
      ]);
    });

    it("should return empty array when no matches", async () => {
      vi.mocked(mockClient.rest.issues.listForRepo).mockResolvedValue({ data: [] });

      const result = await prOps.findPRsWithLabel("test-org", "test-repo", "hivemoot:candidate");

      expect(result).toEqual([]);
    });

    it("should call listForRepo with correct parameters including page", async () => {
      vi.mocked(mockClient.rest.issues.listForRepo).mockResolvedValue({ data: [] });

      await prOps.findPRsWithLabel("owner", "repo", "my-label");

      expect(mockClient.rest.issues.listForRepo).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        state: "open",
        labels: "my-label",
        per_page: 100,
        page: 1,
      });
    });

    it("should paginate through all pages when results fill full pages", async () => {
      // First page: 100 items (full page triggers next fetch)
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        number: i + 1,
        pull_request: {},
        created_at: "2024-01-10T10:00:00Z",
        updated_at: "2024-01-15T10:00:00Z",
        labels: [],
      }));
      // Second page: 50 items (partial page stops pagination)
      const page2 = Array.from({ length: 50 }, (_, i) => ({
        number: i + 101,
        pull_request: {},
        created_at: "2024-01-10T10:00:00Z",
        updated_at: "2024-01-15T10:00:00Z",
        labels: [],
      }));

      vi.mocked(mockClient.rest.issues.listForRepo)
        .mockResolvedValueOnce({ data: page1 })
        .mockResolvedValueOnce({ data: page2 });

      const result = await prOps.findPRsWithLabel("test-org", "test-repo", "hivemoot:candidate");

      expect(result).toHaveLength(150);
      expect(result[0].number).toBe(1);
      expect(result[149].number).toBe(150);
      // 2 calls for canonical label pagination + 1 call for legacy alias "implementation"
      expect(mockClient.rest.issues.listForRepo).toHaveBeenCalledTimes(3);
      expect(mockClient.rest.issues.listForRepo).toHaveBeenNthCalledWith(1, expect.objectContaining({ page: 1, labels: "hivemoot:candidate" }));
      expect(mockClient.rest.issues.listForRepo).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2, labels: "hivemoot:candidate" }));
      expect(mockClient.rest.issues.listForRepo).toHaveBeenNthCalledWith(3, expect.objectContaining({ page: 1, labels: "implementation" }));
    });

    it("should stop paginating when an empty page is returned", async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        number: i + 1,
        pull_request: {},
        created_at: "2024-01-10T10:00:00Z",
        updated_at: "2024-01-15T10:00:00Z",
        labels: [],
      }));

      vi.mocked(mockClient.rest.issues.listForRepo)
        .mockResolvedValueOnce({ data: page1 })
        .mockResolvedValueOnce({ data: [] });

      const result = await prOps.findPRsWithLabel("test-org", "test-repo", "hivemoot:candidate");

      expect(result).toHaveLength(100);
      // 2 calls for canonical label + 1 call for legacy alias "implementation"
      expect(mockClient.rest.issues.listForRepo).toHaveBeenCalledTimes(3);
    });

    it("should filter issues from PRs across multiple pages", async () => {
      const page1 = [
        { number: 1, pull_request: {}, created_at: "2024-01-10T10:00:00Z", updated_at: "2024-01-15T10:00:00Z", labels: [] },
        { number: 2, created_at: "2024-01-10T10:00:00Z", updated_at: "2024-01-15T10:00:00Z", labels: [] }, // issue, not PR
      ];
      const page2 = [
        { number: 3, pull_request: {}, created_at: "2024-01-10T10:00:00Z", updated_at: "2024-01-15T10:00:00Z", labels: [] },
      ];

      // page1 has 2 items (< 100), so it looks like the last page
      vi.mocked(mockClient.rest.issues.listForRepo)
        .mockResolvedValueOnce({ data: page1 })

      const result = await prOps.findPRsWithLabel("test-org", "test-repo", "hivemoot:candidate");

      // Only PR items should be included
      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(1);
    });
  });

  describe("getLatestActivityDate", () => {
    const prCreatedAt = new Date("2024-01-10T08:00:00Z");

    it("should return latest non-bot comment date", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [
          { id: 1, created_at: "2024-01-12T10:00:00Z", performed_via_github_app: null },
          { id: 2, created_at: "2024-01-14T15:00:00Z", performed_via_github_app: null }, // Latest non-bot
          { id: 3, created_at: "2024-01-13T12:00:00Z", performed_via_github_app: { id: 99999 } }, // Other bot, still counts
        ],
      });

      const result = await prOps.getLatestActivityDate(testRef, prCreatedAt);

      expect(result).toEqual(new Date("2024-01-14T15:00:00Z"));
    });

    it("should filter out comments from our own app", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [
          { id: 1, created_at: "2024-01-12T10:00:00Z", performed_via_github_app: null },
          { id: 2, created_at: "2024-01-15T16:00:00Z", performed_via_github_app: { id: testAppId } }, // Our bot - ignored
          { id: 3, created_at: "2024-01-13T12:00:00Z", performed_via_github_app: null },
        ],
      });

      const result = await prOps.getLatestActivityDate(testRef, prCreatedAt);

      // Should return Jan 13, not Jan 15 (our bot's comment)
      expect(result).toEqual(new Date("2024-01-13T12:00:00Z"));
    });

    it("should return prCreatedAt when all comments are from our bot", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [
          { id: 1, created_at: "2024-01-12T10:00:00Z", performed_via_github_app: { id: testAppId } },
          { id: 2, created_at: "2024-01-15T16:00:00Z", performed_via_github_app: { id: testAppId } },
        ],
      });

      const result = await prOps.getLatestActivityDate(testRef, prCreatedAt);

      expect(result).toEqual(prCreatedAt);
    });

    it("should return prCreatedAt when no comments exist", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({ data: [] });

      const result = await prOps.getLatestActivityDate(testRef, prCreatedAt);

      expect(result).toEqual(prCreatedAt);
    });

    it("should count other bot comments as valid activity", async () => {
      const otherBotAppId = 99999;
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [
          { id: 1, created_at: "2024-01-12T10:00:00Z", performed_via_github_app: { id: otherBotAppId } },
          { id: 2, created_at: "2024-01-14T15:00:00Z", performed_via_github_app: { id: testAppId } }, // Our bot - ignored
        ],
      });

      const result = await prOps.getLatestActivityDate(testRef, prCreatedAt);

      // Other bot's comment should count
      expect(result).toEqual(new Date("2024-01-12T10:00:00Z"));
    });

    it("should call listComments with correct parameters including page", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({ data: [] });

      await prOps.getLatestActivityDate(testRef, prCreatedAt);

      expect(mockClient.rest.issues.listComments).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 42,
        per_page: 100,
        page: 1,
      });
    });

    it("should use commit date when more recent than comments", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [
          { id: 1, created_at: "2024-01-12T10:00:00Z", performed_via_github_app: null },
        ],
      });
      vi.mocked(mockClient.rest.pulls.listCommits).mockResolvedValue({
        data: [
          { sha: "abc123", commit: { committer: { date: "2024-01-15T10:00:00Z" } } },
        ],
      });

      const result = await prOps.getLatestActivityDate(testRef, prCreatedAt);

      expect(result).toEqual(new Date("2024-01-15T10:00:00Z"));
    });

    it("should use review date when more recent than other activity", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [
          { id: 1, created_at: "2024-01-12T10:00:00Z", performed_via_github_app: null },
        ],
      });
      vi.mocked(mockClient.rest.pulls.listCommits).mockResolvedValue({
        data: [
          { sha: "abc123", commit: { committer: { date: "2024-01-13T10:00:00Z" } } },
        ],
      });
      vi.mocked(mockClient.rest.pulls.listReviews).mockResolvedValue({
        data: [
          { state: "APPROVED", user: { login: "reviewer" }, submitted_at: "2024-01-16T10:00:00Z" },
        ],
      });

      const result = await prOps.getLatestActivityDate(testRef, prCreatedAt);

      expect(result).toEqual(new Date("2024-01-16T10:00:00Z"));
    });

    it("should use review comment date when more recent than other activity", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [
          { id: 1, created_at: "2024-01-12T10:00:00Z", performed_via_github_app: null },
        ],
      });
      vi.mocked(mockClient.rest.pulls.listCommits).mockResolvedValue({
        data: [
          { sha: "abc123", commit: { committer: { date: "2024-01-13T10:00:00Z" } } },
        ],
      });
      vi.mocked(mockClient.rest.pulls.listReviews).mockResolvedValue({
        data: [
          { state: "APPROVED", user: { login: "reviewer" }, submitted_at: "2024-01-14T10:00:00Z" },
        ],
      });
      vi.mocked(mockClient.rest.pulls.listReviewComments).mockResolvedValue({
        data: [
          { id: 1, created_at: "2024-01-17T10:00:00Z" },
        ],
      });

      const result = await prOps.getLatestActivityDate(testRef, prCreatedAt);

      expect(result).toEqual(new Date("2024-01-17T10:00:00Z"));
    });

    it("should return prCreatedAt when only commits exist but have no committer date", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({ data: [] });
      vi.mocked(mockClient.rest.pulls.listCommits).mockResolvedValue({
        data: [
          { sha: "abc123", commit: { committer: null } },
        ],
      });

      const result = await prOps.getLatestActivityDate(testRef, prCreatedAt);

      expect(result).toEqual(prCreatedAt);
    });

    it("should check all activity sources in parallel", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({ data: [] });
      vi.mocked(mockClient.rest.pulls.listCommits).mockResolvedValue({ data: [] });
      vi.mocked(mockClient.rest.pulls.listReviews).mockResolvedValue({ data: [] });
      vi.mocked(mockClient.rest.pulls.listReviewComments).mockResolvedValue({ data: [] });

      await prOps.getLatestActivityDate(testRef, prCreatedAt);

      // All four endpoints should be called
      expect(mockClient.rest.issues.listComments).toHaveBeenCalled();
      expect(mockClient.rest.pulls.listCommits).toHaveBeenCalled();
      expect(mockClient.rest.pulls.listReviews).toHaveBeenCalled();
      expect(mockClient.rest.pulls.listReviewComments).toHaveBeenCalled();
    });

    it("should find most recent activity across all sources with mixed dates", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [
          { id: 1, created_at: "2024-01-18T08:00:00Z", performed_via_github_app: null },
        ],
      });
      vi.mocked(mockClient.rest.pulls.listCommits).mockResolvedValue({
        data: [
          { sha: "abc123", commit: { committer: { date: "2024-01-15T10:00:00Z" } } },
        ],
      });
      vi.mocked(mockClient.rest.pulls.listReviews).mockResolvedValue({
        data: [
          { state: "APPROVED", user: { login: "reviewer" }, submitted_at: "2024-01-16T10:00:00Z" },
        ],
      });
      vi.mocked(mockClient.rest.pulls.listReviewComments).mockResolvedValue({
        data: [
          { id: 1, created_at: "2024-01-17T10:00:00Z" },
        ],
      });

      const result = await prOps.getLatestActivityDate(testRef, prCreatedAt);

      // Issue comment at Jan 18 is the most recent
      expect(result).toEqual(new Date("2024-01-18T08:00:00Z"));
    });
  });

  describe("getLatestAuthorActivityDate", () => {
    const prCreatedAt = new Date("2024-01-10T08:00:00Z");

    it("should return the latest of comments or commits", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [
          { id: 1, created_at: "2024-01-12T10:00:00Z", performed_via_github_app: null },
        ],
      });
      vi.mocked(mockClient.rest.pulls.listCommits).mockResolvedValue({
        data: [
          { sha: "abc", commit: { committer: { date: "2024-01-13T10:00:00Z" } } },
        ],
      });

      const result = await prOps.getLatestAuthorActivityDate(testRef, prCreatedAt);

      expect(result).toEqual(new Date("2024-01-13T10:00:00Z"));
    });

    it("should fall back to createdAt when no activity exists", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({ data: [] });
      vi.mocked(mockClient.rest.pulls.listCommits).mockResolvedValue({ data: [] });

      const result = await prOps.getLatestAuthorActivityDate(testRef, prCreatedAt);

      expect(result).toEqual(prCreatedAt);
    });
  });

  describe("getApproverLogins", () => {
    it("should return set of approving usernames", async () => {
      vi.mocked(mockClient.rest.pulls.listReviews).mockResolvedValue({
        data: [
          { state: "APPROVED", user: { login: "user1" }, submitted_at: "2024-01-01T10:00:00Z" },
          { state: "APPROVED", user: { login: "user2" }, submitted_at: "2024-01-01T11:00:00Z" },
        ],
      });

      const logins = await prOps.getApproverLogins(testRef);

      expect(logins).toEqual(new Set(["user1", "user2"]));
    });

    it("should not include users whose latest review is CHANGES_REQUESTED", async () => {
      vi.mocked(mockClient.rest.pulls.listReviews).mockResolvedValue({
        data: [
          { state: "APPROVED", user: { login: "user1" }, submitted_at: "2024-01-01T10:00:00Z" },
          { state: "CHANGES_REQUESTED", user: { login: "user1" }, submitted_at: "2024-01-01T14:00:00Z" },
          { state: "APPROVED", user: { login: "user2" }, submitted_at: "2024-01-01T11:00:00Z" },
        ],
      });

      const logins = await prOps.getApproverLogins(testRef);

      expect(logins).toEqual(new Set(["user2"]));
    });

    it("should return empty set for no reviews", async () => {
      vi.mocked(mockClient.rest.pulls.listReviews).mockResolvedValue({ data: [] });

      const logins = await prOps.getApproverLogins(testRef);

      expect(logins).toEqual(new Set());
    });
  });

  describe("getApprovalCount", () => {
    it("should count unique approving users", async () => {
      vi.mocked(mockClient.rest.pulls.listReviews).mockResolvedValue({
        data: [
          { state: "APPROVED", user: { login: "user1" }, submitted_at: "2024-01-01T10:00:00Z" },
          { state: "APPROVED", user: { login: "user2" }, submitted_at: "2024-01-01T11:00:00Z" },
          { state: "APPROVED", user: { login: "user3" }, submitted_at: "2024-01-01T12:00:00Z" },
        ],
      });

      const count = await prOps.getApprovalCount(testRef);

      expect(count).toBe(3);
    });

    it("should deduplicate multiple approvals from same user", async () => {
      vi.mocked(mockClient.rest.pulls.listReviews).mockResolvedValue({
        data: [
          { state: "APPROVED", user: { login: "user1" }, submitted_at: "2024-01-01T10:00:00Z" },
          { state: "APPROVED", user: { login: "user1" }, submitted_at: "2024-01-01T11:00:00Z" },
          { state: "APPROVED", user: { login: "user2" }, submitted_at: "2024-01-01T12:00:00Z" },
        ],
      });

      const count = await prOps.getApprovalCount(testRef);

      expect(count).toBe(2);
    });

    it("should return 0 for no reviews", async () => {
      vi.mocked(mockClient.rest.pulls.listReviews).mockResolvedValue({ data: [] });

      const count = await prOps.getApprovalCount(testRef);

      expect(count).toBe(0);
    });

    it("should skip reviews without user", async () => {
      vi.mocked(mockClient.rest.pulls.listReviews).mockResolvedValue({
        data: [
          { state: "APPROVED", user: { login: "user1" }, submitted_at: "2024-01-01T10:00:00Z" },
          { state: "APPROVED", user: null, submitted_at: "2024-01-01T11:00:00Z" },
          { state: "APPROVED", user: { login: "user2" }, submitted_at: "2024-01-01T12:00:00Z" },
        ],
      });

      const count = await prOps.getApprovalCount(testRef);

      expect(count).toBe(2);
    });

    it("should only count APPROVED state (not other review states)", async () => {
      vi.mocked(mockClient.rest.pulls.listReviews).mockResolvedValue({
        data: [
          { state: "APPROVED", user: { login: "user1" }, submitted_at: "2024-01-01T10:00:00Z" },
          { state: "CHANGES_REQUESTED", user: { login: "user2" }, submitted_at: "2024-01-01T11:00:00Z" },
          { state: "COMMENTED", user: { login: "user3" }, submitted_at: "2024-01-01T12:00:00Z" },
          { state: "PENDING", user: { login: "user4" }, submitted_at: "2024-01-01T13:00:00Z" },
        ],
      });

      const count = await prOps.getApprovalCount(testRef);

      expect(count).toBe(1);
    });

    it("should NOT count user if they approved then later requested changes", async () => {
      vi.mocked(mockClient.rest.pulls.listReviews).mockResolvedValue({
        data: [
          { state: "APPROVED", user: { login: "user1" }, submitted_at: "2024-01-01T10:00:00Z" },
          { state: "CHANGES_REQUESTED", user: { login: "user1" }, submitted_at: "2024-01-01T14:00:00Z" },
          { state: "APPROVED", user: { login: "user2" }, submitted_at: "2024-01-01T11:00:00Z" },
        ],
      });

      const count = await prOps.getApprovalCount(testRef);

      expect(count).toBe(1); // Only user2, not user1
    });

    it("should count user if they requested changes then later approved", async () => {
      vi.mocked(mockClient.rest.pulls.listReviews).mockResolvedValue({
        data: [
          { state: "CHANGES_REQUESTED", user: { login: "user1" }, submitted_at: "2024-01-01T10:00:00Z" },
          { state: "APPROVED", user: { login: "user1" }, submitted_at: "2024-01-01T14:00:00Z" },
        ],
      });

      const count = await prOps.getApprovalCount(testRef);

      expect(count).toBe(1);
    });

    it("should NOT count user if their approval was dismissed", async () => {
      vi.mocked(mockClient.rest.pulls.listReviews).mockResolvedValue({
        data: [
          { state: "APPROVED", user: { login: "user1" }, submitted_at: "2024-01-01T10:00:00Z" },
          { state: "DISMISSED", user: { login: "user1" }, submitted_at: "2024-01-01T14:00:00Z" },
          { state: "APPROVED", user: { login: "user2" }, submitted_at: "2024-01-01T11:00:00Z" },
        ],
      });

      const count = await prOps.getApprovalCount(testRef);

      expect(count).toBe(1); // Only user2
    });

    it("should ignore COMMENTED reviews when determining latest state", async () => {
      vi.mocked(mockClient.rest.pulls.listReviews).mockResolvedValue({
        data: [
          { state: "APPROVED", user: { login: "user1" }, submitted_at: "2024-01-01T10:00:00Z" },
          { state: "COMMENTED", user: { login: "user1" }, submitted_at: "2024-01-01T14:00:00Z" },
        ],
      });

      const count = await prOps.getApprovalCount(testRef);

      expect(count).toBe(1); // COMMENTED doesn't override APPROVED
    });

    it("should call listReviews with correct parameters including page", async () => {
      vi.mocked(mockClient.rest.pulls.listReviews).mockResolvedValue({ data: [] });

      await prOps.getApprovalCount(testRef);

      expect(mockClient.rest.pulls.listReviews).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        pull_number: 42,
        per_page: 100,
        page: 1,
      });
    });
  });

  describe("listCommentsWithBody", () => {
    it("should return all comments with bodies", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [
          { id: 1, body: "First comment", created_at: "2024-01-12T10:00:00Z" },
          { id: 2, body: "Second comment", created_at: "2024-01-13T10:00:00Z" },
        ],
      });

      const result = await prOps.listCommentsWithBody(testRef);

      expect(result).toHaveLength(2);
      expect(result[0].body).toBe("First comment");
      expect(result[1].body).toBe("Second comment");
    });

    it("should return empty array when no comments", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({ data: [] });

      const result = await prOps.listCommentsWithBody(testRef);

      expect(result).toEqual([]);
    });

    it("should include performed_via_github_app field", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [
          { id: 1, body: "Bot comment", created_at: "2024-01-12T10:00:00Z", performed_via_github_app: { id: testAppId } },
        ],
      });

      const result = await prOps.listCommentsWithBody(testRef);

      expect(result[0].performed_via_github_app?.id).toBe(testAppId);
    });
  });

  describe("hasNotificationComment", () => {
    it("should return true when matching notification exists", async () => {
      const notificationBody = buildNotificationComment(
        "Issue passed voting!",
        42,
        NOTIFICATION_TYPES.VOTING_PASSED
      );
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [
          {
            id: 1,
            body: notificationBody,
            created_at: "2024-01-15T10:00:00Z",
            performed_via_github_app: { id: testAppId },
          },
        ],
      });

      const result = await prOps.hasNotificationComment(
        testRef,
        NOTIFICATION_TYPES.VOTING_PASSED,
        42
      );

      expect(result).toBe(true);
    });

    it("should return false when no comments exist", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [],
      });

      const result = await prOps.hasNotificationComment(
        testRef,
        NOTIFICATION_TYPES.VOTING_PASSED,
        42
      );

      expect(result).toBe(false);
    });

    it("should return false when comment is from different app", async () => {
      const notificationBody = buildNotificationComment(
        "Issue passed voting!",
        42,
        NOTIFICATION_TYPES.VOTING_PASSED
      );
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [
          {
            id: 1,
            body: notificationBody,
            created_at: "2024-01-15T10:00:00Z",
            performed_via_github_app: { id: 99999 },
          },
        ],
      });

      const result = await prOps.hasNotificationComment(
        testRef,
        NOTIFICATION_TYPES.VOTING_PASSED,
        42
      );

      expect(result).toBe(false);
    });

    it("should return false when notification is for different issue", async () => {
      const notificationBody = buildNotificationComment(
        "Issue passed voting!",
        99, // Different issue
        NOTIFICATION_TYPES.VOTING_PASSED
      );
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [
          {
            id: 1,
            body: notificationBody,
            created_at: "2024-01-15T10:00:00Z",
            performed_via_github_app: { id: testAppId },
          },
        ],
      });

      const result = await prOps.hasNotificationComment(
        testRef,
        NOTIFICATION_TYPES.VOTING_PASSED,
        42
      );

      expect(result).toBe(false);
    });

    it("should return false when comment has no body", async () => {
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [
          {
            id: 1,
            created_at: "2024-01-15T10:00:00Z",
            performed_via_github_app: { id: testAppId },
          },
        ],
      });

      const result = await prOps.hasNotificationComment(
        testRef,
        NOTIFICATION_TYPES.VOTING_PASSED,
        42
      );

      expect(result).toBe(false);
    });

    it("should return true without issueNumber filter", async () => {
      const notificationBody = buildNotificationComment(
        "Content",
        42,
        NOTIFICATION_TYPES.VOTING_PASSED
      );
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [
          {
            id: 1,
            body: notificationBody,
            created_at: "2024-01-15T10:00:00Z",
            performed_via_github_app: { id: testAppId },
          },
        ],
      });

      // No issueNumber filter — matches any issue
      const result = await prOps.hasNotificationComment(
        testRef,
        NOTIFICATION_TYPES.VOTING_PASSED
      );

      expect(result).toBe(true);
    });

    it("should handle comments without performed_via_github_app", async () => {
      const notificationBody = buildNotificationComment(
        "Content",
        42,
        NOTIFICATION_TYPES.VOTING_PASSED
      );
      vi.mocked(mockClient.rest.issues.listComments).mockResolvedValue({
        data: [
          {
            id: 1,
            body: notificationBody,
            created_at: "2024-01-15T10:00:00Z",
            // No performed_via_github_app — human comment
          },
        ],
      });

      const result = await prOps.hasNotificationComment(
        testRef,
        NOTIFICATION_TYPES.VOTING_PASSED,
        42
      );

      expect(result).toBe(false);
    });
  });

  describe("listFiles", () => {
    it("should return files from a single page", async () => {
      const files = [
        { filename: "README.md", additions: 5, deletions: 0, changes: 5, status: "modified" },
        { filename: "docs/guide.md", additions: 10, deletions: 2, changes: 12, status: "modified" },
      ];
      vi.mocked(mockClient.rest.pulls.listFiles).mockResolvedValue({ data: files });

      const result = await prOps.listFiles(testRef);

      expect(result).toEqual(files);
      expect(mockClient.rest.pulls.listFiles).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        pull_number: 42,
        per_page: 100,
        page: 1,
      });
    });

    it("should paginate across multiple pages", async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        filename: `file-${i}.md`,
        additions: 1,
        deletions: 0,
        changes: 1,
        status: "added",
      }));
      const page2 = [
        { filename: "file-100.md", additions: 1, deletions: 0, changes: 1, status: "added" },
      ];

      vi.mocked(mockClient.rest.pulls.listFiles)
        .mockResolvedValueOnce({ data: page1 })
        .mockResolvedValueOnce({ data: page2 });

      const result = await prOps.listFiles(testRef);

      expect(result).toHaveLength(101);
      expect(mockClient.rest.pulls.listFiles).toHaveBeenCalledTimes(2);
    });

    it("should stop at maxPages", async () => {
      const fullPage = Array.from({ length: 100 }, (_, i) => ({
        filename: `file-${i}.md`,
        additions: 1,
        deletions: 0,
        changes: 1,
        status: "added",
      }));

      vi.mocked(mockClient.rest.pulls.listFiles).mockResolvedValue({ data: fullPage });

      const result = await prOps.listFiles(testRef, { maxPages: 2 });

      expect(result).toHaveLength(200);
      expect(mockClient.rest.pulls.listFiles).toHaveBeenCalledTimes(2);
    });

    it("should early-exit when file count exceeds threshold", async () => {
      const files = Array.from({ length: 10 }, (_, i) => ({
        filename: `file-${i}.md`,
        additions: 1,
        deletions: 0,
        changes: 1,
        status: "added",
      }));

      vi.mocked(mockClient.rest.pulls.listFiles).mockResolvedValue({ data: files });

      const result = await prOps.listFiles(testRef, { earlyExitThreshold: 5 });

      expect(result).toHaveLength(10);
      // Only one page fetched — early exit after exceeding threshold
      expect(mockClient.rest.pulls.listFiles).toHaveBeenCalledTimes(1);
    });

    it("should return empty array when PR has no files", async () => {
      vi.mocked(mockClient.rest.pulls.listFiles).mockResolvedValue({ data: [] });

      const result = await prOps.listFiles(testRef);

      expect(result).toEqual([]);
      expect(mockClient.rest.pulls.listFiles).toHaveBeenCalledTimes(1);
    });
  });
});
