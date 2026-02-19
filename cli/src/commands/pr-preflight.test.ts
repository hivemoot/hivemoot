import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("../github/repo.js", () => ({
  resolveRepo: vi.fn(),
}));

vi.mock("../github/workflow.js", () => ({
  buildPrPreflight: vi.fn(),
}));

import { resolveRepo } from "../github/repo.js";
import { buildPrPreflight } from "../github/workflow.js";
import { prPreflightCommand } from "./pr-preflight.js";

const mockedResolveRepo = vi.mocked(resolveRepo);
const mockedBuildPrPreflight = vi.mocked(buildPrPreflight);

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockedResolveRepo.mockResolvedValue({ owner: "hivemoot", repo: "hivemoot" });
  mockedBuildPrPreflight.mockResolvedValue({
    schemaVersion: 1,
    kind: "pr_preflight",
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
    blockers: [],
    warnings: [],
    pass: true,
  });
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("prPreflightCommand", () => {
  it("sets exit code 2 when blockers are present", async () => {
    mockedBuildPrPreflight.mockResolvedValueOnce({
      schemaVersion: 1,
      kind: "pr_preflight",
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
      blockers: [{ code: "no_linked_issue", message: "missing link" }],
      warnings: [],
      pass: false,
    });

    await prPreflightCommand("54", { json: true });
    expect(process.exitCode).toBe(2);
  });

  it("keeps exit code unset when preflight passes", async () => {
    await prPreflightCommand("54", { json: true });
    expect(process.exitCode).toBeUndefined();
  });

  it("upgrades execution errors to exit code >= 3", async () => {
    mockedBuildPrPreflight.mockRejectedValueOnce(
      new CliError("temporary gh failure", "GH_ERROR", 1),
    );

    await expect(prPreflightCommand("54", {})).rejects.toMatchObject({
      exitCode: 3,
      code: "GH_ERROR",
    });
  });
});
