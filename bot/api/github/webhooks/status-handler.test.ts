import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    createPROperations: vi.fn(),
    loadRepositoryConfig: vi.fn(),
    evaluateMergeReadiness: vi.fn(),
    evaluateAutomerge: vi.fn(),
    retryQueuedSquash: vi.fn(),
  };
});

vi.mock("probot", () => ({
  createProbot: vi.fn(() => ({})),
  createNodeMiddleware: vi.fn(() => vi.fn()),
}));

vi.mock("../../lib/env-validation.js", () => ({
  validateEnv: vi.fn(() => ({ valid: true, missing: [] })),
  getAppId: vi.fn(() => 12345),
}));

vi.mock("../../lib/index.js", () => ({
  createIssueOperations: vi.fn(),
  createPROperations: mocks.createPROperations,
  createRepositoryLabelService: vi.fn(),
  createGovernanceService: vi.fn(),
  loadRepositoryConfig: mocks.loadRepositoryConfig,
  getOpenPRsForIssue: vi.fn(),
  evaluateMergeReadiness: mocks.evaluateMergeReadiness,
  evaluateAutomerge: mocks.evaluateAutomerge,
}));

vi.mock("../../lib/graphql-queries.js", () => ({
  getLinkedIssues: vi.fn(),
}));

vi.mock("../../lib/implementation-intake.js", () => ({
  processImplementationIntake: vi.fn(),
  recalculateLeaderboardForPR: vi.fn(),
}));

vi.mock("../../lib/commands/index.js", () => ({
  parseCommand: vi.fn(),
  executeCommand: vi.fn(),
  retryQueuedSquash: mocks.retryQueuedSquash,
}));

import { app as registerWebhookApp } from "./index.js";

type WebhookHandler = (context: unknown) => Promise<void> | void;

function createWebhookHarness() {
  const handlers = new Map<string, WebhookHandler>();
  const probotApp = {
    log: {
      info: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn((event: string | string[], handler: WebhookHandler) => {
      if (Array.isArray(event)) {
        for (const entry of event) {
          handlers.set(entry, handler);
        }
        return;
      }
      handlers.set(event, handler);
    }),
  };

  registerWebhookApp(probotApp as any);
  return { handlers };
}

function createStatusContext(options?: {
  sha?: string;
  pullRequests?: Array<{ number: number; head: { sha: string } }>;
}) {
  const sha = options?.sha ?? "abc123";
  const pullRequests = options?.pullRequests ?? [];

  return {
    payload: {
      sha,
      repository: {
        owner: { login: "hivemoot" },
        name: "hivemoot-bot",
        full_name: "hivemoot/hivemoot-bot",
      },
    },
    octokit: {
      rest: {
        pulls: {
          list: vi.fn().mockResolvedValue({ data: pullRequests }),
        },
      },
    },
    log: {
      info: vi.fn(),
      error: vi.fn(),
    },
  };
}

function createCheckContext(options?: {
  event: "check_suite.completed" | "check_run.completed";
  headSha?: string;
  pullRequests?: Array<{ number: number }>;
}) {
  const event = options?.event ?? "check_suite.completed";
  const headSha = options?.headSha ?? "abc123";
  const pullRequests = options?.pullRequests ?? [];

  return {
    payload: {
      repository: {
        owner: { login: "hivemoot" },
        name: "hivemoot-bot",
        full_name: "hivemoot/hivemoot-bot",
      },
      [event === "check_suite.completed" ? "check_suite" : "check_run"]: {
        head_sha: headSha,
        pull_requests: pullRequests,
      },
    },
    log: {
      info: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe("status webhook handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createPROperations.mockReturnValue({
      getLabels: vi.fn().mockResolvedValue([]),
    });
    mocks.loadRepositoryConfig.mockResolvedValue({
      governance: {
        pr: {
          mergeReady: {
            requiredApprovals: 1,
          },
          trustedReviewers: ["hivemoot-builder"],
        },
      },
    });
  });

  it("skips processing when PR automation config is disabled", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("status");
    expect(handler).toBeDefined();

    mocks.loadRepositoryConfig.mockResolvedValueOnce({
      governance: {
        pr: null,
      },
    });

    const context = createStatusContext({
      pullRequests: [{ number: 11, head: { sha: "abc123" } }],
    });

    await handler!(context);

    expect(context.octokit.rest.pulls.list).not.toHaveBeenCalled();
    expect(mocks.evaluateMergeReadiness).not.toHaveBeenCalled();
  });

  it("evaluates merge-readiness only for pull requests matching the status SHA", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("status");
    expect(handler).toBeDefined();

    const context = createStatusContext({
      sha: "abc123",
      pullRequests: [
        { number: 11, head: { sha: "abc123" } },
        { number: 12, head: { sha: "def456" } },
        { number: 13, head: { sha: "abc123" } },
      ],
    });

    await handler!(context);

    expect(context.octokit.rest.pulls.list).toHaveBeenCalledWith({
      owner: "hivemoot",
      repo: "hivemoot-bot",
      state: "open",
      sort: "updated",
      direction: "desc",
      per_page: 100,
    });
    expect(mocks.evaluateMergeReadiness).toHaveBeenCalledTimes(2);
    expect(mocks.evaluateMergeReadiness).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ref: { owner: "hivemoot", repo: "hivemoot-bot", prNumber: 11 },
        headSha: "abc123",
      })
    );
    expect(mocks.evaluateMergeReadiness).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        ref: { owner: "hivemoot", repo: "hivemoot-bot", prNumber: 13 },
        headSha: "abc123",
      })
    );
  });

  it("skips merge-readiness evaluation when no pull request matches the status SHA", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("status");
    expect(handler).toBeDefined();

    const context = createStatusContext({
      sha: "abc123",
      pullRequests: [
        { number: 11, head: { sha: "def456" } },
        { number: 12, head: { sha: "ghi789" } },
      ],
    });

    await handler!(context);

    expect(context.octokit.rest.pulls.list).toHaveBeenCalledTimes(1);
    expect(mocks.evaluateMergeReadiness).not.toHaveBeenCalled();
  });

  it("aggregates per-PR merge-readiness failures", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("status");
    expect(handler).toBeDefined();

    mocks.evaluateMergeReadiness
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("review API unavailable"));

    const context = createStatusContext({
      sha: "abc123",
      pullRequests: [
        { number: 11, head: { sha: "abc123" } },
        { number: 13, head: { sha: "abc123" } },
      ],
    });

    await expect(handler!(context)).rejects.toThrow(
      "1 PR(s) failed merge-readiness evaluation after status event"
    );

    expect(context.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        pr: 13,
        repo: "hivemoot/hivemoot-bot",
      }),
      "Failed to evaluate merge-readiness after status event"
    );
  });

  it("evaluates merge-readiness for each pull request in check_suite payload", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("check_suite.completed");
    expect(handler).toBeDefined();

    const context = createCheckContext({
      event: "check_suite.completed",
      headSha: "suite-sha",
      pullRequests: [{ number: 21 }, { number: 34 }],
    });

    await handler!(context);

    expect(mocks.evaluateMergeReadiness).toHaveBeenCalledTimes(2);
    expect(mocks.evaluateMergeReadiness).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ref: { owner: "hivemoot", repo: "hivemoot-bot", prNumber: 21 },
        headSha: "suite-sha",
      })
    );
    expect(mocks.evaluateMergeReadiness).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        ref: { owner: "hivemoot", repo: "hivemoot-bot", prNumber: 34 },
        headSha: "suite-sha",
      })
    );
  });

  it("aggregates per-PR merge-readiness failures for check_run events", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("check_run.completed");
    expect(handler).toBeDefined();

    mocks.evaluateMergeReadiness
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("check API unavailable"));

    const context = createCheckContext({
      event: "check_run.completed",
      headSha: "run-sha",
      pullRequests: [{ number: 55 }, { number: 89 }],
    });

    await expect(handler!(context)).rejects.toThrow(
      "1 PR(s) failed merge-readiness evaluation after check_run"
    );

    expect(context.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        pr: 89,
        repo: "hivemoot/hivemoot-bot",
      }),
      "Failed to evaluate merge-readiness after check_run"
    );
  });

  it("retries queued squash for pull requests carrying the squash-queued label after status events", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("status");
    expect(handler).toBeDefined();

    const getLabels = vi
      .fn()
      .mockResolvedValueOnce(["hivemoot:candidate", "hivemoot:squash-queued"])
      .mockResolvedValueOnce(["hivemoot:candidate"]);
    mocks.createPROperations.mockReturnValue({ getLabels });

    const context = createStatusContext({
      sha: "abc123",
      pullRequests: [
        { number: 11, head: { sha: "abc123" } },
        { number: 13, head: { sha: "abc123" } },
      ],
    });

    await handler!(context);

    expect(getLabels).toHaveBeenNthCalledWith(1, {
      owner: "hivemoot",
      repo: "hivemoot-bot",
      prNumber: 11,
    });
    expect(getLabels).toHaveBeenNthCalledWith(2, {
      owner: "hivemoot",
      repo: "hivemoot-bot",
      prNumber: 13,
    });
    expect(mocks.retryQueuedSquash).toHaveBeenCalledTimes(1);
    expect(mocks.retryQueuedSquash).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 11,
        issueLabels: [{ name: "hivemoot:candidate" }, { name: "hivemoot:squash-queued" }],
        isPullRequest: true,
      }),
      "abc123"
    );
  });

  it("retries queued squash for pull requests carrying the squash-queued label", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("check_run.completed");
    expect(handler).toBeDefined();

    const getLabels = vi
      .fn()
      .mockResolvedValueOnce(["hivemoot:candidate", "hivemoot:squash-queued"])
      .mockResolvedValueOnce(["hivemoot:candidate"]);
    mocks.createPROperations.mockReturnValue({ getLabels });

    const context = createCheckContext({
      event: "check_run.completed",
      headSha: "run-sha",
      pullRequests: [{ number: 55 }, { number: 89 }],
    });

    await handler!(context);

    expect(getLabels).toHaveBeenNthCalledWith(1, {
      owner: "hivemoot",
      repo: "hivemoot-bot",
      prNumber: 55,
    });
    expect(getLabels).toHaveBeenNthCalledWith(2, {
      owner: "hivemoot",
      repo: "hivemoot-bot",
      prNumber: 89,
    });
    expect(mocks.retryQueuedSquash).toHaveBeenCalledTimes(1);
    expect(mocks.retryQueuedSquash).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 55,
        issueLabels: [{ name: "hivemoot:candidate" }, { name: "hivemoot:squash-queued" }],
        isPullRequest: true,
      }),
      "run-sha"
    );
  });
});
