import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for daily-standup script (processRepository)
 *
 * Verifies the 10-step pipeline:
 * 1. Load repo config — check if standup is enabled
 * 2. Check if discussions are enabled
 * 3. Find the configured discussion category
 * 4. Find or create the Colony Journal discussion
 * 5. Idempotency check — skip if today's report already exists
 * 6. Compute day number
 * 7. Collect standup data
 * 8. Generate LLM content (optional)
 * 9. Format the comment body
 * 10. Post the standup comment
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("octokit", () => ({
  App: vi.fn(),
  Octokit: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  setFailed: vi.fn(),
  warning: vi.fn(),
}));

// Suppress unhandled rejection from module-level runIfMain() calling main()
process.on("unhandledRejection", () => {});

vi.mock("../api/lib/index.js", () => ({
  loadRepositoryConfig: vi.fn(),
  createPROperations: vi.fn(() => ({ findPRsWithLabel: vi.fn() })),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    group: vi.fn(),
    groupEnd: vi.fn(),
  },
}));

vi.mock("../api/lib/discussions.js", () => ({
  getRepoDiscussionInfo: vi.fn(),
  findOrCreateColonyJournal: vi.fn(),
  addStandupComment: vi.fn(),
  getLastStandupDate: vi.fn(),
  computeDayNumber: vi.fn(),
}));

vi.mock("../api/lib/standup.js", () => ({
  collectStandupData: vi.fn(),
  formatStandupComment: vi.fn(),
  generateStandupLLMContent: vi.fn(),
  hasAnyContent: vi.fn(),
}));

vi.mock("./shared/run-installations.js", () => ({
  runForAllRepositories: vi.fn(),
  runIfMain: vi.fn(),
}));

vi.mock("../api/lib/env-validation.js", () => ({
  getAppConfig: vi.fn(() => {
    throw new Error("test: no env");
  }),
}));

// Import after all mocks are in place
import { processRepository } from "./daily-standup.js";
import {
  loadRepositoryConfig,
  createPROperations,
  logger,
} from "../api/lib/index.js";
import {
  getRepoDiscussionInfo,
  findOrCreateColonyJournal,
  addStandupComment,
  getLastStandupDate,
  computeDayNumber,
} from "../api/lib/discussions.js";
import {
  collectStandupData,
  formatStandupComment,
  generateStandupLLMContent,
  hasAnyContent,
} from "../api/lib/standup.js";
import type { Repository } from "../api/lib/index.js";

const mockLoadRepositoryConfig = vi.mocked(loadRepositoryConfig);
const mockCreatePROperations = vi.mocked(createPROperations);
const mockGetRepoDiscussionInfo = vi.mocked(getRepoDiscussionInfo);
const mockFindOrCreateColonyJournal = vi.mocked(findOrCreateColonyJournal);
const mockAddStandupComment = vi.mocked(addStandupComment);
const mockGetLastStandupDate = vi.mocked(getLastStandupDate);
const mockComputeDayNumber = vi.mocked(computeDayNumber);
const mockCollectStandupData = vi.mocked(collectStandupData);
const mockFormatStandupComment = vi.mocked(formatStandupComment);
const mockGenerateStandupLLMContent = vi.mocked(generateStandupLLMContent);
const mockHasAnyContent = vi.mocked(hasAnyContent);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRepo(overrides?: Partial<Repository>): Repository {
  return {
    owner: { login: "hivemoot" },
    name: "colony",
    full_name: "hivemoot/colony",
    ...overrides,
  } as Repository;
}

function makeStandupEnabledConfig() {
  return {
    standup: { enabled: true, category: "Colony Reports" },
  } as any;
}

function makeStandupDisabledConfig() {
  return {
    standup: { enabled: false, category: "" },
  } as any;
}

const fakeOctokit = {} as any;
const appId = 12345;

// ── Tests ────────────────────────────────────────────────────────────────────

describe("daily-standup processRepository", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Set to Feb 7 00:05 UTC — report covers Feb 6
    vi.setSystemTime(new Date("2026-02-07T00:05:00Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should skip when standup is not enabled", async () => {
    mockLoadRepositoryConfig.mockResolvedValue(makeStandupDisabledConfig());

    await processRepository(fakeOctokit, makeRepo(), appId);

    expect(mockLoadRepositoryConfig).toHaveBeenCalledWith(fakeOctokit, "hivemoot", "colony");
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Standup not enabled")
    );
    expect(mockGetRepoDiscussionInfo).not.toHaveBeenCalled();
  });

  it("should skip when discussions are not enabled", async () => {
    mockLoadRepositoryConfig.mockResolvedValue(makeStandupEnabledConfig());
    mockGetRepoDiscussionInfo.mockResolvedValue({
      repoId: "R_123",
      repoCreatedAt: "2024-06-01T00:00:00Z",
      hasDiscussions: false,
      categories: [],
    });

    await processRepository(fakeOctokit, makeRepo(), appId);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Discussions not enabled")
    );
    expect(mockFindOrCreateColonyJournal).not.toHaveBeenCalled();
  });

  it("should warn and skip when category is not found", async () => {
    mockLoadRepositoryConfig.mockResolvedValue(makeStandupEnabledConfig());
    mockGetRepoDiscussionInfo.mockResolvedValue({
      repoId: "R_123",
      repoCreatedAt: "2024-06-01T00:00:00Z",
      hasDiscussions: true,
      categories: [{ id: "DC_1", name: "General" }],
    });

    await processRepository(fakeOctokit, makeRepo(), appId);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Colony Reports")
    );
    expect(mockFindOrCreateColonyJournal).not.toHaveBeenCalled();
  });

  it("should skip when today's report already exists (idempotency)", async () => {
    mockLoadRepositoryConfig.mockResolvedValue(makeStandupEnabledConfig());
    mockGetRepoDiscussionInfo.mockResolvedValue({
      repoId: "R_123",
      repoCreatedAt: "2024-06-01T00:00:00Z",
      hasDiscussions: true,
      categories: [{ id: "DC_2", name: "Colony Reports" }],
    });
    mockFindOrCreateColonyJournal.mockResolvedValue({
      discussionId: "D_1",
      number: 42,
    });
    // Report date is yesterday: 2026-02-06
    mockGetLastStandupDate.mockResolvedValue("2026-02-06");

    await processRepository(fakeOctokit, makeRepo(), appId);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("already posted")
    );
    expect(mockCollectStandupData).not.toHaveBeenCalled();
  });

  it("should post standup when no prior report exists", async () => {
    mockLoadRepositoryConfig.mockResolvedValue(makeStandupEnabledConfig());
    mockGetRepoDiscussionInfo.mockResolvedValue({
      repoId: "R_123",
      repoCreatedAt: "2024-06-01T00:00:00Z",
      hasDiscussions: true,
      categories: [{ id: "DC_2", name: "Colony Reports" }],
    });
    mockFindOrCreateColonyJournal.mockResolvedValue({
      discussionId: "D_1",
      number: 42,
    });
    mockGetLastStandupDate.mockResolvedValue(null);
    mockComputeDayNumber.mockReturnValue(251);

    const standupData = {
      discussionPhase: [{ number: 1, title: "Test" }],
      repoFullName: "hivemoot/colony",
      reportDate: "2026-02-06",
      dayNumber: 251,
    };
    mockCollectStandupData.mockResolvedValue(standupData as any);
    mockHasAnyContent.mockReturnValue(true);
    mockGenerateStandupLLMContent.mockResolvedValue(null);
    mockFormatStandupComment.mockReturnValue("# Colony Report — Day 251\n...");
    mockAddStandupComment.mockResolvedValue({
      commentId: "C_1",
      url: "https://github.com/hivemoot/colony/discussions/42#comment-1",
    });

    await processRepository(fakeOctokit, makeRepo(), appId);

    // Verify the full pipeline executed
    expect(mockComputeDayNumber).toHaveBeenCalledWith(
      "2024-06-01T00:00:00Z",
      "2026-02-06"
    );
    expect(mockCollectStandupData).toHaveBeenCalled();
    expect(mockHasAnyContent).toHaveBeenCalledWith(standupData);
    expect(mockGenerateStandupLLMContent).toHaveBeenCalledWith(standupData, { installationId: undefined });
    expect(mockFormatStandupComment).toHaveBeenCalledWith(standupData, null);
    expect(mockAddStandupComment).toHaveBeenCalledWith(
      fakeOctokit,
      "D_1",
      "# Colony Report — Day 251\n...",
      "hivemoot",
      "colony",
      42,
      "2026-02-06"
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Day 251")
    );
  });

  it("should forward installationId to generateStandupLLMContent when installation context is provided", async () => {
    mockLoadRepositoryConfig.mockResolvedValue(makeStandupEnabledConfig());
    mockGetRepoDiscussionInfo.mockResolvedValue({
      repoId: "R_123",
      repoCreatedAt: "2024-06-01T00:00:00Z",
      hasDiscussions: true,
      categories: [{ id: "DC_2", name: "Colony Reports" }],
    });
    mockFindOrCreateColonyJournal.mockResolvedValue({
      discussionId: "D_1",
      number: 42,
    });
    mockGetLastStandupDate.mockResolvedValue(null);
    mockComputeDayNumber.mockReturnValue(251);

    const standupData = {
      discussionPhase: [{ number: 1, title: "Test" }],
      repoFullName: "hivemoot/colony",
      reportDate: "2026-02-06",
      dayNumber: 251,
    };
    mockCollectStandupData.mockResolvedValue(standupData as any);
    mockHasAnyContent.mockReturnValue(true);
    mockGenerateStandupLLMContent.mockResolvedValue(null);
    mockFormatStandupComment.mockReturnValue("# Colony Report — Day 251\n...");
    mockAddStandupComment.mockResolvedValue({
      commentId: "C_1",
      url: "https://github.com/hivemoot/colony/discussions/42#comment-1",
    });

    const installation = { installationId: 9876, installationLogin: "hivemoot-org" };
    await processRepository(fakeOctokit, makeRepo(), appId, installation);

    expect(mockGenerateStandupLLMContent).toHaveBeenCalledWith(standupData, { installationId: 9876 });
  });

  it("should skip LLM generation when hasAnyContent returns false", async () => {
    mockLoadRepositoryConfig.mockResolvedValue(makeStandupEnabledConfig());
    mockGetRepoDiscussionInfo.mockResolvedValue({
      repoId: "R_123",
      repoCreatedAt: "2024-06-01T00:00:00Z",
      hasDiscussions: true,
      categories: [{ id: "DC_2", name: "Colony Reports" }],
    });
    mockFindOrCreateColonyJournal.mockResolvedValue({
      discussionId: "D_1",
      number: 42,
    });
    mockGetLastStandupDate.mockResolvedValue(null);
    mockComputeDayNumber.mockReturnValue(10);

    const emptyData = {
      discussionPhase: [],
      votingPhase: [],
      extendedVoting: [],
      readyToImplement: [],
      repoFullName: "hivemoot/colony",
      reportDate: "2026-02-06",
      dayNumber: 10,
    };
    mockCollectStandupData.mockResolvedValue(emptyData as any);
    mockHasAnyContent.mockReturnValue(false);
    mockFormatStandupComment.mockReturnValue("# Colony Report — Day 10\nQuiet day.");
    mockAddStandupComment.mockResolvedValue({ commentId: "C_2", url: null } as any);

    await processRepository(fakeOctokit, makeRepo(), appId);

    expect(mockGenerateStandupLLMContent).not.toHaveBeenCalled();
    expect(mockFormatStandupComment).toHaveBeenCalledWith(emptyData, null);
  });

  it("should include LLM content when available", async () => {
    mockLoadRepositoryConfig.mockResolvedValue(makeStandupEnabledConfig());
    mockGetRepoDiscussionInfo.mockResolvedValue({
      repoId: "R_123",
      repoCreatedAt: "2024-06-01T00:00:00Z",
      hasDiscussions: true,
      categories: [{ id: "DC_2", name: "Colony Reports" }],
    });
    mockFindOrCreateColonyJournal.mockResolvedValue({
      discussionId: "D_1",
      number: 42,
    });
    mockGetLastStandupDate.mockResolvedValue(null);
    mockComputeDayNumber.mockReturnValue(100);

    const standupData = {
      discussionPhase: [{ number: 1, title: "Feature" }],
      repoFullName: "hivemoot/colony",
      reportDate: "2026-02-06",
      dayNumber: 100,
    };
    const llmContent = {
      narrative: "Active governance day.",
      keyUpdates: ["Feature A approved"],
      queensTake: {
        wentWell: "Smooth voting.",
        focusAreas: "PR reviews.",
        needsAttention: "",
      },
    };
    mockCollectStandupData.mockResolvedValue(standupData as any);
    mockHasAnyContent.mockReturnValue(true);
    mockGenerateStandupLLMContent.mockResolvedValue(llmContent);
    mockFormatStandupComment.mockReturnValue("# Report with LLM");
    mockAddStandupComment.mockResolvedValue({ commentId: "C_3", url: "url" });

    await processRepository(fakeOctokit, makeRepo(), appId);

    expect(mockFormatStandupComment).toHaveBeenCalledWith(standupData, llmContent);
  });

  it("should proceed when last standup date differs from report date", async () => {
    mockLoadRepositoryConfig.mockResolvedValue(makeStandupEnabledConfig());
    mockGetRepoDiscussionInfo.mockResolvedValue({
      repoId: "R_123",
      repoCreatedAt: "2024-06-01T00:00:00Z",
      hasDiscussions: true,
      categories: [{ id: "DC_2", name: "Colony Reports" }],
    });
    mockFindOrCreateColonyJournal.mockResolvedValue({
      discussionId: "D_1",
      number: 42,
    });
    // Last standup was for a previous day
    mockGetLastStandupDate.mockResolvedValue("2026-02-05");
    mockComputeDayNumber.mockReturnValue(251);
    mockCollectStandupData.mockResolvedValue({ repoFullName: "hivemoot/colony", dayNumber: 251 } as any);
    mockHasAnyContent.mockReturnValue(false);
    mockFormatStandupComment.mockReturnValue("report body");
    mockAddStandupComment.mockResolvedValue({ commentId: "C_4", url: null } as any);

    await processRepository(fakeOctokit, makeRepo(), appId);

    // Should not skip — different dates
    expect(mockCollectStandupData).toHaveBeenCalled();
    expect(mockAddStandupComment).toHaveBeenCalled();
  });

  it("should find the correct category by name", async () => {
    mockLoadRepositoryConfig.mockResolvedValue(makeStandupEnabledConfig());
    mockGetRepoDiscussionInfo.mockResolvedValue({
      repoId: "R_123",
      repoCreatedAt: "2024-06-01T00:00:00Z",
      hasDiscussions: true,
      categories: [
        { id: "DC_1", name: "General" },
        { id: "DC_2", name: "Colony Reports" },
        { id: "DC_3", name: "Ideas" },
      ],
    });
    mockFindOrCreateColonyJournal.mockResolvedValue({
      discussionId: "D_1",
      number: 1,
    });
    mockGetLastStandupDate.mockResolvedValue(null);
    mockComputeDayNumber.mockReturnValue(1);
    mockCollectStandupData.mockResolvedValue({ repoFullName: "hivemoot/colony", dayNumber: 1 } as any);
    mockHasAnyContent.mockReturnValue(false);
    mockFormatStandupComment.mockReturnValue("body");
    mockAddStandupComment.mockResolvedValue({ commentId: "C_5", url: null } as any);

    await processRepository(fakeOctokit, makeRepo(), appId);

    // findOrCreateColonyJournal should receive the correct category ID
    expect(mockFindOrCreateColonyJournal).toHaveBeenCalledWith(
      fakeOctokit,
      "R_123",
      "DC_2",
      "hivemoot",
      "colony"
    );
  });

  it("should call logger.group and logger.groupEnd for structured logging", async () => {
    mockLoadRepositoryConfig.mockResolvedValue(makeStandupDisabledConfig());

    await processRepository(fakeOctokit, makeRepo(), appId);

    expect(logger.group).toHaveBeenCalledWith("Processing hivemoot/colony");
    expect(logger.groupEnd).toHaveBeenCalled();
  });

  it("should call logger.groupEnd even when an error is thrown", async () => {
    mockLoadRepositoryConfig.mockRejectedValue(new Error("Config load failed"));

    await expect(
      processRepository(fakeOctokit, makeRepo(), appId)
    ).rejects.toThrow("Config load failed");

    expect(logger.group).toHaveBeenCalledWith("Processing hivemoot/colony");
    expect(logger.groupEnd).toHaveBeenCalled();
  });

  it("should use createPROperations with appId for standup data collection", async () => {
    mockLoadRepositoryConfig.mockResolvedValue(makeStandupEnabledConfig());
    mockGetRepoDiscussionInfo.mockResolvedValue({
      repoId: "R_123",
      repoCreatedAt: "2024-06-01T00:00:00Z",
      hasDiscussions: true,
      categories: [{ id: "DC_2", name: "Colony Reports" }],
    });
    mockFindOrCreateColonyJournal.mockResolvedValue({
      discussionId: "D_1",
      number: 42,
    });
    mockGetLastStandupDate.mockResolvedValue(null);
    mockComputeDayNumber.mockReturnValue(5);
    mockCollectStandupData.mockResolvedValue({ repoFullName: "hivemoot/colony", dayNumber: 5 } as any);
    mockHasAnyContent.mockReturnValue(false);
    mockFormatStandupComment.mockReturnValue("body");
    mockAddStandupComment.mockResolvedValue({ commentId: "C_6", url: null } as any);

    await processRepository(fakeOctokit, makeRepo(), appId);

    expect(mockCreatePROperations).toHaveBeenCalledWith(fakeOctokit, { appId });
  });

  it("should log posted report with URL when available", async () => {
    mockLoadRepositoryConfig.mockResolvedValue(makeStandupEnabledConfig());
    mockGetRepoDiscussionInfo.mockResolvedValue({
      repoId: "R_123",
      repoCreatedAt: "2024-06-01T00:00:00Z",
      hasDiscussions: true,
      categories: [{ id: "DC_2", name: "Colony Reports" }],
    });
    mockFindOrCreateColonyJournal.mockResolvedValue({
      discussionId: "D_1",
      number: 42,
    });
    mockGetLastStandupDate.mockResolvedValue(null);
    mockComputeDayNumber.mockReturnValue(99);
    mockCollectStandupData.mockResolvedValue({ repoFullName: "hivemoot/colony", dayNumber: 99 } as any);
    mockHasAnyContent.mockReturnValue(false);
    mockFormatStandupComment.mockReturnValue("body");
    mockAddStandupComment.mockResolvedValue({
      commentId: "C_7",
      url: "https://github.com/hivemoot/colony/discussions/42#discussioncomment-7",
    });

    await processRepository(fakeOctokit, makeRepo(), appId);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Day 99")
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("https://github.com/hivemoot/colony/discussions/42#discussioncomment-7")
    );
  });

  it("should log 'verified' when addStandupComment returns no URL", async () => {
    mockLoadRepositoryConfig.mockResolvedValue(makeStandupEnabledConfig());
    mockGetRepoDiscussionInfo.mockResolvedValue({
      repoId: "R_123",
      repoCreatedAt: "2024-06-01T00:00:00Z",
      hasDiscussions: true,
      categories: [{ id: "DC_2", name: "Colony Reports" }],
    });
    mockFindOrCreateColonyJournal.mockResolvedValue({
      discussionId: "D_1",
      number: 42,
    });
    mockGetLastStandupDate.mockResolvedValue(null);
    mockComputeDayNumber.mockReturnValue(99);
    mockCollectStandupData.mockResolvedValue({ repoFullName: "hivemoot/colony", dayNumber: 99 } as any);
    mockHasAnyContent.mockReturnValue(false);
    mockFormatStandupComment.mockReturnValue("body");
    mockAddStandupComment.mockResolvedValue({ commentId: "C_8" } as any);

    await processRepository(fakeOctokit, makeRepo(), appId);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("verified")
    );
  });
});
