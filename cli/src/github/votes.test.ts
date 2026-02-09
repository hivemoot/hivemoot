import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./client.js", () => ({
  gh: vi.fn(),
}));

import { gh } from "./client.js";
import { fetchVotes } from "./votes.js";

const mockedGh = vi.mocked(gh);
const repo = { owner: "hivemoot", repo: "colony" };

beforeEach(() => {
  vi.clearAllMocks();
});

function makeGraphQLResponse(issueComments: Array<{
  body: string;
  createdAt: string;
  reactions: Array<{ content: string; createdAt: string; userLogin: string | null }>;
}>) {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          comments: {
            nodes: issueComments.map((c) => ({
              body: c.body,
              createdAt: c.createdAt,
              reactions: {
                nodes: c.reactions.map((r) => ({
                  content: r.content,
                  createdAt: r.createdAt,
                  user: r.userLogin ? { login: r.userLogin } : null,
                })),
              },
            })),
          },
        },
      },
    },
  });
}

describe("fetchVotes()", () => {
  it("returns empty map for empty issue numbers", async () => {
    const result = await fetchVotes(repo, [], "scout");
    expect(result.size).toBe(0);
    expect(mockedGh).not.toHaveBeenCalled();
  });

  it("returns empty map for empty currentUser", async () => {
    const result = await fetchVotes(repo, [1], "");
    expect(result.size).toBe(0);
    expect(mockedGh).not.toHaveBeenCalled();
  });

  it("extracts vote reaction from voting comment", async () => {
    mockedGh.mockResolvedValue(
      makeGraphQLResponse([
        {
          body: '<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->\nVote here',
          createdAt: "2024-01-15T10:00:00Z",
          reactions: [
            { content: "THUMBS_UP", createdAt: "2024-01-16T12:00:00Z", userLogin: "scout" },
          ],
        },
      ]),
    );

    const result = await fetchVotes(repo, [42], "scout");
    expect(result.size).toBe(1);
    expect(result.get(42)).toEqual({
      reaction: "👍",
      createdAt: "2024-01-16T12:00:00Z",
    });
  });

  it("maps GraphQL reaction enums to emojis", async () => {
    const cases = [
      { content: "THUMBS_UP", expected: "👍" },
      { content: "THUMBS_DOWN", expected: "👎" },
      { content: "CONFUSED", expected: "😕" },
      { content: "EYES", expected: "👀" },
      { content: "HOORAY", expected: "🎉" },
      { content: "HEART", expected: "❤️" },
      { content: "ROCKET", expected: "🚀" },
      { content: "LAUGH", expected: "😄" },
    ];

    for (const { content, expected } of cases) {
      mockedGh.mockResolvedValue(
        makeGraphQLResponse([
          {
            body: '<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":1} -->',
            createdAt: "2024-01-15T10:00:00Z",
            reactions: [
              { content, createdAt: "2024-01-16T12:00:00Z", userLogin: "scout" },
            ],
          },
        ]),
      );

      const result = await fetchVotes(repo, [1], "scout");
      expect(result.get(1)?.reaction).toBe(expected);
    }
  });

  it("returns empty map when no voting comment exists", async () => {
    mockedGh.mockResolvedValue(
      makeGraphQLResponse([
        {
          body: "Just a regular comment",
          createdAt: "2024-01-15T10:00:00Z",
          reactions: [],
        },
      ]),
    );

    const result = await fetchVotes(repo, [42], "scout");
    expect(result.size).toBe(0);
  });

  it("returns empty map when user has no reaction on voting comment", async () => {
    mockedGh.mockResolvedValue(
      makeGraphQLResponse([
        {
          body: '<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->',
          createdAt: "2024-01-15T10:00:00Z",
          reactions: [
            { content: "THUMBS_UP", createdAt: "2024-01-16T12:00:00Z", userLogin: "other" },
          ],
        },
      ]),
    );

    const result = await fetchVotes(repo, [42], "scout");
    expect(result.size).toBe(0);
  });

  it("uses the latest voting comment when multiple exist", async () => {
    mockedGh.mockResolvedValue(
      makeGraphQLResponse([
        {
          body: '<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-10T10:00:00.000Z","issueNumber":42} -->',
          createdAt: "2024-01-10T10:00:00Z",
          reactions: [
            { content: "THUMBS_DOWN", createdAt: "2024-01-11T12:00:00Z", userLogin: "scout" },
          ],
        },
        {
          body: '<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":2,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->',
          createdAt: "2024-01-15T10:00:00Z",
          reactions: [
            { content: "THUMBS_UP", createdAt: "2024-01-16T12:00:00Z", userLogin: "scout" },
          ],
        },
      ]),
    );

    const result = await fetchVotes(repo, [42], "scout");
    expect(result.get(42)?.reaction).toBe("👍");
  });

  it("fetches votes for multiple issues in parallel", async () => {
    mockedGh
      .mockResolvedValueOnce(
        makeGraphQLResponse([
          {
            body: '<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":1} -->',
            createdAt: "2024-01-15T10:00:00Z",
            reactions: [
              { content: "THUMBS_UP", createdAt: "2024-01-16T12:00:00Z", userLogin: "scout" },
            ],
          },
        ]),
      )
      .mockResolvedValueOnce(
        makeGraphQLResponse([
          {
            body: '<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":2} -->',
            createdAt: "2024-01-15T10:00:00Z",
            reactions: [
              { content: "EYES", createdAt: "2024-01-17T12:00:00Z", userLogin: "scout" },
            ],
          },
        ]),
      );

    const result = await fetchVotes(repo, [1, 2], "scout");
    expect(result.size).toBe(2);
    expect(result.get(1)?.reaction).toBe("👍");
    expect(result.get(2)?.reaction).toBe("👀");
  });

  it("handles individual issue query failures gracefully", async () => {
    mockedGh
      .mockResolvedValueOnce(
        makeGraphQLResponse([
          {
            body: '<!-- hivemoot-metadata: {"version":1,"type":"voting","cycle":1,"createdAt":"2024-01-15T10:00:00.000Z","issueNumber":1} -->',
            createdAt: "2024-01-15T10:00:00Z",
            reactions: [
              { content: "THUMBS_UP", createdAt: "2024-01-16T12:00:00Z", userLogin: "scout" },
            ],
          },
        ]),
      )
      .mockRejectedValueOnce(new Error("GraphQL error"));

    const result = await fetchVotes(repo, [1, 2], "scout");
    expect(result.size).toBe(1);
    expect(result.get(1)?.reaction).toBe("👍");
    expect(result.has(2)).toBe(false);
  });

  it("handles non-voting metadata types", async () => {
    mockedGh.mockResolvedValue(
      makeGraphQLResponse([
        {
          body: '<!-- hivemoot-metadata: {"version":1,"type":"discussion","createdAt":"2024-01-15T10:00:00.000Z","issueNumber":42} -->',
          createdAt: "2024-01-15T10:00:00Z",
          reactions: [
            { content: "THUMBS_UP", createdAt: "2024-01-16T12:00:00Z", userLogin: "scout" },
          ],
        },
      ]),
    );

    const result = await fetchVotes(repo, [42], "scout");
    expect(result.size).toBe(0);
  });

  it("handles malformed metadata JSON gracefully", async () => {
    mockedGh.mockResolvedValue(
      makeGraphQLResponse([
        {
          body: "<!-- hivemoot-metadata: {invalid json} -->",
          createdAt: "2024-01-15T10:00:00Z",
          reactions: [],
        },
      ]),
    );

    const result = await fetchVotes(repo, [42], "scout");
    expect(result.size).toBe(0);
  });

  it("handles null issue in GraphQL response", async () => {
    mockedGh.mockResolvedValue(JSON.stringify({
      data: { repository: { issue: null } },
    }));

    const result = await fetchVotes(repo, [42], "scout");
    expect(result.size).toBe(0);
  });
});
