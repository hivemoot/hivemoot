import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphqlResponseError } from "@octokit/graphql";
import { isFileAllowed, classifyFiles, evaluateAutomerge } from "./automerge.js";
import type { AutomergeConfig } from "./repo-config.js";
import { LABELS } from "../config.js";

/** Build a GraphqlResponseError that matches what GitHub returns when auto-merge is not enabled. */
function makeAutoMergeNotEnabledError(): GraphqlResponseError<null> {
  return new GraphqlResponseError(
    { url: "https://api.github.com/graphql" },
    {},
    {
      data: null,
      errors: [{ message: "Pull request Auto merge is not enabled.", type: "UNPROCESSABLE" }],
    }
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<AutomergeConfig>): AutomergeConfig {
  return {
    dryRun: true,
    allowedPaths: ["**/*.md", "**/*.txt", "docs/**"],
    denyPaths: [".github/**", "package.json"],
    maxFiles: 5,
    maxChangedLines: 80,
    minApprovals: 2,
    requireChecks: true,
    mergeMethod: "squash",
    ...overrides,
  };
}

function makeFile(filename: string, additions = 5, deletions = 0) {
  return {
    filename,
    additions,
    deletions,
    changes: additions + deletions,
    status: "modified",
  };
}

function createMockPROperations(overrides?: Record<string, unknown>) {
  return {
    listFiles: vi.fn().mockResolvedValue([]),
    getApproverLogins: vi.fn().mockResolvedValue(new Set<string>()),
    getLabels: vi.fn().mockResolvedValue([]),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({ headSha: "abc123", nodeId: "PR_kwNode123" }),
    getCheckRunsForRef: vi.fn().mockResolvedValue({
      totalCount: 0,
      checkRuns: [],
    }),
    getCombinedStatus: vi.fn().mockResolvedValue({
      state: "success",
      totalCount: 0,
    }),
    ...overrides,
  } as any;
}

// ───────────────────────────────────────────────────────────────────────────────
// isFileAllowed
// ───────────────────────────────────────────────────────────────────────────────

describe("isFileAllowed", () => {
  const allow = ["**/*.md", "**/*.txt", "docs/**"];
  const deny = [".github/**", "package.json"];

  it("allows markdown files", () => {
    expect(isFileAllowed("README.md", allow, deny)).toBe(true);
    expect(isFileAllowed("docs/guide.md", allow, deny)).toBe(true);
    expect(isFileAllowed("src/deep/nested/help.md", allow, deny)).toBe(true);
  });

  it("allows text files", () => {
    expect(isFileAllowed("CHANGELOG.txt", allow, deny)).toBe(true);
    expect(isFileAllowed("notes/todo.txt", allow, deny)).toBe(true);
  });

  it("allows files matching docs/** glob", () => {
    expect(isFileAllowed("docs/api.ts", allow, deny)).toBe(true);
    expect(isFileAllowed("docs/deep/nested/thing.js", allow, deny)).toBe(true);
  });

  it("denies files in .github/ even if they match allow patterns", () => {
    expect(isFileAllowed(".github/workflows/ci.yml", allow, deny)).toBe(false);
    expect(isFileAllowed(".github/README.md", allow, deny)).toBe(false);
  });

  it("denies package.json", () => {
    expect(isFileAllowed("package.json", allow, deny)).toBe(false);
  });

  it("denies files that don't match any allow pattern", () => {
    expect(isFileAllowed("src/index.ts", allow, deny)).toBe(false);
    expect(isFileAllowed("lib/utils.js", allow, deny)).toBe(false);
  });

  it("deny takes precedence over allow", () => {
    // A file that matches both allow and deny should be denied
    const denyAll = ["**/*.md"];
    expect(isFileAllowed("README.md", allow, denyAll)).toBe(false);
  });

  it("handles empty allow patterns (nothing allowed)", () => {
    expect(isFileAllowed("README.md", [], deny)).toBe(false);
  });

  it("handles empty deny patterns (nothing denied)", () => {
    expect(isFileAllowed("README.md", allow, [])).toBe(true);
    expect(isFileAllowed("src/index.ts", allow, [])).toBe(false);
  });

  it("handles dotfiles correctly with dot option", () => {
    const dotAllow = ["**/*.yml"];
    expect(isFileAllowed(".prettierrc.yml", dotAllow, [])).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// classifyFiles
// ───────────────────────────────────────────────────────────────────────────────

describe("classifyFiles", () => {
  const config = makeConfig();

  it("returns ineligible for empty file list", () => {
    const result = classifyFiles([], config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("no files");
  });

  it("returns eligible for a single allowed markdown file", () => {
    const files = [makeFile("README.md", 3, 2)];
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(true);
  });

  it("returns ineligible when file count exceeds maxFiles", () => {
    const files = Array.from({ length: 6 }, (_, i) => makeFile(`doc${i}.md`, 1));
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("too many files");
    expect(result.reason).toContain("6");
  });

  it("returns eligible when file count equals maxFiles", () => {
    const files = Array.from({ length: 5 }, (_, i) => makeFile(`doc${i}.md`, 1));
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(true);
  });

  it("returns ineligible when total changed lines exceeds maxChangedLines", () => {
    const files = [makeFile("docs/large.md", 50, 40)]; // 90 lines > 80
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("too many changed lines");
  });

  it("returns eligible when total changed lines equals maxChangedLines", () => {
    const files = [makeFile("docs/exact.md", 40, 40)]; // 80 lines = 80
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(true);
  });

  it("counts additions and deletions in total changed lines", () => {
    const files = [
      makeFile("a.md", 20, 10), // 30
      makeFile("b.md", 30, 25), // 55
    ];
    // Total: 85 > 80
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("85");
  });

  it("returns ineligible when a file doesn't pass path rules", () => {
    const files = [
      makeFile("README.md", 5),
      makeFile("src/index.ts", 5), // not in allowed paths
    ];
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("src/index.ts");
  });

  it("returns ineligible when a file is in deny list", () => {
    const files = [
      makeFile("README.md", 5),
      makeFile("package.json", 1),
    ];
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("package.json");
  });

  it("returns eligible when all files pass all checks", () => {
    const files = [
      makeFile("README.md", 10, 5),
      makeFile("docs/guide.md", 15, 10),
      makeFile("CHANGELOG.txt", 5, 0),
    ];
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(true);
    expect(result.reason).toContain("passed");
  });

  it("rejects renamed file when source path is denied", () => {
    const files = [
      {
        filename: "docs/ci-config.md",
        additions: 5,
        deletions: 0,
        changes: 5,
        status: "renamed",
        previous_filename: ".github/ci.yml",
      },
    ];
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain(".github/ci.yml");
    expect(result.reason).toContain("renamed");
  });

  it("allows renamed file when both source and destination pass", () => {
    const files = [
      {
        filename: "docs/new-guide.md",
        additions: 2,
        deletions: 0,
        changes: 2,
        status: "renamed",
        previous_filename: "docs/old-guide.md",
      },
    ];
    const result = classifyFiles(files, config);
    expect(result.eligible).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// evaluateAutomerge
// ───────────────────────────────────────────────────────────────────────────────

describe("evaluateAutomerge", () => {
  const baseRef = { owner: "org", repo: "repo", prNumber: 42 };
  const trustedReviewers = ["alice", "bob"];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips when config is null (feature disabled)", async () => {
    const prs = createMockPROperations();
    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config: null,
      trustedReviewers,
    });
    expect(result.action).toBe("skipped");
    expect(prs.listFiles).not.toHaveBeenCalled();
  });

  it("adds label when all conditions pass", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "bob"])),
      getLabels: vi.fn().mockResolvedValue([]),
      getCheckRunsForRef: vi.fn().mockResolvedValue({
        totalCount: 1,
        checkRuns: [{ id: 1, status: "completed", conclusion: "success" }],
      }),
      getCombinedStatus: vi.fn().mockResolvedValue({
        state: "success",
        totalCount: 0,
      }),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      headSha: "sha123",
    });

    expect(result.action).toBe("labeled");
    expect(prs.addLabels).toHaveBeenCalledWith(baseRef, [LABELS.AUTOMERGE]);
  });

  it("returns noop when label already present and all conditions pass", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "bob"])),
      getLabels: vi.fn().mockResolvedValue([LABELS.AUTOMERGE]),
      getCheckRunsForRef: vi.fn().mockResolvedValue({
        totalCount: 1,
        checkRuns: [{ id: 1, status: "completed", conclusion: "success" }],
      }),
      getCombinedStatus: vi.fn().mockResolvedValue({
        state: "success",
        totalCount: 0,
      }),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      headSha: "sha123",
    });

    expect(result).toEqual({ action: "noop", labeled: true });
    expect(prs.addLabels).not.toHaveBeenCalled();
  });

  it("removes label when files are ineligible", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("src/index.ts", 5)]),
      getLabels: vi.fn().mockResolvedValue([LABELS.AUTOMERGE]),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
    });

    expect(result.action).toBe("unlabeled");
    expect(prs.removeLabel).toHaveBeenCalledWith(baseRef, LABELS.AUTOMERGE);
  });

  it("returns noop (not labeled) when files ineligible and label not present", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("src/index.ts", 5)]),
      getLabels: vi.fn().mockResolvedValue([]),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
    });

    expect(result).toEqual({ action: "noop", labeled: false });
    expect(prs.removeLabel).not.toHaveBeenCalled();
  });

  it("does not add label when approvals are insufficient", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])), // only 1, need 2
      getLabels: vi.fn().mockResolvedValue([]),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
    });

    expect(result).toEqual({ action: "noop", labeled: false });
    expect(prs.addLabels).not.toHaveBeenCalled();
  });

  it("removes label when approvals drop below threshold", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])),
      getLabels: vi.fn().mockResolvedValue([LABELS.AUTOMERGE]),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
    });

    expect(result.action).toBe("unlabeled");
    expect(prs.removeLabel).toHaveBeenCalledWith(baseRef, LABELS.AUTOMERGE);
  });

  it("does not add label when CI is failing", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "bob"])),
      getLabels: vi.fn().mockResolvedValue([]),
      getCheckRunsForRef: vi.fn().mockResolvedValue({
        totalCount: 1,
        checkRuns: [{ id: 1, status: "completed", conclusion: "failure" }],
      }),
      getCombinedStatus: vi.fn().mockResolvedValue({
        state: "success",
        totalCount: 0,
      }),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      headSha: "sha123",
    });

    expect(result).toEqual({ action: "noop", labeled: false });
  });

  it("skips CI check when requireChecks is false", async () => {
    const config = makeConfig({ requireChecks: false });
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "bob"])),
      getLabels: vi.fn().mockResolvedValue([]),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
    });

    expect(result.action).toBe("labeled");
    expect(prs.getCheckRunsForRef).not.toHaveBeenCalled();
  });

  it("fetches headSha from PR when not provided", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "bob"])),
      getLabels: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ headSha: "fetched-sha" }),
      getCheckRunsForRef: vi.fn().mockResolvedValue({
        totalCount: 0,
        checkRuns: [],
      }),
      getCombinedStatus: vi.fn().mockResolvedValue({
        state: "success",
        totalCount: 0,
      }),
    });

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      // headSha intentionally not provided
    });

    expect(prs.get).toHaveBeenCalledWith(baseRef);
    expect(prs.getCheckRunsForRef).toHaveBeenCalledWith("org", "repo", "fetched-sha");
  });

  it("uses pre-fetched currentLabels when provided", async () => {
    const config = makeConfig({ requireChecks: false });
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "bob"])),
    });

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      currentLabels: [],
    });

    expect(prs.getLabels).not.toHaveBeenCalled();
  });

  it("uses earlyExitThreshold when fetching files", async () => {
    const config = makeConfig({ maxFiles: 3 });
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([]),
      getLabels: vi.fn().mockResolvedValue([]),
    });

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
    });

    expect(prs.listFiles).toHaveBeenCalledWith(baseRef, { earlyExitThreshold: 3 });
  });

  it("short-circuits at file classification (does not check approvals)", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("src/main.ts", 5)]),
      getLabels: vi.fn().mockResolvedValue([]),
    });

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
    });

    // Files ineligible → should not proceed to approvals
    expect(prs.getApproverLogins).not.toHaveBeenCalled();
  });

  it("short-circuits at approvals (does not check CI)", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice"])), // only 1, need 2
      getLabels: vi.fn().mockResolvedValue([]),
    });

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
    });

    // Approvals insufficient → should not proceed to CI
    expect(prs.getCheckRunsForRef).not.toHaveBeenCalled();
  });

  it("propagates errors from API calls", async () => {
    const config = makeConfig();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockRejectedValue(new Error("API error")),
      getLabels: vi.fn().mockResolvedValue([]),
    });

    await expect(
      evaluateAutomerge({
        prs,
        ref: baseRef,
        config,
        trustedReviewers,
      })
    ).rejects.toThrow("API error");
  });

  describe("draft and mergeable gates", () => {
    it("removes label when the PR is a draft", async () => {
      const config = makeConfig({ requireChecks: false });
      const prs = createMockPROperations({
        getLabels: vi.fn().mockResolvedValue([LABELS.AUTOMERGE]),
      });

      const result = await evaluateAutomerge({
        prs,
        ref: baseRef,
        config,
        trustedReviewers,
        draft: true,
      });

      expect(result).toEqual({ action: "unlabeled", reason: "PR is a draft" });
      expect(prs.removeLabel).toHaveBeenCalledWith(baseRef, LABELS.AUTOMERGE);
      expect(prs.listFiles).not.toHaveBeenCalled();
    });

    it("returns noop when the PR is a draft and the label is absent", async () => {
      const config = makeConfig({ requireChecks: false });
      const prs = createMockPROperations({
        getLabels: vi.fn().mockResolvedValue([]),
      });

      const result = await evaluateAutomerge({
        prs,
        ref: baseRef,
        config,
        trustedReviewers,
        draft: true,
      });

      expect(result).toEqual({ action: "noop", labeled: false });
      expect(prs.removeLabel).not.toHaveBeenCalled();
      expect(prs.listFiles).not.toHaveBeenCalled();
    });

    it("removes label when the PR has merge conflicts", async () => {
      const config = makeConfig({ requireChecks: false });
      const prs = createMockPROperations({
        getLabels: vi.fn().mockResolvedValue([LABELS.AUTOMERGE]),
      });

      const result = await evaluateAutomerge({
        prs,
        ref: baseRef,
        config,
        trustedReviewers,
        mergeable: false,
      });

      expect(result).toEqual({
        action: "unlabeled",
        reason: "PR has merge conflicts",
      });
      expect(prs.removeLabel).toHaveBeenCalledWith(baseRef, LABELS.AUTOMERGE);
      expect(prs.listFiles).not.toHaveBeenCalled();
    });

    it("passes through when mergeable is null", async () => {
      const config = makeConfig({ requireChecks: false });
      const prs = createMockPROperations({
        listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
        getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "bob"])),
        getLabels: vi.fn().mockResolvedValue([]),
      });

      const result = await evaluateAutomerge({
        prs,
        ref: baseRef,
        config,
        trustedReviewers,
        mergeable: null,
      });

      expect(result).toEqual({ action: "labeled" });
      expect(prs.listFiles).toHaveBeenCalled();
    });
  });

  it("only counts approvals from trusted reviewers", async () => {
    const config = makeConfig({ minApprovals: 2 });
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      // "charlie" is not in trustedReviewers
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "charlie"])),
      getLabels: vi.fn().mockResolvedValue([]),
    });

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers: ["alice", "bob"],
    });

    // Only alice counts (bob not approved, charlie not trusted)
    expect(result).toEqual({ action: "noop", labeled: false });
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// evaluateAutomerge — Phase 2 (dryRun: false)
// ───────────────────────────────────────────────────────────────────────────────

describe("evaluateAutomerge — Phase 2 (dryRun: false)", () => {
  const baseRef = { owner: "org", repo: "repo", prNumber: 42 };
  const trustedReviewers = ["alice", "bob"];

  function makeEligiblePROperations(overrides?: Record<string, unknown>) {
    return createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("README.md", 5)]),
      getApproverLogins: vi.fn().mockResolvedValue(new Set(["alice", "bob"])),
      getLabels: vi.fn().mockResolvedValue([]),
      getCheckRunsForRef: vi.fn().mockResolvedValue({
        totalCount: 1,
        checkRuns: [{ name: "CI", conclusion: "success", status: "completed" }],
      }),
      ...overrides,
    });
  }

  it("calls enablePullRequestAutoMerge when eligible and dryRun is false", async () => {
    const config = makeConfig({ dryRun: false, mergeMethod: "squash" });
    const prs = makeEligiblePROperations();
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      mergeable: true,
    });

    expect(result).toEqual({ action: "labeled" });
    expect(prs.addLabels).toHaveBeenCalledWith(baseRef, [LABELS.AUTOMERGE]);
    expect(mockGraphQL.graphql).toHaveBeenCalledWith(
      expect.stringContaining("enablePullRequestAutoMerge"),
      { pullRequestId: "PR_kwNode123", mergeMethod: "SQUASH", commitHeadline: null, commitBody: null, expectedHeadOid: "abc123" }
    );
  });

  it("passes commitHeadline and commitBody to the mutation when configured", async () => {
    const config = makeConfig({
      dryRun: false,
      mergeMethod: "squash",
      commitHeadline: "chore: auto-merge",
      commitBody: "Auto-merged.",
    });
    const prs = makeEligiblePROperations();
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      mergeable: true,
    });

    expect(mockGraphQL.graphql).toHaveBeenCalledWith(
      expect.stringContaining("enablePullRequestAutoMerge"),
      {
        pullRequestId: "PR_kwNode123",
        mergeMethod: "SQUASH",
        commitHeadline: "chore: auto-merge",
        commitBody: "Auto-merged.",
        expectedHeadOid: "abc123",
      }
    );
  });

  it("uses rebase merge method when configured", async () => {
    const config = makeConfig({ dryRun: false, mergeMethod: "rebase" });
    const prs = makeEligiblePROperations();
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      mergeable: true,
    });

    expect(mockGraphQL.graphql).toHaveBeenCalledWith(
      expect.stringContaining("enablePullRequestAutoMerge"),
      { pullRequestId: "PR_kwNode123", mergeMethod: "REBASE", commitHeadline: null, commitBody: null, expectedHeadOid: "abc123" }
    );
  });

  it("does NOT call GraphQL mutations when dryRun is true", async () => {
    const config = makeConfig({ dryRun: true });
    const prs = makeEligiblePROperations();
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
    });

    expect(result).toEqual({ action: "labeled" });
    expect(mockGraphQL.graphql).not.toHaveBeenCalled();
  });

  it("does NOT call enablePullRequestAutoMerge when mergeable is undefined (caller did not provide merge state)", async () => {
    const config = makeConfig({ dryRun: false, mergeMethod: "squash" });
    const prs = makeEligiblePROperations();
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      // mergeable not provided — treated same as null (unknown state)
    });

    expect(result).toEqual({ action: "labeled" });
    expect(prs.addLabels).toHaveBeenCalledWith(baseRef, [LABELS.AUTOMERGE]);
    expect(mockGraphQL.graphql).not.toHaveBeenCalledWith(
      expect.stringContaining("enablePullRequestAutoMerge"),
      expect.anything()
    );
  });

  it("does NOT call enablePullRequestAutoMerge when mergeable is null (GitHub still computing)", async () => {
    const config = makeConfig({ dryRun: false, mergeMethod: "squash" });
    const prs = makeEligiblePROperations();
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      mergeable: null,
    });

    // Label is added — the PR is eligible, just merge state is unknown
    expect(result).toEqual({ action: "labeled" });
    expect(prs.addLabels).toHaveBeenCalledWith(baseRef, [LABELS.AUTOMERGE]);
    // Phase 2 mutation must NOT fire when merge state is unknown
    expect(mockGraphQL.graphql).not.toHaveBeenCalledWith(
      expect.stringContaining("enablePullRequestAutoMerge"),
      expect.anything()
    );
  });

  it("passes expectedHeadOid from params.headSha to the mutation", async () => {
    const config = makeConfig({ dryRun: false, requireChecks: false });
    const prs = makeEligiblePROperations();
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      mergeable: true,
      headSha: "classified-sha-abc",
      nodeId: "PR_kwNode123",
    });

    expect(mockGraphQL.graphql).toHaveBeenCalledWith(
      expect.stringContaining("enablePullRequestAutoMerge"),
      expect.objectContaining({ expectedHeadOid: "classified-sha-abc" })
    );
  });

  it("passes expectedHeadOid captured from prs.get() when headSha not pre-fetched", async () => {
    const config = makeConfig({ dryRun: false, requireChecks: true });
    const prs = makeEligiblePROperations({
      get: vi.fn().mockResolvedValue({ headSha: "fetched-sha-xyz", nodeId: "PR_kwNode123" }),
      getCheckRunsForRef: vi.fn().mockResolvedValue({
        totalCount: 1,
        checkRuns: [{ name: "CI", conclusion: "success", status: "completed" }],
      }),
    });
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      mergeable: true,
      // headSha intentionally not provided — must be captured from prs.get() in CI step
    });

    expect(mockGraphQL.graphql).toHaveBeenCalledWith(
      expect.stringContaining("enablePullRequestAutoMerge"),
      expect.objectContaining({ expectedHeadOid: "fetched-sha-xyz" })
    );
  });

  it("does NOT call GraphQL mutations when graphql param is absent (dryRun: false without graphql)", async () => {
    const config = makeConfig({ dryRun: false });
    const prs = makeEligiblePROperations();

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      // no graphql param
    });

    // Should still label but not blow up
    expect(result).toEqual({ action: "labeled" });
  });

  it("calls disablePullRequestAutoMerge when label is removed and dryRun is false", async () => {
    const config = makeConfig({ dryRun: false });
    const prs = createMockPROperations({
      // PR has automerge label but file check fails → label should be removed
      listFiles: vi.fn().mockResolvedValue([makeFile("src/main.ts", 5)]),
      getLabels: vi.fn().mockResolvedValue([LABELS.AUTOMERGE]),
    });
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
    });

    expect(result).toEqual({ action: "unlabeled", reason: "file not allowed: src/main.ts" });
    expect(prs.removeLabel).toHaveBeenCalledWith(baseRef, LABELS.AUTOMERGE);
    expect(mockGraphQL.graphql).toHaveBeenCalledWith(
      expect.stringContaining("disablePullRequestAutoMerge"),
      { pullRequestId: "PR_kwNode123" }
    );
  });

  it("does NOT call disablePullRequestAutoMerge when dryRun is true", async () => {
    const config = makeConfig({ dryRun: true });
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("src/main.ts", 5)]),
      getLabels: vi.fn().mockResolvedValue([LABELS.AUTOMERGE]),
    });
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
    });

    expect(result).toEqual({ action: "unlabeled", reason: "file not allowed: src/main.ts" });
    expect(mockGraphQL.graphql).not.toHaveBeenCalled();
  });

  it("warns but continues when enablePullRequestAutoMerge fails (e.g., no branch protection)", async () => {
    const config = makeConfig({ dryRun: false });
    const prs = makeEligiblePROperations();
    const mockGraphQL = {
      graphql: vi.fn().mockRejectedValue(new Error("PullRequestAutoMergeNotAllowed")),
    };
    const warnLog = vi.fn();

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      log: { info: vi.fn(), warn: warnLog },
      mergeable: true,
    });

    // Label was applied — classification result is preserved even if mutation fails
    expect(result).toEqual({ action: "labeled" });
    expect(prs.addLabels).toHaveBeenCalledWith(baseRef, [LABELS.AUTOMERGE]);
    expect(warnLog).toHaveBeenCalledWith(
      expect.stringContaining("Failed to enable GitHub auto-merge")
    );
  });

  it("includes branch protection hint only for PullRequestAutoMergeNotAllowed", async () => {
    const config = makeConfig({ dryRun: false });
    const prs = makeEligiblePROperations();
    const warnLog = vi.fn();

    // Rate limit error — should NOT get branch protection hint
    const mockGraphQL = {
      graphql: vi.fn().mockRejectedValue(new Error("API rate limit exceeded")),
    };

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      log: { info: vi.fn(), warn: warnLog },
      mergeable: true,
    });

    expect(warnLog).toHaveBeenCalledWith(
      expect.not.stringContaining("branch protection")
    );
  });

  it("calls enablePullRequestAutoMerge even when hivemoot:automerge label already present (reconciliation)", async () => {
    const config = makeConfig({ dryRun: false, mergeMethod: "squash" });
    // PR already has the label (was labeled during dryRun: true)
    const prs = makeEligiblePROperations({
      getLabels: vi.fn().mockResolvedValue([LABELS.AUTOMERGE]),
    });
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      mergeable: true,
    });

    // Returns noop (label already present), but Phase 2 mutation must still fire
    expect(result).toEqual({ action: "noop", labeled: true });
    expect(prs.addLabels).not.toHaveBeenCalled();
    expect(mockGraphQL.graphql).toHaveBeenCalledWith(
      expect.stringContaining("enablePullRequestAutoMerge"),
      expect.objectContaining({ pullRequestId: "PR_kwNode123", mergeMethod: "SQUASH" })
    );
  });

  it("reuses nodeId from requireChecks prs.get() call — no duplicate fetch on Phase 2", async () => {
    const config = makeConfig({ dryRun: false, requireChecks: true });
    const getPRMock = vi.fn().mockResolvedValue({
      headSha: "abc123",
      nodeId: "PR_kwNode123",
      state: "open",
      merged: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      author: "alice",
      mergeable: true,
    });
    const prs = makeEligiblePROperations({
      get: getPRMock,
      getCheckRunsForRef: vi.fn().mockResolvedValue({
        totalCount: 1,
        checkRuns: [{ name: "CI", conclusion: "success", status: "completed" }],
      }),
    });
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      mergeable: true,
      // headSha NOT pre-fetched, so prs.get() must be called for CI check
    });

    // prs.get() should be called exactly once (for headSha + nodeId capture in step 4)
    expect(getPRMock).toHaveBeenCalledTimes(1);
    expect(mockGraphQL.graphql).toHaveBeenCalledWith(
      expect.stringContaining("enablePullRequestAutoMerge"),
      expect.objectContaining({ pullRequestId: "PR_kwNode123" })
    );
  });

  it("skips prs.get() when both nodeId and headSha are pre-seeded", async () => {
    const config = makeConfig({ dryRun: false, requireChecks: false });
    const getPRMock = vi.fn();
    const prs = makeEligiblePROperations({ get: getPRMock });
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      nodeId: "PR_kwPreFetched",
      headSha: "sha-pre-fetched",
      mergeable: true,
    });

    expect(getPRMock).not.toHaveBeenCalled();
    expect(mockGraphQL.graphql).toHaveBeenCalledWith(
      expect.stringContaining("enablePullRequestAutoMerge"),
      expect.objectContaining({ pullRequestId: "PR_kwPreFetched", expectedHeadOid: "sha-pre-fetched" })
    );
  });

  it("fetches headSha from prs.get() when nodeId is pre-seeded but headSha is not", async () => {
    const config = makeConfig({ dryRun: false, requireChecks: false });
    const getPRMock = vi.fn().mockResolvedValue({ headSha: "fetched-sha", nodeId: "PR_kwPreFetched" });
    const prs = makeEligiblePROperations({ get: getPRMock });
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      nodeId: "PR_kwPreFetched",
      // headSha intentionally not provided — must be fetched for expectedHeadOid
      mergeable: true,
    });

    expect(getPRMock).toHaveBeenCalledTimes(1);
    expect(mockGraphQL.graphql).toHaveBeenCalledWith(
      expect.stringContaining("enablePullRequestAutoMerge"),
      expect.objectContaining({ pullRequestId: "PR_kwPreFetched", expectedHeadOid: "fetched-sha" })
    );
  });

  it("warns and skips mutation when prs.get() fails during Phase 2 enable", async () => {
    const config = makeConfig({ dryRun: false, requireChecks: false });
    const warnLog = vi.fn();
    const prs = makeEligiblePROperations({
      get: vi.fn().mockRejectedValue(new Error("API timeout")),
    });
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      log: { info: vi.fn(), warn: warnLog },
      mergeable: true,
    });

    // Label was still added (automerge conditions met), but mutation was skipped
    expect(result).toEqual({ action: "labeled" });
    expect(warnLog).toHaveBeenCalledWith(
      expect.stringContaining("Failed to fetch PR node ID for auto-merge")
    );
    expect(mockGraphQL.graphql).not.toHaveBeenCalled();
  });

  it("skips mutation when nodeId is pre-seeded but headSha is absent and prs.get() fails", async () => {
    // Regression: if nodeId arrives from the webhook payload but headSha is absent and the
    // recovery prs.get() throws, capturedNodeId is still truthy. Before the fix, the old
    // `if (capturedNodeId)` gate would pass, firing enablePullRequestAutoMerge with
    // expectedHeadOid: undefined — silently dropping the TOCTOU guard.
    // After the fix (`if (capturedNodeId && capturedHeadSha)`), the mutation must not fire.
    const config = makeConfig({ dryRun: false, requireChecks: false });
    const warnLog = vi.fn();
    const prs = makeEligiblePROperations({
      get: vi.fn().mockRejectedValue(new Error("API timeout")),
    });
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      nodeId: "PR_kwPreSeededNodeId",
      // headSha intentionally not provided: prs.get() is needed but will fail
      log: { info: vi.fn(), warn: warnLog },
      mergeable: true,
    });

    // Label was still added (automerge conditions met), but mutation must be skipped
    // because headSha could not be captured — running without expectedHeadOid would
    // arm native auto-merge on an unverified head.
    expect(result).toEqual({ action: "labeled" });
    expect(warnLog).toHaveBeenCalledWith(
      expect.stringContaining("Failed to fetch PR node ID for auto-merge")
    );
    expect(mockGraphQL.graphql).not.toHaveBeenCalledWith(
      expect.stringContaining("enablePullRequestAutoMerge"),
      expect.anything()
    );
  });

  it("swallows PullRequestAutoMergeNotEnabled when disabling — idempotent no-op", async () => {
    const config = makeConfig({ dryRun: false });
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("src/main.ts", 5)]),
      getLabels: vi.fn().mockResolvedValue([LABELS.AUTOMERGE]),
    });
    const warnLog = vi.fn();
    const mockGraphQL = {
      graphql: vi.fn().mockRejectedValue(makeAutoMergeNotEnabledError()),
    };

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      log: { info: vi.fn(), warn: warnLog },
    });

    // Label was removed — action is correct
    expect(result).toEqual({ action: "unlabeled", reason: "file not allowed: src/main.ts" });
    expect(prs.removeLabel).toHaveBeenCalledWith(baseRef, LABELS.AUTOMERGE);
    // No warning logged for the expected idempotent case
    expect(warnLog).not.toHaveBeenCalled();
  });

  it("retains label and warns when disablePullRequestAutoMerge fails with unexpected error", async () => {
    // Unexpected disable failure must keep the label so future reconciliations can retry.
    // Without this invariant, a transient GraphQL error would leave GitHub auto-merge armed
    // with no retry signal (label already gone, hasAutomerge === false on next eval).
    const config = makeConfig({ dryRun: false });
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("src/main.ts", 5)]),
      getLabels: vi.fn().mockResolvedValue([LABELS.AUTOMERGE]),
    });
    const warnLog = vi.fn();
    const mockGraphQL = {
      graphql: vi.fn().mockRejectedValue(new Error("GraphQL network error")),
    };

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      log: { info: vi.fn(), warn: warnLog },
    });

    // Label retained — noop, not unlabeled
    expect(result).toEqual({ action: "noop", labeled: true });
    expect(prs.removeLabel).not.toHaveBeenCalledWith(baseRef, LABELS.AUTOMERGE);
    expect(warnLog).toHaveBeenCalledWith(
      expect.stringContaining("Failed to disable GitHub auto-merge")
    );
  });

  it("calls disablePullRequestAutoMerge on the mergeable:false gate when dryRun is false", async () => {
    const config = makeConfig({ dryRun: false });
    const nodeId = "PR_kwConflict";
    const prs = createMockPROperations({
      getLabels: vi.fn().mockResolvedValue([LABELS.AUTOMERGE]),
    });
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      nodeId,
      mergeable: false,
    });

    expect(result).toEqual({ action: "unlabeled", reason: "PR has merge conflicts" });
    expect(prs.removeLabel).toHaveBeenCalledWith(baseRef, LABELS.AUTOMERGE);
    expect(mockGraphQL.graphql).toHaveBeenCalledWith(
      expect.stringContaining("disablePullRequestAutoMerge"),
      { pullRequestId: nodeId }
    );
  });

  it("warns and skips disable mutation when prs.get() fails in the disable path", async () => {
    const config = makeConfig({ dryRun: false });
    const warnLog = vi.fn();
    const prs = createMockPROperations({
      listFiles: vi.fn().mockResolvedValue([makeFile("src/main.ts", 5)]),
      getLabels: vi.fn().mockResolvedValue([LABELS.AUTOMERGE]),
      get: vi.fn().mockRejectedValue(new Error("rate limit")),
    });
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    const result = await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      log: { info: vi.fn(), warn: warnLog },
    });

    // Fail closed: label is retained for retry when nodeId cannot be fetched
    expect(result).toEqual({ action: "noop", labeled: true });
    expect(warnLog).toHaveBeenCalledWith(
      expect.stringContaining("Failed to fetch PR node ID for auto-merge disable")
    );
    // Disable mutation must not be called when nodeId could not be fetched
    expect(mockGraphQL.graphql).not.toHaveBeenCalledWith(
      expect.stringContaining("disablePullRequestAutoMerge"),
      expect.anything()
    );
    // Label must NOT be removed — it is the retry signal for future reconciliations
    expect(prs.removeLabel).not.toHaveBeenCalled();
  });

  it("passes commitHeadline and commitBody for squash even when mergeMethod is rebase in config", async () => {
    // Verify: configuring commitHeadline with rebase still calls the mutation correctly.
    // GitHub ignores commitHeadline/commitBody for REBASE — they pass through as null
    // because the config parser rejects them for rebase (no, actually the parser stores them).
    // This test documents the mutation call shape when rebase + headline are both configured.
    const config = makeConfig({
      dryRun: false,
      mergeMethod: "rebase",
      commitHeadline: "Override headline",
      commitBody: "Override body",
    });
    const prs = makeEligiblePROperations();
    const mockGraphQL = { graphql: vi.fn().mockResolvedValue({}) };

    await evaluateAutomerge({
      prs,
      ref: baseRef,
      config,
      trustedReviewers,
      graphql: mockGraphQL,
      mergeable: true,
    });

    // REBASE method — headline and body are passed through to the API as configured
    // (GitHub silently ignores them for rebase; the mutation call itself is valid)
    expect(mockGraphQL.graphql).toHaveBeenCalledWith(
      expect.stringContaining("enablePullRequestAutoMerge"),
      expect.objectContaining({
        mergeMethod: "REBASE",
        commitHeadline: "Override headline",
        commitBody: "Override body",
      })
    );
  });
});
