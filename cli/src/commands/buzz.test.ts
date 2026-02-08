import { describe, it, expect, vi, beforeEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("../config/loader.js", () => ({
  loadTeamConfig: vi.fn(),
}));

vi.mock("../github/repo.js", () => ({
  resolveRepo: vi.fn(),
}));

vi.mock("../github/issues.js", () => ({
  fetchIssues: vi.fn(),
}));

vi.mock("../github/pulls.js", () => ({
  fetchPulls: vi.fn(),
}));

vi.mock("../github/user.js", () => ({
  fetchCurrentUser: vi.fn(),
}));

vi.mock("../summary/builder.js", () => ({
  buildSummary: vi.fn(),
}));

vi.mock("../output/formatter.js", () => ({
  formatBuzz: vi.fn(),
  formatStatus: vi.fn(),
}));

vi.mock("../output/json.js", () => ({
  jsonBuzz: vi.fn(),
  jsonStatus: vi.fn(),
}));

import { loadTeamConfig } from "../config/loader.js";
import { resolveRepo } from "../github/repo.js";
import { fetchIssues } from "../github/issues.js";
import { fetchPulls } from "../github/pulls.js";
import { fetchCurrentUser } from "../github/user.js";
import { buildSummary } from "../summary/builder.js";
import { formatBuzz, formatStatus } from "../output/formatter.js";
import { jsonBuzz, jsonStatus } from "../output/json.js";
import { buzzCommand } from "./buzz.js";

const mockedResolveRepo = vi.mocked(resolveRepo);
const mockedLoadTeamConfig = vi.mocked(loadTeamConfig);
const mockedFetchIssues = vi.mocked(fetchIssues);
const mockedFetchPulls = vi.mocked(fetchPulls);
const mockedFetchCurrentUser = vi.mocked(fetchCurrentUser);
const mockedBuildSummary = vi.mocked(buildSummary);
const mockedFormatBuzz = vi.mocked(formatBuzz);
const mockedFormatStatus = vi.mocked(formatStatus);
const mockedJsonBuzz = vi.mocked(jsonBuzz);
const mockedJsonStatus = vi.mocked(jsonStatus);

const testRepo = { owner: "hivemoot", repo: "test" };
const testSummary = {
  repo: testRepo,
  currentUser: "testuser",
  driveDiscussion: [],
  driveImplementation: [],
  voteOn: [],
  discuss: [],
  implement: [],
  reviewPRs: [],
  addressFeedback: [],
  alerts: [],
  notes: [],
};
const testTeamConfig = {
  roles: {
    engineer: {
      description: "Engineer role",
      instructions: "Build things.",
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockedResolveRepo.mockResolvedValue(testRepo);
  mockedLoadTeamConfig.mockResolvedValue(testTeamConfig);
  mockedFetchIssues.mockResolvedValue([]);
  mockedFetchPulls.mockResolvedValue([]);
  mockedFetchCurrentUser.mockResolvedValue("testuser");
  mockedBuildSummary.mockReturnValue(testSummary);
});

describe("buzzCommand", () => {
  it("outputs formatted text by default", async () => {
    mockedFormatBuzz.mockReturnValue("ROLE: engineer — Engineer role\n...");

    await buzzCommand({ role: "engineer" });

    expect(mockedResolveRepo).toHaveBeenCalledWith(undefined);
    expect(mockedLoadTeamConfig).toHaveBeenCalledWith(testRepo);
    expect(mockedFetchIssues).toHaveBeenCalledWith(testRepo, 200);
    expect(mockedFetchPulls).toHaveBeenCalledWith(testRepo, 200);
    expect(mockedFormatBuzz).toHaveBeenCalledWith(
      "engineer",
      testTeamConfig.roles.engineer,
      testSummary,
      undefined,
    );
    expect(console.log).toHaveBeenCalledWith("ROLE: engineer — Engineer role\n...");
  });

  it("outputs JSON when --json flag is set", async () => {
    mockedJsonBuzz.mockReturnValue('{"role":{"name":"engineer"}}');

    await buzzCommand({ role: "engineer", json: true });

    expect(mockedJsonBuzz).toHaveBeenCalledWith(
      "engineer",
      testTeamConfig.roles.engineer,
      testSummary,
    );
    expect(console.log).toHaveBeenCalledWith('{"role":{"name":"engineer"}}');
    expect(mockedFormatBuzz).not.toHaveBeenCalled();
  });

  it("outputs formatted status when no role is provided", async () => {
    mockedFormatStatus.mockReturnValue("REPO SUMMARY — hivemoot/test\n...");

    await buzzCommand({});

    expect(mockedFormatStatus).toHaveBeenCalledWith(testSummary, undefined);
    expect(mockedFormatBuzz).not.toHaveBeenCalled();
    expect(mockedLoadTeamConfig).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("REPO SUMMARY — hivemoot/test\n...");
  });

  it("outputs JSON status when no role is provided with --json", async () => {
    mockedJsonStatus.mockReturnValue('{"repo":"hivemoot/test"}');

    await buzzCommand({ json: true });

    expect(mockedJsonStatus).toHaveBeenCalledWith(testSummary);
    expect(console.log).toHaveBeenCalledWith('{"repo":"hivemoot/test"}');
    expect(mockedJsonBuzz).not.toHaveBeenCalled();
    expect(mockedLoadTeamConfig).not.toHaveBeenCalled();
  });

  it("passes --limit to formatter", async () => {
    mockedFormatBuzz.mockReturnValue("output");

    await buzzCommand({ role: "engineer", limit: 5 });

    expect(mockedFormatBuzz).toHaveBeenCalledWith(
      "engineer",
      testTeamConfig.roles.engineer,
      testSummary,
      5,
    );
  });

  it("passes --repo flag to resolveRepo", async () => {
    mockedFormatBuzz.mockReturnValue("output");

    await buzzCommand({ role: "engineer", repo: "owner/custom" });

    expect(mockedResolveRepo).toHaveBeenCalledWith("owner/custom");
  });

  it("throws ROLE_NOT_FOUND for unknown role", async () => {
    await expect(buzzCommand({ role: "nonexistent" })).rejects.toThrow(CliError);
    await expect(buzzCommand({ role: "nonexistent" })).rejects.toMatchObject({
      code: "ROLE_NOT_FOUND",
      message: expect.stringContaining("nonexistent"),
    });
  });

  it("lists available roles in ROLE_NOT_FOUND error message", async () => {
    await expect(buzzCommand({ role: "nonexistent" })).rejects.toMatchObject({
      message: expect.stringContaining("engineer"),
    });
  });

  it("passes fetchLimit to fetch functions", async () => {
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({ fetchLimit: 500 });

    expect(mockedFetchIssues).toHaveBeenCalledWith(testRepo, 500);
    expect(mockedFetchPulls).toHaveBeenCalledWith(testRepo, 500);
  });

  it("defaults fetchLimit to 200", async () => {
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    expect(mockedFetchIssues).toHaveBeenCalledWith(testRepo, 200);
    expect(mockedFetchPulls).toHaveBeenCalledWith(testRepo, 200);
  });

  it("adds truncation note when issues hit fetchLimit", async () => {
    const manyIssues = Array.from({ length: 200 }, (_, i) => ({ number: i }));
    mockedFetchIssues.mockResolvedValue(manyIssues as any);
    mockedFetchPulls.mockResolvedValue([]);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toContain("Only the first 200 issues were fetched. Use --fetch-limit to increase.");
  });

  it("adds truncation note when PRs hit fetchLimit", async () => {
    const manyPRs = Array.from({ length: 200 }, (_, i) => ({ number: i }));
    mockedFetchIssues.mockResolvedValue([]);
    mockedFetchPulls.mockResolvedValue(manyPRs as any);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toContain("Only the first 200 PRs were fetched. Use --fetch-limit to increase.");
  });

  it("no truncation note when results are under the limit", async () => {
    mockedFetchIssues.mockResolvedValue([]);
    mockedFetchPulls.mockResolvedValue([]);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toHaveLength(0);
  });

  // ── Graceful degradation on partial fetch failure ──────────────

  it("shows PRs with warning when issues fetch fails", async () => {
    mockedFetchIssues.mockRejectedValue(new CliError("issues boom", "GH_ERROR"));
    mockedFetchPulls.mockResolvedValue([]);
    mockedFetchCurrentUser.mockResolvedValue("testuser");
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    expect(mockedBuildSummary).toHaveBeenCalledWith(testRepo, [], [], "testuser");
    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toContain("Could not fetch issues (issues boom) — showing PRs only.");
  });

  it("shows issues with warning when PRs fetch fails", async () => {
    mockedFetchIssues.mockResolvedValue([]);
    mockedFetchPulls.mockRejectedValue(new CliError("prs boom", "GH_ERROR"));
    mockedFetchCurrentUser.mockResolvedValue("testuser");
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    expect(mockedBuildSummary).toHaveBeenCalledWith(testRepo, [], [], "testuser");
    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toContain("Could not fetch pull requests (prs boom) — showing issues only.");
  });

  it("works with empty currentUser when user fetch fails", async () => {
    mockedFetchIssues.mockResolvedValue([]);
    mockedFetchPulls.mockResolvedValue([]);
    mockedFetchCurrentUser.mockRejectedValue(new Error("auth failed"));
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    expect(mockedBuildSummary).toHaveBeenCalledWith(testRepo, [], [], "");
    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toContain(
      "Could not determine GitHub user (auth failed) — drive sections, competition counts, and author highlighting are unavailable.",
    );
  });

  it("throws first CliError when all three fetches fail", async () => {
    const cliErr = new CliError("not authenticated", "GH_NOT_AUTHENTICATED");
    mockedFetchIssues.mockRejectedValue(new Error("network"));
    mockedFetchPulls.mockRejectedValue(cliErr);
    mockedFetchCurrentUser.mockRejectedValue(new Error("timeout"));

    await expect(buzzCommand({})).rejects.toBe(cliErr);
  });

  it("throws first rejection reason when all fail and none are CliError", async () => {
    const firstErr = new Error("network");
    mockedFetchIssues.mockRejectedValue(firstErr);
    mockedFetchPulls.mockRejectedValue(new Error("also network"));
    mockedFetchCurrentUser.mockRejectedValue(new Error("timeout"));

    await expect(buzzCommand({})).rejects.toBe(firstErr);
  });

  it("produces single combined warning when both data fetches fail", async () => {
    mockedFetchIssues.mockRejectedValue(new CliError("boom", "GH_ERROR"));
    mockedFetchPulls.mockRejectedValue(new CliError("boom2", "GH_ERROR"));
    mockedFetchCurrentUser.mockResolvedValue("testuser");
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    expect(mockedBuildSummary).toHaveBeenCalledWith(testRepo, [], [], "testuser");
    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toContain(
      "Could not fetch issues (boom) or pull requests (boom2) — showing limited summary.",
    );
    expect(summaryArg.notes).toHaveLength(1);
  });

  it("throws most actionable CliError when all fail with multiple CliErrors", async () => {
    const genericErr = new CliError("generic failure", "GH_ERROR");
    const authErr = new CliError("not authenticated", "GH_NOT_AUTHENTICATED");
    mockedFetchIssues.mockRejectedValue(genericErr);
    mockedFetchPulls.mockRejectedValue(new Error("timeout"));
    mockedFetchCurrentUser.mockRejectedValue(authErr);

    await expect(buzzCommand({})).rejects.toBe(authErr);
  });

  it("includes error detail from non-CliError rejections", async () => {
    mockedFetchIssues.mockRejectedValue(new Error("ETIMEDOUT"));
    mockedFetchPulls.mockResolvedValue([]);
    mockedFetchCurrentUser.mockResolvedValue("testuser");
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toContain("Could not fetch issues (ETIMEDOUT) — showing PRs only.");
  });

  it("includes error detail in both data and user failure notes", async () => {
    mockedFetchIssues.mockRejectedValue(new CliError("rate limited", "RATE_LIMITED"));
    mockedFetchPulls.mockResolvedValue([]);
    mockedFetchCurrentUser.mockRejectedValue(new Error("token expired"));
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toContain(
      "Could not fetch issues (rate limited) — showing PRs only.",
    );
    expect(summaryArg.notes).toContain(
      "Could not determine GitHub user (token expired) — drive sections, competition counts, and author highlighting are unavailable.",
    );
    expect(summaryArg.notes).toHaveLength(2);
  });
});
