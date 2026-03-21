import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getLinkedIssues,
  getPRBodyLastEditedAt,
  getOpenPRsForIssue,
  enablePullRequestAutoMerge,
  disablePullRequestAutoMerge,
  type GraphQLClient,
} from "./graphql-queries.js";
import { logger } from "./logger.js";

/**
 * Tests for GraphQL Queries
 *
 * These tests verify the PR-issue linking queries:
 * - getLinkedIssues: Issues that will be closed when a PR merges
 * - getOpenPRsForIssue: Open PRs referencing an issue (reverse lookup)
 */

describe("getLinkedIssues", () => {
  let mockClient: GraphQLClient;

  beforeEach(() => {
    mockClient = {
      graphql: vi.fn(),
    };
  });

  it("should return linked issues from closingIssuesReferences", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: [
              {
                number: 123,
                title: "Fix bug",
                state: "OPEN",
                labels: { nodes: [{ name: "bug" }] },
              },
              {
                number: 456,
                title: "Add feature",
                state: "OPEN",
                labels: { nodes: [{ name: "enhancement" }] },
              },
            ],
          },
        },
      },
    });

    const result = await getLinkedIssues(mockClient, "owner", "repo", 42);

    expect(result).toEqual([
      {
        number: 123,
        title: "Fix bug",
        state: "OPEN",
        labels: { nodes: [{ name: "bug" }] },
      },
      {
        number: 456,
        title: "Add feature",
        state: "OPEN",
        labels: { nodes: [{ name: "enhancement" }] },
      },
    ]);
  });

  it("should return empty array when PR not found (null)", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        pullRequest: null,
      },
    });

    const result = await getLinkedIssues(mockClient, "owner", "repo", 9999);

    expect(result).toEqual([]);
  });

  it("should return empty array when no linked issues", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: [],
          },
        },
      },
    });

    const result = await getLinkedIssues(mockClient, "owner", "repo", 42);

    expect(result).toEqual([]);
  });

  it("should filter null nodes from closingIssuesReferences", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: [
              null,
              {
                number: 123,
                title: "Fix bug",
                state: "OPEN",
                labels: { nodes: [{ name: "bug" }] },
              },
            ],
          },
        },
      },
    });

    const result = await getLinkedIssues(mockClient, "owner", "repo", 42);

    expect(result).toEqual([
      {
        number: 123,
        title: "Fix bug",
        state: "OPEN",
        labels: { nodes: [{ name: "bug" }] },
      },
    ]);
  });

  it("should pass correct query variables", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          closingIssuesReferences: { nodes: [] },
        },
      },
    });

    await getLinkedIssues(mockClient, "test-owner", "test-repo", 123);

    expect(mockClient.graphql).toHaveBeenCalledWith(
      expect.stringContaining("getLinkedIssues"),
      { owner: "test-owner", repo: "test-repo", pr: 123 }
    );
  });

  it("should propagate GraphQL network errors to caller", async () => {
    vi.mocked(mockClient.graphql).mockRejectedValue(
      new Error("request to https://api.github.com/graphql failed, reason: connect ECONNRESET")
    );

    await expect(
      getLinkedIssues(mockClient, "owner", "repo", 42)
    ).rejects.toThrow("ECONNRESET");
  });

  it("should propagate rate limit errors to caller", async () => {
    const rateLimitError = Object.assign(new Error("API rate limit exceeded"), { status: 403 });
    vi.mocked(mockClient.graphql).mockRejectedValue(rateLimitError);

    await expect(
      getLinkedIssues(mockClient, "owner", "repo", 42)
    ).rejects.toThrow("API rate limit exceeded");
  });

  it("should handle issues with multiple labels", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: [
              {
                number: 1,
                title: "Complex issue",
                state: "OPEN",
                labels: {
                  nodes: [
                    { name: "bug" },
                    { name: "priority-high" },
                    { name: "needs-review" },
                  ],
                },
              },
            ],
          },
        },
      },
    });

    const result = await getLinkedIssues(mockClient, "owner", "repo", 42);

    expect(result[0].labels.nodes).toHaveLength(3);
  });
});

describe("getPRBodyLastEditedAt", () => {
  let mockClient: GraphQLClient;

  beforeEach(() => {
    mockClient = {
      graphql: vi.fn(),
    };
    vi.restoreAllMocks();
  });

  it("should parse and return a valid lastEditedAt timestamp", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          lastEditedAt: "2026-02-12T08:00:00Z",
        },
      },
    });

    const result = await getPRBodyLastEditedAt(mockClient, "owner", "repo", 42);

    expect(result).toBeInstanceOf(Date);
    expect(result?.toISOString()).toBe("2026-02-12T08:00:00.000Z");
  });

  it("should return null when PR is not found", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        pullRequest: null,
      },
    });

    const result = await getPRBodyLastEditedAt(mockClient, "owner", "repo", 9999);

    expect(result).toBeNull();
  });

  it("should return null when lastEditedAt is null", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          lastEditedAt: null,
        },
      },
    });

    const result = await getPRBodyLastEditedAt(mockClient, "owner", "repo", 42);

    expect(result).toBeNull();
  });

  it("should return null and warn when lastEditedAt is invalid", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          lastEditedAt: "not-a-date",
        },
      },
    });

    const result = await getPRBodyLastEditedAt(mockClient, "owner", "repo", 42);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'Invalid lastEditedAt timestamp from GitHub GraphQL: "not-a-date"'
    );
  });

  it("should pass correct query variables", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          lastEditedAt: null,
        },
      },
    });

    await getPRBodyLastEditedAt(mockClient, "test-owner", "test-repo", 123);

    expect(mockClient.graphql).toHaveBeenCalledWith(
      expect.stringContaining("getPRBodyLastEdited"),
      { owner: "test-owner", repo: "test-repo", pr: 123 }
    );
  });

  it("should propagate GraphQL network errors to caller", async () => {
    vi.mocked(mockClient.graphql).mockRejectedValue(
      new Error("request to https://api.github.com/graphql failed, reason: connect ECONNRESET")
    );

    await expect(
      getPRBodyLastEditedAt(mockClient, "owner", "repo", 42)
    ).rejects.toThrow("ECONNRESET");
  });
});

describe("getOpenPRsForIssue", () => {
  let mockClient: GraphQLClient;

  beforeEach(() => {
    mockClient = {
      graphql: vi.fn(),
    };
  });

  /**
   * Helper to mock the two-step verification:
   * 1. Cross-reference query returns candidate PRs
   * 2. For each candidate, getLinkedIssues is called to verify closing syntax
   */
  const mockTwoStepVerification = (
    crossRefPRs: Array<{ number: number; title: string; state: string; author?: { login: string } }>,
    // Map of PR number -> issue numbers that PR closes (via closingIssuesReferences)
    closingIssuesMap: Record<number, number[]>
  ) => {
    // First call: cross-reference query
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: crossRefPRs.map((pr) => ({
                  source: {
                    number: pr.number,
                    title: pr.title,
                    state: pr.state,
                    author: pr.author ?? { login: "user" },
                  },
                })),
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        const prNumber = variables?.pr as number;
        const closingIssues = closingIssuesMap[prNumber] ?? [];
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: closingIssues.map((issueNum) => ({
                  number: issueNum,
                  title: `Issue ${issueNum}`,
                  state: "OPEN",
                  labels: { nodes: [] },
                })),
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });
  };

  it("should only return PRs that use closing syntax (Closes/Fixes)", async () => {
    // PR 1 uses "Closes #123", PR 4 uses "Closes #123"
    // PR 2 and PR 3 only mention #123 without closing syntax
    mockTwoStepVerification(
      [
        { number: 1, title: "PR 1", state: "OPEN" },
        { number: 2, title: "PR 2", state: "OPEN" },
        { number: 3, title: "PR 3", state: "OPEN" },
        { number: 4, title: "PR 4", state: "OPEN" },
      ],
      {
        1: [123], // PR 1 closes issue 123
        2: [],    // PR 2 doesn't close any issues
        3: [456], // PR 3 closes a different issue
        4: [123], // PR 4 closes issue 123
      }
    );

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(2);
    expect(result.map((pr) => pr.number)).toEqual([1, 4]);
  });

  it("should filter to only OPEN PRs before verification", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                  { source: { number: 2, title: "PR 2", state: "CLOSED", author: { login: "user2" } } },
                  { source: { number: 3, title: "PR 3", state: "MERGED", author: { login: "user3" } } },
                  { source: { number: 4, title: "PR 4", state: "OPEN", author: { login: "user4" } } },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        // All PRs close issue 123
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    // Only OPEN PRs (1 and 4) should be returned
    expect(result).toHaveLength(2);
    expect(result.map((pr) => pr.number)).toEqual([1, 4]);
  });

  it("should filter out events without PR number", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                  { source: { title: "No number", state: "OPEN", author: { login: "user2" } } },
                  { source: { number: undefined, title: "Undefined", state: "OPEN", author: { login: "user3" } } },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it("should skip null timeline nodes safely", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  null,
                  { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it("should use 'ghost' for PRs with missing or undefined author", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                  { source: { number: 2, title: "PR 2", state: "OPEN", author: undefined } },
                  { source: { number: 3, title: "PR 3", state: "OPEN" } }, // No author property
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } });
    expect(result[1]).toEqual({ number: 2, title: "PR 2", state: "OPEN", author: { login: "ghost" } });
    expect(result[2]).toEqual({ number: 3, title: "PR 3", state: "OPEN", author: { login: "ghost" } });
  });

  it("should use 'ghost' for PRs with null author (deleted GitHub account)", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { source: { number: 1, title: "PR from deleted user", state: "OPEN", author: null } },
                  { source: { number: 2, title: "PR 2", state: "OPEN", author: { login: "active-user" } } },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(2);
    expect(result[0].author.login).toBe("ghost");
    expect(result[1].author.login).toBe("active-user");
  });

  it("should deduplicate PRs that appear in multiple cross-reference events", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  // Same PR appears twice (e.g., mentioned in body and commit)
                  { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                  { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                  { source: { number: 2, title: "PR 2", state: "OPEN", author: { login: "user2" } } },
                  // PR 1 appears a third time
                  { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(2);
    expect(result.map((pr) => pr.number)).toEqual([1, 2]);
  });

  it("should deduplicate PRs across pagination pages", async () => {
    let crossRefCallCount = 0;
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        crossRefCallCount++;
        if (crossRefCallCount === 1) {
          return {
            repository: {
              issue: {
                timelineItems: {
                  pageInfo: { hasNextPage: true, endCursor: "cursor1" },
                  nodes: [
                    { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                    { source: { number: 2, title: "PR 2", state: "OPEN", author: { login: "user2" } } },
                  ],
                },
              },
            },
          };
        } else {
          return {
            repository: {
              issue: {
                timelineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    // PR 1 appears again on second page
                    { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                    { source: { number: 3, title: "PR 3", state: "OPEN", author: { login: "user3" } } },
                  ],
                },
              },
            },
          };
        }
      } else if (query.includes("getLinkedIssues")) {
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(3);
    expect(result.map((pr) => pr.number)).toEqual([1, 2, 3]);
  });

  it("should stop pagination after scanning the safety event cap", async () => {
    const nodes = Array.from({ length: 100 }, () => ({
      source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } },
    }));

    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: true, endCursor: "cursor1" },
                nodes,
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it("should return empty array when issue not found (null)", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        issue: null,
      },
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 9999);

    expect(result).toEqual([]);
  });

  it("should return empty array when no timeline items (no candidates)", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toEqual([]);
  });

  it("should filter out events with null source", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { source: null },
                  { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(1);
  });

  it("should transform response correctly", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    source: {
                      number: 42,
                      title: "Add new feature",
                      state: "OPEN",
                      author: { login: "developer" },
                    },
                  },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toEqual([
      {
        number: 42,
        title: "Add new feature",
        state: "OPEN",
        author: { login: "developer" },
      },
    ]);
  });

  it("should handle missing title gracefully", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { source: { number: 1, state: "OPEN", author: { login: "user1" } } }, // No title
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result[0].title).toBe("");
  });

  it("should pass correct query variables with null cursor on first request", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    });

    await getOpenPRsForIssue(mockClient, "test-owner", "test-repo", 456);

    expect(mockClient.graphql).toHaveBeenCalledWith(
      expect.stringContaining("getOpenPRsForIssue"),
      { owner: "test-owner", repo: "test-repo", issue: 456, after: null }
    );
  });

  it("should paginate through multiple pages for cross-reference candidates", async () => {
    let crossRefCallCount = 0;
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        crossRefCallCount++;
        if (crossRefCallCount === 1) {
          return {
            repository: {
              issue: {
                timelineItems: {
                  pageInfo: { hasNextPage: true, endCursor: "cursor1" },
                  nodes: [
                    { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                    { source: { number: 2, title: "PR 2", state: "OPEN", author: { login: "user2" } } },
                  ],
                },
              },
            },
          };
        } else if (crossRefCallCount === 2) {
          return {
            repository: {
              issue: {
                timelineItems: {
                  pageInfo: { hasNextPage: true, endCursor: "cursor2" },
                  nodes: [
                    { source: { number: 3, title: "PR 3", state: "OPEN", author: { login: "user3" } } },
                  ],
                },
              },
            },
          };
        } else {
          return {
            repository: {
              issue: {
                timelineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { source: { number: 4, title: "PR 4", state: "OPEN", author: { login: "user4" } } },
                  ],
                },
              },
            },
          };
        }
      } else if (query.includes("getLinkedIssues")) {
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(4);
    expect(result.map((pr) => pr.number)).toEqual([1, 2, 3, 4]);
  });

  it("should call getLinkedIssues for each candidate PR to verify closing syntax", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                  { source: { number: 2, title: "PR 2", state: "OPEN", author: { login: "user2" } } },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        // PR 1 closes issue 123, PR 2 does not
        const prNumber = variables?.pr as number;
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: prNumber === 1
                  ? [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }]
                  : [],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    // Only PR 1 should be returned (PR 2 doesn't close issue 123)
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);

    // Verify getLinkedIssues was called for each candidate
    const linkedIssuesCalls = vi.mocked(mockClient.graphql).mock.calls.filter(
      (call) => (call[0] as string).includes("getLinkedIssues")
    );
    expect(linkedIssuesCalls).toHaveLength(2);
  });

  it("should filter across pages and only return OPEN PRs that close the issue", async () => {
    let crossRefCallCount = 0;
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes("getOpenPRsForIssue")) {
        crossRefCallCount++;
        if (crossRefCallCount === 1) {
          return {
            repository: {
              issue: {
                timelineItems: {
                  pageInfo: { hasNextPage: true, endCursor: "cursor1" },
                  nodes: [
                    { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                    { source: { number: 2, title: "PR 2", state: "CLOSED", author: { login: "user2" } } },
                  ],
                },
              },
            },
          };
        } else {
          return {
            repository: {
              issue: {
                timelineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { source: { number: 3, title: "PR 3", state: "MERGED", author: { login: "user3" } } },
                    { source: { number: 4, title: "PR 4", state: "OPEN", author: { login: "user4" } } },
                  ],
                },
              },
            },
          };
        }
      } else if (query.includes("getLinkedIssues")) {
        // All PRs close issue 123 (but only OPEN ones should be in candidates)
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    // Only OPEN PRs (1 and 4) that close issue 123
    expect(result).toHaveLength(2);
    expect(result.map((pr) => pr.number)).toEqual([1, 4]);
  });

  it("should return verified PRs and warn when some verifications fail (partial failure)", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                  { source: { number: 2, title: "PR 2", state: "OPEN", author: { login: "user2" } } },
                  { source: { number: 3, title: "PR 3", state: "OPEN", author: { login: "user3" } } },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        const prNumber = variables?.pr as number;
        // PR 2 has a transient API failure
        if (prNumber === 2) {
          throw new Error("API rate limit exceeded");
        }
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    // PR 1 and PR 3 verified successfully; PR 2's failure is tolerated
    expect(result).toHaveLength(2);
    expect(result.map((pr) => pr.number)).toEqual([1, 3]);
  });

  it("should throw when all verifications fail (total failure)", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                  { source: { number: 2, title: "PR 2", state: "OPEN", author: { login: "user2" } } },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        // All verification calls fail (e.g., token expired)
        throw new Error("Bad credentials");
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    await expect(
      getOpenPRsForIssue(mockClient, "owner", "repo", 123)
    ).rejects.toThrow("All 2 PR closing-syntax verification(s) failed");
  });

  it("should propagate errors from initial cross-reference query", async () => {
    vi.mocked(mockClient.graphql).mockRejectedValue(
      new Error("502 Bad Gateway")
    );

    await expect(
      getOpenPRsForIssue(mockClient, "owner", "repo", 123)
    ).rejects.toThrow("502 Bad Gateway");
  });

  it("should return empty when candidates exist but none close the issue", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                  { source: { number: 2, title: "PR 2", state: "OPEN", author: { login: "user2" } } },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        // None of the PRs close issue 123 (they just mention it)
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [], // No closing references
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toEqual([]);
  });

  // ─── Layer 1: Null node safety (#32) ───────────────────────────────────────

  it("should ignore null timeline nodes without throwing", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  null,
                  { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" }, repository: { owner: { login: "owner" }, name: "repo" } } },
                  null,
                  null,
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it("should return empty when all timeline nodes are null", async () => {
    vi.mocked(mockClient.graphql).mockResolvedValue({
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [null, null, null],
          },
        },
      },
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toEqual([]);
  });

  // ─── Layer 2: Cross-repo candidate filtering (#26) ────────────────────────

  it("should filter out cross-repo candidates and only verify local PRs", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  // Local PR — should be kept
                  { source: { number: 10, title: "Local PR", state: "OPEN", author: { login: "user1" }, repository: { owner: { login: "owner" }, name: "repo" } } },
                  // Cross-repo PR — should be filtered out
                  { source: { number: 1, title: "External PR", state: "OPEN", author: { login: "user2" }, repository: { owner: { login: "other-org" }, name: "other-repo" } } },
                  // Same owner, different repo — should be filtered out
                  { source: { number: 5, title: "Sibling PR", state: "OPEN", author: { login: "user3" }, repository: { owner: { login: "owner" }, name: "other-repo" } } },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    // Only the local PR should be verified and returned
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(10);
    expect(result[0].title).toBe("Local PR");

    // getLinkedIssues should only be called once (for the local PR, not the cross-repo ones)
    const linkedIssuesCalls = vi.mocked(mockClient.graphql).mock.calls.filter(
      (call) => (call[0] as string).includes("getLinkedIssues")
    );
    expect(linkedIssuesCalls).toHaveLength(1);
  });

  it("should allow candidates through when repository field is missing", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  // No repository field — defensive fallback, allow through
                  { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" } } },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it("should match same-repo candidates case-insensitively", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  // Mixed-case owner/repo — should still match
                  { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" }, repository: { owner: { login: "Owner" }, name: "Repo" } } },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  // ─── Layer 4: Staleness classification (#25) ──────────────────────────────

  it("should classify stale PR errors as noise and return verified results", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { source: { number: 1, title: "Valid PR", state: "OPEN", author: { login: "user1" }, repository: { owner: { login: "owner" }, name: "repo" } } },
                  { source: { number: 99, title: "Stale PR", state: "OPEN", author: { login: "user2" }, repository: { owner: { login: "owner" }, name: "repo" } } },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        const prNumber = variables?.pr as number;
        if (prNumber === 99) {
          throw new Error("Could not resolve to a PullRequest with the number of 99.");
        }
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    // Stale candidate skipped, valid one returned
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it("should return empty (not throw) when all candidates are stale", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { source: { number: 98, title: "Stale 1", state: "OPEN", author: { login: "user1" }, repository: { owner: { login: "owner" }, name: "repo" } } },
                  { source: { number: 99, title: "Stale 2", state: "OPEN", author: { login: "user2" }, repository: { owner: { login: "owner" }, name: "repo" } } },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        throw new Error("Could not resolve to a PullRequest with the number of 99.");
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    // All stale — should return empty without throwing
    expect(result).toEqual([]);
  });

  it("should still throw when non-stale systemic failures occur with zero verified", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" }, repository: { owner: { login: "owner" }, name: "repo" } } },
                  { source: { number: 2, title: "PR 2", state: "OPEN", author: { login: "user2" }, repository: { owner: { login: "owner" }, name: "repo" } } },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        throw new Error("Bad credentials");
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    await expect(
      getOpenPRsForIssue(mockClient, "owner", "repo", 123)
    ).rejects.toThrow("All 2 PR closing-syntax verification(s) failed");
  });

  it("should throw only on hard failures when mixed stale and systemic errors occur", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { source: { number: 1, title: "PR 1", state: "OPEN", author: { login: "user1" }, repository: { owner: { login: "owner" }, name: "repo" } } },
                  { source: { number: 99, title: "Stale PR", state: "OPEN", author: { login: "user2" }, repository: { owner: { login: "owner" }, name: "repo" } } },
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        const prNumber = variables?.pr as number;
        if (prNumber === 99) {
          throw new Error("Could not resolve to a PullRequest with the number of 99.");
        }
        // PR 1 also fails, but with a systemic error
        throw new Error("Server error");
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    // 1 hard failure + 1 stale + 0 verified = throw (hard failure drives the decision)
    await expect(
      getOpenPRsForIssue(mockClient, "owner", "repo", 123)
    ).rejects.toThrow("All 1 PR closing-syntax verification(s) failed");
  });

  // ─── Combined: All layers in same timeline ────────────────────────────────

  it("should handle null nodes, cross-repo, and stale candidates in same timeline", async () => {
    vi.mocked(mockClient.graphql).mockImplementation(async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes("getOpenPRsForIssue")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  null, // Layer 1: null node
                  { source: { number: 1, title: "Cross-repo PR", state: "OPEN", author: { login: "ext" }, repository: { owner: { login: "other" }, name: "repo" } } }, // Layer 2: cross-repo
                  { source: { number: 99, title: "Stale PR", state: "OPEN", author: { login: "user2" }, repository: { owner: { login: "owner" }, name: "repo" } } }, // Layer 4: stale
                  { source: { number: 10, title: "Valid PR", state: "OPEN", author: { login: "user1" }, repository: { owner: { login: "owner" }, name: "repo" } } }, // Valid
                  null, // Another null
                ],
              },
            },
          },
        };
      } else if (query.includes("getLinkedIssues")) {
        const prNumber = variables?.pr as number;
        if (prNumber === 99) {
          throw new Error("Could not resolve to a PullRequest with the number of 99.");
        }
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: 123, title: "Issue", state: "OPEN", labels: { nodes: [] } }],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GraphQL query in test mock: ${query.slice(0, 80)}`);
    });

    const result = await getOpenPRsForIssue(mockClient, "owner", "repo", 123);

    // Only the valid local PR should survive all layers
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(10);
    expect(result[0].title).toBe("Valid PR");

    // Verification should only be called for local PRs (10 and 99), not cross-repo (1)
    const linkedIssuesCalls = vi.mocked(mockClient.graphql).mock.calls.filter(
      (call) => (call[0] as string).includes("getLinkedIssues")
    );
    expect(linkedIssuesCalls).toHaveLength(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// enablePullRequestAutoMerge / disablePullRequestAutoMerge
// ───────────────────────────────────────────────────────────────────────────────

describe("enablePullRequestAutoMerge", () => {
  let mockClient: GraphQLClient;

  beforeEach(() => {
    mockClient = { graphql: vi.fn().mockResolvedValue({}) };
  });

  it("calls the mutation with SQUASH method", async () => {
    await enablePullRequestAutoMerge(mockClient, "PR_kwABC", "squash");

    expect(mockClient.graphql).toHaveBeenCalledOnce();
    const [query, variables] = vi.mocked(mockClient.graphql).mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("enablePullRequestAutoMerge");
    expect(variables.pullRequestId).toBe("PR_kwABC");
    expect(variables.mergeMethod).toBe("SQUASH");
    expect(variables.commitHeadline).toBeNull();
    expect(variables.commitBody).toBeNull();
  });

  it("calls the mutation with MERGE method", async () => {
    await enablePullRequestAutoMerge(mockClient, "PR_kwABC", "merge");

    const [, variables] = vi.mocked(mockClient.graphql).mock.calls[0] as [string, Record<string, unknown>];
    expect(variables.mergeMethod).toBe("MERGE");
  });

  it("calls the mutation with REBASE method", async () => {
    await enablePullRequestAutoMerge(mockClient, "PR_kwABC", "rebase");

    const [, variables] = vi.mocked(mockClient.graphql).mock.calls[0] as [string, Record<string, unknown>];
    expect(variables.mergeMethod).toBe("REBASE");
  });

  it("passes commitHeadline and commitBody when provided", async () => {
    await enablePullRequestAutoMerge(mockClient, "PR_kwABC", "squash", {
      commitHeadline: "chore: auto-merge",
      commitBody: "Auto-merged by bot.",
    });

    const [, variables] = vi.mocked(mockClient.graphql).mock.calls[0] as [string, Record<string, unknown>];
    expect(variables.commitHeadline).toBe("chore: auto-merge");
    expect(variables.commitBody).toBe("Auto-merged by bot.");
  });

  it("sends null for commitHeadline/commitBody when options are absent", async () => {
    await enablePullRequestAutoMerge(mockClient, "PR_kwABC", "squash");

    const [, variables] = vi.mocked(mockClient.graphql).mock.calls[0] as [string, Record<string, unknown>];
    expect(variables.commitHeadline).toBeNull();
    expect(variables.commitBody).toBeNull();
  });

  it("propagates graphql errors", async () => {
    vi.mocked(mockClient.graphql).mockRejectedValue(new Error("PullRequestAutoMergeNotAllowed"));

    await expect(
      enablePullRequestAutoMerge(mockClient, "PR_kwABC", "squash")
    ).rejects.toThrow("PullRequestAutoMergeNotAllowed");
  });
});

describe("disablePullRequestAutoMerge", () => {
  let mockClient: GraphQLClient;

  beforeEach(() => {
    mockClient = { graphql: vi.fn().mockResolvedValue({}) };
  });

  it("calls the mutation with the correct pullRequestId", async () => {
    await disablePullRequestAutoMerge(mockClient, "PR_kwXYZ");

    expect(mockClient.graphql).toHaveBeenCalledOnce();
    const [query, variables] = vi.mocked(mockClient.graphql).mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("disablePullRequestAutoMerge");
    expect(variables.pullRequestId).toBe("PR_kwXYZ");
  });

  it("propagates graphql errors", async () => {
    vi.mocked(mockClient.graphql).mockRejectedValue(new Error("UNPROCESSABLE"));

    await expect(
      disablePullRequestAutoMerge(mockClient, "PR_kwXYZ")
    ).rejects.toThrow("UNPROCESSABLE");
  });
});
