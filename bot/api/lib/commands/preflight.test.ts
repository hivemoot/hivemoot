import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeCommand, type CommandContext } from "./handlers.js";
import { LABELS } from "../../config.js";

/**
 * Tests for the /preflight command handler.
 *
 * The /preflight command:
 * - Only works on PRs (rejects on issues)
 * - Runs the shared preflight checklist (same checks as merge-ready)
 * - Posts a readiness report with checklist + commit message
 * - Generates LLM commit message only when all hard checks pass
 */

// All vi.mock() factories are hoisted — values must be inlined, not referenced.

vi.mock("../index.js", () => ({
  createIssueOperations: vi.fn(() => ({})),
  createGovernanceService: vi.fn(() => ({})),
  createPROperations: vi.fn(() => ({
    get: vi.fn().mockResolvedValue({ number: 42, author: "contributor" }),
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
        message: { subject: "Add feature X", body: "Implements the feature for solving problem Y." },
      }),
    };
  }),
  formatCommitMessage: vi.fn().mockReturnValue("Add feature X\n\nImplements the feature for solving problem Y.\n\nPR: #42"),
}));

function createMockOctokit(permission = "admin") {
  return {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({
          data: { permission },
        }),
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
          data: { title: "Add feature X", body: "PR description" },
        }),
        listCommits: vi.fn().mockResolvedValue({
          data: [{ commit: { message: "initial commit" } }],
        }),
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
    verb: "preflight",
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

describe("/preflight command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should reject /preflight on an issue", async () => {
    const ctx = createPRCtx({ isPullRequest: false });
    const result = await executeCommand(ctx);

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain("pull requests");
    }
  });

  it("should execute successfully on a PR", async () => {
    const ctx = createPRCtx();
    const result = await executeCommand(ctx);

    expect(result).toEqual({ status: "executed", message: "Preflight report posted." });
  });

  it("should post a comment with checklist and commit message", async () => {
    const ctx = createPRCtx();
    await executeCommand(ctx);

    const commentCalls = ctx.octokit.rest.issues.createComment.mock.calls;
    expect(commentCalls).toHaveLength(1);

    const body = (commentCalls[0][0] as { body: string }).body;
    expect(body).toContain("Preflight Check");
    expect(body).toContain("Approved by trusted reviewers");
    expect(body).toContain("No merge conflicts");
    expect(body).toContain("CI checks passing");
    expect(body).toContain("Proposed Commit Message");
    expect(body).toContain("Add feature X");
    expect(body).toContain("Hivemoot Queen");
  });

  it("should add eyes and +1 reactions on success", async () => {
    const ctx = createPRCtx();
    await executeCommand(ctx);

    const reactionCalls = ctx.octokit.rest.reactions.createForIssueComment.mock.calls;
    expect(reactionCalls.length).toBeGreaterThanOrEqual(2);
    expect((reactionCalls[0][0] as { content: string }).content).toBe("eyes");
    expect((reactionCalls[1][0] as { content: string }).content).toBe("+1");
  });

  it("should show advisory checks with advisory tag", async () => {
    const ctx = createPRCtx();
    await executeCommand(ctx);

    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("advisory");
    expect(body).toContain("Implementation label");
    expect(body).toContain("Merge-ready label");
  });

  it("should show ready-for-merge summary when all hard checks pass", async () => {
    const ctx = createPRCtx();
    await executeCommand(ctx);

    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("3/3 hard checks passed");
    expect(body).toContain("ready for merge");
  });

  it("should not generate commit message when hard checks fail", async () => {
    const { evaluatePreflightChecks } = await import("../merge-readiness.js");
    vi.mocked(evaluatePreflightChecks).mockResolvedValueOnce({
      checks: [
        { name: "Approved by trusted reviewers", passed: false, severity: "hard", detail: "0/1 trusted approvals" },
        { name: "No merge conflicts", passed: true, severity: "hard", detail: "Branch is mergeable" },
        { name: "CI checks passing", passed: true, severity: "hard", detail: "All 3 check(s) passed" },
        { name: "Implementation label", passed: true, severity: "advisory", detail: "Has label" },
        { name: "Merge-ready label", passed: false, severity: "advisory", detail: "Missing label" },
      ],
      allHardChecksPassed: false,
    });

    const ctx = createPRCtx();
    await executeCommand(ctx);

    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("resolve failing hard checks first");
    expect(body).not.toContain("Proposed Commit Message");
    expect(body).toContain("2/3 hard checks passed");
    expect(body).toContain("Review the failing checks");
  });

  it("should show a generic warning when commit message generation fails", async () => {
    const { CommitMessageGenerator } = await import("../llm/commit-message.js");
    vi.mocked(CommitMessageGenerator).mockImplementationOnce(
      function () {
        return {
          generate: vi.fn().mockResolvedValue({
            success: false,
            reason: "No object generated: could not parse the response.",
            kind: "generation_failed",
          }),
        };
      } as any
    );

    const ctx = createPRCtx();
    await executeCommand(ctx);

    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("### Commit Message");
    expect(body).toContain("[warning] I couldn't generate a recommended commit message this time.");
    expect(body).not.toContain("No object generated");
    expect(body).not.toContain("could not parse the response");
  });

  it("should omit commit message section when LLM is not configured", async () => {
    const { CommitMessageGenerator } = await import("../llm/commit-message.js");
    vi.mocked(CommitMessageGenerator).mockImplementationOnce(
      function () {
        return {
          generate: vi.fn().mockResolvedValue({
            success: false,
            reason: "LLM not configured",
            kind: "not_configured",
          }),
        };
      } as any
    );

    const ctx = createPRCtx();
    await executeCommand(ctx);

    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).not.toContain("### Commit Message");
    expect(body).not.toContain("Proposed Commit Message");
    expect(body).not.toContain("LLM not configured");
    expect(ctx.log.info).toHaveBeenCalledWith(
      "Commit message generation skipped: LLM not configured"
    );
  });

  it("should show generic warning when commit message generator throws", async () => {
    const { CommitMessageGenerator } = await import("../llm/commit-message.js");
    vi.mocked(CommitMessageGenerator).mockImplementationOnce(
      function () {
        return {
          generate: vi.fn().mockRejectedValue(new Error("provider timeout")),
        };
      } as any
    );

    const ctx = createPRCtx();
    await executeCommand(ctx);

    const body = (ctx.octokit.rest.issues.createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("### Commit Message");
    expect(body).toContain("[warning] I couldn't generate a recommended commit message this time.");
    expect(body).not.toContain("provider timeout");
  });
});
