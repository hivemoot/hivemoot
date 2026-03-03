import { describe, it, expect, vi, beforeEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("../github/repo.js", () => ({
  resolveRepo: vi.fn(),
}));

vi.mock("../github/issue-snapshot.js", () => ({
  buildIssueSnapshot: vi.fn(),
}));

import { resolveRepo } from "../github/repo.js";
import { buildIssueSnapshot } from "../github/issue-snapshot.js";
import { issueSnapshotCommand } from "./issue-snapshot.js";

const mockedResolveRepo = vi.mocked(resolveRepo);
const mockedBuildIssueSnapshot = vi.mocked(buildIssueSnapshot);

const testRepo = { owner: "hivemoot", repo: "hivemoot" };

function makeSnapshotResult(
  overrides: Partial<Awaited<ReturnType<typeof buildIssueSnapshot>>> = {},
): Awaited<ReturnType<typeof buildIssueSnapshot>> {
  return {
    schemaVersion: 1,
    kind: "issue_snapshot",
    generatedAt: "2026-02-25T10:00:00.000Z",
    repo: testRepo,
    issue: {
      number: 42,
      title: "Add issue snapshot command",
      url: "https://github.com/hivemoot/hivemoot/issues/42",
      state: "open",
      phase: "discussion",
      labels: ["hivemoot:discussion"],
      assignees: [],
      author: "hivemoot-worker",
      createdAt: "2026-02-20T00:00:00Z",
      updatedAt: "2026-02-25T00:00:00Z",
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockedResolveRepo.mockResolvedValue(testRepo);
  mockedBuildIssueSnapshot.mockResolvedValue(makeSnapshotResult());
});

describe("issueSnapshotCommand", () => {
  describe("input validation", () => {
    it("throws CliError for non-numeric issue argument", async () => {
      await expect(issueSnapshotCommand("abc", {})).rejects.toThrow(CliError);
      await expect(issueSnapshotCommand("abc", {})).rejects.toMatchObject({
        message: expect.stringContaining("Invalid issue number"),
      });
    });

    it("throws CliError for zero issue number", async () => {
      await expect(issueSnapshotCommand("0", {})).rejects.toThrow(CliError);
    });

    it("throws CliError for negative issue number", async () => {
      await expect(issueSnapshotCommand("-1", {})).rejects.toThrow(CliError);
    });
  });

  describe("JSON output", () => {
    it("prints JSON payload when --json is set", async () => {
      await issueSnapshotCommand("42", { json: true });

      expect(mockedResolveRepo).toHaveBeenCalledWith(undefined);
      expect(mockedBuildIssueSnapshot).toHaveBeenCalledWith(testRepo, 42);
      const output = vi.mocked(console.log).mock.calls[0][0];
      expect(JSON.parse(output)).toMatchObject({
        schemaVersion: 1,
        kind: "issue_snapshot",
        issue: { number: 42 },
      });
    });

    it("passes --repo option to resolveRepo", async () => {
      await issueSnapshotCommand("42", { repo: "owner/other", json: true });
      expect(mockedResolveRepo).toHaveBeenCalledWith("owner/other");
    });

    it("includes voting comment in JSON when present", async () => {
      mockedBuildIssueSnapshot.mockResolvedValue(
        makeSnapshotResult({
          votingComment: {
            id: "IC_node123",
            databaseId: 999,
            url: "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-999",
            createdAt: "2026-02-24T00:00:00Z",
            thumbsUp: 5,
            thumbsDown: 1,
            yourVote: "👍",
          },
        }),
      );

      await issueSnapshotCommand("42", { json: true });
      const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0]);
      expect(output.votingComment).toMatchObject({
        thumbsUp: 5,
        thumbsDown: 1,
        yourVote: "👍",
      });
    });

    it("includes queen summary in JSON when present", async () => {
      mockedBuildIssueSnapshot.mockResolvedValue(
        makeSnapshotResult({
          queenSummary: {
            url: "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-888",
            createdAt: "2026-02-23T00:00:00Z",
            bodyPreview: "## Summary\nThis proposal adds...",
          },
        }),
      );

      await issueSnapshotCommand("42", { json: true });
      const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0]);
      expect(output.queenSummary.bodyPreview).toContain("Summary");
    });
  });

  describe("human-readable output", () => {
    it("prints ISSUE SNAPSHOT header with repo and number", async () => {
      await issueSnapshotCommand("42", {});

      const output = vi.mocked(console.log).mock.calls[0][0] as string;
      expect(output).toContain("ISSUE SNAPSHOT");
      expect(output).toContain("hivemoot/hivemoot#42");
    });

    it("prints issue title", async () => {
      await issueSnapshotCommand("42", {});
      const output = vi.mocked(console.log).mock.calls[0][0] as string;
      expect(output).toContain("Add issue snapshot command");
    });

    it("prints phase and state", async () => {
      await issueSnapshotCommand("42", {});
      const output = vi.mocked(console.log).mock.calls[0][0] as string;
      expect(output).toContain("discussion");
      expect(output).toContain("open");
    });

    it("prints voting comment URL and tallies when present", async () => {
      mockedBuildIssueSnapshot.mockResolvedValue(
        makeSnapshotResult({
          issue: {
            number: 42,
            title: "Test",
            url: "https://github.com/hivemoot/hivemoot/issues/42",
            state: "open",
            phase: "voting",
            labels: ["hivemoot:voting"],
            assignees: [],
            author: null,
            createdAt: "2026-02-20T00:00:00Z",
            updatedAt: "2026-02-25T00:00:00Z",
          },
          votingComment: {
            id: "IC_node123",
            databaseId: 999,
            url: "https://github.com/hivemoot/hivemoot/issues/42#issuecomment-999",
            createdAt: "2026-02-24T00:00:00Z",
            thumbsUp: 3,
            thumbsDown: 0,
            yourVote: null,
          },
        }),
      );

      await issueSnapshotCommand("42", {});
      const output = vi.mocked(console.log).mock.calls[0][0] as string;
      expect(output).toContain("voting comment");
      expect(output).toContain("👍 3");
      expect(output).toContain("👎 0");
    });
  });

  describe("error handling", () => {
    it("re-throws CliError from buildIssueSnapshot with exit code >= 3", async () => {
      mockedBuildIssueSnapshot.mockRejectedValue(
        new CliError("not found", "GH_NOT_FOUND", 1),
      );

      await expect(issueSnapshotCommand("99", {})).rejects.toMatchObject({
        code: "GH_NOT_FOUND",
        exitCode: 3,
      });
    });

    it("wraps non-CliError in GH_ERROR with exit code 3", async () => {
      mockedBuildIssueSnapshot.mockRejectedValue(new Error("network failure"));

      await expect(issueSnapshotCommand("42", {})).rejects.toMatchObject({
        code: "GH_ERROR",
        exitCode: 3,
        message: "network failure",
      });
    });
  });
});
