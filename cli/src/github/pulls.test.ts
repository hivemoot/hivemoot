import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitHubPR } from "../config/types.js";
import { CliError } from "../config/types.js";

vi.mock("./client.js", () => ({
  gh: vi.fn(),
}));

import { gh } from "./client.js";
import { fetchPulls } from "./pulls.js";

const mockGh = gh as unknown as ReturnType<typeof vi.fn>;

// GraphQL response for fetchLatestCommitDates — no commits
const emptyGraphQL = JSON.stringify({
  data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
});

// GraphQL response with one commit date
function graphQLWithCommit(prNumber: number, date: string): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            { number: prNumber, commits: { nodes: [{ commit: { committedDate: date } }] } },
          ],
        },
      },
    },
  });
}

describe("fetchPulls()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls gh pr list without commits and a separate graphql call", async () => {
    // First call: gh pr list, second call: gh api graphql
    mockGh
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce(emptyGraphQL);

    await fetchPulls({ owner: "hivemoot", repo: "cli" });

    expect(mockGh).toHaveBeenCalledTimes(2);

    // First call: pr list without commits
    expect(mockGh.mock.calls[0][0]).toEqual(expect.arrayContaining([
      "pr", "list", "-R", "hivemoot/cli",
    ]));
    const jsonFields = mockGh.mock.calls[0][0].find(
      (arg: string) => arg.startsWith("number,"),
    );
    expect(jsonFields).not.toContain("commits");

    // Second call: graphql query for commit dates
    expect(mockGh.mock.calls[1][0]).toEqual(expect.arrayContaining([
      "api", "graphql",
    ]));
  });

  it("stitches commit dates from graphql into PR objects", async () => {
    const prs = [
      {
        number: 42,
        title: "Add feature",
        state: "OPEN",
        author: { login: "alice" },
        labels: [{ name: "enhancement" }],
        comments: [],
        reviews: [{ state: "APPROVED", author: { login: "bob" } }],
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-02T00:00:00Z",
        url: "https://github.com/hivemoot/cli/pull/42",
        isDraft: false,
        reviewDecision: "APPROVED",
        mergeable: "MERGEABLE",
        statusCheckRollup: [
          { context: "ci", state: "SUCCESS", conclusion: "success" },
        ],
        closingIssuesReferences: [{ number: 5 }],
      },
    ];

    mockGh
      .mockResolvedValueOnce(JSON.stringify(prs))
      .mockResolvedValueOnce(graphQLWithCommit(42, "2025-01-01T12:00:00Z"));

    const result = await fetchPulls({ owner: "hivemoot", repo: "cli" });

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(42);
    expect(result[0].commits).toEqual([{ committedDate: "2025-01-01T12:00:00Z" }]);
  });

  it("sets empty commits when graphql has no commit for a PR", async () => {
    const prs = [{ number: 99 }];
    mockGh
      .mockResolvedValueOnce(JSON.stringify(prs))
      .mockResolvedValueOnce(emptyGraphQL);

    const result = await fetchPulls({ owner: "hivemoot", repo: "cli" });

    expect(result[0].commits).toEqual([]);
  });

  it("returns empty array when no PRs", async () => {
    mockGh
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce(emptyGraphQL);

    const result = await fetchPulls({ owner: "hivemoot", repo: "cli" });

    expect(result).toEqual([]);
  });

  it("throws CliError on malformed JSON from gh pr list", async () => {
    mockGh
      .mockResolvedValueOnce("not valid json")
      .mockResolvedValueOnce(emptyGraphQL);

    await expect(fetchPulls({ owner: "hivemoot", repo: "cli" })).rejects.toThrow(CliError);
    mockGh
      .mockResolvedValueOnce("not valid json")
      .mockResolvedValueOnce(emptyGraphQL);
    await expect(fetchPulls({ owner: "hivemoot", repo: "cli" })).rejects.toMatchObject({
      code: "GH_ERROR",
      message: expect.stringContaining("Failed to parse"),
    });
  });

  it("throws CliError when gh returns non-array JSON", async () => {
    mockGh
      .mockResolvedValueOnce('{"not": "an array"}')
      .mockResolvedValueOnce(emptyGraphQL);

    await expect(fetchPulls({ owner: "hivemoot", repo: "cli" })).rejects.toThrow(CliError);
    mockGh
      .mockResolvedValueOnce('{"not": "an array"}')
      .mockResolvedValueOnce(emptyGraphQL);
    await expect(fetchPulls({ owner: "hivemoot", repo: "cli" })).rejects.toMatchObject({
      code: "GH_ERROR",
      message: expect.stringContaining("Unexpected"),
    });
  });
});
