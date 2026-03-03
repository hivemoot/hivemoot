import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("../github/repo.js", () => ({
  resolveRepo: vi.fn(),
}));

vi.mock("../github/pr-review.js", () => ({
  buildPrReviewResult: vi.fn(),
}));

import { resolveRepo } from "../github/repo.js";
import { buildPrReviewResult } from "../github/pr-review.js";
import { prReviewCommand } from "./pr-review.js";

const mockedResolveRepo = vi.mocked(resolveRepo);
const mockedBuildPrReviewResult = vi.mocked(buildPrReviewResult);

const REPO = { owner: "hivemoot", repo: "hivemoot" };
const HEAD_SHA = "abc1234defabc1234defabc1234defabc1234def";

function makeSubmittedResult(overrides = {}) {
  return {
    schemaVersion: 1 as const,
    kind: "pr_review" as const,
    generatedAt: "2026-03-03T00:00:00.000Z",
    repo: REPO,
    pr: 99,
    headSha: HEAD_SHA,
    event: "approve" as const,
    dryRun: false,
    code: "review_submitted" as const,
    reviewUrl: "https://github.com/hivemoot/hivemoot/pull/99#pullrequestreview-123",
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockedResolveRepo.mockResolvedValue(REPO);
  mockedBuildPrReviewResult.mockResolvedValue(makeSubmittedResult());
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("prReviewCommand", () => {
  it("rejects invalid event argument", async () => {
    await expect(prReviewCommand("99", "invalid-event", {})).rejects.toMatchObject({
      code: "GH_ERROR",
      exitCode: 2,
    });
  });

  it("accepts approve event and prints text output", async () => {
    await prReviewCommand("99", "approve", {});
    expect(console.log).toHaveBeenCalledTimes(1);
    const output = String(vi.mocked(console.log).mock.calls[0]?.[0] ?? "");
    expect(output).toContain("PR REVIEW");
    expect(output).toContain("hivemoot/hivemoot#99");
    expect(output).toContain("approve");
    expect(output).toContain("review_submitted");
  });

  it("accepts request-changes event", async () => {
    mockedBuildPrReviewResult.mockResolvedValueOnce(
      makeSubmittedResult({ event: "request-changes" }),
    );
    await prReviewCommand("99", "request-changes", {});
    expect(mockedBuildPrReviewResult).toHaveBeenCalledWith(
      REPO, "99", "request-changes", "", false,
    );
  });

  it("accepts comment event", async () => {
    mockedBuildPrReviewResult.mockResolvedValueOnce(
      makeSubmittedResult({ event: "comment" }),
    );
    await prReviewCommand("99", "comment", { body: "looks good" });
    expect(mockedBuildPrReviewResult).toHaveBeenCalledWith(
      REPO, "99", "comment", "looks good", false,
    );
  });

  it("outputs JSON when --json flag is set", async () => {
    await prReviewCommand("99", "approve", { json: true });
    expect(console.log).toHaveBeenCalledTimes(1);
    const raw = String(vi.mocked(console.log).mock.calls[0]?.[0] ?? "");
    const parsed = JSON.parse(raw) as { kind: string };
    expect(parsed.kind).toBe("pr_review");
    expect(parsed).toMatchObject({ schemaVersion: 1 });
  });

  it("sets exit code 2 when already_reviewed", async () => {
    mockedBuildPrReviewResult.mockResolvedValueOnce(
      makeSubmittedResult({ code: "already_reviewed", priorState: "APPROVED", reviewUrl: undefined }),
    );
    await prReviewCommand("99", "approve", {});
    expect(process.exitCode).toBe(2);
  });

  it("keeps exit code unset when review_submitted", async () => {
    await prReviewCommand("99", "approve", {});
    expect(process.exitCode).toBeUndefined();
  });

  it("shows already-reviewed message in text output", async () => {
    mockedBuildPrReviewResult.mockResolvedValueOnce(
      makeSubmittedResult({ code: "already_reviewed", priorState: "APPROVED", reviewUrl: undefined }),
    );
    await prReviewCommand("99", "approve", {});
    const output = String(vi.mocked(console.log).mock.calls[0]?.[0] ?? "");
    expect(output).toContain("APPROVED at current HEAD");
    expect(output).toContain("already_reviewed");
  });

  it("passes dry-run flag to buildPrReviewResult", async () => {
    mockedBuildPrReviewResult.mockResolvedValueOnce(
      makeSubmittedResult({ dryRun: true, reviewUrl: undefined }),
    );
    await prReviewCommand("99", "approve", { dryRun: true });
    expect(mockedBuildPrReviewResult).toHaveBeenCalledWith(
      REPO, "99", "approve", "", true,
    );
  });

  it("shows dry-run mode in text output", async () => {
    mockedBuildPrReviewResult.mockResolvedValueOnce(
      makeSubmittedResult({ dryRun: true, reviewUrl: undefined }),
    );
    await prReviewCommand("99", "approve", { dryRun: true });
    const output = String(vi.mocked(console.log).mock.calls[0]?.[0] ?? "");
    expect(output).toContain("dry-run");
  });

  it("shows review URL in text output when submitted", async () => {
    await prReviewCommand("99", "approve", {});
    const output = String(vi.mocked(console.log).mock.calls[0]?.[0] ?? "");
    expect(output).toContain("https://github.com/hivemoot/hivemoot/pull/99#pullrequestreview-123");
  });

  it("shows warnings in text output", async () => {
    mockedBuildPrReviewResult.mockResolvedValueOnce(
      makeSubmittedResult({
        warnings: [{ code: "own_pr", message: "You are the PR author." }],
      }),
    );
    await prReviewCommand("99", "approve", {});
    const output = String(vi.mocked(console.log).mock.calls[0]?.[0] ?? "");
    expect(output).toContain("own_pr");
  });

  it("upgrades execution errors to exit code >= 3", async () => {
    mockedBuildPrReviewResult.mockRejectedValueOnce(
      new CliError("temporary gh failure", "GH_ERROR", 1),
    );
    await expect(prReviewCommand("99", "approve", {})).rejects.toMatchObject({
      exitCode: 3,
      code: "GH_ERROR",
    });
  });

  it("wraps non-CliError exceptions in CliError with exit code >= 3", async () => {
    mockedBuildPrReviewResult.mockRejectedValueOnce(new Error("network error"));
    await expect(prReviewCommand("99", "approve", {})).rejects.toMatchObject({
      exitCode: 3,
      code: "GH_ERROR",
    });
  });
});
