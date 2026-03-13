import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

vi.mock("../github/repo.js", () => ({
  resolveRepo: vi.fn(),
}));

vi.mock("../github/pr-post-review.js", () => ({
  postPrReview: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { resolveRepo } from "../github/repo.js";
import { postPrReview } from "../github/pr-post-review.js";
import { prPostReviewCommand } from "./pr-post-review.js";
import type { PrPostReviewResult } from "../github/pr-post-review.js";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedResolveRepo = vi.mocked(resolveRepo);
const mockedPostPrReview = vi.mocked(postPrReview);

const testRepo = { owner: "hivemoot", repo: "hivemoot" };

function makeReviewResult(overrides: Partial<PrPostReviewResult> = {}): PrPostReviewResult {
  return {
    schemaVersion: 1,
    kind: "pr_review",
    generatedAt: "2026-03-04T10:00:00.000Z",
    repo: testRepo,
    pr: 42,
    headSha: "abc1234def5678901234567890123456789012345",
    event: "APPROVE",
    dryRun: false,
    code: "review_posted",
    reviewId: 9001,
    reviewUrl: "https://github.com/hivemoot/hivemoot/pull/42#pullrequestreview-9001",
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockedResolveRepo.mockResolvedValue(testRepo);
  mockedPostPrReview.mockResolvedValue(makeReviewResult());
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("prPostReviewCommand", () => {
  describe("input validation", () => {
    it("throws CliError for non-numeric PR argument", async () => {
      await expect(
        prPostReviewCommand("abc", { event: "APPROVE" }),
      ).rejects.toMatchObject({
        code: "GH_ERROR",
        message: expect.stringContaining("Invalid pull request number"),
      });
    });

    it("throws CliError for zero PR number", async () => {
      await expect(
        prPostReviewCommand("0", { event: "APPROVE" }),
      ).rejects.toThrow(CliError);
    });

    it("throws CliError for invalid event value", async () => {
      await expect(
        prPostReviewCommand("42", { event: "MERGE" }),
      ).rejects.toMatchObject({
        code: "GH_ERROR",
        message: expect.stringContaining("Invalid review event"),
      });
    });

    it("throws CliError when both --body and --body-file provided", async () => {
      await expect(
        prPostReviewCommand("42", { event: "APPROVE", body: "text", bodyFile: "file.txt" }),
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
        prPostReviewCommand("42", { event: "APPROVE", bodyFile: "missing.txt" }),
      ).rejects.toMatchObject({
        code: "GH_ERROR",
        message: expect.stringContaining("Could not read body file"),
      });
    });
  });

  describe("event normalization", () => {
    it("accepts lowercase approve", async () => {
      await prPostReviewCommand("42", { event: "approve" });
      expect(mockedPostPrReview).toHaveBeenCalledWith(testRepo, 42, "APPROVE", "", false);
    });

    it("accepts request-changes", async () => {
      await prPostReviewCommand("42", { event: "request-changes" });
      expect(mockedPostPrReview).toHaveBeenCalledWith(testRepo, 42, "REQUEST_CHANGES", "", false);
    });

    it("accepts comment", async () => {
      await prPostReviewCommand("42", { event: "comment" });
      expect(mockedPostPrReview).toHaveBeenCalledWith(testRepo, 42, "COMMENT", "", false);
    });
  });

  describe("body-file handling", () => {
    it("reads body from file and passes to postPrReview", async () => {
      mockedReadFileSync.mockReturnValue("Review body from file");
      await prPostReviewCommand("42", { event: "APPROVE", bodyFile: "review.txt" });
      expect(mockedPostPrReview).toHaveBeenCalledWith(
        testRepo,
        42,
        "APPROVE",
        "Review body from file",
        false,
      );
    });
  });

  describe("inline body handling", () => {
    it("passes --body text to postPrReview", async () => {
      await prPostReviewCommand("42", { event: "APPROVE", body: "LGTM" });
      expect(mockedPostPrReview).toHaveBeenCalledWith(testRepo, 42, "APPROVE", "LGTM", false);
    });
  });

  describe("dry-run", () => {
    it("passes dryRun=true to postPrReview", async () => {
      await prPostReviewCommand("42", { event: "APPROVE", dryRun: true });
      expect(mockedPostPrReview).toHaveBeenCalledWith(testRepo, 42, "APPROVE", "", true);
    });

    it("formats dry-run output correctly", async () => {
      mockedPostPrReview.mockResolvedValue(
        makeReviewResult({ dryRun: true, code: "dry_run", reviewId: undefined, reviewUrl: undefined }),
      );
      await prPostReviewCommand("42", { event: "APPROVE", dryRun: true });
      const output = vi.mocked(console.log).mock.calls[0]![0] as string;
      expect(output).toContain("dry-run");
    });
  });

  describe("already_reviewed idempotency", () => {
    it("sets exit code 2 when already reviewed", async () => {
      mockedPostPrReview.mockResolvedValue(
        makeReviewResult({
          code: "already_reviewed",
          reviewId: undefined,
          reviewUrl: undefined,
          warnings: [{ code: "already_reviewed", message: "Already submitted APPROVED review at abc1234." }],
        }),
      );
      await prPostReviewCommand("42", { event: "APPROVE" });
      expect(process.exitCode).toBe(2);
    });

    it("does not set exit code 2 for review_posted", async () => {
      await prPostReviewCommand("42", { event: "APPROVE" });
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe("JSON output", () => {
    it("prints schemaVersion and kind", async () => {
      await prPostReviewCommand("42", { event: "APPROVE", json: true });
      const output = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as PrPostReviewResult;
      expect(output.schemaVersion).toBe(1);
      expect(output.kind).toBe("pr_review");
    });

    it("includes headSha, event, and code in JSON output", async () => {
      await prPostReviewCommand("42", { event: "APPROVE", json: true });
      const output = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as PrPostReviewResult;
      expect(output.headSha).toBe("abc1234def5678901234567890123456789012345");
      expect(output.event).toBe("APPROVE");
      expect(output.code).toBe("review_posted");
    });

    it("includes reviewUrl in JSON output", async () => {
      await prPostReviewCommand("42", { event: "APPROVE", json: true });
      const output = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as PrPostReviewResult;
      expect(output.reviewUrl).toBe(
        "https://github.com/hivemoot/hivemoot/pull/42#pullrequestreview-9001",
      );
    });
  });

  describe("text output", () => {
    it("includes PR number and shortened SHA in text output", async () => {
      await prPostReviewCommand("42", { event: "APPROVE" });
      const output = vi.mocked(console.log).mock.calls[0]![0] as string;
      expect(output).toContain("42");
      expect(output).toContain("abc1234");
    });

    it("includes review URL in text output when posted", async () => {
      await prPostReviewCommand("42", { event: "APPROVE" });
      const output = vi.mocked(console.log).mock.calls[0]![0] as string;
      expect(output).toContain("https://github.com/hivemoot/hivemoot/pull/42#pullrequestreview-9001");
    });

    it("includes warning in text output", async () => {
      mockedPostPrReview.mockResolvedValue(
        makeReviewResult({
          warnings: [{ code: "own_pr", message: "PR #42 was authored by you." }],
        }),
      );
      await prPostReviewCommand("42", { event: "APPROVE" });
      const output = vi.mocked(console.log).mock.calls[0]![0] as string;
      expect(output).toContain("warning [own_pr]");
    });
  });

  describe("error handling", () => {
    it("escalates CliError exit code to at least 3", async () => {
      mockedPostPrReview.mockRejectedValue(new CliError("API error", "GH_ERROR", 1));
      await expect(prPostReviewCommand("42", { event: "APPROVE" })).rejects.toMatchObject({
        exitCode: 3,
      });
    });

    it("wraps non-CliError as CliError with GH_ERROR code", async () => {
      mockedPostPrReview.mockRejectedValue(new Error("network timeout"));
      await expect(prPostReviewCommand("42", { event: "APPROVE" })).rejects.toMatchObject({
        code: "GH_ERROR",
        exitCode: 3,
      });
    });

    it("passes --repo flag to resolveRepo", async () => {
      await prPostReviewCommand("42", { event: "APPROVE", repo: "other/repo" });
      expect(mockedResolveRepo).toHaveBeenCalledWith("other/repo");
    });
  });
});
