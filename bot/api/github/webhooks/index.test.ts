import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GraphqlResponseError } from "@octokit/graphql";
import { GovernanceService } from "../../lib/governance.js";
import { createIssueOperations } from "../../lib/github-client.js";
import { getLinkedIssues, getOpenPRsForIssue, disablePullRequestAutoMerge } from "../../lib/graphql-queries.js";
import { processImplementationIntake, recalculateLeaderboardForPR } from "../../lib/implementation-intake.js";
import { evaluateMergeReadiness, evaluateAutomerge, loadRepositoryConfig } from "../../lib/index.js";
import { maybeCreatePrReviewRoom, maybeEmitSubjectUpdated } from "../../lib/war-room-routing.js";
import { LABELS, MESSAGES, REQUIRED_REPOSITORY_LABELS } from "../../config.js";
import type { IssueRef } from "../../lib/types.js";
import type { IncomingMessage, ServerResponse } from "http";
import { app as registerWebhookApp } from "./index.js";

// Mock probot to prevent actual initialization
vi.mock("../../lib/war-room-routing.js", () => ({
  maybeCreatePrReviewRoom: vi.fn(async () => ({ roomId: null })),
  maybeEmitSubjectUpdated: vi.fn(async () => ({ sequence: null })),
  maybeCreateMentionRoom: vi.fn(async () => ({ roomId: null })),
  commentHasHivemootMention: () => false,
  derivePrRoomId: ({ owner, repo, prNumber }) => `derived-${owner}-${repo}-${prNumber}`,
  deriveMentionRoomId: ({ owner, repo, issueOrPrNumber, commentId }) => `derived-mention-${owner}-${repo}-${issueOrPrNumber}-${commentId}`,
}));

vi.mock("probot", () => ({
  createProbot: vi.fn(() => ({})),
  createNodeMiddleware: vi.fn(() => vi.fn()),
}));

// Mock env-validation
vi.mock("../../lib/env-validation.js", () => ({
  validateEnv: vi.fn(() => ({ valid: true, missing: [] })),
  getAppId: vi.fn(() => 12345),
}));

// Mock LLM provider
vi.mock("../../lib/llm/provider.js", () => ({
  getLLMReadiness: vi.fn(() => ({ ready: true })),
}));

vi.mock("../../lib/graphql-queries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/graphql-queries.js")>();
  return {
    ...actual,
    getLinkedIssues: vi.fn().mockResolvedValue([]),
    getOpenPRsForIssue: vi.fn().mockResolvedValue([]),
    disablePullRequestAutoMerge: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../lib/implementation-intake.js", () => ({
  processImplementationIntake: vi.fn().mockResolvedValue(undefined),
  recalculateLeaderboardForPR: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/index.js")>("../../lib/index.js");
  return {
    ...actual,
    loadRepositoryConfig: vi.fn().mockResolvedValue({
      governance: {
        proposals: {
          discussion: {
            exits: [{ type: "manual" }],
            durationMs: 0,
            autoGather: { enabled: false, minNewComments: 5, cooldownMinutes: 60 },
          },
        },
        pr: {
          maxPRsPerIssue: 3,
          trustedReviewers: [],
          intake: {},
          mergeReady: {},
          automerge: null,
        },
      },
    }),
    evaluateMergeReadiness: vi.fn().mockResolvedValue(undefined),
    evaluateAutomerge: vi.fn().mockResolvedValue(undefined),
  };
});

/**
 * Tests for Queen Bot webhook handlers
 *
 * These tests verify:
 * 1. GovernanceService integration for issue handling
 * 2. Health check endpoint behavior with configuration validation
 * 3. Error handling propagation
 */

const TEST_APP_ID = 12345;

type WebhookHandler = (context: unknown) => Promise<void> | void;

function buildIterator<T>(pages: T[][]): AsyncIterable<{ data: T[] }> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const page of pages) {
        yield { data: page };
      }
    },
  };
}

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

function createInstallationOctokit(options?: {
  existingLabels?: Array<{ name: string; color?: string; description?: string | null }>;
  fallbackRepositories?: Array<{ name: string; full_name: string; owner?: { login?: string } | null }>;
  fallbackRepositoryPages?: Array<Array<{ name: string; full_name: string; owner?: { login?: string } | null }>>;
  createLabelImpl?: (params: {
    owner: string;
    repo: string;
    name: string;
    color: string;
    description?: string;
  }) => Promise<unknown>;
}) {
  const existingLabels = options?.existingLabels ?? [];
  const fallbackRepositories = options?.fallbackRepositories ?? [];
  const fallbackRepositoryPages = options?.fallbackRepositoryPages ?? [fallbackRepositories];
  const createLabelImpl = options?.createLabelImpl ?? (async () => ({}));

  const rest = {
    issues: {
      listLabelsForRepo: vi.fn(),
      createLabel: vi.fn().mockImplementation(createLabelImpl),
      updateLabel: vi.fn().mockResolvedValue({}),
    },
    apps: {
      listReposAccessibleToInstallation: vi.fn().mockImplementation(async ({ page = 1 }: {
        per_page?: number;
        page?: number;
      }) => ({
        data: {
          repositories: fallbackRepositoryPages[page - 1] ?? [],
        },
      })),
    },
  };

  return {
    rest,
    paginate: {
      iterator: vi.fn().mockImplementation((method: unknown) => {
        if (method === rest.issues.listLabelsForRepo) {
          return buildIterator([existingLabels]);
        }
        return buildIterator([[]]);
      }),
    },
  };
}

describe("Queen Bot", () => {
  describe("Installation label bootstrap handlers", () => {
    it("should bootstrap labels from installation.created payload repositories", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("installation.created");
      expect(handler).toBeDefined();

      const octokit = createInstallationOctokit();
      const log = {
        info: vi.fn(),
        error: vi.fn(),
      };
      await handler!({
        octokit,
        log,
        payload: {
          repositories: [
            {
              owner: { login: "hivemoot" },
              name: "repo-a",
              full_name: "hivemoot/repo-a",
            },
          ],
        },
      });

      expect(octokit.rest.apps.listReposAccessibleToInstallation).not.toHaveBeenCalled();
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledTimes(REQUIRED_REPOSITORY_LABELS.length);
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "hivemoot",
          repo: "repo-a",
        })
      );
      expect(log.info).toHaveBeenCalledWith(
        `[installation.created] Label bootstrap summary: reposProcessed=1, reposFailed=0, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length}, labelsRenamed=0, labelsUpdated=0, labelsSkipped=0`
      );
    });

    it("should update labels with drifted colors during bootstrap", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("installation.created");
      expect(handler).toBeDefined();

      // One label exists with wrong color (gray default from auto-creation)
      const driftedLabel = {
        name: REQUIRED_REPOSITORY_LABELS[0].name,
        color: "ededed",
        description: REQUIRED_REPOSITORY_LABELS[0].description ?? null,
      };
      const octokit = createInstallationOctokit({
        existingLabels: [driftedLabel],
      });
      const log = {
        info: vi.fn(),
        error: vi.fn(),
      };
      await handler!({
        octokit,
        log,
        payload: {
          repositories: [
            {
              owner: { login: "hivemoot" },
              name: "repo-drift",
              full_name: "hivemoot/repo-drift",
            },
          ],
        },
      });

      // The drifted label should be updated, the rest created
      expect(octokit.rest.issues.updateLabel).toHaveBeenCalledTimes(1);
      expect(octokit.rest.issues.updateLabel).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "hivemoot",
          repo: "repo-drift",
          name: driftedLabel.name,
          color: REQUIRED_REPOSITORY_LABELS[0].color,
        })
      );
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledTimes(REQUIRED_REPOSITORY_LABELS.length - 1);
      expect(log.info).toHaveBeenCalledWith(
        `[installation.created] Label bootstrap summary: reposProcessed=1, reposFailed=0, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length - 1}, labelsRenamed=0, labelsUpdated=1, labelsSkipped=0`
      );
    });

    it("should bootstrap labels from installation_repositories.added payload repositories", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("installation_repositories.added");
      expect(handler).toBeDefined();

      const octokit = createInstallationOctokit();
      const log = {
        info: vi.fn(),
        error: vi.fn(),
      };
      await handler!({
        octokit,
        log,
        payload: {
          repositories_added: [
            {
              name: "repo-b",
              full_name: "hivemoot/repo-b",
            },
          ],
        },
      });

      expect(octokit.rest.apps.listReposAccessibleToInstallation).not.toHaveBeenCalled();
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledTimes(REQUIRED_REPOSITORY_LABELS.length);
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "hivemoot",
          repo: "repo-b",
        })
      );
      expect(log.info).toHaveBeenCalledWith(
        `[installation_repositories.added] Label bootstrap summary: reposProcessed=1, reposFailed=0, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length}, labelsRenamed=0, labelsUpdated=0, labelsSkipped=0`
      );
    });

    it("should fetch installation repositories when installation.created payload omits repositories", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("installation.created");
      expect(handler).toBeDefined();

      const fallbackRepositories = [
        { name: "repo-c", full_name: "hivemoot/repo-c" },
        { name: "repo-d", full_name: "hivemoot/repo-d" },
      ];
      const octokit = createInstallationOctokit({ fallbackRepositories });
      const log = {
        info: vi.fn(),
        error: vi.fn(),
      };

      await handler!({
        octokit,
        log,
        payload: {},
      });

      expect(octokit.rest.apps.listReposAccessibleToInstallation).toHaveBeenCalledWith({
        per_page: 100,
        page: 1,
      });
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledTimes(
        REQUIRED_REPOSITORY_LABELS.length * fallbackRepositories.length
      );
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ repo: "repo-c" })
      );
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ repo: "repo-d" })
      );
      expect(log.info).toHaveBeenCalledWith(
        `[installation.created] Label bootstrap summary: reposProcessed=2, reposFailed=0, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length * fallbackRepositories.length}, labelsRenamed=0, labelsUpdated=0, labelsSkipped=0`
      );
    });

    it("should paginate installation repository fallback listing beyond first page", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("installation.created");
      expect(handler).toBeDefined();

      const pageOneRepositories = Array.from({ length: 100 }, (_, index) => ({
        name: `repo-${index + 1}`,
        full_name: `hivemoot/repo-${index + 1}`,
      }));
      const pageTwoRepositories = [{ name: "repo-101", full_name: "hivemoot/repo-101" }];
      const octokit = createInstallationOctokit({
        fallbackRepositoryPages: [pageOneRepositories, pageTwoRepositories],
      });
      const log = {
        info: vi.fn(),
        error: vi.fn(),
      };

      await handler!({
        octokit,
        log,
        payload: {},
      });

      // Label-bootstrap and onboarding each independently paginate the fallback
      // repo list. Label-bootstrap runs first (calls 1 + 2), onboarding runs
      // second (calls 3 + 4). Both handlers share the same octokit so
      // listReposAccessibleToInstallation is called 4 times total.
      expect(octokit.rest.apps.listReposAccessibleToInstallation).toHaveBeenNthCalledWith(1, {
        per_page: 100,
        page: 1,
      });
      expect(octokit.rest.apps.listReposAccessibleToInstallation).toHaveBeenNthCalledWith(2, {
        per_page: 100,
        page: 2,
      });
      expect(octokit.rest.apps.listReposAccessibleToInstallation).toHaveBeenCalledTimes(4);
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ repo: "repo-1" })
      );
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ repo: "repo-101" })
      );
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledTimes(
        REQUIRED_REPOSITORY_LABELS.length * 101
      );
      expect(log.info).toHaveBeenCalledWith(
        `[installation.created] Label bootstrap summary: reposProcessed=101, reposFailed=0, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length * 101}, labelsRenamed=0, labelsUpdated=0, labelsSkipped=0`
      );
    });

    it("should fetch installation repositories when installation_repositories.added payload is empty", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("installation_repositories.added");
      expect(handler).toBeDefined();

      const fallbackRepositories = [{ name: "repo-e", full_name: "hivemoot/repo-e" }];
      const octokit = createInstallationOctokit({ fallbackRepositories });
      const log = {
        info: vi.fn(),
        error: vi.fn(),
      };

      await handler!({
        octokit,
        log,
        payload: {
          repositories_added: [],
        },
      });

      expect(octokit.rest.apps.listReposAccessibleToInstallation).toHaveBeenCalledWith({
        per_page: 100,
        page: 1,
      });
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledTimes(
        REQUIRED_REPOSITORY_LABELS.length * fallbackRepositories.length
      );
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ repo: "repo-e" })
      );
      expect(log.info).toHaveBeenCalledWith(
        `[installation_repositories.added] Label bootstrap summary: reposProcessed=1, reposFailed=0, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length}, labelsRenamed=0, labelsUpdated=0, labelsSkipped=0`
      );
    });

    it("should log summary counters and fail when one repository bootstrap fails", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("installation.created");
      expect(handler).toBeDefined();

      const repositories = [
        { name: "repo-ok", full_name: "hivemoot/repo-ok" },
        { name: "repo-fail", full_name: "hivemoot/repo-fail" },
      ];
      const octokit = createInstallationOctokit({
        createLabelImpl: async (params) => {
          if (params.repo === "repo-fail") {
            throw new Error("boom");
          }
          return {};
        },
      });
      const log = {
        info: vi.fn(),
        error: vi.fn(),
      };

      await expect(
        handler!({
          octokit,
          log,
          payload: {
            repositories,
          },
        })
      ).rejects.toThrow("1 repository label bootstrap operation(s) failed");

      expect(log.error).toHaveBeenCalledTimes(1);
      expect(log.info).toHaveBeenCalledWith(
        `[installation.created] Label bootstrap summary: reposProcessed=2, reposFailed=1, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length}, labelsRenamed=0, labelsUpdated=0, labelsSkipped=0`
      );
    });
  });

  describe("Issue Handler via GovernanceService", () => {
    const createMockOctokit = () => ({
      rest: {
        issues: {
          get: vi.fn().mockResolvedValue({ data: { reactions: { "+1": 0, "-1": 0, confused: 0 } } }),
          addLabels: vi.fn().mockResolvedValue({}),
          removeLabel: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
          listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          lock: vi.fn().mockResolvedValue({}),
          unlock: vi.fn().mockResolvedValue({}),
        },
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
          listForIssue: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      paginate: {
        iterator: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() {
            yield { data: [] };
          },
        }),
      },
    });

    it("should add phase:discussion label and post welcome comment on new issue", async () => {
      const mockOctokit = createMockOctokit();
      const issues = createIssueOperations(mockOctokit, { appId: TEST_APP_ID });
      const governance = new GovernanceService(issues);

      const ref: IssueRef = { owner: "hivemoot", repo: "test-repo", issueNumber: 42 };
      await governance.startDiscussion(ref);

      expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
        owner: "hivemoot",
        repo: "test-repo",
        issue_number: 42,
        labels: [LABELS.DISCUSSION],
      });

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      const commentBody = mockOctokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(commentBody).toContain("hivemoot-metadata:");
      expect(commentBody).toContain('"type":"welcome"');
      expect(commentBody).toContain("Discussion Phase");
    });

    it("should propagate API errors", async () => {
      const mockOctokit = createMockOctokit();
      const apiError = new Error("GitHub API rate limited");
      mockOctokit.rest.issues.addLabels.mockRejectedValue(apiError);

      const issues = createIssueOperations(mockOctokit, { appId: TEST_APP_ID });
      const governance = new GovernanceService(issues);

      const ref: IssueRef = { owner: "hivemoot", repo: "test-repo", issueNumber: 42 };

      await expect(governance.startDiscussion(ref)).rejects.toThrow("GitHub API rate limited");
    });
  });

  describe("PR Handler", () => {
    const createMockOctokit = () => ({
      rest: {
        issues: {
          get: vi.fn().mockResolvedValue({ data: {} }),
          addLabels: vi.fn().mockResolvedValue({}),
          removeLabel: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
          listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          lock: vi.fn().mockResolvedValue({}),
          unlock: vi.fn().mockResolvedValue({}),
        },
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
          listForIssue: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      paginate: {
        iterator: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator]() {
            yield { data: [] };
          },
        }),
      },
    });

    it("should post no-linked-issue comment on unlinked PR", async () => {
      const mockOctokit = createMockOctokit();
      const issues = createIssueOperations(mockOctokit, { appId: TEST_APP_ID });

      const ref: IssueRef = { owner: "hivemoot", repo: "test-repo", issueNumber: 123 };
      await issues.comment(ref, MESSAGES.PR_NO_LINKED_ISSUE);

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: "hivemoot",
        repo: "test-repo",
        issue_number: 123,
        body: MESSAGES.PR_NO_LINKED_ISSUE,
      });
    });

    it("should propagate API errors", async () => {
      const mockOctokit = createMockOctokit();
      const apiError = new Error("Permission denied");
      mockOctokit.rest.issues.createComment.mockRejectedValue(apiError);

      const issues = createIssueOperations(mockOctokit, { appId: TEST_APP_ID });
      const ref: IssueRef = { owner: "hivemoot", repo: "test-repo", issueNumber: 123 };

      await expect(issues.comment(ref, MESSAGES.PR_NO_LINKED_ISSUE)).rejects.toThrow("Permission denied");
    });
  });

  describe("issues.labeled Handler (manual voting transition)", () => {
    /** Build a valid mock Octokit that passes createIssueOperations validation */
    const createLabeledMockOctokit = (overrides?: {
      comments?: Array<{ id: number; body: string; performed_via_github_app?: { id: number } | null }>;
    }) => {
      const comments = overrides?.comments ?? [];
      return {
        rest: {
          issues: {
            get: vi.fn().mockResolvedValue({ data: {} }),
            addLabels: vi.fn().mockResolvedValue({}),
            removeLabel: vi.fn().mockResolvedValue({}),
            createComment: vi.fn().mockResolvedValue({}),
            update: vi.fn().mockResolvedValue({}),
            lock: vi.fn().mockResolvedValue({}),
            unlock: vi.fn().mockResolvedValue({}),
            listComments: vi.fn(),
          },
          reactions: {
            listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
            listForIssue: vi.fn().mockResolvedValue({ data: [] }),
          },
        },
        paginate: {
          // Each call gets a fresh generator (generators are single-use)
          iterator: vi.fn().mockImplementation(() => ({
            async *[Symbol.asyncIterator]() {
              yield { data: comments };
            },
          })),
        },
      };
    };

    it("should register the issues.labeled handler", () => {
      const { handlers } = createWebhookHarness();
      expect(handlers.get("issues.labeled")).toBeDefined();
    });

    it("should skip non-voting labels", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issues.labeled")!;
      const mockOctokit = createLabeledMockOctokit();

      await handler({
        payload: {
          label: { name: "bug" },
          issue: { number: 42 },
          sender: { type: "User", login: "alice" },
          repository: { name: "test-repo", full_name: "hivemoot/test-repo", owner: { login: "hivemoot" } },
        },
        octokit: mockOctokit,
        log: { info: vi.fn(), error: vi.fn() },
      });

      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it("should skip Bot senders (automatic transitions)", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issues.labeled")!;
      const mockOctokit = createLabeledMockOctokit();

      await handler({
        payload: {
          label: { name: LABELS.VOTING },
          issue: { number: 42 },
          sender: { type: "Bot", login: "hivemoot-bot[bot]" },
          repository: { name: "test-repo", full_name: "hivemoot/test-repo", owner: { login: "hivemoot" } },
        },
        octokit: mockOctokit,
        log: { info: vi.fn(), error: vi.fn() },
      });

      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it("should post voting comment for manual user label addition", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issues.labeled")!;
      // No existing comments → findVotingCommentId returns null → posts new comment
      const mockOctokit = createLabeledMockOctokit();
      const log = { info: vi.fn(), error: vi.fn() };

      await handler({
        payload: {
          label: { name: LABELS.VOTING },
          issue: { number: 26 },
          sender: { type: "User", login: "hivemoot" },
          repository: { name: "sandbox", full_name: "hivemoot/sandbox", owner: { login: "hivemoot" } },
        },
        octokit: mockOctokit,
        log,
      });

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      const commentBody = mockOctokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(commentBody).toContain('"type":"voting"');
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("Voting comment for issue #26: posted"),
      );
    });

    it("should skip when voting comment already exists", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issues.labeled")!;
      const existingVotingComment = {
        id: 999,
        body: `<!-- hivemoot-metadata: ${JSON.stringify({ version: 1, type: "voting", issueNumber: 26, cycle: 1 })} -->\nVoting stuff`,
        performed_via_github_app: { id: TEST_APP_ID },
      };
      const mockOctokit = createLabeledMockOctokit({ comments: [existingVotingComment] });
      const log = { info: vi.fn(), error: vi.fn() };

      await handler({
        payload: {
          label: { name: LABELS.VOTING },
          issue: { number: 26 },
          sender: { type: "User", login: "hivemoot" },
          repository: { name: "sandbox", full_name: "hivemoot/sandbox", owner: { login: "hivemoot" } },
        },
        octokit: mockOctokit,
        log,
      });

      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("Voting comment for issue #26: skipped"),
      );
    });

    it("should propagate errors from postVotingComment", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issues.labeled")!;
      const mockOctokit = createLabeledMockOctokit();
      // Force createComment to fail
      mockOctokit.rest.issues.createComment.mockRejectedValue(new Error("API failure"));
      const log = { info: vi.fn(), error: vi.fn() };

      await expect(
        handler({
          payload: {
            label: { name: LABELS.VOTING },
            issue: { number: 42 },
            sender: { type: "User", login: "alice" },
            repository: { name: "test-repo", full_name: "hivemoot/test-repo", owner: { login: "hivemoot" } },
          },
          octokit: mockOctokit,
          log,
        }),
      ).rejects.toThrow("API failure");

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ issue: 42 }),
        expect.stringContaining("Failed to post voting comment"),
      );
    });
  });

  describe("issue_comment.created command dispatch", () => {
    const createCommandOctokit = (permission = "admin") => ({
      rest: {
        repos: {
          getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({
            data: { permission },
          }),
          getContent: vi.fn().mockRejectedValue({ status: 404 }),
          getCombinedStatusForRef: vi.fn().mockResolvedValue({
            data: { state: "success", total_count: 0, statuses: [] },
          }),
        },
        reactions: {
          createForIssueComment: vi.fn().mockResolvedValue({}),
          listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
          listForIssue: vi.fn().mockResolvedValue({ data: [] }),
        },
        issues: {
          get: vi.fn().mockResolvedValue({ data: { reactions: { "+1": 0, "-1": 0, confused: 0 } } }),
          addLabels: vi.fn().mockResolvedValue({}),
          removeLabel: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
          listLabelsForRepo: vi.fn().mockResolvedValue({ data: [] }),
          createLabel: vi.fn().mockResolvedValue({}),
          updateLabel: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
          lock: vi.fn().mockResolvedValue({}),
          unlock: vi.fn().mockResolvedValue({}),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
          listForRepo: vi.fn().mockResolvedValue({ data: [] }),
        },
        pulls: {
          get: vi.fn().mockResolvedValue({ data: {} }),
          update: vi.fn().mockResolvedValue({}),
          listReviews: vi.fn().mockResolvedValue({ data: [] }),
          listCommits: vi.fn().mockResolvedValue({ data: [] }),
          listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
          listFiles: vi.fn().mockResolvedValue({ data: [] }),
        },
        checks: {
          listForRef: vi.fn().mockResolvedValue({
            data: { total_count: 0, check_runs: [] },
          }),
        },
      },
      paginate: {
        iterator: vi.fn().mockImplementation(() => ({
          async *[Symbol.asyncIterator]() {
            yield { data: [] };
          },
        })),
      },
      graphql: vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            closingIssuesReferences: {
              nodes: [],
            },
          },
        },
      }),
    });

    it("should dispatch recognized @mention + /command to executeCommand", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issue_comment.created")!;
      const octokit = createCommandOctokit();
      const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

      await handler({
        octokit,
        log,
        payload: {
          issue: {
            number: 10,
            labels: [{ name: LABELS.DISCUSSION }],
          },
          comment: {
            id: 200,
            body: "@hivemoot /vote",
            user: { login: "maintainer" },
            performed_via_github_app: null,
          },
          repository: {
            name: "test-repo",
            full_name: "hivemoot/test-repo",
            owner: { login: "hivemoot" },
          },
        },
      });

      // Command was recognized and dispatched — eyes reaction is the first signal
      expect(octokit.rest.reactions.createForIssueComment).toHaveBeenCalledWith(
        expect.objectContaining({ content: "eyes" }),
      );
    });

    it("should skip commands from bot's own comments", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issue_comment.created")!;
      const octokit = createCommandOctokit();
      const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

      await handler({
        octokit,
        log,
        payload: {
          issue: {
            number: 10,
            labels: [{ name: LABELS.DISCUSSION }],
          },
          comment: {
            id: 200,
            body: "@hivemoot /vote",
            user: { login: "queen-bot[bot]" },
            performed_via_github_app: { id: TEST_APP_ID },
          },
          repository: {
            name: "test-repo",
            full_name: "hivemoot/test-repo",
            owner: { login: "hivemoot" },
          },
        },
      });

      // Bot's own comment should be skipped entirely
      expect(octokit.rest.reactions.createForIssueComment).not.toHaveBeenCalled();
      expect(octokit.rest.repos.getCollaboratorPermissionLevel).not.toHaveBeenCalled();
    });

    it("should ignore quoted commands in replies", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issue_comment.created")!;
      const octokit = createCommandOctokit();
      const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

      await handler({
        octokit,
        log,
        payload: {
          issue: {
            number: 10,
            labels: [{ name: LABELS.DISCUSSION }],
          },
          comment: {
            id: 200,
            body: "> @hivemoot /vote\nI disagree",
            user: { login: "maintainer" },
            performed_via_github_app: null,
          },
          repository: {
            name: "test-repo",
            full_name: "hivemoot/test-repo",
            owner: { login: "hivemoot" },
          },
        },
      });

      // Quoted command should not trigger any reactions or permission checks
      expect(octokit.rest.reactions.createForIssueComment).not.toHaveBeenCalled();
      expect(octokit.rest.repos.getCollaboratorPermissionLevel).not.toHaveBeenCalled();
    });

    it("should return early after command dispatch without processing PR intake", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issue_comment.created")!;
      const octokit = createCommandOctokit();
      const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

      await handler({
        octokit,
        log,
        payload: {
          issue: {
            number: 10,
            labels: [{ name: LABELS.DISCUSSION }],
            pull_request: { url: "https://api.github.com/repos/hivemoot/test-repo/pulls/10" },
          },
          comment: {
            id: 200,
            body: "@hivemoot /implement",
            user: { login: "maintainer" },
            performed_via_github_app: null,
          },
          repository: {
            name: "test-repo",
            full_name: "hivemoot/test-repo",
            owner: { login: "hivemoot" },
          },
        },
      });

      // Command was dispatched — graphql (getLinkedIssues) should NOT have been called
      // because the handler returns early after command execution
      expect(octokit.graphql).not.toHaveBeenCalled();
    });

    it("should return early for /doctor without processing PR intake", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issue_comment.created")!;
      const octokit = createCommandOctokit();
      const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

      await handler({
        octokit,
        log,
        payload: {
          issue: {
            number: 10,
            labels: [{ name: LABELS.DISCUSSION }],
            pull_request: { url: "https://api.github.com/repos/hivemoot/test-repo/pulls/10" },
          },
          comment: {
            id: 200,
            body: "@hivemoot /doctor",
            user: { login: "maintainer" },
            performed_via_github_app: null,
          },
          repository: {
            name: "test-repo",
            full_name: "hivemoot/test-repo",
            owner: { login: "hivemoot" },
          },
        },
      });

      expect(octokit.graphql).not.toHaveBeenCalled();
    });

    it("should fast-exit without loading config for non-discussion issues", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issue_comment.created")!;
      const octokit = createCommandOctokit();
      const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

      await handler({
        octokit,
        log,
        payload: {
          issue: {
            number: 11,
            labels: [{ name: LABELS.READY_TO_IMPLEMENT }],
          },
          comment: {
            id: 201,
            body: "This needs more details.",
            user: { login: "maintainer" },
            performed_via_github_app: null,
          },
          repository: {
            name: "test-repo",
            full_name: "hivemoot/test-repo",
            owner: { login: "hivemoot" },
          },
        },
      });

      // Non-discussion issues must not load config — fast-exit path
      expect(octokit.graphql).not.toHaveBeenCalled();
      expect(octokit.rest.repos.getContent).not.toHaveBeenCalled();
    });

    it("should load config for discussion issues but not run auto-gather when disabled", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issue_comment.created")!;
      const octokit = createCommandOctokit();
      const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

      const callsBefore = vi.mocked(loadRepositoryConfig).mock.calls.length;

      await handler({
        octokit,
        log,
        payload: {
          issue: {
            number: 11,
            labels: [{ name: LABELS.DISCUSSION }],
          },
          comment: {
            id: 201,
            body: "This needs more details before we vote.",
            user: { login: "maintainer" },
            performed_via_github_app: null,
          },
          repository: {
            name: "test-repo",
            full_name: "hivemoot/test-repo",
            owner: { login: "hivemoot" },
          },
        },
      });

      // Config is loaded to check if auto-gather is enabled (it's disabled in default mock)
      expect(vi.mocked(loadRepositoryConfig).mock.calls.length).toBe(callsBefore + 1);
      // But no gather should run
      expect(octokit.graphql).not.toHaveBeenCalled();
    });

    it("should process non-command comments on PRs through intake path", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issue_comment.created")!;
      const octokit = createCommandOctokit();
      const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

      await handler({
        octokit,
        log,
        payload: {
          issue: {
            number: 12,
            labels: [{ name: LABELS.DISCUSSION }],
            pull_request: { url: "https://api.github.com/repos/hivemoot/test-repo/pulls/12" },
          },
          comment: {
            id: 202,
            body: "Please take another look at this.",
            user: { login: "maintainer" },
            performed_via_github_app: null,
          },
          repository: {
            name: "test-repo",
            full_name: "hivemoot/test-repo",
            owner: { login: "hivemoot" },
          },
        },
      });

      expect(processImplementationIntake).toHaveBeenCalledTimes(1);
    });
  });

  describe("issues.opened handler", () => {
    const createIssuesOpenedOctokit = (discussionExitType: "manual" | "auto" = "manual") => {
      const configYml = discussionExitType === "auto"
        ? "version: 1\ngovernance:\n  proposals:\n    discussion:\n      exits:\n        - type: auto\n          afterMinutes: 30\n"
        : "";

      return {
        rest: {
          repos: {
            getContent: vi.fn().mockImplementation(async () => {
              if (discussionExitType === "manual") {
                throw { status: 404 };
              }
              return {
                data: {
                  type: "file",
                  content: Buffer.from(configYml, "utf-8").toString("base64"),
                },
              };
            }),
          },
          issues: {
            get: vi.fn().mockResolvedValue({ data: { reactions: { "+1": 0, "-1": 0, confused: 0 } } }),
            addLabels: vi.fn().mockResolvedValue({}),
            removeLabel: vi.fn().mockResolvedValue({}),
            createComment: vi.fn().mockResolvedValue({}),
            update: vi.fn().mockResolvedValue({}),
            lock: vi.fn().mockResolvedValue({}),
            unlock: vi.fn().mockResolvedValue({}),
            listComments: vi.fn().mockResolvedValue({ data: [] }),
            listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
          },
          reactions: {
            listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
            listForIssue: vi.fn().mockResolvedValue({ data: [] }),
          },
        },
        paginate: {
          iterator: vi.fn().mockImplementation(() => ({
            async *[Symbol.asyncIterator]() {
              yield { data: [] };
            },
          })),
        },
      };
    };

    it("should use manual welcome when discussion auto-exit is not configured", async () => {
      vi.mocked(loadRepositoryConfig).mockResolvedValueOnce({
        governance: {
          proposals: {
            discussion: { exits: [{ type: "manual" }], durationMs: 0 },
            voting: { exits: [{ type: "manual" }], durationMs: 0 },
            extendedVoting: { exits: [{ type: "manual" }], durationMs: 0 },
          },
          pr: { staleDays: 14, maxPRsPerIssue: 3, trustedReviewers: [], intake: [{ method: "update" }], mergeReady: null },
        },
        version: 1,
        standup: { enabled: false, category: "" },
      });

      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issues.opened")!;
      const octokit = createIssuesOpenedOctokit("manual");
      const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

      await handler({
        octokit,
        log,
        payload: {
          issue: { number: 42 },
          repository: {
            name: "test-repo",
            full_name: "hivemoot/test-repo",
            owner: { login: "hivemoot" },
          },
        },
      });

      const commentBody = octokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(commentBody).toContain("Nothing moves forward automatically here.");
    });

    it("should use voting-focused welcome when discussion auto-exit is configured", async () => {
      vi.mocked(loadRepositoryConfig).mockResolvedValueOnce({
        governance: {
          proposals: {
            discussion: {
              exits: [{ type: "auto", afterMs: 1_800_000, minReady: 0, requiredReady: { minCount: 0, users: [] } }],
              durationMs: 1_800_000,
            },
            voting: { exits: [{ type: "manual" }], durationMs: 0 },
            extendedVoting: { exits: [{ type: "manual" }], durationMs: 0 },
          },
          pr: { staleDays: 14, maxPRsPerIssue: 3, trustedReviewers: [], intake: [{ method: "update" }], mergeReady: null },
        },
        version: 1,
        standup: { enabled: false, category: "" },
      });

      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issues.opened")!;
      const octokit = createIssuesOpenedOctokit("auto");
      const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

      await handler({
        octokit,
        log,
        payload: {
          issue: { number: 43 },
          repository: {
            name: "test-repo",
            full_name: "hivemoot/test-repo",
            owner: { login: "hivemoot" },
          },
        },
      });

      const commentBody = octokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(commentBody).toContain("Ready to vote?");
    });

    it("should skip all automation when config is null (no .github/hivemoot.yml)", async () => {
      vi.mocked(loadRepositoryConfig).mockResolvedValueOnce(null);

      const { handlers } = createWebhookHarness();
      const handler = handlers.get("issues.opened")!;
      const octokit = createIssuesOpenedOctokit("manual");
      const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

      await handler({
        octokit,
        log,
        payload: {
          issue: { number: 43 },
          repository: {
            name: "test-repo",
            full_name: "hivemoot/test-repo",
            owner: { login: "hivemoot" },
          },
        },
      });

      // No comment should be posted, no label added
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });
  });

  describe("pull_request_review handlers", () => {
    const createReviewOctokit = () => ({
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              number: 1,
              state: "open",
              merged: false,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
              user: { login: "author" },
              head: { sha: "abc123" },
              mergeable: true,
            },
          }),
          update: vi.fn().mockResolvedValue({}),
          listReviews: vi.fn().mockResolvedValue({ data: [] }),
          listCommits: vi.fn().mockResolvedValue({ data: [] }),
          listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
          listFiles: vi.fn().mockResolvedValue({ data: [] }),
        },
        issues: {
          get: vi.fn().mockResolvedValue({ data: { reactions: { "+1": 0, "-1": 0, confused: 0 } } }),
          addLabels: vi.fn().mockResolvedValue({}),
          removeLabel: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
          listForRepo: vi.fn().mockResolvedValue({ data: [] }),
          listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          lock: vi.fn().mockResolvedValue({}),
          unlock: vi.fn().mockResolvedValue({}),
        },
        checks: {
          listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }),
        },
        repos: {
          getCombinedStatusForRef: vi.fn().mockResolvedValue({
            data: {
              state: "success",
              total_count: 0,
              statuses: [],
            },
          }),
        },
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
          listForIssue: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      paginate: {
        iterator: vi.fn().mockImplementation(() => ({
          async *[Symbol.asyncIterator]() {
            yield { data: [] };
          },
        })),
      },
    });

    beforeEach(() => {
      vi.mocked(getLinkedIssues).mockReset();
      vi.mocked(processImplementationIntake).mockReset();
      vi.mocked(recalculateLeaderboardForPR).mockReset();
      vi.mocked(loadRepositoryConfig).mockReset();
      vi.mocked(evaluateMergeReadiness).mockReset();
      vi.mocked(evaluateAutomerge).mockReset();
    });

    it("should process intake, leaderboard, and merge-readiness on approval", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request_review.submitted");
      expect(handler).toBeDefined();

      const octokit = createReviewOctokit();
      const log = { info: vi.fn(), error: vi.fn() };
      const linkedIssues = [
        {
          number: 79,
          title: "coverage gap",
          state: "OPEN",
          labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
        },
      ];
      const repoConfig = {
        governance: {
          pr: {
            maxPRsPerIssue: 5,
            trustedReviewers: ["maintainer-a"],
            intake: { mode: "always" },
            mergeReady: { minApprovals: 2 },
          },
        },
      };

      vi.mocked(getLinkedIssues).mockResolvedValueOnce(linkedIssues as any);
      vi.mocked(loadRepositoryConfig).mockResolvedValueOnce(repoConfig as any);

      await handler!({
        octokit,
        log,
        payload: {
          review: { state: "approved" },
          pull_request: { number: 22 },
          repository: {
            name: "test-repo",
            full_name: "hivemoot/test-repo",
            owner: { login: "hivemoot" },
          },
        },
      });

      expect(recalculateLeaderboardForPR).toHaveBeenCalledWith(octokit, log, "hivemoot", "test-repo", 22);
      expect(processImplementationIntake).toHaveBeenCalledWith(
        expect.objectContaining({
          octokit,
          log,
          owner: "hivemoot",
          repo: "test-repo",
          prNumber: 22,
          linkedIssues,
          trigger: "updated",
          maxPRsPerIssue: 5,
          trustedReviewers: ["maintainer-a"],
          intake: repoConfig.governance.pr.intake,
        })
      );
      expect(evaluateMergeReadiness).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: { owner: "hivemoot", repo: "test-repo", prNumber: 22 },
          config: repoConfig.governance.pr.mergeReady,
          trustedReviewers: ["maintainer-a"],
          log,
        })
      );
    });

    it("should skip intake and leaderboard on non-approval review", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request_review.submitted");
      expect(handler).toBeDefined();

      const octokit = createReviewOctokit();
      const log = { info: vi.fn(), error: vi.fn() };
      const repoConfig = {
        governance: {
          pr: {
            maxPRsPerIssue: 3,
            trustedReviewers: [],
            intake: {},
            mergeReady: { minApprovals: 1 },
          },
        },
      };

      vi.mocked(getLinkedIssues).mockResolvedValueOnce([]);
      vi.mocked(loadRepositoryConfig).mockResolvedValueOnce(repoConfig as any);

      await handler!({
        octokit,
        log,
        payload: {
          review: { state: "changes_requested" },
          pull_request: { number: 40 },
          repository: {
            name: "test-repo",
            full_name: "hivemoot/test-repo",
            owner: { login: "hivemoot" },
          },
        },
      });

      expect(recalculateLeaderboardForPR).not.toHaveBeenCalled();
      expect(processImplementationIntake).not.toHaveBeenCalled();
      expect(evaluateMergeReadiness).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: { owner: "hivemoot", repo: "test-repo", prNumber: 40 },
          config: repoConfig.governance.pr.mergeReady,
          trustedReviewers: [],
          log,
        })
      );
    });

    it("should recalculate leaderboard and re-evaluate on dismissed review", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request_review.dismissed");
      expect(handler).toBeDefined();

      const octokit = createReviewOctokit();
      const log = { info: vi.fn(), error: vi.fn() };
      const repoConfig = {
        governance: {
          pr: {
            maxPRsPerIssue: 3,
            trustedReviewers: ["maintainer-b"],
            intake: {},
            mergeReady: { minApprovals: 1 },
          },
        },
      };
      vi.mocked(loadRepositoryConfig).mockResolvedValueOnce(repoConfig as any);

      await handler!({
        octokit,
        log,
        payload: {
          review: { state: "dismissed" },
          pull_request: { number: 56 },
          repository: {
            name: "test-repo",
            full_name: "hivemoot/test-repo",
            owner: { login: "hivemoot" },
          },
        },
      });

      expect(recalculateLeaderboardForPR).toHaveBeenCalledWith(octokit, log, "hivemoot", "test-repo", 56);
      expect(processImplementationIntake).not.toHaveBeenCalled();
      expect(evaluateMergeReadiness).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: { owner: "hivemoot", repo: "test-repo", prNumber: 56 },
          config: repoConfig.governance.pr.mergeReady,
          trustedReviewers: ["maintainer-b"],
          log,
        })
      );
    });
  });

  describe("pull_request.closed handler", () => {
    const createClosedPROctokit = () => ({
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              number: 1,
              state: "open",
              merged: false,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
              user: { login: "author" },
              head: { sha: "abc123" },
              mergeable: true,
            },
          }),
          update: vi.fn().mockResolvedValue({}),
          listReviews: vi.fn().mockResolvedValue({ data: [] }),
          listCommits: vi.fn().mockResolvedValue({ data: [] }),
          listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
          listFiles: vi.fn().mockResolvedValue({ data: [] }),
        },
        issues: {
          get: vi.fn().mockResolvedValue({ data: { labels: [] } }),
          addLabels: vi.fn().mockResolvedValue({}),
          removeLabel: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
          listForRepo: vi.fn().mockResolvedValue({ data: [] }),
          listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          lock: vi.fn().mockResolvedValue({}),
          unlock: vi.fn().mockResolvedValue({}),
        },
        checks: {
          listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }),
        },
        repos: {
          getCombinedStatusForRef: vi.fn().mockResolvedValue({
            data: {
              state: "success",
              total_count: 0,
              statuses: [],
            },
          }),
        },
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
          listForIssue: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      paginate: {
        iterator: vi.fn().mockImplementation(() => ({
          async *[Symbol.asyncIterator]() {
            yield { data: [] };
          },
        })),
      },
    });

    beforeEach(() => {
      vi.mocked(getLinkedIssues).mockReset();
      vi.mocked(getOpenPRsForIssue).mockReset();
    });

    it("should close competing PR before posting superseded comment", async () => {
      const { handlers } = createWebhookHarness();
      const handler = handlers.get("pull_request.closed");
      expect(handler).toBeDefined();

      const octokit = createClosedPROctokit();
      const log = { info: vi.fn(), error: vi.fn() };

      vi.mocked(getLinkedIssues).mockResolvedValueOnce([
        {
          number: 79,
          title: "coverage gap",
          state: "OPEN",
          labels: { nodes: [{ name: LABELS.READY_TO_IMPLEMENT }] },
        },
      ] as any);
      vi.mocked(getOpenPRsForIssue).mockResolvedValueOnce([
        { number: 22, state: "OPEN", title: "winner" },
        { number: 24, state: "OPEN", title: "competing" },
      ] as any);

      await handler!({
        octokit,
        log,
        payload: {
          pull_request: { number: 22, merged: true },
          repository: {
            name: "test-repo",
            full_name: "hivemoot/test-repo",
            owner: { login: "hivemoot" },
          },
        },
      });

      expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
        expect.objectContaining({ pull_number: 24, state: "closed" })
      );

      const supersededCommentCall = octokit.rest.issues.createComment.mock.calls.find(
        (call: [{ issue_number: number; body: string }]) =>
          call[0].issue_number === 24 && call[0].body.includes("Superseded")
      );
      expect(supersededCommentCall).toBeDefined();

      const closeCallOrder = octokit.rest.pulls.update.mock.invocationCallOrder[0];
      const supersededCallOrder = supersededCommentCall
        ? octokit.rest.issues.createComment.mock.invocationCallOrder[
            octokit.rest.issues.createComment.mock.calls.indexOf(supersededCommentCall as never)
          ]
        : Number.MAX_SAFE_INTEGER;
      expect(closeCallOrder).toBeLessThan(supersededCallOrder);
    });
  });

  describe("Health Check Endpoint", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should return ok status when all required env vars are set", () => {
      process.env.APP_ID = "12345";
      process.env.PRIVATE_KEY = "test-key";
      process.env.WEBHOOK_SECRET = "test-secret";

      // Simulate the validation logic from the handler
      const requiredVars = ["APP_ID", "PRIVATE_KEY", "WEBHOOK_SECRET"];
      const missing = requiredVars.filter((v) => !process.env[v]);
      const valid = missing.length === 0;

      expect(valid).toBe(true);
      expect(missing).toEqual([]);
    });

    it("should return misconfigured status when env vars are missing", () => {
      process.env.APP_ID = "12345";
      // PRIVATE_KEY and WEBHOOK_SECRET are not set

      const requiredVars = ["APP_ID", "PRIVATE_KEY", "WEBHOOK_SECRET"];
      const missing = requiredVars.filter((v) => !process.env[v]);
      const valid = missing.length === 0;

      expect(valid).toBe(false);
      expect(missing).toContain("PRIVATE_KEY");
      expect(missing).toContain("WEBHOOK_SECRET");
    });

    it("should identify all missing required variables", () => {
      // No env vars set
      delete process.env.APP_ID;
      delete process.env.PRIVATE_KEY;
      delete process.env.WEBHOOK_SECRET;

      const requiredVars = ["APP_ID", "PRIVATE_KEY", "WEBHOOK_SECRET"];
      const missing = requiredVars.filter((v) => !process.env[v]);

      expect(missing).toEqual(["APP_ID", "PRIVATE_KEY", "WEBHOOK_SECRET"]);
    });
  });

  describe("PR workflow guards (pr: null config)", () => {
    const createPRGuardOctokit = () => ({
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({ data: { number: 1, state: "open", merged: false, user: { login: "author" }, head: { sha: "abc123" } } }),
          update: vi.fn().mockResolvedValue({}),
          listReviews: vi.fn().mockResolvedValue({ data: [] }),
          listCommits: vi.fn().mockResolvedValue({ data: [] }),
          listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
          listFiles: vi.fn().mockResolvedValue({ data: [] }),
          list: vi.fn().mockResolvedValue({ data: [] }),
        },
        issues: {
          get: vi.fn().mockResolvedValue({ data: { labels: [] } }),
          addLabels: vi.fn().mockResolvedValue({}),
          removeLabel: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
          listForRepo: vi.fn().mockResolvedValue({ data: [] }),
          listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          lock: vi.fn().mockResolvedValue({}),
          unlock: vi.fn().mockResolvedValue({}),
        },
        checks: {
          listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }),
        },
        repos: {
          getCombinedStatusForRef: vi.fn().mockResolvedValue({ data: { state: "success", total_count: 0, statuses: [] } }),
        },
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
          listForIssue: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      paginate: {
        iterator: vi.fn().mockImplementation(() => ({
          async *[Symbol.asyncIterator]() { yield { data: [] }; },
        })),
      },
    });

    const nullPrConfig = {
      governance: {
        proposals: { discussion: { exits: [{ type: "manual" }], durationMs: 0 } },
        pr: null,
      },
    };

    const testRepo = {
      name: "test-repo",
      full_name: "hivemoot/test-repo",
      owner: { login: "hivemoot" },
      default_branch: "main",
    };

    const mkLog = () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() });

    beforeEach(() => {
      vi.mocked(processImplementationIntake).mockReset();
      vi.mocked(recalculateLeaderboardForPR).mockReset();
      vi.mocked(evaluateMergeReadiness).mockReset();
      vi.mocked(evaluateAutomerge).mockReset();
      vi.mocked(getLinkedIssues).mockReset();
      vi.mocked(loadRepositoryConfig).mockReset();
    });

    it("should skip intake on pull_request.opened when pr config is null", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(getLinkedIssues).mockResolvedValue([
        { number: 1, title: "issue", state: "OPEN", labels: { nodes: [] } },
      ] as any);
      vi.mocked(loadRepositoryConfig).mockResolvedValue(nullPrConfig as any);

      await handlers.get("pull_request.opened")!({
        octokit: createPRGuardOctokit(),
        log: mkLog(),
        payload: {
          pull_request: { number: 1, body: "", base: { ref: "main" } },
          repository: testRepo,
        },
      });

      expect(processImplementationIntake).not.toHaveBeenCalled();
    });

    it("should skip intake on pull_request.synchronize when pr config is null", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(getLinkedIssues).mockResolvedValue([]);
      vi.mocked(loadRepositoryConfig).mockResolvedValue(nullPrConfig as any);

      await handlers.get("pull_request.synchronize")!({
        octokit: createPRGuardOctokit(),
        log: mkLog(),
        payload: {
          pull_request: { number: 1, base: { ref: "main" } },
          repository: testRepo,
        },
      });

      expect(processImplementationIntake).not.toHaveBeenCalled();
    });

    it("should skip intake on pull_request.edited when pr config is null", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(getLinkedIssues).mockResolvedValue([]);
      vi.mocked(loadRepositoryConfig).mockResolvedValue(nullPrConfig as any);

      await handlers.get("pull_request.edited")!({
        octokit: createPRGuardOctokit(),
        log: mkLog(),
        payload: {
          changes: { body: { from: "old" } },
          pull_request: { number: 1, base: { ref: "main" }, updated_at: "2026-01-01T00:00:00Z" },
          repository: testRepo,
        },
      });

      expect(processImplementationIntake).not.toHaveBeenCalled();
    });

    it("should skip intake on issue_comment.created for non-command PR comment when pr config is null", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(getLinkedIssues).mockResolvedValue([]);
      vi.mocked(loadRepositoryConfig).mockResolvedValue(nullPrConfig as any);

      await handlers.get("issue_comment.created")!({
        octokit: createPRGuardOctokit(),
        log: mkLog(),
        payload: {
          issue: {
            number: 1,
            labels: [],
            pull_request: { url: "https://api.github.com/repos/hivemoot/test-repo/pulls/1" },
          },
          comment: { id: 100, body: "LGTM", user: { login: "reviewer" }, performed_via_github_app: null },
          repository: testRepo,
        },
      });

      expect(processImplementationIntake).not.toHaveBeenCalled();
    });

    it("should skip intake and merge-readiness on pull_request_review.submitted when pr config is null", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(getLinkedIssues).mockResolvedValue([]);
      vi.mocked(loadRepositoryConfig).mockResolvedValue(nullPrConfig as any);

      await handlers.get("pull_request_review.submitted")!({
        octokit: createPRGuardOctokit(),
        log: mkLog(),
        payload: {
          review: { state: "approved" },
          pull_request: { number: 1 },
          repository: testRepo,
        },
      });

      expect(processImplementationIntake).not.toHaveBeenCalled();
      expect(evaluateMergeReadiness).not.toHaveBeenCalled();
    });

    it("should skip merge-readiness on pull_request_review.dismissed when pr config is null", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(nullPrConfig as any);

      await handlers.get("pull_request_review.dismissed")!({
        octokit: createPRGuardOctokit(),
        log: mkLog(),
        payload: {
          review: { state: "dismissed" },
          pull_request: { number: 1 },
          repository: testRepo,
        },
      });

      expect(evaluateMergeReadiness).not.toHaveBeenCalled();
    });

    it("should skip merge-readiness on pull_request.labeled when pr config is null", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(nullPrConfig as any);

      await handlers.get("pull_request.labeled")!({
        octokit: createPRGuardOctokit(),
        log: mkLog(),
        payload: {
          label: { name: LABELS.IMPLEMENTATION },
          pull_request: { number: 1, labels: [] },
          repository: testRepo,
        },
      });

      expect(evaluateMergeReadiness).not.toHaveBeenCalled();
    });

    it("should skip ready_for_review automation when pr config is null", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(nullPrConfig as any);

      await handlers.get("pull_request.ready_for_review")!({
        octokit: createPRGuardOctokit(),
        log: mkLog(),
        payload: {
          pull_request: { number: 1, draft: false, labels: [] },
          repository: testRepo,
        },
      });

      expect(evaluateMergeReadiness).not.toHaveBeenCalled();
      expect(evaluateAutomerge).not.toHaveBeenCalled();
    });

    it("should skip converted_to_draft label cleanup when pr config is null", async () => {
      const { handlers } = createWebhookHarness();
      const octokit = createPRGuardOctokit();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(nullPrConfig as any);

      await handlers.get("pull_request.converted_to_draft")!({
        octokit,
        log: mkLog(),
        payload: {
          pull_request: { number: 1, draft: true, labels: [{ name: LABELS.MERGE_READY }] },
          repository: testRepo,
        },
      });

      expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
    });

    it("should surface errors from pull_request.ready_for_review", async () => {
      const { handlers } = createWebhookHarness();
      const log = mkLog();
      vi.mocked(loadRepositoryConfig).mockRejectedValueOnce(new Error("config-fail"));

      await expect(handlers.get("pull_request.ready_for_review")!({
        octokit: createPRGuardOctokit(),
        log,
        payload: {
          pull_request: { number: 1, draft: false, labels: [] },
          repository: testRepo,
        },
      })).rejects.toThrow("config-fail");

      expect(log.error).toHaveBeenCalled();
    });

    it("should surface errors from pull_request.converted_to_draft", async () => {
      const { handlers } = createWebhookHarness();
      const log = mkLog();
      vi.mocked(loadRepositoryConfig).mockRejectedValueOnce(new Error("config-fail"));

      await expect(handlers.get("pull_request.converted_to_draft")!({
        octokit: createPRGuardOctokit(),
        log,
        payload: {
          pull_request: { number: 1, draft: true, labels: [{ name: LABELS.MERGE_READY }] },
          repository: testRepo,
        },
      })).rejects.toThrow("config-fail");

      expect(log.error).toHaveBeenCalled();
    });

    it("should skip merge-readiness on check_suite.completed when pr config is null", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(nullPrConfig as any);

      await handlers.get("check_suite.completed")!({
        octokit: createPRGuardOctokit(),
        log: mkLog(),
        payload: {
          check_suite: { pull_requests: [{ number: 1 }], head_sha: "abc123" },
          repository: testRepo,
        },
      });

      expect(evaluateMergeReadiness).not.toHaveBeenCalled();
    });

    it("should skip merge-readiness on check_run.completed when pr config is null", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(nullPrConfig as any);

      await handlers.get("check_run.completed")!({
        octokit: createPRGuardOctokit(),
        log: mkLog(),
        payload: {
          check_run: { pull_requests: [{ number: 1 }], head_sha: "abc123" },
          repository: testRepo,
        },
      });

      expect(evaluateMergeReadiness).not.toHaveBeenCalled();
    });

    it("should skip merge-readiness on status event when pr config is null", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(nullPrConfig as any);

      await handlers.get("status")!({
        octokit: createPRGuardOctokit(),
        log: mkLog(),
        payload: {
          sha: "abc123",
          repository: testRepo,
        },
      });

      expect(evaluateMergeReadiness).not.toHaveBeenCalled();
    });

    const automergeEnabledConfig = {
      governance: {
        proposals: { discussion: { exits: [{ type: "manual" }], durationMs: 0 } },
        pr: {
          maxPRsPerIssue: 3,
          trustedReviewers: [],
          intake: {},
          mergeReady: null,
          automerge: {
            dryRun: true,
            allowedPaths: ["**/*.md"],
            denyPaths: [],
            maxFiles: 5,
            maxChangedLines: 80,
            minApprovals: 1,
            requireChecks: false,
          },
        },
      },
    };

    it("should thread draft:true from prs.get() to evaluateAutomerge on check_suite.completed", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(automergeEnabledConfig as any);
      vi.mocked(evaluateAutomerge).mockResolvedValue({ action: "unlabeled", reason: "PR is a draft" });

      const octokit = createPRGuardOctokit();
      // Override pulls.get to return a draft PR
      octokit.rest.pulls.get = vi.fn().mockResolvedValue({
        data: { number: 1, state: "open", merged: false, draft: true, mergeable: null, user: { login: "author" }, head: { sha: "abc123" } },
      });

      await handlers.get("check_suite.completed")!({
        octokit,
        log: mkLog(),
        payload: {
          check_suite: { pull_requests: [{ number: 1 }], head_sha: "abc123" },
          repository: testRepo,
        },
      });

      expect(evaluateAutomerge).toHaveBeenCalledWith(
        expect.objectContaining({ draft: true, mergeable: null, graphql: expect.anything() })
      );
    });

    it("should thread draft:true from prs.get() to evaluateAutomerge on check_run.completed", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(automergeEnabledConfig as any);
      vi.mocked(evaluateAutomerge).mockResolvedValue({ action: "unlabeled", reason: "PR is a draft" });

      const octokit = createPRGuardOctokit();
      octokit.rest.pulls.get = vi.fn().mockResolvedValue({
        data: { number: 1, state: "open", merged: false, draft: true, mergeable: null, user: { login: "author" }, head: { sha: "abc123" } },
      });

      await handlers.get("check_run.completed")!({
        octokit,
        log: mkLog(),
        payload: {
          check_run: { pull_requests: [{ number: 1 }], head_sha: "abc123" },
          repository: testRepo,
        },
      });

      expect(evaluateAutomerge).toHaveBeenCalledWith(
        expect.objectContaining({ draft: true, mergeable: null, graphql: expect.anything() })
      );
    });

    it("should thread draft:true from pulls.list to evaluateAutomerge on status event", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(automergeEnabledConfig as any);
      vi.mocked(evaluateAutomerge).mockResolvedValue({ action: "unlabeled", reason: "PR is a draft" });

      const octokit = createPRGuardOctokit();
      // Override pulls.list to return a draft PR whose HEAD matches the status SHA
      octokit.rest.pulls.list = vi.fn().mockResolvedValue({
        data: [{ number: 1, head: { sha: "abc123" }, draft: true }],
      });

      await handlers.get("status")!({
        octokit,
        log: mkLog(),
        payload: {
          sha: "abc123",
          repository: testRepo,
        },
      });

      expect(evaluateAutomerge).toHaveBeenCalledWith(
        expect.objectContaining({ draft: true, graphql: expect.anything() })
      );
    });

    it("should thread mergeable from prs.get() to evaluateAutomerge on pull_request_review.submitted", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(automergeEnabledConfig as any);
      vi.mocked(evaluateAutomerge).mockResolvedValue({ action: "unlabeled", reason: "PR has merge conflicts" });

      const octokit = createPRGuardOctokit();
      octokit.rest.pulls.get = vi.fn().mockResolvedValue({
        data: { number: 1, state: "open", merged: false, draft: false, mergeable: false, user: { login: "author" }, head: { sha: "abc123" } },
      });

      await handlers.get("pull_request_review.submitted")!({
        octokit,
        log: mkLog(),
        payload: {
          review: { state: "approved" },
          pull_request: { number: 1, draft: false },
          repository: testRepo,
        },
      });

      expect(evaluateAutomerge).toHaveBeenCalledWith(
        expect.objectContaining({ draft: false, mergeable: false, graphql: expect.anything() })
      );
    });

    it("should thread mergeable from prs.get() to evaluateAutomerge on pull_request_review.dismissed", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(automergeEnabledConfig as any);
      vi.mocked(evaluateAutomerge).mockResolvedValue({ action: "unlabeled", reason: "PR has merge conflicts" });

      const octokit = createPRGuardOctokit();
      octokit.rest.pulls.get = vi.fn().mockResolvedValue({
        data: { number: 1, state: "open", merged: false, draft: false, mergeable: false, user: { login: "author" }, head: { sha: "abc123" } },
      });

      await handlers.get("pull_request_review.dismissed")!({
        octokit,
        log: mkLog(),
        payload: {
          review: { state: "dismissed" },
          pull_request: { number: 1, draft: false },
          repository: testRepo,
        },
      });

      expect(evaluateAutomerge).toHaveBeenCalledWith(
        expect.objectContaining({ draft: false, mergeable: false, graphql: expect.anything() })
      );
    });

    it("should thread mergeable from prs.get() to evaluateAutomerge on status event", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(automergeEnabledConfig as any);
      vi.mocked(evaluateAutomerge).mockResolvedValue({ action: "unlabeled", reason: "PR has merge conflicts" });

      const octokit = createPRGuardOctokit();
      octokit.rest.pulls.list = vi.fn().mockResolvedValue({
        data: [{ number: 1, head: { sha: "abc123" }, draft: false }],
      });
      octokit.rest.pulls.get = vi.fn().mockResolvedValue({
        data: { number: 1, state: "open", merged: false, draft: false, mergeable: false, user: { login: "author" }, head: { sha: "abc123" } },
      });

      await handlers.get("status")!({
        octokit,
        log: mkLog(),
        payload: {
          sha: "abc123",
          repository: testRepo,
        },
      });

      expect(evaluateAutomerge).toHaveBeenCalledWith(
        expect.objectContaining({ draft: false, mergeable: false, graphql: expect.anything() })
      );
    });
  });

  describe("PR workflow truthy paths (pr config present)", () => {
    // These tests cover the body inside `if (repoConfig.governance.pr)` guards
    // for handlers that had no prior truthy-path tests.
    const mkOctokit = () => ({
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({ data: { number: 1, state: "open", merged: false, user: { login: "author" }, head: { sha: "abc123" } } }),
          update: vi.fn().mockResolvedValue({}),
          listReviews: vi.fn().mockResolvedValue({ data: [] }),
          listCommits: vi.fn().mockResolvedValue({ data: [] }),
          listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
          listFiles: vi.fn().mockResolvedValue({ data: [] }),
          list: vi.fn().mockResolvedValue({ data: [] }),
        },
        issues: {
          get: vi.fn().mockResolvedValue({ data: {} }),
          addLabels: vi.fn().mockResolvedValue({}),
          removeLabel: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
          listForRepo: vi.fn().mockResolvedValue({ data: [] }),
          listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          lock: vi.fn().mockResolvedValue({}),
          unlock: vi.fn().mockResolvedValue({}),
        },
        checks: {
          listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }),
        },
        repos: {
          getCombinedStatusForRef: vi.fn().mockResolvedValue({ data: { state: "success", total_count: 0, statuses: [] } }),
        },
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
          listForIssue: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      paginate: {
        iterator: vi.fn().mockImplementation(() => ({
          async *[Symbol.asyncIterator]() { yield { data: [] }; },
        })),
      },
    });

    const prConfig = {
      governance: {
        proposals: { discussion: { exits: [{ type: "manual" }], durationMs: 0 } },
        pr: { maxPRsPerIssue: 3, trustedReviewers: [], intake: {}, mergeReady: {} },
      },
    };

    const testRepo = {
      name: "test-repo",
      full_name: "hivemoot/test-repo",
      owner: { login: "hivemoot" },
      default_branch: "main",
    };

    const mkLog = () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() });

    const phase2Config = {
      governance: {
        proposals: { discussion: { exits: [{ type: "manual" }], durationMs: 0 } },
        pr: {
          maxPRsPerIssue: 3,
          trustedReviewers: [],
          intake: {},
          mergeReady: {},
          automerge: {
            dryRun: false,
            mergeMethod: "squash",
            allowedPaths: ["**"],
            denyPaths: [],
            maxFiles: 100,
            maxChangedLines: 1000,
            minApprovals: 0,
            requireChecks: false,
          },
        },
      },
    };

    beforeEach(() => {
      vi.mocked(processImplementationIntake).mockReset();
      vi.mocked(evaluateMergeReadiness).mockReset();
      vi.mocked(evaluateAutomerge).mockReset();
      vi.mocked(getLinkedIssues).mockReset();
      vi.mocked(loadRepositoryConfig).mockReset();
      vi.mocked(disablePullRequestAutoMerge).mockReset().mockResolvedValue(undefined);
      vi.mocked(maybeCreatePrReviewRoom).mockReset().mockResolvedValue({ roomId: null });
      vi.mocked(maybeEmitSubjectUpdated).mockReset().mockResolvedValue({ sequence: null });
    });

    it("should call processImplementationIntake on pull_request.opened", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(getLinkedIssues).mockResolvedValue([
        { number: 1, title: "issue", state: "OPEN", labels: { nodes: [] } },
      ] as any);
      vi.mocked(loadRepositoryConfig).mockResolvedValue(prConfig as any);

      await handlers.get("pull_request.opened")!({
        octokit: mkOctokit(),
        log: mkLog(),
        payload: {
          pull_request: { number: 1, body: "Closes #1", base: { ref: "main" } },
          repository: testRepo,
        },
      });

      expect(processImplementationIntake).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: "opened" })
      );
    });

    it("should create the PR war room on opened before later automation failures", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(getLinkedIssues).mockResolvedValue([
        { number: 1, title: "issue", state: "OPEN", labels: { nodes: [] } },
      ] as any);
      vi.mocked(loadRepositoryConfig).mockResolvedValue(prConfig as any);
      vi.mocked(evaluateAutomerge).mockRejectedValueOnce(new Error("automerge failed"));

      await expect(handlers.get("pull_request.opened")!({
        octokit: mkOctokit(),
        log: mkLog(),
        payload: {
          installation: { id: 1234 },
          pull_request: { number: 1, body: "Closes #1", base: { ref: "main" } },
          repository: testRepo,
        },
      })).rejects.toThrow("automerge failed");

      expect(maybeCreatePrReviewRoom).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "hivemoot",
          repo: "test-repo",
          installationId: 1234,
          prNumber: 1,
        })
      );
    });

    it("should call processImplementationIntake on pull_request.synchronize", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(getLinkedIssues).mockResolvedValue([]);
      vi.mocked(loadRepositoryConfig).mockResolvedValue(prConfig as any);

      await handlers.get("pull_request.synchronize")!({
        octokit: mkOctokit(),
        log: mkLog(),
        payload: {
          pull_request: { number: 1, base: { ref: "main" } },
          repository: testRepo,
        },
      });

      expect(processImplementationIntake).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: "updated" })
      );
    });

    it("should retry PR war-room creation on synchronize when the update finds no room", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(getLinkedIssues).mockResolvedValue([]);
      vi.mocked(loadRepositoryConfig).mockResolvedValue(prConfig as any);
      vi.mocked(maybeEmitSubjectUpdated).mockResolvedValueOnce({ sequence: null, skipped: "no_room" });

      await handlers.get("pull_request.synchronize")!({
        octokit: mkOctokit(),
        log: mkLog(),
        payload: {
          installation: { id: 1234 },
          pull_request: { number: 1, base: { ref: "main" }, head: { sha: "abc123" } },
          repository: testRepo,
        },
      });

      expect(maybeEmitSubjectUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "hivemoot",
          repo: "test-repo",
          installationId: 1234,
          prNumber: 1,
          changeKind: "synchronize",
          headSha: "abc123",
        })
      );
      expect(maybeCreatePrReviewRoom).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "hivemoot",
          repo: "test-repo",
          installationId: 1234,
          prNumber: 1,
        })
      );
    });

    it("should not retry PR war-room creation on synchronize when the update succeeds", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(getLinkedIssues).mockResolvedValue([]);
      vi.mocked(loadRepositoryConfig).mockResolvedValue(prConfig as any);
      vi.mocked(maybeEmitSubjectUpdated).mockResolvedValueOnce({ sequence: 7 });

      await handlers.get("pull_request.synchronize")!({
        octokit: mkOctokit(),
        log: mkLog(),
        payload: {
          installation: { id: 1234 },
          pull_request: { number: 1, base: { ref: "main" }, head: { sha: "abc123" } },
          repository: testRepo,
        },
      });

      expect(maybeCreatePrReviewRoom).not.toHaveBeenCalled();
    });

    it("should cancel queued squash on pull_request.synchronize when the label is present", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(getLinkedIssues).mockResolvedValue([]);
      vi.mocked(loadRepositoryConfig).mockResolvedValue(prConfig as any);
      const octokit = mkOctokit();

      await handlers.get("pull_request.synchronize")!({
        octokit,
        log: mkLog(),
        payload: {
          pull_request: {
            number: 1,
            base: { ref: "main" },
            labels: [{ name: "hivemoot:squash-queued" }],
          },
          repository: testRepo,
        },
      });

      expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 1,
          name: "hivemoot:squash-queued",
        }),
      );
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 1,
          body: "Queued squash cancelled because new commits were pushed. Run `/squash` again when the branch is ready.",
        }),
      );
    });

    it("should call processImplementationIntake on pull_request.edited", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(getLinkedIssues).mockResolvedValue([]);
      vi.mocked(loadRepositoryConfig).mockResolvedValue(prConfig as any);

      await handlers.get("pull_request.edited")!({
        octokit: mkOctokit(),
        log: mkLog(),
        payload: {
          changes: { body: { from: "old" } },
          pull_request: { number: 1, base: { ref: "main" }, updated_at: "2026-01-01T00:00:00Z" },
          repository: testRepo,
        },
      });

      expect(processImplementationIntake).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: "edited" })
      );
    });

    it("should call evaluateMergeReadiness on pull_request.labeled", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(prConfig as any);

      await handlers.get("pull_request.labeled")!({
        octokit: mkOctokit(),
        log: mkLog(),
        payload: {
          label: { name: LABELS.IMPLEMENTATION },
          pull_request: { number: 1, labels: [{ name: LABELS.IMPLEMENTATION }] },
          repository: testRepo,
        },
      });

      expect(evaluateMergeReadiness).toHaveBeenCalledWith(
        expect.objectContaining({
          currentLabels: [LABELS.IMPLEMENTATION],
        })
      );
    });

    it("should evaluate readiness and automerge on pull_request.ready_for_review", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(prConfig as any);

      await handlers.get("pull_request.ready_for_review")!({
        octokit: mkOctokit(),
        log: mkLog(),
        payload: {
          pull_request: { number: 2, draft: false, labels: [{ name: LABELS.IMPLEMENTATION }] },
          repository: testRepo,
        },
      });

      expect(evaluateMergeReadiness).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: { owner: "hivemoot", repo: "test-repo", prNumber: 2 },
          currentLabels: [LABELS.IMPLEMENTATION],
          draft: false,
        })
      );
      expect(evaluateAutomerge).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: { owner: "hivemoot", repo: "test-repo", prNumber: 2 },
          currentLabels: [LABELS.IMPLEMENTATION],
          draft: false,
          graphql: expect.anything(),
        })
      );
    });

    it("should remove merge-ready and automerge labels on pull_request.converted_to_draft", async () => {
      const { handlers } = createWebhookHarness();
      const octokit = mkOctokit();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(prConfig as any);

      await handlers.get("pull_request.converted_to_draft")!({
        octokit,
        log: mkLog(),
        payload: {
          pull_request: {
            number: 3,
            draft: true,
            labels: [{ name: LABELS.MERGE_READY }, { name: LABELS.AUTOMERGE }],
          },
          repository: testRepo,
        },
      });

      expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "hivemoot",
          repo: "test-repo",
          issue_number: 3,
          name: LABELS.MERGE_READY,
        })
      );
      expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "hivemoot",
          repo: "test-repo",
          issue_number: 3,
          name: LABELS.AUTOMERGE,
        })
      );
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "hivemoot",
          repo: "test-repo",
          issue_number: 3,
          body: expect.stringContaining(`\`${LABELS.MERGE_READY}\``),
        })
      );
      expect(evaluateMergeReadiness).not.toHaveBeenCalled();
      expect(evaluateAutomerge).not.toHaveBeenCalled();
    });

    it("should remove automerge without posting draft comment when merge-ready is absent", async () => {
      const { handlers } = createWebhookHarness();
      const octokit = mkOctokit();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(prConfig as any);

      await handlers.get("pull_request.converted_to_draft")!({
        octokit,
        log: mkLog(),
        payload: {
          pull_request: {
            number: 5,
            draft: true,
            labels: [{ name: LABELS.AUTOMERGE }],
          },
          repository: testRepo,
        },
      });

      expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "hivemoot",
          repo: "test-repo",
          issue_number: 5,
          name: LABELS.AUTOMERGE,
        })
      );
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it("should skip label cleanup on pull_request.converted_to_draft when no tracked labels are present", async () => {
      const { handlers } = createWebhookHarness();
      const octokit = mkOctokit();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(prConfig as any);

      await handlers.get("pull_request.converted_to_draft")!({
        octokit,
        log: mkLog(),
        payload: {
          pull_request: {
            number: 4,
            draft: true,
            labels: [{ name: LABELS.IMPLEMENTATION }],
          },
          repository: testRepo,
        },
      });

      expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it("should call disablePullRequestAutoMerge before removing automerge label on pull_request.synchronize (Phase 2 active)", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(getLinkedIssues).mockResolvedValue([]);
      vi.mocked(loadRepositoryConfig).mockResolvedValue(phase2Config as any);

      await handlers.get("pull_request.synchronize")!({
        octokit: mkOctokit(),
        log: mkLog(),
        payload: {
          pull_request: {
            number: 10,
            node_id: "PR_node_sync",
            base: { ref: "main" },
            labels: [{ name: LABELS.AUTOMERGE }],
          },
          repository: testRepo,
        },
      });

      expect(disablePullRequestAutoMerge).toHaveBeenCalledWith(expect.anything(), "PR_node_sync");
    });

    it("should call disablePullRequestAutoMerge before removing automerge label on pull_request.converted_to_draft (Phase 2 active)", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(phase2Config as any);

      await handlers.get("pull_request.converted_to_draft")!({
        octokit: mkOctokit(),
        log: mkLog(),
        payload: {
          pull_request: {
            number: 11,
            node_id: "PR_node_draft",
            draft: true,
            labels: [{ name: LABELS.AUTOMERGE }],
          },
          repository: testRepo,
        },
      });

      expect(disablePullRequestAutoMerge).toHaveBeenCalledWith(expect.anything(), "PR_node_draft");
    });

    it("warns and retains automerge label when disablePullRequestAutoMerge throws on pull_request.synchronize (Phase 2 active)", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(getLinkedIssues).mockResolvedValue([]);
      vi.mocked(loadRepositoryConfig).mockResolvedValue(phase2Config as any);
      vi.mocked(disablePullRequestAutoMerge).mockRejectedValueOnce(new Error("network failure"));

      const octokit = mkOctokit();
      const log = mkLog();
      await handlers.get("pull_request.synchronize")!({
        octokit,
        log,
        payload: {
          pull_request: {
            number: 12,
            node_id: "PR_node_sync_err",
            base: { ref: "main" },
            labels: [{ name: LABELS.AUTOMERGE }],
          },
          repository: testRepo,
        },
      });

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to disable GitHub auto-merge on synchronize"));
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("retaining label for retry"));
      expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: LABELS.AUTOMERGE })
      );
    });

    it("silently ignores PullRequestAutoMergeNotEnabled on pull_request.synchronize (Phase 2 active)", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(getLinkedIssues).mockResolvedValue([]);
      vi.mocked(loadRepositoryConfig).mockResolvedValue(phase2Config as any);
      vi.mocked(disablePullRequestAutoMerge).mockRejectedValueOnce(
        new GraphqlResponseError(
          { url: "https://api.github.com/graphql" },
          {},
          { data: null, errors: [{ message: "Pull request Auto merge is not enabled.", type: "UNPROCESSABLE" }] }
        )
      );

      const log = mkLog();
      await handlers.get("pull_request.synchronize")!({
        octokit: mkOctokit(),
        log,
        payload: {
          pull_request: {
            number: 13,
            node_id: "PR_node_sync_notEnabled",
            base: { ref: "main" },
            labels: [{ name: LABELS.AUTOMERGE }],
          },
          repository: testRepo,
        },
      });

      expect(log.warn).not.toHaveBeenCalled();
    });

    it("warns and retains automerge label when disablePullRequestAutoMerge throws on pull_request.converted_to_draft (Phase 2 active)", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(phase2Config as any);
      vi.mocked(disablePullRequestAutoMerge).mockRejectedValueOnce(new Error("network failure"));

      const octokit = mkOctokit();
      const log = mkLog();
      await handlers.get("pull_request.converted_to_draft")!({
        octokit,
        log,
        payload: {
          pull_request: {
            number: 14,
            node_id: "PR_node_draft_err",
            draft: true,
            labels: [{ name: LABELS.AUTOMERGE }],
          },
          repository: testRepo,
        },
      });

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to disable GitHub auto-merge on converted_to_draft"));
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("retaining label for retry"));
      expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: LABELS.AUTOMERGE })
      );
    });

    it("silently ignores PullRequestAutoMergeNotEnabled on pull_request.converted_to_draft (Phase 2 active)", async () => {
      const { handlers } = createWebhookHarness();
      vi.mocked(loadRepositoryConfig).mockResolvedValue(phase2Config as any);
      vi.mocked(disablePullRequestAutoMerge).mockRejectedValueOnce(
        new GraphqlResponseError(
          { url: "https://api.github.com/graphql" },
          {},
          { data: null, errors: [{ message: "Pull request Auto merge is not enabled.", type: "UNPROCESSABLE" }] }
        )
      );

      const log = mkLog();
      await handlers.get("pull_request.converted_to_draft")!({
        octokit: mkOctokit(),
        log,
        payload: {
          pull_request: {
            number: 15,
            node_id: "PR_node_draft_notEnabled",
            draft: true,
            labels: [{ name: LABELS.AUTOMERGE }],
          },
          repository: testRepo,
        },
      });

      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  describe("Message Templates", () => {
    it("should include Queen signature in all messages", () => {
      expect(MESSAGES.ISSUE_WELCOME_VOTING).toContain("Queen");
      expect(MESSAGES.ISSUE_WELCOME).toContain("Queen");
      expect(MESSAGES.ISSUE_WELCOME_MANUAL).toContain("Queen");
      expect(MESSAGES.PR_NO_LINKED_ISSUE).toContain("Queen");
      expect(MESSAGES.VOTING_START).toContain("Queen");
    });

    it("should keep distinct issue welcome text for vote and manual modes", () => {
      expect(MESSAGES.ISSUE_WELCOME_VOTING).toContain("Ready to vote?");
      expect(MESSAGES.ISSUE_WELCOME_MANUAL).toContain("Nothing moves forward automatically here.");
    });

    it("should include voting instructions in VOTING_START", () => {
      expect(MESSAGES.VOTING_START).toContain("React to THIS comment to vote");
      expect(MESSAGES.VOTING_START).toContain("👍");
      expect(MESSAGES.VOTING_START).toContain("👎");
    });

    it("should format vote results correctly", () => {
      const votes = { thumbsUp: 5, thumbsDown: 2, confused: 1, eyes: 0 };

      const readyMsg = MESSAGES.votingEndReadyToImplement(votes);
      expect(readyMsg).toContain("👍 5");
      expect(readyMsg).toContain("👎 2");
      expect(readyMsg).toContain("😕 1");
      expect(readyMsg).toContain("Ready to Implement");

      const rejectedMsg = MESSAGES.votingEndRejected(votes);
      expect(rejectedMsg).toContain("Rejected");

      const inconclusiveMsg = MESSAGES.votingEndInconclusive({ thumbsUp: 3, thumbsDown: 3, confused: 0, eyes: 0 });
      expect(inconclusiveMsg).toContain("Extended Voting");
    });
  });

  describe("HTTP Handler", () => {
    const createMockRequest = (method: string): IncomingMessage => {
      return { method } as IncomingMessage;
    };

    const createMockResponse = () => {
      const res = {
        statusCode: 0,
        headers: {} as Record<string, string>,
        body: "",
        setHeader: vi.fn((name: string, value: string) => {
          res.headers[name] = value;
        }),
        end: vi.fn((body: string) => {
          res.body = body;
        }),
      };
      return res as unknown as ServerResponse & {
        headers: Record<string, string>;
        body: string;
      };
    };

    describe("GET requests (health check)", () => {
      it("should return 200 ok with checks when environment is valid", async () => {
        const { validateEnv } = await import("../../lib/env-validation.js");
        vi.mocked(validateEnv).mockReturnValue({ valid: true, missing: [] });

        const { getLLMReadiness } = await import("../../lib/llm/provider.js");
        vi.mocked(getLLMReadiness).mockReturnValue({ ready: true });

        // Re-import handler to pick up mocks
        const { default: handler } = await import("./index.js");

        const req = createMockRequest("GET");
        const res = createMockResponse();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.headers["Content-Type"]).toBe("application/json");
        const body = JSON.parse(res.body);
        expect(body.status).toBe("ok");
        expect(body.bot).toBe("Queen");
        expect(body.checks.githubApp).toEqual({ ready: true });
        expect(body.checks.llm).toEqual({ ready: true });
        expect(body.missing).toBeUndefined();
      });

      it("should return 503 misconfigured with checks when environment is invalid", async () => {
        const { validateEnv } = await import("../../lib/env-validation.js");
        vi.mocked(validateEnv).mockReturnValue({
          valid: false,
          missing: ["APP_ID", "WEBHOOK_SECRET"],
        });

        const { getLLMReadiness } = await import("../../lib/llm/provider.js");
        vi.mocked(getLLMReadiness).mockReturnValue({ ready: false, reason: "not_configured" });

        const { default: handler } = await import("./index.js");

        const req = createMockRequest("GET");
        const res = createMockResponse();

        handler(req, res);

        expect(res.statusCode).toBe(503);
        expect(res.headers["Content-Type"]).toBe("application/json");
        const body = JSON.parse(res.body);
        expect(body.status).toBe("misconfigured");
        expect(body.bot).toBe("Queen");
        expect(body.checks.githubApp).toEqual({ ready: false });
        expect(body.checks.llm).toEqual({ ready: false, reason: "not_configured" });
        expect(body.missing).toBeUndefined();
      });

      it("should report llm api_key_missing when provider configured but key absent", async () => {
        const { validateEnv } = await import("../../lib/env-validation.js");
        vi.mocked(validateEnv).mockReturnValue({ valid: true, missing: [] });

        const { getLLMReadiness } = await import("../../lib/llm/provider.js");
        vi.mocked(getLLMReadiness).mockReturnValue({ ready: false, reason: "api_key_missing" });

        const { default: handler } = await import("./index.js");

        const req = createMockRequest("GET");
        const res = createMockResponse();

        handler(req, res);

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.status).toBe("ok");
        expect(body.checks.githubApp).toEqual({ ready: true });
        expect(body.checks.llm).toEqual({ ready: false, reason: "api_key_missing" });
      });
    });

    describe("POST requests (webhooks)", () => {
      it("should return 503 when environment is misconfigured", async () => {
        const { validateEnv } = await import("../../lib/env-validation.js");
        vi.mocked(validateEnv).mockReturnValue({
          valid: false,
          missing: ["WEBHOOK_SECRET"],
        });

        const { default: handler } = await import("./index.js");

        const req = createMockRequest("POST");
        const res = createMockResponse();

        handler(req, res);

        expect(res.statusCode).toBe(503);
        expect(res.headers["Content-Type"]).toBe("application/json");
        const body = JSON.parse(res.body);
        expect(body.error).toBe("Webhook processing unavailable");
      });

      it("should forward to middleware when environment is valid", async () => {
        const { validateEnv } = await import("../../lib/env-validation.js");
        vi.mocked(validateEnv).mockReturnValue({ valid: true, missing: [] });

        const { createNodeMiddleware } = await import("probot");
        const mockMiddleware = vi.fn();
        vi.mocked(createNodeMiddleware).mockReturnValue(mockMiddleware);

        // Re-import to pick up the new middleware mock
        vi.resetModules();
        const { default: handler } = await import("./index.js");

        const req = createMockRequest("POST");
        const res = createMockResponse();

        handler(req, res);

        // The middleware should have been called (it was set up during import)
        // Since we mocked createNodeMiddleware, the actual middleware won't process
        // but we verify the env validation happened
        expect(validateEnv).toHaveBeenCalledWith(true);
      });
    });
  });

  describe("null-config no-op guards", () => {
    // Minimal Octokit stub that passes createIssueOperations + createPROperations validation.
    // None of these methods are reached — every handler returns early when loadRepositoryConfig → null.
    const createNullConfigOctokit = () => ({
      rest: {
        issues: {
          get: vi.fn(),
          addLabels: vi.fn(),
          removeLabel: vi.fn(),
          createComment: vi.fn(),
          update: vi.fn(),
          lock: vi.fn(),
          unlock: vi.fn(),
          listForRepo: vi.fn(),
          listComments: vi.fn(),
          listEventsForTimeline: vi.fn(),
        },
        reactions: {
          listForIssueComment: vi.fn(),
          listForIssue: vi.fn(),
        },
        pulls: {
          get: vi.fn(),
          update: vi.fn(),
          listReviews: vi.fn(),
          listCommits: vi.fn(),
          listReviewComments: vi.fn(),
          listFiles: vi.fn(),
          list: vi.fn(),
        },
        checks: { listForRef: vi.fn() },
        repos: { getCombinedStatusForRef: vi.fn() },
      },
      paginate: {
        iterator: vi.fn().mockImplementation(() => ({
          async *[Symbol.asyncIterator]() {
            yield { data: [] };
          },
        })),
      },
    });

    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const baseRepo = {
      name: "no-config-repo",
      full_name: "hivemoot/no-config-repo",
      owner: { login: "hivemoot" },
      default_branch: "main",
    };
    const basePR = { number: 10, base: { ref: "main" }, body: "", labels: [] };

    beforeEach(() => {
      vi.mocked(loadRepositoryConfig).mockReset().mockResolvedValue(null);
      vi.mocked(getLinkedIssues).mockReset().mockResolvedValue([]);
      vi.mocked(recalculateLeaderboardForPR).mockReset().mockResolvedValue(undefined);
      vi.mocked(processImplementationIntake).mockReset().mockResolvedValue(undefined);
      vi.mocked(evaluateMergeReadiness).mockReset().mockResolvedValue(undefined);
      vi.mocked(evaluateAutomerge).mockReset().mockResolvedValue(undefined);
    });

    it("pull_request.opened: skips automation when config is null", async () => {
      const { handlers } = createWebhookHarness();
      const octokit = createNullConfigOctokit();
      await handlers.get("pull_request.opened")!({
        octokit,
        log,
        payload: { pull_request: basePR, repository: baseRepo },
      });
      expect(processImplementationIntake).not.toHaveBeenCalled();
    });

    it("pull_request.synchronize: skips automation when config is null", async () => {
      const { handlers } = createWebhookHarness();
      const octokit = createNullConfigOctokit();
      await handlers.get("pull_request.synchronize")!({
        octokit,
        log,
        payload: { pull_request: basePR, repository: baseRepo },
      });
      expect(processImplementationIntake).not.toHaveBeenCalled();
    });

    it("pull_request.edited: skips automation when config is null", async () => {
      const { handlers } = createWebhookHarness();
      const octokit = createNullConfigOctokit();
      await handlers.get("pull_request.edited")!({
        octokit,
        log,
        payload: {
          pull_request: basePR,
          repository: baseRepo,
          changes: { body: { from: "old body" } },
        },
      });
      expect(processImplementationIntake).not.toHaveBeenCalled();
    });

    it("issue_comment.created (PR intake path): skips automation when config is null", async () => {
      const { handlers } = createWebhookHarness();
      const octokit = createNullConfigOctokit();
      await handlers.get("issue_comment.created")!({
        octokit,
        log,
        payload: {
          issue: { number: 55, pull_request: { url: "https://github.com/hivemoot/no-config-repo/pull/55" }, labels: [] },
          comment: { id: 1, body: "looks good", performed_via_github_app: null, user: { login: "user" } },
          repository: baseRepo,
        },
      });
      expect(processImplementationIntake).not.toHaveBeenCalled();
    });

    it("pull_request_review.submitted: skips automation when config is null", async () => {
      const { handlers } = createWebhookHarness();
      const octokit = createNullConfigOctokit();
      await handlers.get("pull_request_review.submitted")!({
        octokit,
        log,
        payload: {
          review: { state: "approved" },
          pull_request: { number: 10 },
          repository: baseRepo,
        },
      });
      expect(recalculateLeaderboardForPR).not.toHaveBeenCalled();
      expect(processImplementationIntake).not.toHaveBeenCalled();
      expect(evaluateMergeReadiness).not.toHaveBeenCalled();
    });

    it("pull_request_review.dismissed: skips automation when config is null", async () => {
      const { handlers } = createWebhookHarness();
      const octokit = createNullConfigOctokit();
      await handlers.get("pull_request_review.dismissed")!({
        octokit,
        log,
        payload: {
          review: { state: "dismissed" },
          pull_request: { number: 10 },
          repository: baseRepo,
        },
      });
      expect(recalculateLeaderboardForPR).not.toHaveBeenCalled();
      expect(evaluateMergeReadiness).not.toHaveBeenCalled();
    });

    it("pull_request.labeled: skips automation when config is null", async () => {
      const { handlers } = createWebhookHarness();
      const octokit = createNullConfigOctokit();
      await handlers.get("pull_request.labeled")!({
        octokit,
        log,
        payload: {
          label: { name: LABELS.IMPLEMENTATION },
          pull_request: { number: 10, labels: [] },
          repository: baseRepo,
        },
      });
      expect(evaluateMergeReadiness).not.toHaveBeenCalled();
    });

    it("pull_request.ready_for_review: skips automation when config is null", async () => {
      const { handlers } = createWebhookHarness();
      const octokit = createNullConfigOctokit();
      await handlers.get("pull_request.ready_for_review")!({
        octokit,
        log,
        payload: {
          pull_request: { number: 10, draft: false, labels: [] },
          repository: baseRepo,
        },
      });
      expect(evaluateMergeReadiness).not.toHaveBeenCalled();
      expect(evaluateAutomerge).not.toHaveBeenCalled();
    });

    it("pull_request.converted_to_draft: skips automation when config is null", async () => {
      const { handlers } = createWebhookHarness();
      const octokit = createNullConfigOctokit();
      await handlers.get("pull_request.converted_to_draft")!({
        octokit,
        log,
        payload: {
          pull_request: { number: 10, draft: true, labels: [{ name: LABELS.MERGE_READY }] },
          repository: baseRepo,
        },
      });
      expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it("check_suite.completed: skips automation when config is null", async () => {
      const { handlers } = createWebhookHarness();
      const octokit = createNullConfigOctokit();
      await handlers.get("check_suite.completed")!({
        octokit,
        log,
        payload: {
          check_suite: { pull_requests: [{ number: 1 }], head_sha: "abc123" },
          repository: baseRepo,
        },
      });
      expect(evaluateMergeReadiness).not.toHaveBeenCalled();
    });

    it("check_run.completed: skips automation when config is null", async () => {
      const { handlers } = createWebhookHarness();
      const octokit = createNullConfigOctokit();
      await handlers.get("check_run.completed")!({
        octokit,
        log,
        payload: {
          check_run: { pull_requests: [{ number: 1 }], head_sha: "abc123" },
          repository: baseRepo,
        },
      });
      expect(evaluateMergeReadiness).not.toHaveBeenCalled();
    });

    it("status: skips automation when config is null", async () => {
      const { handlers } = createWebhookHarness();
      const octokit = createNullConfigOctokit();
      await handlers.get("status")!({
        octokit,
        log,
        payload: { sha: "abc123", repository: baseRepo },
      });
      expect(evaluateMergeReadiness).not.toHaveBeenCalled();
    });
  });
});
