import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitHubIssue } from "../config/types.js";
import { CliError } from "../config/types.js";

vi.mock("./client.js", () => ({
  gh: vi.fn(),
}));

import { gh } from "./client.js";
import { fetchIssues } from "./issues.js";

const mockGh = gh as unknown as ReturnType<typeof vi.fn>;

describe("fetchIssues()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls gh with correct arguments", async () => {
    mockGh.mockResolvedValue("[]");

    await fetchIssues({ owner: "hivemoot", repo: "cli" });

    expect(mockGh).toHaveBeenCalledWith([
      "issue",
      "list",
      "-R",
      "hivemoot/cli",
      "--state",
      "open",
      "--json",
      "number,title,labels,assignees,author,comments,createdAt,updatedAt,url",
      "--limit",
      "200",
    ]);
  });

  it("parses and returns issues from JSON", async () => {
    const issues: GitHubIssue[] = [
      {
        number: 1,
        title: "Bug report",
        labels: [{ name: "bug" }],
        assignees: [{ login: "alice" }],
        author: { login: "bob" },
        comments: [{ createdAt: "2025-01-01T00:00:00Z" }],
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-02T00:00:00Z",
        url: "https://github.com/hivemoot/cli/issues/1",
      },
    ];
    mockGh.mockResolvedValue(JSON.stringify(issues));

    const result = await fetchIssues({ owner: "hivemoot", repo: "cli" });

    expect(result).toEqual(issues);
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
    expect(result[0].labels[0].name).toBe("bug");
  });

  it("returns empty array when no issues", async () => {
    mockGh.mockResolvedValue("[]");

    const result = await fetchIssues({ owner: "hivemoot", repo: "cli" });

    expect(result).toEqual([]);
  });

  it("throws CliError on malformed JSON from gh", async () => {
    mockGh.mockResolvedValue("not valid json");

    await expect(fetchIssues({ owner: "hivemoot", repo: "cli" })).rejects.toThrow(CliError);
    await expect(fetchIssues({ owner: "hivemoot", repo: "cli" })).rejects.toMatchObject({
      code: "GH_ERROR",
      message: expect.stringContaining("Failed to parse"),
    });
  });

  it("throws CliError on empty string from gh", async () => {
    mockGh.mockResolvedValue("");

    await expect(fetchIssues({ owner: "hivemoot", repo: "cli" })).rejects.toThrow(CliError);
  });

  it("throws CliError when gh returns non-array JSON", async () => {
    mockGh.mockResolvedValue('{"not": "an array"}');

    await expect(fetchIssues({ owner: "hivemoot", repo: "cli" })).rejects.toThrow(CliError);
    await expect(fetchIssues({ owner: "hivemoot", repo: "cli" })).rejects.toMatchObject({
      code: "GH_ERROR",
      message: expect.stringContaining("Unexpected"),
    });
  });
});
