import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    getLinkedIssues: vi.fn(),
    createIssueOperations: vi.fn(),
    createPROperations: vi.fn(),
    loadRepositoryConfig: vi.fn(),
    processImplementationIntake: vi.fn(),
    issuesOps: {
      comment: vi.fn(),
    },
    prOps: {},
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

vi.mock("../../lib/graphql-queries.js", () => ({
  getLinkedIssues: mocks.getLinkedIssues,
}));

vi.mock("../../lib/index.js", () => ({
  createIssueOperations: mocks.createIssueOperations,
  createPROperations: mocks.createPROperations,
  createRepositoryLabelService: vi.fn(),
  createGovernanceService: vi.fn(),
  loadRepositoryConfig: mocks.loadRepositoryConfig,
  getOpenPRsForIssue: vi.fn(),
  evaluateMergeReadiness: vi.fn(),
  evaluateAutomerge: vi.fn(),
}));

vi.mock("../../lib/implementation-intake.js", () => ({
  processImplementationIntake: mocks.processImplementationIntake,
  recalculateLeaderboardForPR: vi.fn(),
}));

import { app as registerWebhookApp } from "./index.js";

type WebhookHandler = (context: unknown) => Promise<void> | void;

function createWebhookHarness() {
  const handlers = new Map<string, WebhookHandler>();
  const probotApp = {
    log: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
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

function createContext(body: string | null, options?: { baseRef?: string; defaultBranch?: string }) {
  return {
    payload: {
      pull_request: {
        number: 49,
        body,
        base: { ref: options?.baseRef ?? "main" },
      },
      repository: {
        owner: { login: "hivemoot" },
        name: "hivemoot-bot",
        full_name: "hivemoot/hivemoot-bot",
        default_branch: options?.defaultBranch ?? "main",
      },
    },
    octokit: { graphql: vi.fn() },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe("pull_request.opened linked issue resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createIssueOperations.mockReturnValue(mocks.issuesOps);
    mocks.createPROperations.mockReturnValue(mocks.prOps);
    mocks.loadRepositoryConfig.mockResolvedValue({
      governance: {
        pr: {
          maxPRsPerIssue: 3,
          trustedReviewers: [],
          intake: {},
        },
      },
    });
  });

  it("posts no-linked warning when no closing keyword is present", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.opened");
    expect(handler).toBeDefined();

    mocks.getLinkedIssues.mockResolvedValue([]);

    await handler!(createContext("Related to #21"));

    expect(mocks.getLinkedIssues).toHaveBeenCalledTimes(1);
    expect(mocks.issuesOps.comment).toHaveBeenCalledTimes(1);
    expect(mocks.processImplementationIntake).toHaveBeenCalledTimes(1);
  });

  it("retries once when closing keywords are present and initial lookup is empty", async () => {
    vi.useFakeTimers();
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.opened");
    expect(handler).toBeDefined();

    const linkedIssue = {
      number: 21,
      title: "Issue",
      state: "OPEN",
      labels: { nodes: [] },
    };
    mocks.getLinkedIssues
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([linkedIssue]);

    const context = createContext("Fixes #21");
    const handlerPromise = handler!(context);
    await vi.advanceTimersByTimeAsync(2000);
    await handlerPromise;
    vi.useRealTimers();

    expect(mocks.getLinkedIssues).toHaveBeenCalledTimes(2);
    expect(mocks.issuesOps.comment).not.toHaveBeenCalled();
    expect(mocks.processImplementationIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        linkedIssues: [linkedIssue],
      })
    );
  });

  it("suppresses no-linked warning when retry remains empty with closing keyword", async () => {
    vi.useFakeTimers();
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.opened");
    expect(handler).toBeDefined();

    mocks.getLinkedIssues.mockResolvedValue([]);

    const context = createContext("Resolves #21");
    const handlerPromise = handler!(context);
    await vi.advanceTimersByTimeAsync(2000);
    await handlerPromise;
    vi.useRealTimers();

    expect(mocks.getLinkedIssues).toHaveBeenCalledTimes(2);
    expect(mocks.issuesOps.comment).not.toHaveBeenCalled();
    expect(context.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pr: 49, resolutionSource: "heuristic-suppressed" }),
      expect.stringContaining("suppressing warning")
    );
    expect(mocks.processImplementationIntake).toHaveBeenCalledTimes(1);
  });

  it("retries when closing keyword uses colon syntax", async () => {
    vi.useFakeTimers();
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.opened");
    expect(handler).toBeDefined();

    const linkedIssue = {
      number: 21,
      title: "Issue",
      state: "OPEN",
      labels: { nodes: [] },
    };
    mocks.getLinkedIssues
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([linkedIssue]);

    const context = createContext("Closes: #21");
    const handlerPromise = handler!(context);
    await vi.advanceTimersByTimeAsync(2000);
    await handlerPromise;
    vi.useRealTimers();

    expect(mocks.getLinkedIssues).toHaveBeenCalledTimes(2);
    expect(mocks.issuesOps.comment).not.toHaveBeenCalled();
    expect(context.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ pr: 49, resolutionSource: "retry" }),
      expect.stringContaining("Resolved linked issues")
    );
    expect(mocks.processImplementationIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        linkedIssues: [linkedIssue],
      })
    );
  });

  it("treats equivalent closing-keyword body variants consistently", async () => {
    vi.useFakeTimers();
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.opened");
    expect(handler).toBeDefined();

    const linkedIssue = {
      number: 21,
      title: "Issue",
      state: "OPEN",
      labels: { nodes: [] },
    };

    const equivalentBodies = ["Fixes #21", "This implements the fix.\n\nFixes #21"];
    for (const body of equivalentBodies) {
      mocks.getLinkedIssues.mockReset();
      mocks.issuesOps.comment.mockReset();
      mocks.processImplementationIntake.mockReset();

      mocks.getLinkedIssues
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([linkedIssue]);

      const context = createContext(body);
      const handlerPromise = handler!(context);
      await vi.advanceTimersByTimeAsync(2000);
      await handlerPromise;

      expect(mocks.getLinkedIssues).toHaveBeenCalledTimes(2);
      expect(mocks.issuesOps.comment).not.toHaveBeenCalled();
      expect(context.log.info).toHaveBeenCalledWith(
        expect.objectContaining({ pr: 49, resolutionSource: "retry" }),
        expect.stringContaining("Resolved linked issues")
      );
      expect(mocks.processImplementationIntake).toHaveBeenCalledWith(
        expect.objectContaining({
          linkedIssues: [linkedIssue],
        })
      );
    }

    vi.useRealTimers();
  });

  it("treats immediate and retry resolution paths consistently for equivalent bodies", async () => {
    vi.useFakeTimers();
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.opened");
    expect(handler).toBeDefined();

    const linkedIssue = {
      number: 21,
      title: "Issue",
      state: "OPEN",
      labels: { nodes: [] },
    };

    const equivalentBodies = ["Fixes #21", "This implements #21.\n\nFixes #21"];

    for (const [index, body] of equivalentBodies.entries()) {
      mocks.getLinkedIssues.mockReset();
      mocks.issuesOps.comment.mockReset();
      mocks.processImplementationIntake.mockClear();

      if (index === 0) {
        mocks.getLinkedIssues.mockResolvedValueOnce([linkedIssue]);
      } else {
        mocks.getLinkedIssues
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([linkedIssue]);
      }

      const context = createContext(body);
      const handlerPromise = handler!(context);
      await vi.advanceTimersByTimeAsync(2000);
      await handlerPromise;

      const expectedCalls = index === 0 ? 1 : 2;
      const expectedSource = index === 0 ? "initial" : "retry";

      expect(mocks.getLinkedIssues).toHaveBeenCalledTimes(expectedCalls);
      expect(mocks.issuesOps.comment).not.toHaveBeenCalled();
      expect(context.log.info).toHaveBeenCalledWith(
        expect.objectContaining({ pr: 49, resolutionSource: expectedSource }),
        expect.stringContaining("Resolved linked issues")
      );
      expect(mocks.processImplementationIntake).toHaveBeenCalledWith(
        expect.objectContaining({
          linkedIssues: [linkedIssue],
        })
      );
    }

    vi.useRealTimers();
  });

  it("skips intake for PRs targeting non-default branch", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.opened");
    expect(handler).toBeDefined();

    const context = createContext("Fixes #21", {
      baseRef: "feat/commands",
      defaultBranch: "main",
    });

    await handler!(context);

    expect(mocks.getLinkedIssues).not.toHaveBeenCalled();
    expect(mocks.issuesOps.comment).not.toHaveBeenCalled();
    expect(mocks.processImplementationIntake).not.toHaveBeenCalled();
    expect(context.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ pr: 49, base: "feat/commands" }),
      expect.stringContaining("non-default branch")
    );
  });

  it("processes intake normally when PR targets default branch", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.opened");
    expect(handler).toBeDefined();

    mocks.getLinkedIssues.mockResolvedValue([]);

    const context = createContext("Related to #21", {
      baseRef: "main",
      defaultBranch: "main",
    });

    await handler!(context);

    expect(mocks.getLinkedIssues).toHaveBeenCalledTimes(1);
    expect(mocks.processImplementationIntake).toHaveBeenCalledTimes(1);
  });
});

describe("pull_request.synchronize non-default branch skip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createIssueOperations.mockReturnValue(mocks.issuesOps);
    mocks.createPROperations.mockReturnValue(mocks.prOps);
    mocks.loadRepositoryConfig.mockResolvedValue({
      governance: {
        pr: {
          maxPRsPerIssue: 3,
          trustedReviewers: [],
          intake: {},
        },
      },
    });
  });

  it("skips intake for synchronize on non-default branch", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.synchronize");
    expect(handler).toBeDefined();

    const context = {
      payload: {
        pull_request: {
          number: 50,
          base: { ref: "feat/commands" },
        },
        repository: {
          owner: { login: "hivemoot" },
          name: "hivemoot-bot",
          full_name: "hivemoot/hivemoot-bot",
          default_branch: "main",
        },
      },
      octokit: { graphql: vi.fn() },
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    };

    await handler!(context);

    expect(mocks.getLinkedIssues).not.toHaveBeenCalled();
    expect(mocks.processImplementationIntake).not.toHaveBeenCalled();
    expect(context.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ pr: 50, base: "feat/commands" }),
      expect.stringContaining("non-default branch")
    );
  });
});

describe("pull_request.edited non-default branch skip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createIssueOperations.mockReturnValue(mocks.issuesOps);
    mocks.createPROperations.mockReturnValue(mocks.prOps);
    mocks.loadRepositoryConfig.mockResolvedValue({
      governance: {
        pr: {
          maxPRsPerIssue: 3,
          trustedReviewers: [],
          intake: {},
        },
      },
    });
  });

  it("skips intake for edited PR on non-default branch", async () => {
    const { handlers } = createWebhookHarness();
    const handler = handlers.get("pull_request.edited");
    expect(handler).toBeDefined();

    const context = {
      payload: {
        changes: { body: { from: "old body" } },
        pull_request: {
          number: 51,
          body: "Fixes #21",
          base: { ref: "feat/commands" },
          updated_at: "2026-02-14T12:00:00Z",
        },
        repository: {
          owner: { login: "hivemoot" },
          name: "hivemoot-bot",
          full_name: "hivemoot/hivemoot-bot",
          default_branch: "main",
        },
      },
      octokit: { graphql: vi.fn() },
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    };

    await handler!(context);

    expect(mocks.getLinkedIssues).not.toHaveBeenCalled();
    expect(mocks.processImplementationIntake).not.toHaveBeenCalled();
  });
});
