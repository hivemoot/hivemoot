import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("../github/repo.js", () => ({
  resolveRepo: vi.fn(),
}));

vi.mock("../github/issue-vote.js", () => ({
  buildIssueVoteResult: vi.fn(),
}));

import { resolveRepo } from "../github/repo.js";
import { buildIssueVoteResult } from "../github/issue-vote.js";
import { issueVoteCommand } from "./issue-vote.js";

const mockedResolveRepo = vi.mocked(resolveRepo);
const mockedBuildIssueVoteResult = vi.mocked(buildIssueVoteResult);

const testRepo = { owner: "hivemoot", repo: "hivemoot" };

function makeVoteResult(overrides: Partial<Awaited<ReturnType<typeof buildIssueVoteResult>>> = {}): Awaited<ReturnType<typeof buildIssueVoteResult>> {
  return {
    schemaVersion: 1,
    kind: "issue_vote",
    generatedAt: "2026-02-25T10:00:00.000Z",
    repo: testRepo,
    issue: 42,
    vote: "up",
    dryRun: false,
    trustedQueenLogins: ["hivemoot", "hivemoot[bot]"],
    targetComment: {
      id: "IC_node123",
      databaseId: 1234,
      url: "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-1234",
      createdAt: "2026-02-25T09:00:00Z",
      author: "hivemoot",
    },
    appliedReaction: "👍",
    code: "vote_applied",
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockedResolveRepo.mockResolvedValue(testRepo);
  mockedBuildIssueVoteResult.mockResolvedValue(makeVoteResult());
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("issueVoteCommand", () => {
  describe("input validation", () => {
    it("throws CliError for non-numeric issue argument", async () => {
      await expect(issueVoteCommand("abc", "up", {})).rejects.toThrow(CliError);
      await expect(issueVoteCommand("abc", "up", {})).rejects.toMatchObject({
        message: expect.stringContaining("Invalid issue number"),
      });
    });

    it("throws CliError for zero issue number", async () => {
      await expect(issueVoteCommand("0", "up", {})).rejects.toThrow(CliError);
    });

    it("throws CliError for invalid vote value", async () => {
      await expect(issueVoteCommand("42", "sideways", {})).rejects.toThrow(CliError);
      await expect(issueVoteCommand("42", "sideways", {})).rejects.toMatchObject({
        code: "GH_ERROR",
        exitCode: 2,
      });
    });

    it("accepts 'up' and 'down' as valid votes", async () => {
      mockedBuildIssueVoteResult.mockResolvedValue(makeVoteResult({ vote: "up" }));
      await expect(issueVoteCommand("42", "up", {})).resolves.toBeUndefined();

      mockedBuildIssueVoteResult.mockResolvedValue(makeVoteResult({ vote: "down" }));
      await expect(issueVoteCommand("42", "down", {})).resolves.toBeUndefined();
    });

    it("normalizes vote argument to lowercase", async () => {
      mockedBuildIssueVoteResult.mockResolvedValue(makeVoteResult({ vote: "up" }));
      await issueVoteCommand("42", "UP", {});
      expect(mockedBuildIssueVoteResult).toHaveBeenCalledWith(testRepo, 42, "up", false);
    });
  });

  describe("exit codes", () => {
    it("sets no exit code on vote_applied", async () => {
      mockedBuildIssueVoteResult.mockResolvedValue(makeVoteResult({ code: "vote_applied" }));
      await issueVoteCommand("42", "up", {});
      expect(process.exitCode).toBeUndefined();
    });

    it("sets no exit code on already_voted", async () => {
      mockedBuildIssueVoteResult.mockResolvedValue(makeVoteResult({
        code: "already_voted",
        warnings: [{ code: "already_voted", message: "Already voted 👍" }],
      }));
      await issueVoteCommand("42", "up", {});
      expect(process.exitCode).toBeUndefined();
    });

    it("sets exit code 2 on no_voting_target", async () => {
      mockedBuildIssueVoteResult.mockResolvedValue(makeVoteResult({
        code: "no_voting_target",
        targetComment: undefined,
        appliedReaction: undefined,
      }));
      await issueVoteCommand("42", "up", {});
      expect(process.exitCode).toBe(2);
    });

    it("sets exit code 2 on conflicting_vote", async () => {
      mockedBuildIssueVoteResult.mockResolvedValue(makeVoteResult({
        code: "conflicting_vote",
        appliedReaction: undefined,
      }));
      await issueVoteCommand("42", "down", {});
      expect(process.exitCode).toBe(2);
    });

    it("throws CliError with exitCode >= 3 when buildIssueVoteResult throws CliError", async () => {
      mockedBuildIssueVoteResult.mockRejectedValue(
        new CliError("rate limited", "RATE_LIMITED", 3),
      );
      await expect(issueVoteCommand("42", "up", {})).rejects.toMatchObject({
        exitCode: 3,
      });
    });

    it("wraps generic errors as CliError with exitCode 3", async () => {
      mockedBuildIssueVoteResult.mockRejectedValue(new Error("network failure"));
      await expect(issueVoteCommand("42", "up", {})).rejects.toMatchObject({
        exitCode: 3,
        message: "network failure",
      });
    });
  });

  describe("JSON output", () => {
    it("outputs JSON when --json flag is set", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const result = makeVoteResult();
      mockedBuildIssueVoteResult.mockResolvedValue(result);

      await issueVoteCommand("42", "up", { json: true });

      expect(logSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(logSpy.mock.calls[0][0]);
      expect(output.kind).toBe("issue_vote");
      expect(output.code).toBe("vote_applied");
      expect(output.schemaVersion).toBe(1);
    });
  });

  describe("text output", () => {
    it("includes issue number and vote code in text output", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      mockedBuildIssueVoteResult.mockResolvedValue(makeVoteResult({
        code: "vote_applied",
        vote: "up",
      }));

      await issueVoteCommand("42", "up", {});

      const output = logSpy.mock.calls[0][0] as string;
      expect(output).toContain("42");
      expect(output).toContain("vote_applied");
    });

    it("includes dry-run indicator in text output when --dry-run is set", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      mockedBuildIssueVoteResult.mockResolvedValue(makeVoteResult({ dryRun: true }));

      await issueVoteCommand("42", "up", { dryRun: true });

      const output = logSpy.mock.calls[0][0] as string;
      expect(output).toContain("dry-run");
    });

    it("includes target comment URL in text output", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      mockedBuildIssueVoteResult.mockResolvedValue(makeVoteResult());

      await issueVoteCommand("42", "up", {});

      const output = logSpy.mock.calls[0][0] as string;
      expect(output).toContain("https://github.com/hivemoot/hivemoot/issues/42#issuecomment-1234");
    });

    it("includes warnings in text output", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      mockedBuildIssueVoteResult.mockResolvedValue(makeVoteResult({
        code: "already_voted",
        warnings: [{ code: "already_voted", message: "Already voted 👍 on this issue." }],
      }));

      await issueVoteCommand("42", "up", {});

      const output = logSpy.mock.calls[0][0] as string;
      expect(output).toContain("already_voted");
    });
  });

  describe("passes options correctly", () => {
    it("passes dryRun=true when --dry-run is set", async () => {
      mockedBuildIssueVoteResult.mockResolvedValue(makeVoteResult({ dryRun: true }));
      await issueVoteCommand("42", "up", { dryRun: true });
      expect(mockedBuildIssueVoteResult).toHaveBeenCalledWith(testRepo, 42, "up", true);
    });

    it("passes dryRun=false by default", async () => {
      await issueVoteCommand("42", "up", {});
      expect(mockedBuildIssueVoteResult).toHaveBeenCalledWith(testRepo, 42, "up", false);
    });

    it("resolves repo from --repo flag", async () => {
      mockedResolveRepo.mockResolvedValue({ owner: "acme", repo: "widget" });
      mockedBuildIssueVoteResult.mockResolvedValue(makeVoteResult({ repo: { owner: "acme", repo: "widget" } }));

      await issueVoteCommand("42", "up", { repo: "acme/widget" });

      expect(mockedResolveRepo).toHaveBeenCalledWith("acme/widget");
    });
  });
});
