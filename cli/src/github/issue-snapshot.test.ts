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
