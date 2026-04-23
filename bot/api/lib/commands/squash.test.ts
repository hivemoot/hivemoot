import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeCommand, retryQueuedSquash, type CommandContext } from "./handlers.js";
import { LABELS } from "../../config.js";

const DEFAULT_PREFLIGHT = {
  checks: [
    { name: "PR is open", passed: true, severity: "hard", detail: "PR is open" },
    { name: "Approved by trusted reviewers", passed: true, severity: "hard", detail: "1/1 trusted approvals (alice)" },
    { name: "No merge conflicts", passed: true, severity: "hard", detail: "Branch is mergeable" },
    { name: "CI checks passing", passed: true, severity: "hard", detail: "All 3 check(s) passed" },
    { name: "Implementation label", passed: true, severity: "advisory", detail: "Has `hivemoot:candidate` label" },
    { name: "Merge-ready label", passed: true, severity: "advisory", detail: "Has `hivemoot:merge-ready` label" },
  ],
  allHardChecksPassed: true,
} as const;

vi.mock("../index.js", () => ({
  createIssueOperations: vi.fn(() => ({})),
  createGovernanceService: vi.fn(() => ({})),
  createPROperations: vi.fn(() => ({
    get: vi.fn().mockResolvedValue({ number: 42, state: "open", merged: false, headSha: "abc123", mergeable: true }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
  })),
  loadRepositoryConfig: vi.fn().mockResolvedValue({
    governance: {
      pr: {
        mergeReady: { minApprovals: 1 },
        trustedReviewers: ["alice"],
        staleDays: 3,
        maxPRsPerIssue: 3,
        intake: [],
      },
      proposals: {
        discussion: { exits: [], durationMs: 86400000 },
        voting: { exits: [], durationMs: 86400000 },
        extendedVoting: { exits: [], durationMs: 86400000 },
      },
    },
    version: 1,
    standup: { enabled: false },
  }),
}));

vi.mock("../merge-readiness.js", () => ({
  evaluatePreflightChecks: vi.fn().mockResolvedValue({
    checks: [
      { name: "PR is open", passed: true, severity: "hard", detail: "PR is open" },
      { name: "Approved by trusted reviewers", passed: true, severity: "hard", detail: "1/1 trusted approvals (alice)" },
      { name: "No merge conflicts", passed: true, severity: "hard", detail: "Branch is mergeable" },
      { name: "CI checks passing", passed: true, severity: "hard", detail: "All 3 check(s) passed" },
      { name: "Implementation label", passed: true, severity: "advisory", detail: "Has `hivemoot:candidate` label" },
      { name: "Merge-ready label", passed: true, severity: "advisory", detail: "Has `hivemoot:merge-ready` label" },
    ],
    allHardChecksPassed: true,
  }),
}));

vi.mock("../llm/commit-message.js", () => ({
  CommitMessageGenerator: vi.fn().mockImplementation(function () {
    return {
      generate: vi.fn().mockResolvedValue({
        success: true,
        message: { subject: "Add merge helper", body: "Introduces automatic squash merge after readiness checks pass." },
      }),
    };
  }),
  formatCommitMessage: vi.fn().mockReturnValue(
    "Add merge helper\n\nIntroduces automatic squash merge after readiness checks pass.\n\nPR: #42",
  ),
}));

function createMockOctokit(permission = "admin") {
  return {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({
          data: { permission },
        }),
        get: vi.fn().mockResolvedValue({ data: { allow_squash_merge: true } }),
      },
      reactions: {
        createForIssueComment: vi.fn().mockResolvedValue({}),
        listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({}),
      },
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            title: "Add merge helper",
            body: "PR description",
            mergeable_state: "clean",
            head: { sha: "abc123" },
          },
        }),
        updateBranch: vi.fn().mockResolvedValue({}),
        listCommits: vi.fn().mockResolvedValue({
          data: [{ commit: { message: "initial commit" } }],
        }),
        merge: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

function createPRCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    octokit: createMockOctokit(),
    owner: "test-org",
    repo: "test-repo",
    issueNumber: 42,
    commentId: 100,
    senderLogin: "maintainer",
    verb: "squash",
    freeText: undefined,
    issueLabels: [{ name: LABELS.IMPLEMENTATION }],
    isPullRequest: true,
    appId: 12345,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

describe("/squash command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("squash-merges a PR when all checks pass and commit message is generated", async () => {
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result).toEqual({ status: "executed", message: "Squash merge completed." });
    expect(ctx.octokit.rest.pulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: "abc123",
        merge_method: "squash",
        commit_title: "Add merge helper",
      }),
    );
    expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Squash Preflight");
    expect(body).toContain("Proposed Commit Message");
    expect(body).toContain("Squash merge completed successfully");
  });

  it("rejects /squash on issues", async () => {
    const ctx = createPRCtx({ isPullRequest: false });

    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    expect(ctx.octokit.rest.pulls.merge).not.toHaveBeenCalled();
  });

  it("rejects when PR is already closed or merged", async () => {
    const { createPROperations } = await import("../index.js");
    vi.mocked(createPROperations).mockReturnValueOnce({
      get: vi.fn().mockResolvedValue({ number: 42, state: "closed", merged: true, headSha: "abc123", mergeable: true }),
    } as any);
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    expect(ctx.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("already closed or merged");
  });

  it("rejects when squash merge is disabled for the repository", async () => {
    const octokit = createMockOctokit();
    octokit.rest.repos.get.mockResolvedValueOnce({ data: { allow_squash_merge: false } });
    const ctx = createPRCtx({ octokit });

    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    expect(octokit.rest.pulls.merge).not.toHaveBeenCalled();
    const body = (octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Squash merge is disabled");
  });

  it("blocks merge when hard preflight checks fail", async () => {
    const { evaluatePreflightChecks } = await import("../merge-readiness.js");
    vi.mocked(evaluatePreflightChecks).mockResolvedValueOnce({
      checks: [
        { name: "PR is open", passed: true, severity: "hard", detail: "PR is open" },
        { name: "Approved by trusted reviewers", passed: false, severity: "hard", detail: "0/1 trusted approvals" },
      ],
      allHardChecksPassed: false,
    } as any);
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    expect(ctx.octokit.rest.pulls.merge).not.toHaveBeenCalled();
    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Squash Preflight");
    expect(body).toContain("hard checks passed");
    expect(body).toContain("blocked");
  });

  it("queues squash when CI is the only pending hard check", async () => {
    const { createPROperations } = await import("../index.js");
    const { evaluatePreflightChecks } = await import("../merge-readiness.js");
    const mockPrs = {
      get: vi.fn().mockResolvedValue({ number: 42, state: "open", merged: false, headSha: "abc123", mergeable: true }),
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createPROperations).mockReturnValueOnce(mockPrs as any);
    vi.mocked(evaluatePreflightChecks).mockResolvedValueOnce({
      checks: [
        { name: "PR is open", passed: true, severity: "hard", detail: "PR is open" },
        { name: "Approved by trusted reviewers", passed: true, severity: "hard", detail: "1/1 trusted approvals (alice)" },
        { name: "No merge conflicts", passed: true, severity: "hard", detail: "Branch is mergeable" },
        {
          name: "CI checks passing",
          passed: false,
          severity: "hard",
          detail: "Still running: CI / build, CI / test",
          pendingTargets: ["CI / build", "CI / test"],
        },
      ],
      allHardChecksPassed: false,
    } as any);
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result).toEqual({ status: "executed", message: "Squash queued." });
    expect(mockPrs.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42 }),
      [LABELS.SQUASH_QUEUED],
    );
    expect(ctx.octokit.rest.pulls.merge).not.toHaveBeenCalled();
    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Squash queued");
    expect(body).toContain("CI / build, CI / test");
    expect(body).toContain("retry automatically");
  });

  it("fails closed when commit message generation is unavailable", async () => {
    const { CommitMessageGenerator } = await import("../llm/commit-message.js");
    vi.mocked(CommitMessageGenerator).mockImplementationOnce(
      function () {
        return {
          generate: vi.fn().mockResolvedValue({
            success: false,
            kind: "not_configured",
            reason: "LLM not configured",
          }),
        };
      } as any,
    );
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    expect(ctx.octokit.rest.pulls.merge).not.toHaveBeenCalled();
    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Commit message generation failed");
    expect(body).not.toContain("LLM not configured");
    expect(body).toContain("Retry `/squash` after the generator is healthy");
    expect(body).not.toContain("Fix commit-message generation");
  });

  it("fails closed when commit message generation throws", async () => {
    const { CommitMessageGenerator } = await import("../llm/commit-message.js");
    vi.mocked(CommitMessageGenerator).mockImplementationOnce(
      function () {
        return {
          generate: vi.fn().mockRejectedValue(new Error("upstream timeout")),
        };
      } as any,
    );
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    expect(ctx.octokit.rest.pulls.merge).not.toHaveBeenCalled();
    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Commit message generation failed");
    expect(body).toContain("Retry `/squash` after the generator is healthy");
  });

  it("queues squash when final verification is waiting on CI", async () => {
    const { evaluatePreflightChecks } = await import("../merge-readiness.js");
    vi.mocked(evaluatePreflightChecks)
      .mockResolvedValueOnce(DEFAULT_PREFLIGHT as any)
      .mockResolvedValueOnce({
        checks: [
          { name: "PR is open", passed: true, severity: "hard", detail: "PR is open" },
          {
            name: "CI checks passing",
            passed: false,
            severity: "hard",
            detail: "Still running: CI / build",
            pendingTargets: ["CI / build"],
          },
        ],
        allHardChecksPassed: false,
      } as any);
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result).toEqual({ status: "executed", message: "Squash queued." });
    expect(ctx.octokit.rest.pulls.merge).not.toHaveBeenCalled();
    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("final verification");
    expect(body).toContain("Squash queued");
  });

  it("queues squash when legacy status checks are still pending without explicit targets", async () => {
    const { evaluatePreflightChecks } = await import("../merge-readiness.js");
    vi.mocked(evaluatePreflightChecks).mockResolvedValueOnce({
      checks: [
        { name: "PR is open", passed: true, severity: "hard", detail: "PR is open" },
        { name: "Approved by trusted reviewers", passed: true, severity: "hard", detail: "1/1 trusted approvals (alice)" },
        { name: "No merge conflicts", passed: true, severity: "hard", detail: "Branch is mergeable" },
        {
          name: "CI checks passing",
          passed: false,
          severity: "hard",
          detail: "Still running: legacy status checks",
        },
      ],
      allHardChecksPassed: false,
    } as any);
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result).toEqual({ status: "executed", message: "Squash queued." });
    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Squash queued");
    expect(body).toContain("legacy status checks");
  });

  it("does not queue squash when CI is failing rather than still running", async () => {
    const { createPROperations } = await import("../index.js");
    const { evaluatePreflightChecks } = await import("../merge-readiness.js");
    const mockPrs = {
      get: vi.fn().mockResolvedValue({ number: 42, state: "open", merged: false, headSha: "abc123", mergeable: true }),
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createPROperations).mockReturnValueOnce(mockPrs as any);
    vi.mocked(evaluatePreflightChecks).mockResolvedValueOnce({
      checks: [
        { name: "PR is open", passed: true, severity: "hard", detail: "PR is open" },
        { name: "Approved by trusted reviewers", passed: true, severity: "hard", detail: "1/1 trusted approvals (alice)" },
        { name: "No merge conflicts", passed: true, severity: "hard", detail: "Branch is mergeable" },
        {
          name: "CI checks passing",
          passed: false,
          severity: "hard",
          detail: "Legacy status: failure",
        },
      ],
      allHardChecksPassed: false,
    } as any);
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    expect(mockPrs.addLabels).not.toHaveBeenCalled();
    expect(mockPrs.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42 }),
      LABELS.SQUASH_QUEUED,
    );
  });

  it("passes commit generator logger callbacks through to the command context", async () => {
    const { CommitMessageGenerator } = await import("../llm/commit-message.js");
    vi.mocked(CommitMessageGenerator).mockImplementationOnce(
      function (options: { logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void } }) {
        options.logger.info("generator info");
        options.logger.error("generator error");
        return {
          generate: vi.fn().mockResolvedValue({
            success: true,
            message: { subject: "Add merge helper", body: "Introduces automatic squash merge after readiness checks pass." },
          }),
        };
      } as any,
    );
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result).toEqual({ status: "executed", message: "Squash merge completed." });
    expect(ctx.log.info).toHaveBeenCalledWith("generator info");
    expect(ctx.log.error).toHaveBeenCalledWith("generator error");
  });

  it("refreshes a behind branch before final verification and merge", async () => {
    const octokit = createMockOctokit();
    let pullsGetCalls = 0;
    octokit.rest.pulls.get.mockImplementation(async () => {
      pullsGetCalls += 1;
      if (pullsGetCalls === 2) {
        return {
          data: {
            title: "Add merge helper",
            body: "PR description",
            mergeable_state: "behind",
            head: { sha: "abc123" },
          },
        };
      }
      if (pullsGetCalls === 3) {
        return {
          data: {
            title: "Add merge helper",
            body: "PR description",
            mergeable_state: "clean",
            head: { sha: "def456" },
          },
        };
      }
      return {
        data: {
          title: "Add merge helper",
          body: "PR description",
          mergeable_state: "clean",
          head: { sha: "abc123" },
        },
      };
    });
    const ctx = createPRCtx({ octokit });

    const result = await executeCommand(ctx);

    expect(result).toEqual({ status: "executed", message: "Squash merge completed." });
    expect(octokit.rest.pulls.updateBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 42,
        expected_head_sha: "abc123",
      }),
    );
    expect(octokit.rest.pulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: "def456",
      }),
    );
    const body = (octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Branch Refresh");
    expect(body).toContain("refreshed to `def456`");
  });

  it("blocks merge when a behind branch cannot be refreshed", async () => {
    const octokit = createMockOctokit();
    let pullsGetCalls = 0;
    octokit.rest.pulls.get.mockImplementation(async () => {
      pullsGetCalls += 1;
      if (pullsGetCalls === 2) {
        return {
          data: {
            title: "Add merge helper",
            body: "PR description",
            mergeable_state: "behind",
            head: { sha: "abc123" },
          },
        };
      }
      return {
        data: {
          title: "Add merge helper",
          body: "PR description",
          mergeable_state: "clean",
          head: { sha: "abc123" },
        },
      };
    });
    octokit.rest.pulls.updateBranch.mockRejectedValueOnce(new Error("update not allowed"));
    const ctx = createPRCtx({ octokit });

    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    expect(octokit.rest.pulls.merge).not.toHaveBeenCalled();
    const body = (octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Branch Refresh");
    expect(body).toContain("couldn't be refreshed automatically");
    expect(body).toContain("stale head");
  });

  it("blocks merge when branch refresh does not advance the head SHA", async () => {
    vi.useFakeTimers();
    const octokit = createMockOctokit();
    let pullsGetCalls = 0;
    octokit.rest.pulls.get.mockImplementation(async () => {
      pullsGetCalls += 1;
      if (pullsGetCalls === 2) {
        return {
          data: {
            title: "Add merge helper",
            body: "PR description",
            mergeable_state: "behind",
            head: { sha: "abc123" },
          },
        };
      }
      return {
        data: {
          title: "Add merge helper",
          body: "PR description",
          mergeable_state: "clean",
          head: { sha: "abc123" },
        },
      };
    });
    const ctx = createPRCtx({ octokit });

    const resultPromise = executeCommand(ctx);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.status).toBe("rejected");
    expect(octokit.rest.pulls.updateBranch).toHaveBeenCalledTimes(1);
    expect(octokit.rest.pulls.merge).not.toHaveBeenCalled();
    const body = (octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Branch Refresh");
    expect(body).toContain("head SHA did not advance");
    expect(body).toContain("stale head");
  });

  it("waits for transient mergeable_state to resolve before refreshing behind branches", async () => {
    vi.useFakeTimers();
    const octokit = createMockOctokit();
    let pullsGetCalls = 0;
    octokit.rest.pulls.get.mockImplementation(async () => {
      pullsGetCalls += 1;
      if (pullsGetCalls === 2) {
        return {
          data: {
            title: "Add merge helper",
            body: "PR description",
            mergeable_state: "unknown",
            head: { sha: "abc123" },
          },
        };
      }
      if (pullsGetCalls === 3) {
        return {
          data: {
            title: "Add merge helper",
            body: "PR description",
            mergeable_state: "behind",
            head: { sha: "abc123" },
          },
        };
      }
      if (pullsGetCalls === 4) {
        return {
          data: {
            title: "Add merge helper",
            body: "PR description",
            mergeable_state: "clean",
            head: { sha: "def456" },
          },
        };
      }
      return {
        data: {
          title: "Add merge helper",
          body: "PR description",
          mergeable_state: "clean",
          head: { sha: "abc123" },
        },
      };
    });
    const ctx = createPRCtx({ octokit });

    const resultPromise = executeCommand(ctx);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result).toEqual({ status: "executed", message: "Squash merge completed." });
    expect(octokit.rest.pulls.updateBranch).toHaveBeenCalledTimes(1);
    expect(octokit.rest.pulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: "def456",
      }),
    );
  });

  it("fails closed when mergeable_state never resolves", async () => {
    vi.useFakeTimers();
    const octokit = createMockOctokit();
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        title: "Add merge helper",
        body: "PR description",
        mergeable_state: "unknown",
        head: { sha: "abc123" },
      },
    });
    const ctx = createPRCtx({ octokit });

    const resultPromise = executeCommand(ctx);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.status).toBe("rejected");
    expect(octokit.rest.pulls.updateBranch).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.merge).not.toHaveBeenCalled();
    const body = (octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Couldn't determine mergeability state yet");
    expect(body).toContain("stale head");
  });

  it("uses PR fallback commit body when generator returns an empty body", async () => {
    const { CommitMessageGenerator } = await import("../llm/commit-message.js");
    vi.mocked(CommitMessageGenerator).mockImplementationOnce(
      function () {
        return {
          generate: vi.fn().mockResolvedValue({
            success: true,
            message: { subject: "Tighten merge command", body: "   " },
          }),
        };
      } as any,
    );
    const ctx = createPRCtx();

    const result = await executeCommand(ctx);

    expect(result).toEqual({ status: "executed", message: "Squash merge completed." });
    expect(ctx.octokit.rest.pulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: "abc123",
        commit_title: "Tighten merge command",
        commit_message: "PR: #42",
      }),
    );
  });

  it("fails closed when GitHub squash merge API returns an error", async () => {
    const octokit = createMockOctokit();
    octokit.rest.pulls.merge.mockRejectedValueOnce(new Error("merge blocked by branch protection"));
    const ctx = createPRCtx({ octokit });

    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    const body = (octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Squash merge failed due to a GitHub merge API error");
  });

  it("cancels queued retry when the PR head SHA has changed", async () => {
    const { createPROperations } = await import("../index.js");
    const headCheckPrs = {
      get: vi.fn().mockResolvedValue({ number: 42, state: "open", merged: false, headSha: "def456", mergeable: true }),
      removeLabel: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createPROperations).mockReturnValueOnce(headCheckPrs as any);
    const ctx = createPRCtx();

    await retryQueuedSquash(ctx, "abc123");

    expect(headCheckPrs.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42 }),
      LABELS.SQUASH_QUEUED,
    );
    expect(ctx.octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("posts a cancellation comment when queued retry is no longer mergeable", async () => {
    const { createPROperations } = await import("../index.js");
    const { evaluatePreflightChecks } = await import("../merge-readiness.js");
    const headCheckPrs = {
      get: vi.fn().mockResolvedValue({ number: 42, state: "open", merged: false, headSha: "abc123", mergeable: true }),
      removeLabel: vi.fn().mockResolvedValue(undefined),
    };
    const runPrs = {
      get: vi.fn().mockResolvedValue({ number: 42, state: "open", merged: false, headSha: "abc123", mergeable: true }),
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createPROperations)
      .mockReturnValueOnce(headCheckPrs as any)
      .mockReturnValueOnce(runPrs as any);
    vi.mocked(evaluatePreflightChecks).mockResolvedValueOnce({
      checks: [
        { name: "PR is open", passed: true, severity: "hard", detail: "PR is open" },
        { name: "Approved by trusted reviewers", passed: false, severity: "hard", detail: "0/1 trusted approvals" },
      ],
      allHardChecksPassed: false,
    } as any);
    const ctx = createPRCtx();

    await retryQueuedSquash(ctx, "abc123");

    expect(runPrs.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42 }),
      LABELS.SQUASH_QUEUED,
    );
    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Queued squash was cancelled");
    expect(body).toContain("Run `/squash` again after resolving the failing checks");
  });

  it("posts a cancellation comment when final verification fails after a refresh during queued retry", async () => {
    const { createPROperations } = await import("../index.js");
    const { evaluatePreflightChecks } = await import("../merge-readiness.js");
    const headCheckPrs = {
      get: vi.fn().mockResolvedValue({ number: 42, state: "open", merged: false, headSha: "abc123", mergeable: true }),
      removeLabel: vi.fn().mockResolvedValue(undefined),
    };
    const runPrs = {
      get: vi.fn().mockResolvedValue({ number: 42, state: "open", merged: false, headSha: "abc123", mergeable: true }),
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createPROperations)
      .mockReturnValueOnce(headCheckPrs as any)
      .mockReturnValueOnce(runPrs as any);
    vi.mocked(evaluatePreflightChecks)
      .mockResolvedValueOnce(DEFAULT_PREFLIGHT as any)
      .mockResolvedValueOnce({
        checks: [
          { name: "PR is open", passed: true, severity: "hard", detail: "PR is open" },
          { name: "Approved by trusted reviewers", passed: false, severity: "hard", detail: "0/1 trusted approvals" },
        ],
        allHardChecksPassed: false,
      } as any);

    const octokit = createMockOctokit();
    let pullsGetCalls = 0;
    octokit.rest.pulls.get.mockImplementation(async () => {
      pullsGetCalls += 1;
      if (pullsGetCalls === 2) {
        return {
          data: {
            title: "Add merge helper",
            body: "PR description",
            mergeable_state: "behind",
            head: { sha: "abc123" },
          },
        };
      }
      if (pullsGetCalls === 3) {
        return {
          data: {
            title: "Add merge helper",
            body: "PR description",
            mergeable_state: "clean",
            head: { sha: "def456" },
          },
        };
      }
      return {
        data: {
          title: "Add merge helper",
          body: "PR description",
          mergeable_state: "clean",
          head: { sha: "abc123" },
        },
      };
    });
    const ctx = createPRCtx({ octokit });

    await retryQueuedSquash(ctx, "abc123");

    expect(runPrs.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42 }),
      LABELS.SQUASH_QUEUED,
    );
    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("Checks changed while processing");
    expect(body).toContain("Queued squash was cancelled");
  });
});
