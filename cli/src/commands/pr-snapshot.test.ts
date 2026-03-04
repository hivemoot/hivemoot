import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../github/repo.js", () => ({
  resolveRepo: vi.fn(),
}));

vi.mock("../github/workflow.js", () => ({
  buildPrSnapshot: vi.fn(),
}));

import { resolveRepo } from "../github/repo.js";
import { buildPrSnapshot } from "../github/workflow.js";
import { prSnapshotCommand } from "./pr-snapshot.js";

const mockedResolveRepo = vi.mocked(resolveRepo);
const mockedBuildPrSnapshot = vi.mocked(buildPrSnapshot);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockedResolveRepo.mockResolvedValue({ owner: "hivemoot", repo: "hivemoot" });
  mockedBuildPrSnapshot.mockResolvedValue({
    schemaVersion: 1,
    kind: "pr_snapshot",
    generatedAt: "2026-02-19T00:00:00.000Z",
    repo: { owner: "hivemoot", repo: "hivemoot" },
    pr: {
      number: 54,
      title: "workflow commands",
      url: "https://github.com/hivemoot/hivemoot/pull/54",
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      reviewDecision: null,
      createdAt: "2026-02-19T00:00:00Z",
      updatedAt: "2026-02-19T00:00:00Z",
      headRefName: "worker/issue-54",
      baseRefName: "main",
      author: "hivemoot-worker",
    },
    linkedIssues: [],
    checks: {
      required: [],
      all: [],
      requiredFailing: [],
      requiredPending: [],
    },
    warnings: [],
  });
});

describe("prSnapshotCommand", () => {
  it("prints JSON payload when --json is set", async () => {
    await prSnapshotCommand("54", { json: true });

    expect(mockedResolveRepo).toHaveBeenCalledWith(undefined);
    expect(mockedBuildPrSnapshot).toHaveBeenCalledWith(
      { owner: "hivemoot", repo: "hivemoot" },
      "54",
    );
    const output = vi.mocked(console.log).mock.calls[0][0];
    expect(JSON.parse(output)).toMatchObject({
      schemaVersion: 1,
      kind: "pr_snapshot",
      pr: { number: 54 },
    });
  });

  it("prints human-readable summary by default", async () => {
    await prSnapshotCommand("54", {});

    const output = vi.mocked(console.log).mock.calls[0][0] as string;
    expect(output).toContain("PR SNAPSHOT");
    expect(output).toContain("workflow commands");
  });
});
