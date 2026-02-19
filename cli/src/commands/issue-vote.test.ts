import { describe, it, expect, vi, beforeEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("../github/repo.js", () => ({
  resolveRepo: vi.fn(),
}));

vi.mock("../github/workflow.js", () => ({
  ISSUE_VOTE_CHOICES: ["support", "oppose", "needs-discussion", "needs-human"],
  submitIssueVote: vi.fn(),
}));

import { resolveRepo } from "../github/repo.js";
import { submitIssueVote } from "../github/workflow.js";
import { issueVoteCommand } from "./issue-vote.js";

const mockedResolveRepo = vi.mocked(resolveRepo);
const mockedSubmitIssueVote = vi.mocked(submitIssueVote);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockedResolveRepo.mockResolvedValue({ owner: "hivemoot", repo: "hivemoot" });
  mockedSubmitIssueVote.mockResolvedValue({
    schemaVersion: 1,
    kind: "issue_vote",
    generatedAt: "2026-02-19T00:00:00.000Z",
    repo: { owner: "hivemoot", repo: "hivemoot" },
    issue: {
      number: 23,
      title: "Simplify issue/PR conversations",
      url: "https://github.com/hivemoot/hivemoot/issues/23",
      state: "OPEN",
      labels: ["hivemoot:voting"],
    },
    targetComment: {
      id: "comment-id",
      databaseId: 1002,
      url: "https://github.com/hivemoot/hivemoot/issues/23#issuecomment-1002",
      author: "hivemoot",
      createdAt: "2026-02-18T01:00:00Z",
    },
    vote: {
      choice: "support",
      reaction: "👍",
      content: "+1",
    },
  });
});

describe("issueVoteCommand", () => {
  it("rejects invalid vote values", async () => {
    await expect(
      issueVoteCommand("23", { vote: "invalid", json: true }),
    ).rejects.toMatchObject({
      code: "GH_ERROR",
    });
    expect(mockedSubmitIssueVote).not.toHaveBeenCalled();
  });

  it("prints JSON payload when --json is set", async () => {
    await issueVoteCommand("23", { vote: "support", json: true });

    expect(mockedSubmitIssueVote).toHaveBeenCalledWith(
      { owner: "hivemoot", repo: "hivemoot" },
      "23",
      "support",
    );
    const output = vi.mocked(console.log).mock.calls[0][0];
    expect(JSON.parse(output)).toMatchObject({
      schemaVersion: 1,
      kind: "issue_vote",
      vote: { choice: "support" },
    });
  });

  it("prints human-readable output by default", async () => {
    await issueVoteCommand("23", { vote: "support" });

    const output = vi.mocked(console.log).mock.calls[0][0] as string;
    expect(output).toContain("ISSUE VOTE");
    expect(output).toContain("choice: support");
  });

  it("rethrows submitIssueVote failures", async () => {
    mockedSubmitIssueVote.mockRejectedValueOnce(
      new CliError("Issue is not in voting", "GH_ERROR", 1),
    );

    await expect(
      issueVoteCommand("23", { vote: "support" }),
    ).rejects.toMatchObject({
      message: "Issue is not in voting",
    });
  });
});
