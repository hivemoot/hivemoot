import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getRepoDiscussionInfo,
  findOrCreateColonyJournal,
  addStandupComment,
  getLastStandupDate,
  computeDayNumber,
} from "./discussions.js";
import type { GraphQLClient } from "./graphql-queries.js";

/**
 * Tests for Discussions Module
 *
 * Verifies:
 * - Repository discussion info retrieval
 * - Colony Journal find-or-create logic with locking
 * - Standup comment posting with write-then-verify
 * - Idempotency via last standup date parsing
 * - Day counter calculation from repo epoch
 */

function createMockClient(): GraphQLClient & { graphql: ReturnType<typeof vi.fn> } {
  return {
    graphql: vi.fn(),
  };
}

describe("getRepoDiscussionInfo", () => {
  it("should return repo info with discussions enabled", async () => {
    const client = createMockClient();
    client.graphql.mockResolvedValueOnce({
      repository: {
        id: "R_123",
        createdAt: "2024-06-01T00:00:00Z",
        hasDiscussionsEnabled: true,
        discussionCategories: {
          nodes: [
            { id: "DC_1", name: "General" },
            { id: "DC_2", name: "Colony Reports" },
          ],
        },
      },
    });

    const result = await getRepoDiscussionInfo(client, "hivemoot", "colony");

    expect(result).toEqual({
      repoId: "R_123",
      repoCreatedAt: "2024-06-01T00:00:00Z",
      hasDiscussions: true,
      categories: [
        { id: "DC_1", name: "General" },
        { id: "DC_2", name: "Colony Reports" },
      ],
    });
  });

  it("should return discussions disabled when not enabled", async () => {
    const client = createMockClient();
    client.graphql.mockResolvedValueOnce({
      repository: {
        id: "R_456",
        createdAt: "2024-01-01T00:00:00Z",
        hasDiscussionsEnabled: false,
        discussionCategories: { nodes: [] },
      },
    });

    const result = await getRepoDiscussionInfo(client, "org", "repo");

    expect(result.hasDiscussions).toBe(false);
    expect(result.categories).toEqual([]);
  });

  it("should filter null discussion category nodes", async () => {
    const client = createMockClient();
    client.graphql.mockResolvedValueOnce({
      repository: {
        id: "R_789",
        createdAt: "2024-02-01T00:00:00Z",
        hasDiscussionsEnabled: true,
        discussionCategories: {
          nodes: [
            null,
            { id: "DC_3", name: "Announcements" },
          ],
        },
      },
    });

    const result = await getRepoDiscussionInfo(client, "org", "repo");

    expect(result.categories).toEqual([{ id: "DC_3", name: "Announcements" }]);
  });
});

describe("findOrCreateColonyJournal", () => {
  it("should return existing journal when found", async () => {
    const client = createMockClient();
    client.graphql.mockResolvedValueOnce({
      repository: {
        discussions: {
          nodes: [
            {
              id: "D_existing",
              number: 42,
              title: "Colony Journal",
              locked: true,
            },
          ],
        },
      },
    });

    const result = await findOrCreateColonyJournal(
      client, "R_123", "DC_2", "hivemoot", "colony"
    );

    expect(result).toEqual({ discussionId: "D_existing", number: 42 });
    // Should not have called create or lock mutations
    expect(client.graphql).toHaveBeenCalledTimes(1);
  });

  it("should lock existing journal if unlocked", async () => {
    const client = createMockClient();
    client.graphql
      .mockResolvedValueOnce({
        repository: {
          discussions: {
            nodes: [
              {
                id: "D_unlocked",
                number: 10,
                title: "Colony Journal",
                locked: false,
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        lockLockable: { lockedRecord: { locked: true } },
      });

    const result = await findOrCreateColonyJournal(
      client, "R_123", "DC_2", "hivemoot", "colony"
    );

    expect(result).toEqual({ discussionId: "D_unlocked", number: 10 });
    // Should have called lock mutation
    expect(client.graphql).toHaveBeenCalledTimes(2);
  });

  it("should create and lock new journal on first run", async () => {
    const client = createMockClient();
    client.graphql
      // Search returns no results
      .mockResolvedValueOnce({
        repository: { discussions: { nodes: [] } },
      })
      // Create mutation
      .mockResolvedValueOnce({
        createDiscussion: {
          discussion: {
            id: "D_new",
            number: 1,
            url: "https://github.com/hivemoot/colony/discussions/1",
          },
        },
      })
      // Lock mutation
      .mockResolvedValueOnce({
        lockLockable: { lockedRecord: { locked: true } },
      });

    const result = await findOrCreateColonyJournal(
      client, "R_123", "DC_2", "hivemoot", "colony"
    );

    expect(result).toEqual({ discussionId: "D_new", number: 1 });
    expect(client.graphql).toHaveBeenCalledTimes(3);
  });

  it("should match journal by title containing 'Colony Journal'", async () => {
    const client = createMockClient();
    client.graphql.mockResolvedValueOnce({
      repository: {
        discussions: {
          nodes: [
            {
              id: "D_match",
              number: 5,
              title: "Colony Journal",
              locked: true,
            },
            {
              id: "D_other",
              number: 3,
              title: "Some Other Discussion",
              locked: false,
            },
          ],
        },
      },
    });

    const result = await findOrCreateColonyJournal(
      client, "R_123", "DC_2", "hivemoot", "colony"
    );

    expect(result.discussionId).toBe("D_match");
  });

  it("should skip null discussion nodes when searching for existing journal", async () => {
    const client = createMockClient();
    client.graphql.mockResolvedValueOnce({
      repository: {
        discussions: {
          nodes: [
            null,
            {
              id: "D_match",
              number: 8,
              title: "Colony Journal",
              locked: true,
            },
          ],
        },
      },
    });

    const result = await findOrCreateColonyJournal(
      client, "R_123", "DC_2", "hivemoot", "colony"
    );

    expect(result).toEqual({ discussionId: "D_match", number: 8 });
  });
});

describe("addStandupComment", () => {
  it("should return comment info on success", async () => {
    const client = createMockClient();
    client.graphql.mockResolvedValueOnce({
      addDiscussionComment: {
        comment: {
          id: "C_123",
          url: "https://github.com/hivemoot/colony/discussions/1#discussioncomment-123",
        },
      },
    });

    const result = await addStandupComment(
      client, "D_1", "body content", "hivemoot", "colony", 1, "2026-02-07"
    );

    expect(result).toEqual({
      commentId: "C_123",
      url: "https://github.com/hivemoot/colony/discussions/1#discussioncomment-123",
    });
  });

  it("should verify comment creation on network error", async () => {
    const client = createMockClient();
    // Mutation throws
    client.graphql
      .mockRejectedValueOnce(new Error("Network timeout"))
      // Verification query finds today's comment
      .mockResolvedValueOnce({
        repository: {
          discussion: {
            comments: {
              nodes: [{
                body: '<!-- hivemoot-metadata: {"version":1,"type":"standup","day":42,"date":"2026-02-07","repo":"hivemoot/colony","issueNumber":0,"createdAt":"2026-02-07T00:05:00Z"} -->',
                createdAt: "2026-02-07T00:05:00Z",
              }],
            },
          },
        },
      });

    const result = await addStandupComment(
      client, "D_1", "body", "hivemoot", "colony", 1, "2026-02-07"
    );

    expect(result.commentId).toBe("verified-after-error");
  });

  it("should throw when both mutation and verification fail", async () => {
    const client = createMockClient();
    client.graphql
      .mockRejectedValueOnce(new Error("Network timeout"))
      // Verification finds no matching comment
      .mockResolvedValueOnce({
        repository: {
          discussion: {
            comments: {
              nodes: [{
                body: '<!-- hivemoot-metadata: {"version":1,"type":"standup","day":41,"date":"2026-02-06","repo":"hivemoot/colony","issueNumber":0,"createdAt":"2026-02-06T00:05:00Z"} -->',
                createdAt: "2026-02-06T00:05:00Z",
              }],
            },
          },
        },
      });

    await expect(
      addStandupComment(client, "D_1", "body", "hivemoot", "colony", 1, "2026-02-07")
    ).rejects.toThrow("Network timeout");
  });

  it("should propagate original error when verification query also throws", async () => {
    const client = createMockClient();
    client.graphql
      // Mutation fails with permissions error
      .mockRejectedValueOnce(new Error("Insufficient permissions"))
      // Verification query also fails (different error)
      .mockRejectedValueOnce(new Error("Secondary network failure"));

    await expect(
      addStandupComment(client, "D_1", "body", "hivemoot", "colony", 1, "2026-02-07")
    ).rejects.toThrow("Insufficient permissions");
  });
});

describe("getLastStandupDate", () => {
  it("should return date from latest standup comment", async () => {
    const client = createMockClient();
    client.graphql.mockResolvedValueOnce({
      repository: {
        discussion: {
          comments: {
            nodes: [
              {
                body: "Some random comment",
                createdAt: "2026-02-05T00:05:00Z",
              },
              {
                body: '<!-- hivemoot-metadata: {"version":1,"type":"standup","day":41,"date":"2026-02-06","repo":"hivemoot/colony","issueNumber":0,"createdAt":"2026-02-06T00:05:00Z"} -->\n# Colony Report',
                createdAt: "2026-02-06T00:05:00Z",
              },
            ],
          },
        },
      },
    });

    const result = await getLastStandupDate(client, "hivemoot", "colony", 1);

    expect(result).toBe("2026-02-06");
  });

  it("should return null when no standup comments exist", async () => {
    const client = createMockClient();
    client.graphql.mockResolvedValueOnce({
      repository: {
        discussion: {
          comments: {
            nodes: [
              {
                body: "Just a regular comment",
                createdAt: "2026-02-05T00:00:00Z",
              },
            ],
          },
        },
      },
    });

    const result = await getLastStandupDate(client, "hivemoot", "colony", 1);

    expect(result).toBeNull();
  });

  it("should skip null comment nodes when scanning for standup metadata", async () => {
    const client = createMockClient();
    client.graphql.mockResolvedValueOnce({
      repository: {
        discussion: {
          comments: {
            nodes: [
              null,
              {
                body: '<!-- hivemoot-metadata: {"version":1,"type":"standup","day":41,"date":"2026-02-06","repo":"hivemoot/colony","issueNumber":0,"createdAt":"2026-02-06T00:05:00Z"} -->',
                createdAt: "2026-02-06T00:05:00Z",
              },
            ],
          },
        },
      },
    });

    const result = await getLastStandupDate(client, "hivemoot", "colony", 1);

    expect(result).toBe("2026-02-06");
  });

  it("should return null when discussion has no comments", async () => {
    const client = createMockClient();
    client.graphql.mockResolvedValueOnce({
      repository: {
        discussion: {
          comments: { nodes: [] },
        },
      },
    });

    const result = await getLastStandupDate(client, "hivemoot", "colony", 1);

    expect(result).toBeNull();
  });

  it("should return null when discussion doesn't exist", async () => {
    const client = createMockClient();
    client.graphql.mockResolvedValueOnce({
      repository: {
        discussion: null,
      },
    });

    const result = await getLastStandupDate(client, "hivemoot", "colony", 1);

    expect(result).toBeNull();
  });
});

describe("computeDayNumber", () => {
  it("should return 0 for same UTC calendar day as repo creation", () => {
    const result = computeDayNumber(
      "2024-06-01T00:00:00Z",
      "2024-06-01"
    );
    expect(result).toBe(0);
  });

  it("should return 1 for the next UTC calendar day", () => {
    const result = computeDayNumber(
      "2024-06-01T00:00:00Z",
      "2024-06-02"
    );
    expect(result).toBe(1);
  });

  it("should count days correctly over long periods", () => {
    const result = computeDayNumber(
      "2024-06-01T00:00:00Z",
      "2024-07-11" // 40 days later
    );
    expect(result).toBe(40);
  });

  it("should ignore repo creation time-of-day and use UTC calendar math", () => {
    const result = computeDayNumber(
      "2024-06-01T12:00:00Z",
      "2024-06-02"
    );
    expect(result).toBe(1);
  });

  it("should increment for consecutive report dates even when run less than 24h apart", () => {
    const repoCreatedAt = "2026-02-01T17:00:00Z";

    const daySeven = computeDayNumber(repoCreatedAt, "2026-02-07");
    const dayEight = computeDayNumber(repoCreatedAt, "2026-02-08");

    expect(dayEight).toBe(daySeven + 1);
  });

  it("should never return negative day numbers", () => {
    const result = computeDayNumber(
      "2026-02-10T00:00:00Z",
      "2026-02-09"
    );

    expect(result).toBe(0);
  });
});
