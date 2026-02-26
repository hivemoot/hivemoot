import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./client.js", () => ({
  gh: vi.fn(),
}));

vi.mock("./user.js", () => ({
  fetchCurrentUser: vi.fn(),
}));

import { gh } from "./client.js";
import { fetchCurrentUser } from "./user.js";
import { buildIssueVoteResult, TRUSTED_QUEEN_LOGINS } from "./issue-vote.js";

const mockedGh = vi.mocked(gh);
const mockedFetchCurrentUser = vi.mocked(fetchCurrentUser);

const repo = { owner: "hivemoot", repo: "hivemoot" };
const ISSUE = 42;

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetchCurrentUser.mockResolvedValue("hivemoot-heater");
});

function makeVotingCommentBody(issueNumber: number): string {
  return `<!-- hivemoot-metadata: {"version":1,"type":"voting","issueNumber":${issueNumber}} -->\n# Voting\nCast your vote.`;
}

function makeNonVotingCommentBody(): string {
  return `<!-- hivemoot-metadata: {"version":1,"type":"welcome"} -->\nWelcome!`;
}

function makeCommentsResponse(comments: Array<{
  id?: string;
  databaseId?: number;
  url?: string;
  body: string;
  author?: string | null;
  reactions?: Array<{ content: string; userLogin: string | null }>;
}>, options?: {
  hasPreviousPage?: boolean;
  startCursor?: string | null;
  reactionsHasNextPage?: boolean;
  reactionsEndCursor?: string | null;
}): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          comments: {
            pageInfo: {
              hasPreviousPage: options?.hasPreviousPage ?? false,
              startCursor: options?.startCursor ?? null,
            },
            nodes: comments.map((c, i) => ({
              id: c.id ?? `node-id-${i}`,
              databaseId: c.databaseId ?? (1000 + i),
              url: c.url ?? `https://github.com/hivemoot/hivemoot/issues/${ISSUE}#issuecomment-${1000 + i}`,
              body: c.body,
              createdAt: "2026-02-25T10:00:00Z",
              author: c.author !== undefined
                ? (c.author === null ? null : { login: c.author })
                : { login: "hivemoot" },
              reactions: {
                pageInfo: {
                  hasNextPage: options?.reactionsHasNextPage ?? false,
                  endCursor: options?.reactionsEndCursor ?? null,
                },
                nodes: (c.reactions ?? []).map((r) => ({
                  content: r.content,
                  createdAt: "2026-02-25T11:00:00Z",
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

function makeReactionsPageResponse(reactions: Array<{ content: string; userLogin: string | null }>, options?: {
  hasNextPage?: boolean;
  endCursor?: string | null;
}): string {
  return JSON.stringify({
    data: {
      node: {
        reactions: {
          pageInfo: {
            hasNextPage: options?.hasNextPage ?? false,
            endCursor: options?.endCursor ?? null,
          },
          nodes: reactions.map((r) => ({
            content: r.content,
            createdAt: "2026-02-25T11:00:00Z",
            user: r.userLogin ? { login: r.userLogin } : null,
          })),
        },
      },
    },
  });
}

function makeAddReactionResponse(): string {
  return JSON.stringify({ id: 99, content: "+1", user: { login: "hivemoot-heater" } });
}

describe("buildIssueVoteResult", () => {
  describe("trusted queen logins", () => {
    it("exports TRUSTED_QUEEN_LOGINS constant", () => {
      expect(TRUSTED_QUEEN_LOGINS).toContain("hivemoot");
      expect(TRUSTED_QUEEN_LOGINS).toContain("hivemoot[bot]");
    });
  });

  describe("no_voting_target", () => {
    it("returns no_voting_target when issue has no comments", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([], { hasPreviousPage: false }));

      const result = await buildIssueVoteResult(repo, ISSUE, "up", false);

      expect(result.code).toBe("no_voting_target");
      expect(result.targetComment).toBeUndefined();
      expect(result.appliedReaction).toBeUndefined();
      expect(result.warnings).toHaveLength(0);
      expect(result.kind).toBe("issue_vote");
      expect(result.schemaVersion).toBe(1);
      expect(result.trustedQueenLogins).toEqual(["hivemoot", "hivemoot[bot]"]);
      expect(mockedFetchCurrentUser).not.toHaveBeenCalled();
    });

    it("returns no_voting_target when comments exist but none are voting type", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([
        { body: makeNonVotingCommentBody(), author: "hivemoot" },
        { body: "A regular comment", author: "some-user" },
      ]));

      const result = await buildIssueVoteResult(repo, ISSUE, "up", false);

      expect(result.code).toBe("no_voting_target");
      expect(mockedFetchCurrentUser).not.toHaveBeenCalled();
    });

    it("returns no_voting_target when voting comment is not from trusted author", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([
        { body: makeVotingCommentBody(ISSUE), author: "untrusted-user" },
      ]));

      const result = await buildIssueVoteResult(repo, ISSUE, "up", false);

      expect(result.code).toBe("no_voting_target");
    });

    it("returns no_voting_target when voting comment issueNumber does not match", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([
        { body: makeVotingCommentBody(999), author: "hivemoot" },
      ]));

      const result = await buildIssueVoteResult(repo, ISSUE, "up", false);

      expect(result.code).toBe("no_voting_target");
    });

    it("accepts hivemoot[bot] as a trusted author", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([
        { body: makeVotingCommentBody(ISSUE), author: "hivemoot[bot]" },
      ]));
      mockedGh.mockResolvedValueOnce(makeAddReactionResponse());

      const result = await buildIssueVoteResult(repo, ISSUE, "up", false);

      expect(result.code).toBe("vote_applied");
      expect(result.targetComment?.author).toBe("hivemoot[bot]");
    });

    it("paginates backward to find voting comment", async () => {
      // First page: no voting comment, but has previous page
      mockedGh.mockResolvedValueOnce(makeCommentsResponse(
        [{ body: "recent comment", author: "someone" }],
        { hasPreviousPage: true, startCursor: "cursor-abc" },
      ));
      // Second page: has the voting comment
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([
        { body: makeVotingCommentBody(ISSUE), author: "hivemoot", databaseId: 2000 },
      ]));
      mockedGh.mockResolvedValueOnce(makeAddReactionResponse());

      const result = await buildIssueVoteResult(repo, ISSUE, "up", false);

      expect(result.code).toBe("vote_applied");
      expect(mockedGh).toHaveBeenCalledTimes(3); // 2 page fetches + 1 reaction POST
    });

    it("selects the latest trusted voting comment when multiple are on one page", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([
        { body: makeVotingCommentBody(ISSUE), author: "hivemoot", databaseId: 2001, id: "old-id" },
        { body: makeVotingCommentBody(ISSUE), author: "hivemoot[bot]", databaseId: 2002, id: "new-id" },
      ]));
      mockedGh.mockResolvedValueOnce(makeAddReactionResponse());

      const result = await buildIssueVoteResult(repo, ISSUE, "up", false);

      expect(result.code).toBe("vote_applied");
      expect(result.targetComment?.databaseId).toBe(2002);
      expect(result.targetComment?.id).toBe("new-id");
      const reactionArgs = mockedGh.mock.calls[1][0] as string[];
      expect(reactionArgs).toContain("/repos/hivemoot/hivemoot/issues/comments/2002/reactions");
    });
  });

  describe("vote_applied", () => {
    it("applies thumbs-up reaction and returns vote_applied", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([
        { body: makeVotingCommentBody(ISSUE), author: "hivemoot", databaseId: 5001 },
      ]));
      mockedGh.mockResolvedValueOnce(makeAddReactionResponse());

      const result = await buildIssueVoteResult(repo, ISSUE, "up", false);

      expect(result.code).toBe("vote_applied");
      expect(result.appliedReaction).toBe("👍");
      expect(result.warnings).toHaveLength(0);
      expect(result.targetComment?.databaseId).toBe(5001);
      expect(result.vote).toBe("up");
      expect(result.dryRun).toBe(false);

      // Verify the reaction POST used +1
      const reactionArgs = mockedGh.mock.calls[1][0] as string[];
      expect(reactionArgs).toContain("content=+1");
    });

    it("applies thumbs-down reaction for down vote", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([
        { body: makeVotingCommentBody(ISSUE), author: "hivemoot", databaseId: 5002 },
      ]));
      mockedGh.mockResolvedValueOnce(makeAddReactionResponse());

      const result = await buildIssueVoteResult(repo, ISSUE, "down", false);

      expect(result.code).toBe("vote_applied");
      expect(result.appliedReaction).toBe("👎");

      const reactionArgs = mockedGh.mock.calls[1][0] as string[];
      expect(reactionArgs).toContain("content=-1");
    });

    it("includes targetComment with url, id, databaseId, author, createdAt", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([
        {
          body: makeVotingCommentBody(ISSUE),
          author: "hivemoot",
          databaseId: 9999,
          id: "IC_abc123",
          url: "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-9999",
        },
      ]));
      mockedGh.mockResolvedValueOnce(makeAddReactionResponse());

      const result = await buildIssueVoteResult(repo, ISSUE, "up", false);

      expect(result.targetComment).toEqual({
        id: "IC_abc123",
        databaseId: 9999,
        url: "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-9999",
        createdAt: "2026-02-25T10:00:00Z",
        author: "hivemoot",
      });
    });

    it("includes repo, issue, schemaVersion, kind, generatedAt in result", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([
        { body: makeVotingCommentBody(ISSUE), author: "hivemoot" },
      ]));
      mockedGh.mockResolvedValueOnce(makeAddReactionResponse());

      const result = await buildIssueVoteResult(repo, ISSUE, "up", false);

      expect(result.schemaVersion).toBe(1);
      expect(result.kind).toBe("issue_vote");
      expect(result.repo).toEqual(repo);
      expect(result.issue).toBe(ISSUE);
      expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("already_voted", () => {
    it("returns already_voted for matching existing up vote without applying reaction", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([
        {
          body: makeVotingCommentBody(ISSUE),
          author: "hivemoot",
          reactions: [{ content: "THUMBS_UP", userLogin: "hivemoot-heater" }],
        },
      ]));

      const result = await buildIssueVoteResult(repo, ISSUE, "up", false);

      expect(result.code).toBe("already_voted");
      expect(result.appliedReaction).toBe("👍");
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].code).toBe("already_voted");
      // No reaction POST was made
      expect(mockedGh).toHaveBeenCalledTimes(1);
    });

    it("returns already_voted for matching existing down vote", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([
        {
          body: makeVotingCommentBody(ISSUE),
          author: "hivemoot",
          reactions: [{ content: "THUMBS_DOWN", userLogin: "hivemoot-heater" }],
        },
      ]));

      const result = await buildIssueVoteResult(repo, ISSUE, "down", false);

      expect(result.code).toBe("already_voted");
      expect(result.appliedReaction).toBe("👎");
    });
  });

  describe("conflicting_vote", () => {
    it("returns conflicting_vote when existing up vote conflicts with down request", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([
        {
          body: makeVotingCommentBody(ISSUE),
          author: "hivemoot",
          reactions: [{ content: "THUMBS_UP", userLogin: "hivemoot-heater" }],
        },
      ]));

      const result = await buildIssueVoteResult(repo, ISSUE, "down", false);

      expect(result.code).toBe("conflicting_vote");
      expect(result.appliedReaction).toBeUndefined();
      expect(result.warnings).toHaveLength(0);
      // No reaction POST was made
      expect(mockedGh).toHaveBeenCalledTimes(1);
    });

    it("returns conflicting_vote when existing down vote conflicts with up request", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([
        {
          body: makeVotingCommentBody(ISSUE),
          author: "hivemoot",
          reactions: [{ content: "THUMBS_DOWN", userLogin: "hivemoot-heater" }],
        },
      ]));

      const result = await buildIssueVoteResult(repo, ISSUE, "up", false);

      expect(result.code).toBe("conflicting_vote");
      expect(mockedGh).toHaveBeenCalledTimes(1);
    });

    it("does not count reactions from other users as conflicts", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([
        {
          body: makeVotingCommentBody(ISSUE),
          author: "hivemoot",
          reactions: [
            { content: "THUMBS_DOWN", userLogin: "someone-else" },
            { content: "THUMBS_UP", userLogin: "another-user" },
          ],
        },
      ]));
      mockedGh.mockResolvedValueOnce(makeAddReactionResponse());

      const result = await buildIssueVoteResult(repo, ISSUE, "up", false);

      expect(result.code).toBe("vote_applied");
    });
  });

  describe("dry-run", () => {
    it("resolves target comment but does not apply reaction", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([
        { body: makeVotingCommentBody(ISSUE), author: "hivemoot", databaseId: 7777 },
      ]));

      const result = await buildIssueVoteResult(repo, ISSUE, "up", true);

      expect(result.code).toBe("vote_applied");
      expect(result.dryRun).toBe(true);
      expect(result.appliedReaction).toBe("👍");
      expect(result.targetComment?.databaseId).toBe(7777);
      // Only the comments fetch, no POST
      expect(mockedGh).toHaveBeenCalledTimes(1);
    });

    it("returns no_voting_target in dry-run without side effects", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([]));

      const result = await buildIssueVoteResult(repo, ISSUE, "up", true);

      expect(result.code).toBe("no_voting_target");
      expect(result.dryRun).toBe(true);
    });

    it("returns conflicting_vote in dry-run without side effects", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse([
        {
          body: makeVotingCommentBody(ISSUE),
          author: "hivemoot",
          reactions: [{ content: "THUMBS_UP", userLogin: "hivemoot-heater" }],
        },
      ]));

      const result = await buildIssueVoteResult(repo, ISSUE, "down", true);

      expect(result.code).toBe("conflicting_vote");
      expect(result.dryRun).toBe(true);
      expect(mockedGh).toHaveBeenCalledTimes(1);
    });
  });

  describe("reaction pagination", () => {
    it("paginates to find user reaction when first page overflows", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse(
        [{ body: makeVotingCommentBody(ISSUE), author: "hivemoot", databaseId: 8888 }],
        { reactionsHasNextPage: true, reactionsEndCursor: "react-cursor-1" },
      ));
      // Reactions page 2: user's reaction is here
      mockedGh.mockResolvedValueOnce(makeReactionsPageResponse(
        [{ content: "THUMBS_UP", userLogin: "hivemoot-heater" }],
        { hasNextPage: false },
      ));

      const result = await buildIssueVoteResult(repo, ISSUE, "up", false);

      expect(result.code).toBe("already_voted");
      expect(mockedGh).toHaveBeenCalledTimes(2);
    });

    it("applies vote when user reaction not found across reaction pages", async () => {
      mockedGh.mockResolvedValueOnce(makeCommentsResponse(
        [{ body: makeVotingCommentBody(ISSUE), author: "hivemoot", databaseId: 8889 }],
        { reactionsHasNextPage: true, reactionsEndCursor: "react-cursor-2" },
      ));
      // Reactions page 2: no user reaction
      mockedGh.mockResolvedValueOnce(makeReactionsPageResponse(
        [{ content: "THUMBS_DOWN", userLogin: "someone-else" }],
        { hasNextPage: false },
      ));
      mockedGh.mockResolvedValueOnce(makeAddReactionResponse());

      const result = await buildIssueVoteResult(repo, ISSUE, "up", false);

      expect(result.code).toBe("vote_applied");
      expect(mockedGh).toHaveBeenCalledTimes(3);
    });
  });
});
