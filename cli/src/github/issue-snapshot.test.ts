import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./client.js", () => ({
  gh: vi.fn(),
}));

vi.mock("./user.js", () => ({
  fetchCurrentUser: vi.fn(),
}));

import { gh } from "./client.js";
import { fetchCurrentUser } from "./user.js";
import { buildIssueSnapshot } from "./issue-snapshot.js";

const mockedGh = vi.mocked(gh);
const mockedFetchCurrentUser = vi.mocked(fetchCurrentUser);

const testRepo = { owner: "hivemoot", repo: "hivemoot" };

function makeIssueResponse(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    number: 42,
    title: "Test issue",
    url: "https://github.com/hivemoot/hivemoot/issues/42",
    state: "OPEN",
    labels: [{ name: "hivemoot:discussion" }],
    assignees: [],
    author: { login: "testuser" },
    createdAt: "2026-02-20T00:00:00Z",
    updatedAt: "2026-02-25T00:00:00Z",
    ...overrides,
  });
}

function makeGraphQLResponse(comments: Array<Record<string, unknown>> = []) {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          comments: {
            pageInfo: { hasPreviousPage: false },
            nodes: comments,
          },
        },
      },
    },
  });
}

// Pageable comments response — hasPreviousPage controls whether another page exists.
function makeGraphQLResponsePaged(
  comments: Array<Record<string, unknown>>,
  hasPreviousPage: boolean,
  startCursor: string | null = null,
) {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          comments: {
            pageInfo: { hasPreviousPage, startCursor },
            nodes: comments,
          },
        },
      },
    },
  });
}

// A Queen comment with hivemoot-metadata embedded in the body.
function makeQueenComment(
  type: "voting" | "summary",
  issueNumber: number,
  options: {
    id?: string;
    databaseId?: number;
    url?: string;
    createdAt?: string;
    reactionsNodes?: Array<{ content: string; createdAt: string; user: { login: string } | null }>;
    reactionsHasNextPage?: boolean;
    reactionsEndCursor?: string | null;
  } = {},
) {
  const {
    id = "comment-id-1",
    databaseId = 1001,
    url = "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-1001",
    createdAt = "2026-02-20T12:00:00Z",
    reactionsNodes = [],
    reactionsHasNextPage = false,
    reactionsEndCursor = null,
  } = options;

  return {
    id,
    databaseId,
    url,
    body: `Queen body text\n<!-- hivemoot-metadata: {"type": "${type}", "issueNumber": ${issueNumber}} -->`,
    createdAt,
    author: { login: "hivemoot" },
    reactions: {
      pageInfo: { hasNextPage: reactionsHasNextPage, endCursor: reactionsEndCursor },
      nodes: reactionsNodes,
    },
  };
}

// A paginated reactions response (used when hasNextPage is true on the initial reactions).
function makeReactionsPageResponse(
  reactions: Array<{ content: string; createdAt: string; user: { login: string } | null }>,
  hasNextPage: boolean,
  endCursor: string | null = null,
) {
  return JSON.stringify({
    data: {
      node: {
        reactions: {
          pageInfo: { hasNextPage, endCursor },
          nodes: reactions,
        },
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetchCurrentUser.mockResolvedValue("testuser");
});

describe("buildIssueSnapshot phase detection", () => {
  it("recognizes hivemoot:discussion label", async () => {
    mockedGh
      .mockResolvedValueOnce(
        makeIssueResponse({ labels: [{ name: "hivemoot:discussion" }] }),
      )
      .mockResolvedValueOnce(makeGraphQLResponse());

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.issue.phase).toBe("discussion");
  });

  it("recognizes phase:discussion label", async () => {
    mockedGh
      .mockResolvedValueOnce(
        makeIssueResponse({ labels: [{ name: "phase:discussion" }] }),
      )
      .mockResolvedValueOnce(makeGraphQLResponse());

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.issue.phase).toBe("discussion");
  });

  it("recognizes hivemoot:voting label", async () => {
    mockedGh
      .mockResolvedValueOnce(
        makeIssueResponse({ labels: [{ name: "hivemoot:voting" }] }),
      )
      .mockResolvedValueOnce(makeGraphQLResponse());

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.issue.phase).toBe("voting");
  });

  it("recognizes phase:voting label", async () => {
    mockedGh
      .mockResolvedValueOnce(
        makeIssueResponse({ labels: [{ name: "phase:voting" }] }),
      )
      .mockResolvedValueOnce(makeGraphQLResponse());

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.issue.phase).toBe("voting");
  });

  it("recognizes hivemoot:extended-voting label", async () => {
    mockedGh
      .mockResolvedValueOnce(
        makeIssueResponse({
          labels: [{ name: "hivemoot:extended-voting" }],
        }),
      )
      .mockResolvedValueOnce(makeGraphQLResponse());

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.issue.phase).toBe("extended-voting");
  });

  it("recognizes phase:extended-voting label", async () => {
    mockedGh
      .mockResolvedValueOnce(
        makeIssueResponse({
          labels: [{ name: "phase:extended-voting" }],
        }),
      )
      .mockResolvedValueOnce(makeGraphQLResponse());

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.issue.phase).toBe("extended-voting");
  });

  it("recognizes hivemoot:ready-to-implement label", async () => {
    mockedGh
      .mockResolvedValueOnce(
        makeIssueResponse({
          labels: [{ name: "hivemoot:ready-to-implement" }],
        }),
      )
      .mockResolvedValueOnce(makeGraphQLResponse());

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.issue.phase).toBe("ready-to-implement");
  });

  it("recognizes phase:ready-to-implement label", async () => {
    mockedGh
      .mockResolvedValueOnce(
        makeIssueResponse({
          labels: [{ name: "phase:ready-to-implement" }],
        }),
      )
      .mockResolvedValueOnce(makeGraphQLResponse());

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.issue.phase).toBe("ready-to-implement");
  });

  it("recognizes hivemoot:rejected label", async () => {
    mockedGh
      .mockResolvedValueOnce(
        makeIssueResponse({ labels: [{ name: "hivemoot:rejected" }] }),
      )
      .mockResolvedValueOnce(makeGraphQLResponse());

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.issue.phase).toBe("rejected");
  });

  it("recognizes hivemoot:inconclusive label", async () => {
    mockedGh
      .mockResolvedValueOnce(
        makeIssueResponse({ labels: [{ name: "hivemoot:inconclusive" }] }),
      )
      .mockResolvedValueOnce(makeGraphQLResponse());

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.issue.phase).toBe("inconclusive");
  });

  it("recognizes hivemoot:implemented label", async () => {
    mockedGh
      .mockResolvedValueOnce(
        makeIssueResponse({ labels: [{ name: "hivemoot:implemented" }] }),
      )
      .mockResolvedValueOnce(makeGraphQLResponse());

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.issue.phase).toBe("implemented");
  });

  it("returns null for unknown labels", async () => {
    mockedGh
      .mockResolvedValueOnce(
        makeIssueResponse({ labels: [{ name: "bug" }, { name: "enhancement" }] }),
      )
      .mockResolvedValueOnce(makeGraphQLResponse());

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.issue.phase).toBe(null);
  });

  it("returns null for issues with no labels", async () => {
    mockedGh
      .mockResolvedValueOnce(makeIssueResponse({ labels: [] }))
      .mockResolvedValueOnce(makeGraphQLResponse());

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.issue.phase).toBe(null);
  });

  it("is case-insensitive for phase labels", async () => {
    mockedGh
      .mockResolvedValueOnce(
        makeIssueResponse({ labels: [{ name: "PHASE:DISCUSSION" }] }),
      )
      .mockResolvedValueOnce(makeGraphQLResponse());

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.issue.phase).toBe("discussion");
  });
});

describe("buildIssueSnapshot Queen comment extraction and metadata filtering", () => {
  it("ignores comments from non-Queen authors", async () => {
    const nonQueenComment = {
      id: "c1",
      databaseId: 1,
      url: "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-1",
      body: '<!-- hivemoot-metadata: {"type": "voting", "issueNumber": 42} -->',
      createdAt: "2026-02-20T12:00:00Z",
      author: { login: "some-contributor" },
      reactions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    };

    mockedGh
      .mockResolvedValueOnce(makeIssueResponse({ labels: [{ name: "hivemoot:voting" }] }))
      .mockResolvedValueOnce(makeGraphQLResponsePaged([nonQueenComment], false));

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.votingComment).toBeUndefined();
  });

  it("ignores Queen comments without hivemoot-metadata block", async () => {
    const commentWithoutMeta = {
      id: "c1",
      databaseId: 1,
      url: "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-1",
      body: "Just a regular comment with no metadata.",
      createdAt: "2026-02-20T12:00:00Z",
      author: { login: "hivemoot" },
      reactions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    };

    mockedGh
      .mockResolvedValueOnce(makeIssueResponse({ labels: [{ name: "hivemoot:voting" }] }))
      .mockResolvedValueOnce(makeGraphQLResponsePaged([commentWithoutMeta], false));

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.votingComment).toBeUndefined();
  });

  it("ignores Queen comments with metadata for a different issueNumber", async () => {
    const wrongIssueComment = {
      id: "c1",
      databaseId: 1,
      url: "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-1",
      body: '<!-- hivemoot-metadata: {"type": "voting", "issueNumber": 99} -->',
      createdAt: "2026-02-20T12:00:00Z",
      author: { login: "hivemoot" },
      reactions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    };

    mockedGh
      .mockResolvedValueOnce(makeIssueResponse({ labels: [{ name: "hivemoot:voting" }] }))
      .mockResolvedValueOnce(makeGraphQLResponsePaged([wrongIssueComment], false));

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.votingComment).toBeUndefined();
  });

  it("extracts voting comment fields and tallies reactions", async () => {
    const votingComment = makeQueenComment("voting", 42, {
      id: "voting-id",
      databaseId: 1001,
      url: "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-1001",
      reactionsNodes: [
        { content: "THUMBS_UP", createdAt: "2026-02-20T13:00:00Z", user: { login: "user1" } },
        { content: "THUMBS_UP", createdAt: "2026-02-20T13:01:00Z", user: { login: "user2" } },
        { content: "THUMBS_DOWN", createdAt: "2026-02-20T13:02:00Z", user: { login: "user3" } },
      ],
    });

    mockedGh
      .mockResolvedValueOnce(makeIssueResponse({ labels: [{ name: "hivemoot:voting" }] }))
      .mockResolvedValueOnce(makeGraphQLResponsePaged([votingComment], false));

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.votingComment).toBeDefined();
    expect(result.votingComment!.id).toBe("voting-id");
    expect(result.votingComment!.thumbsUp).toBe(2);
    expect(result.votingComment!.thumbsDown).toBe(1);
  });

  it("sets yourVote when the current user has reacted", async () => {
    mockedFetchCurrentUser.mockResolvedValue("testuser");

    const votingComment = makeQueenComment("voting", 42, {
      reactionsNodes: [
        { content: "THUMBS_UP", createdAt: "2026-02-20T13:00:00Z", user: { login: "testuser" } },
        { content: "THUMBS_DOWN", createdAt: "2026-02-20T13:01:00Z", user: { login: "other" } },
      ],
    });

    mockedGh
      .mockResolvedValueOnce(makeIssueResponse({ labels: [{ name: "hivemoot:voting" }] }))
      .mockResolvedValueOnce(makeGraphQLResponsePaged([votingComment], false));

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.votingComment?.yourVote).toBe("👍");
  });

  it("sets yourVote to null when the current user has not reacted", async () => {
    mockedFetchCurrentUser.mockResolvedValue("testuser");

    const votingComment = makeQueenComment("voting", 42, {
      reactionsNodes: [
        { content: "THUMBS_UP", createdAt: "2026-02-20T13:00:00Z", user: { login: "other-user" } },
      ],
    });

    mockedGh
      .mockResolvedValueOnce(makeIssueResponse({ labels: [{ name: "hivemoot:voting" }] }))
      .mockResolvedValueOnce(makeGraphQLResponsePaged([votingComment], false));

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.votingComment?.yourVote).toBeNull();
  });

  it("extracts Queen summary comment and strips metadata from bodyPreview", async () => {
    const summaryComment = makeQueenComment("summary", 42, {
      url: "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-999",
    });

    mockedGh
      .mockResolvedValueOnce(makeIssueResponse({ labels: [{ name: "hivemoot:discussion" }] }))
      .mockResolvedValueOnce(makeGraphQLResponsePaged([summaryComment], false));

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.queenSummary).toBeDefined();
    expect(result.queenSummary!.url).toBe("https://github.com/hivemoot/hivemoot/issues/42#issuecomment-999");
    expect(result.queenSummary!.bodyPreview).toBe("Queen body text");
    expect(result.queenSummary!.bodyPreview).not.toMatch(/hivemoot-metadata/);
  });

  it("extracts both voting and summary comments when present", async () => {
    const votingComment = makeQueenComment("voting", 42, { id: "voting-id" });
    const summaryComment = makeQueenComment("summary", 42, { id: "summary-id" });

    mockedGh
      .mockResolvedValueOnce(makeIssueResponse({ labels: [{ name: "hivemoot:voting" }] }))
      .mockResolvedValueOnce(makeGraphQLResponsePaged([summaryComment, votingComment], false));

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.votingComment?.id).toBe("voting-id");
    expect(result.queenSummary).toBeDefined();
  });
});

describe("buildIssueSnapshot comment pagination", () => {
  it("finds Queen comment on the second (earlier) page when first page is empty", async () => {
    const votingComment = makeQueenComment("voting", 42, { id: "voting-id" });

    mockedGh
      .mockResolvedValueOnce(makeIssueResponse({ labels: [{ name: "hivemoot:voting" }] }))
      .mockResolvedValueOnce(makeGraphQLResponsePaged([], true, "cursor-page-1"))
      .mockResolvedValueOnce(makeGraphQLResponsePaged([votingComment], false));

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.votingComment?.id).toBe("voting-id");
    // gh was called for: issue view + 2 comment pages
    expect(mockedGh).toHaveBeenCalledTimes(3);
  });

  it("stops paging after finding both voting and summary on the same page", async () => {
    const votingComment = makeQueenComment("voting", 42, { id: "voting-id" });
    const summaryComment = makeQueenComment("summary", 42, { id: "summary-id" });

    // First page has both; hasPreviousPage is true but should not be fetched.
    mockedGh
      .mockResolvedValueOnce(makeIssueResponse({ labels: [{ name: "hivemoot:voting" }] }))
      .mockResolvedValueOnce(
        makeGraphQLResponsePaged([summaryComment, votingComment], true, "cursor-old"),
      );

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.votingComment).toBeDefined();
    expect(result.queenSummary).toBeDefined();
    // Only issue view + 1 comment page — pagination halted early.
    expect(mockedGh).toHaveBeenCalledTimes(2);
  });

  it("newer-page Queen comment takes precedence over older-page duplicate", async () => {
    const oldVoting = makeQueenComment("voting", 42, {
      id: "old-voting-id",
      url: "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-100",
      createdAt: "2026-02-15T12:00:00Z",
    });
    const newVoting = makeQueenComment("voting", 42, {
      id: "new-voting-id",
      url: "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-200",
      createdAt: "2026-02-20T12:00:00Z",
    });

    // Page 1 (most recent): newer comment; page 2 (earlier): older comment.
    mockedGh
      .mockResolvedValueOnce(makeIssueResponse({ labels: [{ name: "hivemoot:voting" }] }))
      .mockResolvedValueOnce(makeGraphQLResponsePaged([newVoting], true, "cursor-old"))
      .mockResolvedValueOnce(makeGraphQLResponsePaged([oldVoting], false));

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.votingComment?.id).toBe("new-voting-id");
  });
});

describe("buildIssueSnapshot reaction pagination", () => {
  it("fetches additional reaction pages when hasNextPage is true", async () => {
    const votingComment = makeQueenComment("voting", 42, {
      id: "voting-comment-id",
      reactionsNodes: [
        { content: "THUMBS_UP", createdAt: "2026-02-20T13:00:00Z", user: { login: "user1" } },
        { content: "THUMBS_UP", createdAt: "2026-02-20T13:01:00Z", user: { login: "user2" } },
      ],
      reactionsHasNextPage: true,
      reactionsEndCursor: "reactions-cursor-1",
    });

    // Second reactions page adds 1 more up and 1 down.
    const reactionsPage2 = makeReactionsPageResponse(
      [
        { content: "THUMBS_UP", createdAt: "2026-02-20T14:00:00Z", user: { login: "user3" } },
        { content: "THUMBS_DOWN", createdAt: "2026-02-20T14:01:00Z", user: { login: "user4" } },
      ],
      false,
    );

    mockedGh
      .mockResolvedValueOnce(makeIssueResponse({ labels: [{ name: "hivemoot:voting" }] }))
      .mockResolvedValueOnce(makeGraphQLResponsePaged([votingComment], false))
      .mockResolvedValueOnce(reactionsPage2);

    const result = await buildIssueSnapshot(testRepo, 42);
    // 2 from page 1 + 1 from page 2 = 3 up; 1 down from page 2.
    expect(result.votingComment?.thumbsUp).toBe(3);
    expect(result.votingComment?.thumbsDown).toBe(1);
    // gh called for: issue view + comments page + reactions page 2.
    expect(mockedGh).toHaveBeenCalledTimes(3);
  });

  it("detects yourVote when the current user reacted on the second reactions page", async () => {
    mockedFetchCurrentUser.mockResolvedValue("testuser");

    const votingComment = makeQueenComment("voting", 42, {
      id: "voting-comment-id",
      reactionsNodes: [
        { content: "THUMBS_UP", createdAt: "2026-02-20T13:00:00Z", user: { login: "other-user" } },
      ],
      reactionsHasNextPage: true,
      reactionsEndCursor: "reactions-cursor-1",
    });

    // testuser's 👎 is only on the second reactions page.
    const reactionsPage2 = makeReactionsPageResponse(
      [{ content: "THUMBS_DOWN", createdAt: "2026-02-20T14:00:00Z", user: { login: "testuser" } }],
      false,
    );

    mockedGh
      .mockResolvedValueOnce(makeIssueResponse({ labels: [{ name: "hivemoot:voting" }] }))
      .mockResolvedValueOnce(makeGraphQLResponsePaged([votingComment], false))
      .mockResolvedValueOnce(reactionsPage2);

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.votingComment?.yourVote).toBe("👎");
    expect(result.votingComment?.thumbsUp).toBe(1);
    expect(result.votingComment?.thumbsDown).toBe(1);
  });

  it("does not call the reactions paginator when hasNextPage is false", async () => {
    const votingComment = makeQueenComment("voting", 42, {
      reactionsNodes: [
        { content: "THUMBS_UP", createdAt: "2026-02-20T13:00:00Z", user: { login: "user1" } },
      ],
      reactionsHasNextPage: false,
    });

    mockedGh
      .mockResolvedValueOnce(makeIssueResponse({ labels: [{ name: "hivemoot:voting" }] }))
      .mockResolvedValueOnce(makeGraphQLResponsePaged([votingComment], false));

    const result = await buildIssueSnapshot(testRepo, 42);
    expect(result.votingComment?.thumbsUp).toBe(1);
    // Only 2 gh calls — no reaction pagination needed.
    expect(mockedGh).toHaveBeenCalledTimes(2);
  });
});
