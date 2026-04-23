import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  collectStandupData,
  hasAnyContent,
  formatStandupComment,
  validateLLMReferences,
  computeHealthSignals,
  type StandupData,
  type StandupClient,
  type StandupPROperations,
  type StandupLLMContent,
} from "./standup.js";

/**
 * Tests for Standup Module
 *
 * Verifies:
 * - Data collection with required vs optional sections
 * - Content detection (hasAnyContent)
 * - Comment formatting (full, quiet day, truncation)
 * - LLM reference validation (valid, hallucinated, threshold)
 * - Health signal generation
 */

// ───────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ───────────────────────────────────────────────────────────────────────────────

function createMockOctokit(): StandupClient & {
  rest: {
    issues: { listForRepo: ReturnType<typeof vi.fn> };
    pulls: {
      list: ReturnType<typeof vi.fn>;
      listCommits: ReturnType<typeof vi.fn>;
    };
    repos: {
      get: ReturnType<typeof vi.fn>;
      listCommits: ReturnType<typeof vi.fn>;
    };
  };
} {
  return {
    rest: {
      issues: {
        listForRepo: vi.fn().mockResolvedValue({ data: [] }),
      },
      pulls: {
        list: vi.fn().mockResolvedValue({ data: [] }),
        listCommits: vi.fn().mockResolvedValue({ data: [] }),
      },
      repos: {
        get: vi.fn().mockResolvedValue({ data: { open_issues_count: 0 } }),
        listCommits: vi.fn().mockResolvedValue({ data: [] }),
      },
    },
  };
}

function createMockPROperations(): StandupPROperations & {
  findPRsWithLabel: ReturnType<typeof vi.fn>;
} {
  return {
    findPRsWithLabel: vi.fn().mockResolvedValue([]),
  };
}

function createEmptyStandupData(overrides?: Partial<StandupData>): StandupData {
  return {
    discussionPhase: [],
    votingPhase: [],
    extendedVoting: [],
    readyToImplement: [],
    repoFullName: "hivemoot/colony",
    reportDate: "2026-02-06",
    dayNumber: 42,
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Data Collection
// ───────────────────────────────────────────────────────────────────────────────

describe("collectStandupData", () => {
  it("should collect pipeline issues by label", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    // Set up different label results
    octokit.rest.issues.listForRepo
      .mockResolvedValueOnce({
        data: [{ number: 1, title: "Add feature X", pull_request: undefined }],
      })
      .mockResolvedValueOnce({
        data: [{ number: 2, title: "Improve Y" }],
      })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [
          { number: 3, title: "Build Z" },
          { number: 4, title: "Build W" },
        ],
      });

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    expect(result.discussionPhase).toHaveLength(1);
    expect(result.votingPhase).toHaveLength(1);
    expect(result.extendedVoting).toHaveLength(0);
    expect(result.readyToImplement).toHaveLength(2);
    expect(result.repoFullName).toBe("hivemoot/colony");
    expect(result.dayNumber).toBe(42);
  });

  it("should filter out pull requests from issue results", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    octokit.rest.issues.listForRepo
      .mockResolvedValueOnce({
        data: [
          { number: 1, title: "Real issue" },
          { number: 10, title: "This is a PR", pull_request: { url: "..." } },
        ],
      })
      .mockResolvedValue({ data: [] });

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    expect(result.discussionPhase).toHaveLength(1);
    expect(result.discussionPhase[0].number).toBe(1);
  });

  it("should gracefully handle optional section failures", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    // Pipeline succeeds
    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });

    // PR operations fail
    prs.findPRsWithLabel.mockRejectedValue(new Error("API rate limited"));

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    // Pipeline data still present
    expect(result.discussionPhase).toEqual([]);
    // Optional data undefined (graceful degradation)
    expect(result.implementationPRs).toBeUndefined();
    expect(result.mergeReadyPRs).toBeUndefined();
    expect(result.stalePRs).toBeUndefined();
  });

  it("should use placeholder title/author when PR details fetch fails", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });
    // PR details fetch fails
    octokit.rest.pulls.list.mockRejectedValue(new Error("Rate limited"));
    // But label-based search succeeds
    prs.findPRsWithLabel.mockResolvedValueOnce([{ number: 10, createdAt: new Date(), updatedAt: new Date(), labels: [] }]);
    prs.findPRsWithLabel.mockResolvedValue([]);

    const result = await collectStandupData(
      octokit, prs, "hivemoot", "colony", "2026-02-06", 42
    );

    // PR ref falls back to placeholder
    expect(result.implementationPRs).toHaveLength(1);
    expect(result.implementationPRs![0].title).toBe("PR #10");
    expect(result.implementationPRs![0].author).toBe("unknown");
  });

  it("should only call pulls.list once for all enrichment", async () => {
    const octokit = createMockOctokit();
    const prs = createMockPROperations();

    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });
    octokit.rest.pulls.list.mockResolvedValue({
      data: [{ number: 10, title: "Real Title", user: { login: "agent-1" }, merged_at: null, labels: [] }],
    });
    prs.findPRsWithLabel
      .mockResolvedValueOnce([{ number: 10, createdAt: new Date(), updatedAt: new Date(), labels: [] }])
      .mockResolvedValue([]);

    await collectStandupData(octokit, prs, "hivemoot", "colony", "2026-02-06", 42);

    // pulls.list called twice: 1x for enrichment (not 3x) + 1x for merged PRs
    expect(octokit.rest.pulls.list).toHaveBeenCalledTimes(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Content Detection
// ───────────────────────────────────────────────────────────────────────────────

describe("hasAnyContent", () => {
  it("should return false for completely empty data", () => {
    expect(hasAnyContent(createEmptyStandupData())).toBe(false);
  });

  it("should return true when pipeline has issues", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "Test" }],
    });
    expect(hasAnyContent(data)).toBe(true);
  });

  it("should return true when there are implementation PRs", () => {
    const data = createEmptyStandupData({
      implementationPRs: [{ number: 10, title: "PR", author: "agent" }],
    });
    expect(hasAnyContent(data)).toBe(true);
  });

  it("should return true when there are merged PRs", () => {
    const data = createEmptyStandupData({
      recentlyMergedPRs: [{ number: 5, title: "Merged PR", author: "agent" }],
    });
    expect(hasAnyContent(data)).toBe(true);
  });

  it("should return true when there are direct commits", () => {
    const data = createEmptyStandupData({
      directCommits: [{ sha: "abc1234", message: "fix", author: "admin" }],
    });
    expect(hasAnyContent(data)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Formatting
// ───────────────────────────────────────────────────────────────────────────────

describe("formatStandupComment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-07T00:05:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should format quiet day when no content", () => {
    const data = createEmptyStandupData();
    const result = formatStandupComment(data);

    expect(result).toContain("Colony Report — Day 42");
    expect(result).toContain("The colony rests");
    expect(result).toContain("hivemoot-metadata:");
    expect(result).toContain('"type":"standup"');
    expect(result).toContain('"day":42');
    expect(result).toContain("buzz buzz");
  });

  it("should format full report with pipeline data", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "Feature A" }],
      votingPhase: [{ number: 2, title: "Feature B" }],
      readyToImplement: [
        { number: 3, title: "Feature C" },
        { number: 4, title: "Feature D" },
      ],
    });

    const result = formatStandupComment(data);

    expect(result).toContain("Colony Report — Day 42");
    expect(result).toContain("open issues");
    expect(result).toContain("PRs in flight");
    expect(result).toContain("hivemoot-metadata:");
  });

  it("should include LLM content when provided", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "Feature" }],
    });

    const llmContent: StandupLLMContent = {
      narrative: "A productive day in the colony.",
      keyUpdates: ["Feature approved"],
      queensTake: {
        wentWell: "Quick consensus on Feature.",
        focusAreas: "PR reviews needed.",
        needsAttention: "",
      },
    };

    const result = formatStandupComment(data, llmContent);

    expect(result).toContain("A productive day in the colony.");
    expect(result).toContain("Queen's Take");
    expect(result).toContain("Quick consensus on Feature.");
    expect(result).toContain("PR reviews needed.");
  });

  it("should omit needsAttention when empty", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "Feature" }],
    });

    const llmContent: StandupLLMContent = {
      narrative: "Summary.",
      keyUpdates: ["Update"],
      queensTake: {
        wentWell: "Things went well.",
        focusAreas: "Focus here.",
        needsAttention: "",
      },
    };

    const result = formatStandupComment(data, llmContent);

    expect(result).not.toContain("Needs addressing:");
  });

  it("should format implementation activity table", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      implementationPRs: [
        { number: 10, title: "Implement X", author: "agent-1" },
      ],
    });

    const result = formatStandupComment(data);

    expect(result).toContain("Implementation Activity");
    expect(result).toContain("#10");
    expect(result).toContain("@agent-1");
  });

  it("should escape pipe characters in PR titles for table formatting", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      implementationPRs: [
        { number: 10, title: "Add input|output handling", author: "agent-1" },
      ],
    });

    const result = formatStandupComment(data);

    // Pipe should be escaped so it doesn't break the markdown table
    expect(result).toContain("Add input\\|output handling");
    expect(result).not.toContain("Add input|output handling");
  });

  it("should format merged PRs", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      recentlyMergedPRs: [{ number: 5, title: "Feature X", author: "agent-1" }],
    });

    const result = formatStandupComment(data);

    expect(result).toContain("## Merged");
    expect(result).toContain("#5");
    expect(result).toContain("Feature X");
  });

  it("should keep detailed merged PR list when merged count is at threshold", () => {
    const merged = Array.from({ length: 8 }, (_, i) => ({
      number: i + 1,
      title: `Feature ${i + 1}`,
      author: "agent-1",
    }));
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      recentlyMergedPRs: merged,
    });

    const result = formatStandupComment(data);

    expect(result).toContain("## Merged");
    expect(result).toContain("**#8** Feature 8");
    expect(result).not.toContain("View all merged PRs");
  });

  it("should render compact merged summary and link when merged count exceeds threshold", () => {
    const merged = Array.from({ length: 9 }, (_, i) => ({
      number: i + 1,
      title: `Feature ${i + 1}`,
      author: "agent-1",
    }));
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
      repoFullName: "hivemoot/colony",
      reportDate: "2026-02-08",
      recentlyMergedPRs: merged,
    });

    const result = formatStandupComment(data);

    expect(result).toContain("## Merged");
    expect(result).toContain("**9 PRs merged**");
    expect(result).toContain(
      "[View all merged PRs for 2026-02-08](https://github.com/hivemoot/colony/pulls?q=is%3Apr%20is%3Amerged%20merged%3A2026-02-08..2026-02-08)"
    );
    expect(result).not.toContain("**#1** Feature 1");
  });

  it("should include metadata tag with correct structure", () => {
    const data = createEmptyStandupData({
      discussionPhase: [{ number: 1, title: "X" }],
    });

    const result = formatStandupComment(data);
    const metadataMatch = result.match(
      /<!--\s*hivemoot-metadata:\s*(\{[\s\S]*?\})\s*-->/
    );

    expect(metadataMatch).not.toBeNull();
    const metadata = JSON.parse(metadataMatch![1]);
    expect(metadata.type).toBe("standup");
    expect(metadata.day).toBe(42);
    expect(metadata.date).toBe("2026-02-06");
    expect(metadata.repo).toBe("hivemoot/colony");
    expect(metadata.issueNumber).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// LLM Reference Validation
// ───────────────────────────────────────────────────────────────────────────────

describe("validateLLMReferences", () => {
  it("should pass text with valid references", () => {
    const validNumbers = new Set([1, 5, 10]);
    const text = "Issue #1 was resolved via PR #5, while #10 remains open.";

    const result = validateLLMReferences(text, validNumbers);

    expect(result).toBe(text);
  });

  it("should replace hallucinated references", () => {
    const validNumbers = new Set([1, 5]);
    const text = "Issue #1 and #999 were discussed.";

    const result = validateLLMReferences(text, validNumbers);

    expect(result).toBe("Issue #1 and [ref removed] were discussed.");
  });

  it("should reject output when >50% references are hallucinated", () => {
    const validNumbers = new Set([1]);
    const text = "Issues #1, #99, #100, #200 were all active.";

    const result = validateLLMReferences(text, validNumbers);

    // 3 out of 4 refs are hallucinated (75%)
    expect(result).toBeNull();
  });

  it("should pass text with no references", () => {
    const validNumbers = new Set([1, 5]);
    const text = "The colony had a quiet day.";

    const result = validateLLMReferences(text, validNumbers);

    expect(result).toBe(text);
  });

  it("should handle exactly 50% hallucinated refs (not rejected)", () => {
    const validNumbers = new Set([1, 2]);
    const text = "Issues #1, #2, #99, #100.";

    const result = validateLLMReferences(text, validNumbers);

    // 2 out of 4 = 50%, not >50%, so should sanitize not reject
    expect(result).toBe("Issues #1, #2, [ref removed], [ref removed].");
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Health Signals
// ───────────────────────────────────────────────────────────────────────────────

describe("computeHealthSignals", () => {
  it("should detect merge-ready but unmerged PRs", () => {
    const data = createEmptyStandupData({
      mergeReadyPRs: [{ number: 10, title: "PR", author: "agent" }],
    });

    const signals = computeHealthSignals(data);

    expect(signals).toContainEqual(
      expect.stringContaining("merge-ready but unmerged")
    );
  });

  it("should detect stale PRs", () => {
    const data = createEmptyStandupData({
      stalePRs: [{ number: 20, title: "Old PR", author: "agent" }],
    });

    const signals = computeHealthSignals(data);

    expect(signals).toContainEqual(
      expect.stringContaining("stale PR")
    );
  });

  it("should detect large ready-to-implement backlog", () => {
    const data = createEmptyStandupData({
      readyToImplement: Array.from({ length: 6 }, (_, i) => ({
        number: i + 1,
        title: `Issue ${i + 1}`,
      })),
    });

    const signals = computeHealthSignals(data);

    expect(signals).toContainEqual(
      expect.stringContaining("ready-to-implement backlog")
    );
  });

  it("should detect ready issues with no implementation PRs", () => {
    const data = createEmptyStandupData({
      readyToImplement: [{ number: 1, title: "Ready" }],
      implementationPRs: [],
    });

    const signals = computeHealthSignals(data);

    expect(signals).toContainEqual(
      expect.stringContaining("no active implementation PRs")
    );
  });

  it("should return empty for healthy state", () => {
    const data = createEmptyStandupData({
      readyToImplement: [{ number: 1, title: "Ready" }],
      implementationPRs: [{ number: 10, title: "PR", author: "agent" }],
    });

    const signals = computeHealthSignals(data);

    expect(signals).toHaveLength(0);
  });
});
