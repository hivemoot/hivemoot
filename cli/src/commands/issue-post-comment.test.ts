import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

vi.mock("../github/repo.js", () => ({
  resolveRepo: vi.fn(),
}));

vi.mock("../github/issue-post-comment.js", () => ({
  postIssueComment: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { resolveRepo } from "../github/repo.js";
import { postIssueComment } from "../github/issue-post-comment.js";
import { issuePostCommentCommand } from "./issue-post-comment.js";
import type { IssuePostCommentResult } from "../github/issue-post-comment.js";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedResolveRepo = vi.mocked(resolveRepo);
const mockedPostIssueComment = vi.mocked(postIssueComment);

const testRepo = { owner: "hivemoot", repo: "hivemoot" };

function makePostResult(overrides: Partial<IssuePostCommentResult> = {}): IssuePostCommentResult {
  return {
    schemaVersion: 1,
    kind: "issue_post_comment",
    generatedAt: "2026-03-03T10:00:00.000Z",
    repo: testRepo,
    issue: 42,
    dryRun: false,
    code: "comment_posted",
    commentId: 9001,
    commentUrl: "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-9001",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockedResolveRepo.mockResolvedValue(testRepo);
  mockedPostIssueComment.mockResolvedValue(makePostResult());
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("issuePostCommentCommand", () => {
  describe("input validation", () => {
    it("throws CliError for non-numeric issue argument", async () => {
      await expect(issuePostCommentCommand("abc", { body: "Hello" })).rejects.toMatchObject({
        code: "GH_ERROR",
        message: expect.stringContaining("Invalid issue number"),
      });
    });

    it("throws CliError for zero issue number", async () => {
      await expect(issuePostCommentCommand("0", { body: "Hello" })).rejects.toThrow(CliError);
    });

    it("throws CliError when neither --body nor --body-file provided", async () => {
      await expect(issuePostCommentCommand("42", {})).rejects.toMatchObject({
        code: "GH_ERROR",
        message: expect.stringContaining("--body or --body-file is required"),
      });
    });

    it("throws CliError when both --body and --body-file provided", async () => {
      await expect(
        issuePostCommentCommand("42", { body: "Hello", bodyFile: "file.txt" }),
      ).rejects.toMatchObject({
        code: "GH_ERROR",
        message: expect.stringContaining("mutually exclusive"),
      });
    });

    it("throws CliError when body-file cannot be read", async () => {
      mockedReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file");
      });
      await expect(
        issuePostCommentCommand("42", { bodyFile: "missing.txt" }),
      ).rejects.toMatchObject({
        code: "GH_ERROR",
        message: expect.stringContaining("Could not read body file"),
      });
    });
  });

  describe("body-file handling", () => {
    it("reads body from file and passes to postIssueComment", async () => {
      mockedReadFileSync.mockReturnValue("Body from file");
      await issuePostCommentCommand("42", { bodyFile: "comment.txt" });
      expect(mockedPostIssueComment).toHaveBeenCalledWith(
        testRepo,
        42,
        "Body from file",
        false,
      );
    });
  });

  describe("inline body handling", () => {
    it("passes --body text to postIssueComment", async () => {
      await issuePostCommentCommand("42", { body: "Inline comment" });
      expect(mockedPostIssueComment).toHaveBeenCalledWith(
        testRepo,
        42,
        "Inline comment",
        false,
      );
    });
  });

  describe("dry-run", () => {
    it("passes dryRun=true to postIssueComment", async () => {
      await issuePostCommentCommand("42", { body: "Test", dryRun: true });
      expect(mockedPostIssueComment).toHaveBeenCalledWith(testRepo, 42, "Test", true);
    });

    it("formats dry-run output correctly", async () => {
      mockedPostIssueComment.mockResolvedValue(
        makePostResult({ dryRun: true, code: "dry_run", commentId: undefined, commentUrl: undefined }),
      );
      await issuePostCommentCommand("42", { body: "Test", dryRun: true });
      const output = (vi.mocked(console.log).mock.calls[0]![0] as string);
      expect(output).toContain("dry-run");
    });
  });

  describe("JSON output", () => {
    it("prints schemaVersion and kind", async () => {
      await issuePostCommentCommand("42", { body: "Hello", json: true });
      const output = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as IssuePostCommentResult;
      expect(output.schemaVersion).toBe(1);
      expect(output.kind).toBe("issue_post_comment");
    });

    it("includes commentUrl in JSON output", async () => {
      await issuePostCommentCommand("42", { body: "Hello", json: true });
      const output = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as IssuePostCommentResult;
      expect(output.commentUrl).toBe("https://github.com/hivemoot/hivemoot/issues/42#issuecomment-9001");
      expect(output.commentId).toBe(9001);
    });

    it("includes repo and issue in JSON output", async () => {
      await issuePostCommentCommand("42", { body: "Hello", json: true });
      const output = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as IssuePostCommentResult;
      expect(output.repo).toEqual(testRepo);
      expect(output.issue).toBe(42);
    });
  });

  describe("text output", () => {
    it("includes issue number and URL in text output", async () => {
      await issuePostCommentCommand("42", { body: "Hello" });
      const output = vi.mocked(console.log).mock.calls[0]![0] as string;
      expect(output).toContain("42");
      expect(output).toContain("https://github.com/hivemoot/hivemoot/issues/42#issuecomment-9001");
    });
  });

  describe("error handling", () => {
    it("escalates CliError exit code to at least 3", async () => {
      mockedPostIssueComment.mockRejectedValue(new CliError("API error", "GH_ERROR", 1));
      await expect(issuePostCommentCommand("42", { body: "Hello" })).rejects.toMatchObject({
        exitCode: 3,
      });
    });

    it("wraps non-CliError as CliError with GH_ERROR code", async () => {
      mockedPostIssueComment.mockRejectedValue(new Error("network timeout"));
      await expect(issuePostCommentCommand("42", { body: "Hello" })).rejects.toMatchObject({
        code: "GH_ERROR",
        exitCode: 3,
      });
    });

    it("passes --repo flag to resolveRepo", async () => {
      await issuePostCommentCommand("42", { body: "Hello", repo: "other/repo" });
      expect(mockedResolveRepo).toHaveBeenCalledWith("other/repo");
    });
  });
});
