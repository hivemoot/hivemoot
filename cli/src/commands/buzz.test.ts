import { describe, it, expect, vi, beforeEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("../config/loader.js", () => ({
  loadTeamConfig: vi.fn(),
}));

vi.mock("../github/repo.js", () => ({
  resolveRepo: vi.fn(),
  fetchRepoPushAccess: vi.fn(),
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

vi.mock("../github/votes.js", () => ({
  fetchVotes: vi.fn(),
}));

vi.mock("../github/notifications.js", () => ({
  fetchNotifications: vi.fn(),
}));

vi.mock("../github/publish.js", () => ({
  runPublishPreflight: vi.fn(),
}));

vi.mock("../github/recent.js", () => ({
  fetchRecentClosedByAuthor: vi.fn(),
}));

vi.mock("../watch/state.js", () => ({
  loadState: vi.fn(),
  loadStateWithStatus: vi.fn(),
  mergeAckJournal: vi.fn(),
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
import { fetchRepoPushAccess, resolveRepo } from "../github/repo.js";
import { fetchIssues } from "../github/issues.js";
import { fetchPulls } from "../github/pulls.js";
import { fetchCurrentUser } from "../github/user.js";
import { fetchVotes } from "../github/votes.js";
import { fetchNotifications } from "../github/notifications.js";
import { fetchRecentClosedByAuthor } from "../github/recent.js";
import { loadStateWithStatus, mergeAckJournal } from "../watch/state.js";
import { buildSummary } from "../summary/builder.js";
import { formatBuzz, formatStatus } from "../output/formatter.js";
import { jsonBuzz, jsonStatus } from "../output/json.js";
import { runPublishPreflight } from "../github/publish.js";
import { buzzCommand } from "./buzz.js";

const mockedResolveRepo = vi.mocked(resolveRepo);
const mockedFetchRepoPushAccess = vi.mocked(fetchRepoPushAccess);
const mockedLoadTeamConfig = vi.mocked(loadTeamConfig);
const mockedFetchIssues = vi.mocked(fetchIssues);
const mockedFetchPulls = vi.mocked(fetchPulls);
const mockedFetchCurrentUser = vi.mocked(fetchCurrentUser);
const mockedFetchVotes = vi.mocked(fetchVotes);
const mockedFetchNotifications = vi.mocked(fetchNotifications);
const mockedFetchRecentClosedByAuthor = vi.mocked(fetchRecentClosedByAuthor);
const mockedLoadStateWithStatus = vi.mocked(loadStateWithStatus);
const mockedMergeAckJournal = vi.mocked(mergeAckJournal);
const mockedBuildSummary = vi.mocked(buildSummary);
const mockedFormatBuzz = vi.mocked(formatBuzz);
const mockedFormatStatus = vi.mocked(formatStatus);
const mockedJsonBuzz = vi.mocked(jsonBuzz);
const mockedJsonStatus = vi.mocked(jsonStatus);
const mockedRunPublishPreflight = vi.mocked(runPublishPreflight);

const testRepo = { owner: "hivemoot", repo: "test" };
const testSummary = {
  repo: testRepo,
  currentUser: "testuser",
  needsHuman: [],
  driveDiscussion: [],
  driveImplementation: [],
  voteOn: [],
  discuss: [],
  implement: [],
  reviewPRs: [],
  draftPRs: [],
  addressFeedback: [],
  notifications: [],
  unackedMentions: [],
  recentlyClosedByYou: [],
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
  mockedFetchRepoPushAccess.mockResolvedValue(true);
  mockedRunPublishPreflight.mockResolvedValue({ command: "git push --dry-run origin HEAD", ok: true, originUrl: "https://github.com/hivemoot-guard/test.git" });
  mockedLoadTeamConfig.mockResolvedValue(testTeamConfig);
  mockedFetchIssues.mockResolvedValue([]);
  mockedFetchPulls.mockResolvedValue([]);
  mockedFetchCurrentUser.mockResolvedValue("testuser");
  mockedFetchVotes.mockResolvedValue(new Map());
  mockedFetchNotifications.mockResolvedValue(new Map());
  mockedFetchRecentClosedByAuthor.mockResolvedValue([]);
  mockedLoadStateWithStatus.mockResolvedValue({
    state: {
      lastChecked: "2026-02-17T00:00:00Z",
      processedThreadIds: [],
    },
    degraded: false,
  });
  mockedMergeAckJournal.mockImplementation(async (_stateFile, state) => state);
  mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [], unackedMentions: [] });
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
      undefined,
    );
    expect(console.log).toHaveBeenCalledWith('{"role":{"name":"engineer"}}');
    expect(mockedFormatBuzz).not.toHaveBeenCalled();
  });

  it("outputs formatted status when no role is provided", async () => {
    mockedFormatStatus.mockReturnValue("REPO SUMMARY — hivemoot/test\n...");

    await buzzCommand({});

    expect(mockedFormatStatus).toHaveBeenCalledWith(testSummary, undefined);
    expect(mockedFormatBuzz).not.toHaveBeenCalled();
    expect(mockedLoadTeamConfig).toHaveBeenCalledWith(testRepo);
    expect(console.log).toHaveBeenCalledWith("REPO SUMMARY — hivemoot/test\n...");
  });

  it("outputs JSON status when no role is provided with --json", async () => {
    mockedJsonStatus.mockReturnValue('{"repo":"hivemoot/test"}');

    await buzzCommand({ json: true });

    expect(mockedJsonStatus).toHaveBeenCalledWith(testSummary);
    expect(console.log).toHaveBeenCalledWith('{"repo":"hivemoot/test"}');
    expect(mockedJsonBuzz).not.toHaveBeenCalled();
    expect(mockedLoadTeamConfig).toHaveBeenCalledWith(testRepo);
  });

  it("passes --limit to formatter", async () => {
    mockedFormatBuzz.mockReturnValue("output");

    await buzzCommand({ role: "engineer", limit: 5 });

    expect(mockedFormatBuzz).toHaveBeenCalledWith(
      "engineer",
      testTeamConfig.roles.engineer,
      testSummary,
      5,
      undefined,
    );
  });

  it("passes --repo flag to resolveRepo", async () => {
    mockedFormatBuzz.mockReturnValue("output");

    await buzzCommand({ role: "engineer", repo: "owner/custom" });

    expect(mockedResolveRepo).toHaveBeenCalledWith("owner/custom");
  });

  it("passes onboarding to formatBuzz when present in team config", async () => {
    const teamWithOnboarding = {
      ...testTeamConfig,
      onboarding: "Read CONTRIBUTING.md first.",
    };
    mockedLoadTeamConfig.mockResolvedValue(teamWithOnboarding);
    mockedFormatBuzz.mockReturnValue("output");

    await buzzCommand({ role: "engineer" });

    expect(mockedFormatBuzz).toHaveBeenCalledWith(
      "engineer",
      teamWithOnboarding.roles.engineer,
      testSummary,
      undefined,
      "Read CONTRIBUTING.md first.",
    );
  });

  it("passes onboarding to jsonBuzz when present in team config", async () => {
    const teamWithOnboarding = {
      ...testTeamConfig,
      onboarding: "Read CONTRIBUTING.md first.",
    };
    mockedLoadTeamConfig.mockResolvedValue(teamWithOnboarding);
    mockedJsonBuzz.mockReturnValue('{}');

    await buzzCommand({ role: "engineer", json: true });

    expect(mockedJsonBuzz).toHaveBeenCalledWith(
      "engineer",
      teamWithOnboarding.roles.engineer,
      testSummary,
      "Read CONTRIBUTING.md first.",
    );
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

  it("fetches recently closed authored activity when current user is known", async () => {
    mockedFetchCurrentUser.mockResolvedValue("testuser");
    mockedFetchRecentClosedByAuthor.mockResolvedValue([
      {
        number: 77,
        title: "Closed thread",
        url: "https://github.com/hivemoot/test/issues/77",
        itemType: "issue",
        outcome: "closed",
        closedAt: "2026-02-18T09:00:00Z",
      },
    ]);
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    expect(mockedFetchRecentClosedByAuthor).toHaveBeenCalledWith(
      testRepo,
      "testuser",
      expect.any(Date),
    );
    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.recentlyClosedByYou).toHaveLength(1);
    expect(summaryArg.recentlyClosedByYou[0].closedAge).toBeDefined();
  });

  it("adds a note when recently closed authored activity cannot be loaded", async () => {
    mockedFetchCurrentUser.mockResolvedValue("testuser");
    mockedFetchRecentClosedByAuthor.mockRejectedValue(new Error("boom"));
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toContain("Could not fetch recently closed authored activity.");
  });

  it("adds truncation note when issues hit fetchLimit", async () => {
    const manyIssues = Array.from({ length: 200 }, (_, i) => ({ number: i, labels: [] }));
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

    expect(mockedBuildSummary).toHaveBeenCalledWith(
      testRepo,
      [],
      [],
      "testuser",
      expect.any(Date),
      expect.any(Map),
      expect.any(Map),
      undefined,
    );
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

    expect(mockedBuildSummary).toHaveBeenCalledWith(
      testRepo,
      [],
      [],
      "testuser",
      expect.any(Date),
      expect.any(Map),
      expect.any(Map),
      undefined,
    );
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

    expect(mockedBuildSummary).toHaveBeenCalledWith(
      testRepo,
      [],
      [],
      "",
      expect.any(Date),
      expect.any(Map),
      expect.any(Map),
      undefined,
    );
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

    expect(mockedBuildSummary).toHaveBeenCalledWith(
      testRepo,
      [],
      [],
      "testuser",
      expect.any(Date),
      expect.any(Map),
      expect.any(Map),
      undefined,
    );
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

  // ── Vote fetching ───────────────────────────────────────────────

  it("calls fetchVotes with voting issue numbers", async () => {
    const votingIssue = { number: 42, labels: [{ name: "phase:voting" }] };
    const normalIssue = { number: 43, labels: [{ name: "bug" }] };
    mockedFetchIssues.mockResolvedValue([votingIssue, normalIssue] as any);
    mockedFetchPulls.mockResolvedValue([]);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    expect(mockedFetchVotes).toHaveBeenCalledWith(testRepo, [42], "testuser");
  });

  it("calls fetchVotes for hivemoot:voting issues too", async () => {
    const votingIssue = { number: 142, labels: [{ name: "hivemoot:voting" }] };
    mockedFetchIssues.mockResolvedValue([votingIssue] as any);
    mockedFetchPulls.mockResolvedValue([]);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    expect(mockedFetchVotes).toHaveBeenCalledWith(testRepo, [142], "testuser");
  });

  it("passes votes map to buildSummary", async () => {
    const votingIssue = { number: 42, labels: [{ name: "vote" }] };
    mockedFetchIssues.mockResolvedValue([votingIssue] as any);
    const voteMap = new Map([[42, { reaction: "👍", createdAt: "2025-01-01T00:00:00Z" }]]);
    mockedFetchVotes.mockResolvedValue(voteMap);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    // buildSummary should be called with the votes map and notification map
    expect(mockedBuildSummary).toHaveBeenCalledWith(
      testRepo,
      [votingIssue],
      [],
      "testuser",
      expect.any(Date),
      voteMap,
      expect.any(Map),
      undefined,
    );
  });

  it("does not call fetchVotes when no voting issues exist", async () => {
    mockedFetchIssues.mockResolvedValue([{ number: 1, labels: [{ name: "bug" }] }] as any);
    mockedFetchPulls.mockResolvedValue([]);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    expect(mockedFetchVotes).toHaveBeenCalledWith(testRepo, [], "testuser");
  });

  it("adds note when fetchVotes fails", async () => {
    const votingIssue = { number: 42, labels: [{ name: "phase:voting" }] };
    mockedFetchIssues.mockResolvedValue([votingIssue] as any);
    mockedFetchVotes.mockRejectedValue(new Error("GraphQL error"));
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toContain("Could not fetch vote data — vote status unavailable.");
  });

  it("does not add vote failure note when fetchVotes succeeds", async () => {
    mockedFetchIssues.mockResolvedValue([]);
    mockedFetchPulls.mockResolvedValue([]);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).not.toContain("Could not fetch vote data — vote status unavailable.");
  });

  // ── Notification fetching ─────────────────────────────────────────

  it("calls fetchNotifications in parallel with issues/PRs/user", async () => {
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    expect(mockedFetchNotifications).toHaveBeenCalledWith(testRepo);
  });

  it("starts data fetches before team config resolves", async () => {
    let resolveConfig!: (config: typeof testTeamConfig) => void;
    const configPromise = new Promise<typeof testTeamConfig>((resolve) => {
      resolveConfig = resolve;
    });
    mockedLoadTeamConfig.mockReturnValue(configPromise);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    const run = buzzCommand({});
    await Promise.resolve();

    expect(mockedFetchIssues).toHaveBeenCalledWith(testRepo, 200);
    expect(mockedFetchPulls).toHaveBeenCalledWith(testRepo, 200);
    expect(mockedFetchCurrentUser).toHaveBeenCalled();
    expect(mockedFetchNotifications).toHaveBeenCalledWith(testRepo);

    resolveConfig(testTeamConfig);
    await run;
  });

  it("passes notification map to buildSummary", async () => {
    const notificationMap = new Map([[42, {
      threadId: "T42",
      reason: "mention",
      updatedAt: "2025-06-15T10:00:00Z",
      title: "Fix dashboard",
      url: "https://github.com/hivemoot/test/issues/42",
      itemType: "Issue" as const,
    }]]);
    mockedFetchNotifications.mockResolvedValue(notificationMap);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    expect(mockedBuildSummary).toHaveBeenCalledWith(
      testRepo,
      [],
      [],
      "testuser",
      expect.any(Date),
      expect.any(Map),
      notificationMap,
      undefined,
    );
  });

  it("adds note when fetchNotifications fails", async () => {
    mockedFetchNotifications.mockRejectedValue(new Error("API error"));
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toContain("Could not fetch notifications — unread indicators unavailable.");
  });

  it("passes empty notification map when fetchNotifications fails", async () => {
    mockedFetchNotifications.mockRejectedValue(new Error("API error"));
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const notificationsArg = mockedBuildSummary.mock.calls[0][6];
    expect(notificationsArg).toEqual(new Map());
  });

  it("does not add notification failure note when fetchNotifications succeeds", async () => {
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).not.toContain("Could not fetch notifications — unread indicators unavailable.");
  });

  it("builds unackedMentions from unread mention notifications not in processedThreadIds", async () => {
    const notificationMap = new Map([[42, {
      threadId: "T42",
      reason: "mention",
      updatedAt: "2025-06-15T10:00:00Z",
      title: "Fix dashboard",
      url: "https://github.com/hivemoot/test/issues/42",
      itemType: "Issue" as const,
    }]]);
    mockedFetchNotifications.mockResolvedValue(notificationMap);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [], unackedMentions: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.unackedMentions).toEqual([
      expect.objectContaining({
        number: 42,
        reason: "mention",
        ackKey: "T42:2025-06-15T10:00:00Z",
      }),
    ]);
  });

  it("filters already-acked mentions out of unackedMentions", async () => {
    const notificationMap = new Map([[42, {
      threadId: "T42",
      reason: "mention",
      updatedAt: "2025-06-15T10:00:00Z",
      title: "Fix dashboard",
      url: "https://github.com/hivemoot/test/issues/42",
      itemType: "Issue" as const,
    }]]);
    mockedFetchNotifications.mockResolvedValue(notificationMap);
    mockedLoadStateWithStatus.mockResolvedValue({
      state: {
        lastChecked: "2026-02-17T00:00:00Z",
        processedThreadIds: ["T42:2025-06-15T10:00:00Z"],
      },
      degraded: false,
    });
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [], unackedMentions: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.unackedMentions).toEqual([]);
  });

  it("merges pending ack journal entries before unacked mention filtering", async () => {
    const notificationMap = new Map([[42, {
      threadId: "T42",
      reason: "mention",
      updatedAt: "2025-06-15T10:00:00Z",
      title: "Fix dashboard",
      url: "https://github.com/hivemoot/test/issues/42",
      itemType: "Issue" as const,
    }]]);
    mockedFetchNotifications.mockResolvedValue(notificationMap);
    mockedMergeAckJournal.mockResolvedValue({
      lastChecked: "2026-02-17T00:00:00Z",
      processedThreadIds: ["T42:2025-06-15T10:00:00Z"],
    });
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [], unackedMentions: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    expect(mockedMergeAckJournal).toHaveBeenCalledWith(".hivemoot-watch.json", {
      lastChecked: "2026-02-17T00:00:00Z",
      processedThreadIds: [],
    });
    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.unackedMentions).toEqual([]);
  });

  it("ignores non-mention notifications in unackedMentions", async () => {
    const notificationMap = new Map([[49, {
      threadId: "T49",
      reason: "comment",
      updatedAt: "2025-06-15T10:00:00Z",
      title: "Add search",
      url: "https://github.com/hivemoot/test/pull/49",
      itemType: "PullRequest" as const,
    }]]);
    mockedFetchNotifications.mockResolvedValue(notificationMap);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [], unackedMentions: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.unackedMentions).toEqual([]);
  });

  it("sorts unackedMentions deterministically when timestamps match", async () => {
    const notificationMap = new Map([
      [18, {
        threadId: "TB",
        reason: "mention",
        updatedAt: "2025-06-15T10:00:00Z",
        title: "B",
        url: "https://github.com/hivemoot/test/issues/18",
        itemType: "Issue" as const,
      }],
      [17, {
        threadId: "TA",
        reason: "mention",
        updatedAt: "2025-06-15T10:00:00Z",
        title: "A",
        url: "https://github.com/hivemoot/test/issues/17",
        itemType: "Issue" as const,
      }],
    ]);
    mockedFetchNotifications.mockResolvedValue(notificationMap);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [], unackedMentions: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.unackedMentions.map((n: { number: number }) => n.number)).toEqual([17, 18]);
  });

  it("adds warning note when watch state cannot be loaded", async () => {
    mockedLoadStateWithStatus.mockRejectedValue(new Error("EACCES"));
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [], unackedMentions: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toContain(
      "Could not load watch state (EACCES) from .hivemoot-watch.json — UNACKED MENTIONS may be incomplete.",
    );
  });

  it("adds warning note when watch state degrades to defaults", async () => {
    mockedLoadStateWithStatus.mockResolvedValue({
      state: {
        lastChecked: "2026-02-17T00:00:00Z",
        processedThreadIds: [],
      },
      degraded: true,
      reason: "invalid JSON",
    });
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [], unackedMentions: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toContain(
      "Could not fully load watch state: invalid JSON from .hivemoot-watch.json — UNACKED MENTIONS may be incomplete.",
    );
  });

  // ── Push permission hints ──────────────────────────────────────────

  it("checks repository push permissions", async () => {
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    expect(mockedFetchRepoPushAccess).toHaveBeenCalledWith(testRepo);
  });

  it("adds publishing-flow guidance note when token cannot push", async () => {
    mockedFetchRepoPushAccess.mockResolvedValue(false);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toContain(
      "No direct push permission detected for you on hivemoot/test — check this repository's docs for the exact contribution flow.",
    );
  });

  it("does not add push-permission note when token has push access", async () => {
    mockedFetchRepoPushAccess.mockResolvedValue(true);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toEqual(
      expect.not.arrayContaining([expect.stringContaining("No direct push permission detected")]),
    );
  });

  it("adds note when push permission check is inconclusive", async () => {
    mockedFetchRepoPushAccess.mockResolvedValue(undefined);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toContain(
      "Could not determine push permissions for you on hivemoot/test — check this repository's contribution docs for the exact publishing flow.",
    );
  });

  it("adds note when permission check fails", async () => {
    mockedFetchRepoPushAccess.mockRejectedValue(new Error("permission endpoint unavailable"));
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.notes).toContain(
      "Could not check push permissions (permission endpoint unavailable) — check this repository's contribution docs for publishing guidance.",
    );
  });

  // ── Publish preflight ─────────────────────────────────────────────

  it("does not set publishReadiness when preflight succeeds", async () => {
    mockedRunPublishPreflight.mockResolvedValue({ command: "git push --dry-run origin HEAD", ok: true, originUrl: "https://github.com/hivemoot-guard/test.git" });
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.publishReadiness).toBeUndefined();
  });

  it("sets publishReadiness.canPush=false with upstream message when origin targets upstream", async () => {
    mockedRunPublishPreflight.mockResolvedValue({
      command: "git push --dry-run origin HEAD",
      ok: false,
      originUrl: "https://github.com/hivemoot/test.git",
      error: "remote: Permission to hivemoot/test.git denied to hivemoot-guard.",
    });
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.publishReadiness).toEqual({
      canPush: false,
      message: "Cannot push — origin targets the upstream repo (hivemoot/test). Point origin at a repo you have push access to.",
    });
  });

  it("sets publishReadiness.canPush=false with push-denied message when origin is not upstream", async () => {
    mockedRunPublishPreflight.mockResolvedValue({
      command: "git push --dry-run origin HEAD",
      ok: false,
      originUrl: "https://github.com/hivemoot-guard/test.git",
      error: "remote: Permission denied (403).",
    });
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.publishReadiness).toEqual({
      canPush: false,
      message: "Cannot push to origin (https://github.com/hivemoot-guard/test.git): remote: Permission denied (403). Check credentials and push access.",
    });
  });

  it("does not classify prefix-extended repo names as upstream", async () => {
    mockedRunPublishPreflight.mockResolvedValue({
      command: "git push --dry-run origin HEAD",
      ok: false,
      originUrl: "https://github.com/hivemoot/test-extended.git",
      error: "remote: Permission denied (403).",
    });
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.publishReadiness).toEqual({
      canPush: false,
      message: "Cannot push to origin (https://github.com/hivemoot/test-extended.git): remote: Permission denied (403). Check credentials and push access.",
    });
  });

  it("sets publishReadiness.canPush=false with verify-error message when no origin URL", async () => {
    mockedRunPublishPreflight.mockResolvedValue({
      command: "git push --dry-run origin HEAD",
      ok: false,
      error: "could not resolve git origin remote: fatal: not a git repository",
    });
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.publishReadiness).toEqual({
      canPush: false,
      message: "Could not verify push access (could not resolve git origin remote: fatal: not a git repository). Ensure git is available and origin is configured.",
    });
  });

  it("sets publishReadiness.canPush=false with spawn-error message when preflight execution fails", async () => {
    mockedRunPublishPreflight.mockRejectedValue(new Error("spawn git ENOENT"));
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(summaryArg.publishReadiness).toEqual({
      canPush: false,
      message: "Could not verify push access (spawn git ENOENT). Ensure git is available and origin is configured.",
    });
  });

  // ── Team focus ────────────────────────────────────────────────────

  it("passes focus from team config to buildSummary", async () => {
    const teamWithFocus = {
      ...testTeamConfig,
      focus: "Focus on PR reviews first.",
    };
    mockedLoadTeamConfig.mockResolvedValue(teamWithFocus);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const focusArg = mockedBuildSummary.mock.calls[0][7];
    expect(focusArg).toBe("Focus on PR reviews first.");
  });

  it("passes undefined focus when team config has no focus", async () => {
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const focusArg = mockedBuildSummary.mock.calls[0][7];
    expect(focusArg).toBeUndefined();
  });

  it("passes focus to buildSummary when using --role", async () => {
    const teamWithFocus = {
      ...testTeamConfig,
      focus: "Ship bug fixes this cycle.",
    };
    mockedLoadTeamConfig.mockResolvedValue(teamWithFocus);
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatBuzz.mockReturnValue("output");

    await buzzCommand({ role: "engineer" });

    const focusArg = mockedBuildSummary.mock.calls[0][7];
    expect(focusArg).toBe("Ship bug fixes this cycle.");
  });

  // ── Config loading graceful degradation ───────────────────────────

  it("silently ignores missing config when no role is provided", async () => {
    mockedLoadTeamConfig.mockRejectedValue(new CliError("No .github/hivemoot.yml found", "CONFIG_NOT_FOUND"));
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const focusArg = mockedBuildSummary.mock.calls[0][7];
    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(focusArg).toBeUndefined();
    expect(summaryArg.notes).not.toContain(expect.stringContaining("Could not load team config"));
    expect(console.log).toHaveBeenCalledWith("output");
  });

  it("adds a warning note for non-missing team config errors when no role is provided", async () => {
    mockedLoadTeamConfig.mockRejectedValue(new CliError("Config error: invalid YAML", "INVALID_CONFIG"));
    mockedBuildSummary.mockReturnValue({ ...testSummary, notes: [] });
    mockedFormatStatus.mockReturnValue("output");

    await buzzCommand({});

    const focusArg = mockedBuildSummary.mock.calls[0][7];
    const summaryArg = mockedFormatStatus.mock.calls[0][0];
    expect(focusArg).toBeUndefined();
    expect(summaryArg.notes).toContain(
      "Could not load team config (Config error: invalid YAML) — team focus guidance unavailable.",
    );
  });

  it("throws loadTeamConfig error when role is provided", async () => {
    mockedLoadTeamConfig.mockRejectedValue(new CliError("No .github/hivemoot.yml found", "CONFIG_NOT_FOUND"));

    await expect(buzzCommand({ role: "engineer" })).rejects.toThrow(CliError);
    await expect(buzzCommand({ role: "engineer" })).rejects.toMatchObject({
      code: "CONFIG_NOT_FOUND",
    });
  });
});
