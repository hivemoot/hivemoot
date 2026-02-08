import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitHubPR } from "../config/types.js";
import { CliError } from "../config/types.js";

vi.mock("./client.js", () => ({
  gh: vi.fn(),
}));

import { gh } from "./client.js";
import { fetchPulls } from "./pulls.js";

const mockGh = gh as unknown as ReturnType<typeof vi.fn>;

describe("fetchPulls()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls gh with correct arguments", async () => {
    mockGh.mockResolvedValue("[]");

    await fetchPulls({ owner: "hivemoot", repo: "cli" });

    expect(mockGh).toHaveBeenCalledWith([
      "pr",
      "list",
      "-R",
      "hivemoot/cli",
      "--state",
      "open",
      "--json",
      "number,title,state,author,labels,comments,reviews,createdAt,updatedAt,url,isDraft,reviewDecision,mergeable,statusCheckRollup,closingIssuesReferences",
      "--limit",
      "200",
    ]);
  });

  it("parses and returns PRs from JSON", async () => {
    const prs: GitHubPR[] = [
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
    mockGh.mockResolvedValue(JSON.stringify(prs));

    const result = await fetchPulls({ owner: "hivemoot", repo: "cli" });

    expect(result).toEqual(prs);
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(42);
    expect(result[0].isDraft).toBe(false);
    expect(result[0].statusCheckRollup[0].state).toBe("SUCCESS");
  });

  it("returns empty array when no PRs", async () => {
    mockGh.mockResolvedValue("[]");

    const result = await fetchPulls({ owner: "hivemoot", repo: "cli" });

    expect(result).toEqual([]);
  });

  it("throws CliError on malformed JSON from gh", async () => {
    mockGh.mockResolvedValue("not valid json");

    await expect(fetchPulls({ owner: "hivemoot", repo: "cli" })).rejects.toThrow(CliError);
    await expect(fetchPulls({ owner: "hivemoot", repo: "cli" })).rejects.toMatchObject({
      code: "GH_ERROR",
      message: expect.stringContaining("Failed to parse"),
    });
  });

  it("throws CliError when gh returns non-array JSON", async () => {
    mockGh.mockResolvedValue('{"not": "an array"}');

    await expect(fetchPulls({ owner: "hivemoot", repo: "cli" })).rejects.toThrow(CliError);
    await expect(fetchPulls({ owner: "hivemoot", repo: "cli" })).rejects.toMatchObject({
      code: "GH_ERROR",
      message: expect.stringContaining("Unexpected"),
    });
  });
});
