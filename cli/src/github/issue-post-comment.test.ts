import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./client.js", () => ({
  gh: vi.fn(),
}));

import { gh } from "./client.js";
import { postIssueComment } from "./issue-post-comment.js";
import { CliError } from "../config/types.js";

const mockedGh = vi.mocked(gh);
const repo = { owner: "hivemoot", repo: "hivemoot" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("postIssueComment()", () => {
  it("returns dry_run result without calling gh when dryRun=true", async () => {
    const result = await postIssueComment(repo, 42, "Hello", true);
    expect(result.code).toBe("dry_run");
    expect(result.dryRun).toBe(true);
    expect(result.commentId).toBeUndefined();
    expect(result.commentUrl).toBeUndefined();
    expect(mockedGh).not.toHaveBeenCalled();
  });

  it("calls gh POST to the issue comments endpoint", async () => {
    mockedGh.mockResolvedValue(JSON.stringify({ id: 1234, html_url: "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-1234" }));
    await postIssueComment(repo, 42, "Test body", false);
    expect(mockedGh).toHaveBeenCalledWith([
      "api",
      "-X", "POST",
      "/repos/hivemoot/hivemoot/issues/42/comments",
      "--raw-field", "body=Test body",
    ]);
  });

  it("returns comment_posted with id and url on success", async () => {
    mockedGh.mockResolvedValue(JSON.stringify({
      id: 5678,
      html_url: "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-5678",
    }));
    const result = await postIssueComment(repo, 42, "Hello", false);
    expect(result.code).toBe("comment_posted");
    expect(result.commentId).toBe(5678);
    expect(result.commentUrl).toBe("https://github.com/hivemoot/hivemoot/issues/42#issuecomment-5678");
    expect(result.dryRun).toBe(false);
  });

  it("sets schemaVersion, kind, repo, and issue correctly", async () => {
    mockedGh.mockResolvedValue(JSON.stringify({ id: 1, html_url: "https://github.com/x" }));
    const result = await postIssueComment(repo, 99, "body", false);
    expect(result.schemaVersion).toBe(1);
    expect(result.kind).toBe("issue_post_comment");
    expect(result.repo).toEqual(repo);
    expect(result.issue).toBe(99);
  });

  it("throws CliError on invalid JSON response", async () => {
    mockedGh.mockResolvedValue("not json");
    await expect(postIssueComment(repo, 42, "Hello", false)).rejects.toMatchObject({
      code: "GH_ERROR",
    });
  });

  it("throws CliError when response is missing id field", async () => {
    mockedGh.mockResolvedValue(JSON.stringify({ html_url: "https://github.com/x" }));
    await expect(postIssueComment(repo, 42, "Hello", false)).rejects.toMatchObject({
      code: "GH_ERROR",
      message: expect.stringContaining("Unexpected GitHub API response shape"),
    });
  });

  it("throws CliError when response is missing html_url field", async () => {
    mockedGh.mockResolvedValue(JSON.stringify({ id: 1 }));
    await expect(postIssueComment(repo, 42, "Hello", false)).rejects.toMatchObject({
      code: "GH_ERROR",
    });
  });

  it("propagates gh CliError as-is", async () => {
    mockedGh.mockRejectedValue(new CliError("Not Found (HTTP 404)", "GH_ERROR", 1));
    await expect(postIssueComment(repo, 42, "Hello", false)).rejects.toMatchObject({
      code: "GH_ERROR",
      message: "Not Found (HTTP 404)",
    });
  });
});
