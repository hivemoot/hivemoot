import { describe, it, expect, vi } from "vitest";
import { REQUIRED_REPOSITORY_LABELS } from "../config.js";
import {
  installationCreatedLabelBootstrapHandler,
  installationRepositoriesAddedLabelBootstrapHandler,
} from "./label-bootstrap.handler.js";
import type { HandlerEvent } from "./types.js";

function buildIterator<T>(pages: T[][]): AsyncIterable<{ data: T[] }> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const page of pages) {
        yield { data: page };
      }
    },
  };
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

function createEvent(
  name: string,
  payload: Record<string, unknown>,
  octokit: ReturnType<typeof createInstallationOctokit>,
  log: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> },
): HandlerEvent {
  return {
    name,
    context: {
      octokit,
      log,
      payload,
    },
  };
}

describe("label-bootstrap handlers", () => {
  it("bootstraps labels from installation.created payload repositories", async () => {
    const octokit = createInstallationOctokit();
    const log = { info: vi.fn(), error: vi.fn() };

    await installationCreatedLabelBootstrapHandler.handle(
      createEvent(
        "installation.created",
        {
          repositories: [
            {
              owner: { login: "hivemoot" },
              name: "repo-a",
              full_name: "hivemoot/repo-a",
            },
          ],
        },
        octokit,
        log,
      ),
      {},
    );

    expect(octokit.rest.apps.listReposAccessibleToInstallation).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createLabel).toHaveBeenCalledTimes(REQUIRED_REPOSITORY_LABELS.length);
    expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "hivemoot",
        repo: "repo-a",
      }),
    );
    expect(log.info).toHaveBeenCalledWith(
      `[installation.created] Label bootstrap summary: reposProcessed=1, reposFailed=0, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length}, labelsRenamed=0, labelsUpdated=0, labelsSkipped=0`,
    );
  });

  it("updates drifted labels during installation.created bootstrap", async () => {
    const driftedLabel = {
      name: REQUIRED_REPOSITORY_LABELS[0].name,
      color: "ededed",
      description: REQUIRED_REPOSITORY_LABELS[0].description ?? null,
    };
    const octokit = createInstallationOctokit({
      existingLabels: [driftedLabel],
    });
    const log = { info: vi.fn(), error: vi.fn() };

    await installationCreatedLabelBootstrapHandler.handle(
      createEvent(
        "installation.created",
        {
          repositories: [
            {
              owner: { login: "hivemoot" },
              name: "repo-drift",
              full_name: "hivemoot/repo-drift",
            },
          ],
        },
        octokit,
        log,
      ),
      {},
    );

    expect(octokit.rest.issues.updateLabel).toHaveBeenCalledTimes(1);
    expect(octokit.rest.issues.updateLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "hivemoot",
        repo: "repo-drift",
        name: driftedLabel.name,
        color: REQUIRED_REPOSITORY_LABELS[0].color,
      }),
    );
    expect(octokit.rest.issues.createLabel).toHaveBeenCalledTimes(REQUIRED_REPOSITORY_LABELS.length - 1);
    expect(log.info).toHaveBeenCalledWith(
      `[installation.created] Label bootstrap summary: reposProcessed=1, reposFailed=0, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length - 1}, labelsRenamed=0, labelsUpdated=1, labelsSkipped=0`,
    );
  });

  it("uses fallback listing when installation.created payload omits repositories", async () => {
    const fallbackRepositories = [
      { name: "repo-c", full_name: "hivemoot/repo-c" },
      { name: "repo-d", full_name: "hivemoot/repo-d" },
    ];
    const octokit = createInstallationOctokit({ fallbackRepositories });
    const log = { info: vi.fn(), error: vi.fn() };

    await installationCreatedLabelBootstrapHandler.handle(
      createEvent("installation.created", {}, octokit, log),
      {},
    );

    expect(octokit.rest.apps.listReposAccessibleToInstallation).toHaveBeenCalledWith({
      per_page: 100,
      page: 1,
    });
    expect(octokit.rest.issues.createLabel).toHaveBeenCalledTimes(
      REQUIRED_REPOSITORY_LABELS.length * fallbackRepositories.length,
    );
    expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "repo-c" }),
    );
    expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "repo-d" }),
    );
    expect(log.info).toHaveBeenCalledWith(
      `[installation.created] Label bootstrap summary: reposProcessed=2, reposFailed=0, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length * fallbackRepositories.length}, labelsRenamed=0, labelsUpdated=0, labelsSkipped=0`,
    );
  });

  it("paginates fallback installation repository listing", async () => {
    const pageOneRepositories = Array.from({ length: 100 }, (_, index) => ({
      name: `repo-${index + 1}`,
      full_name: `hivemoot/repo-${index + 1}`,
    }));
    const pageTwoRepositories = [{ name: "repo-101", full_name: "hivemoot/repo-101" }];
    const octokit = createInstallationOctokit({
      fallbackRepositoryPages: [pageOneRepositories, pageTwoRepositories],
    });
    const log = { info: vi.fn(), error: vi.fn() };

    await installationCreatedLabelBootstrapHandler.handle(
      createEvent("installation.created", {}, octokit, log),
      {},
    );

    expect(octokit.rest.apps.listReposAccessibleToInstallation).toHaveBeenNthCalledWith(1, {
      per_page: 100,
      page: 1,
    });
    expect(octokit.rest.apps.listReposAccessibleToInstallation).toHaveBeenNthCalledWith(2, {
      per_page: 100,
      page: 2,
    });
    expect(octokit.rest.apps.listReposAccessibleToInstallation).toHaveBeenCalledTimes(2);
    expect(octokit.rest.issues.createLabel).toHaveBeenCalledTimes(REQUIRED_REPOSITORY_LABELS.length * 101);
    expect(log.info).toHaveBeenCalledWith(
      `[installation.created] Label bootstrap summary: reposProcessed=101, reposFailed=0, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length * 101}, labelsRenamed=0, labelsUpdated=0, labelsSkipped=0`,
    );
  });

  it("uses fallback listing when installation_repositories.added payload is empty", async () => {
    const fallbackRepositories = [{ name: "repo-e", full_name: "hivemoot/repo-e" }];
    const octokit = createInstallationOctokit({ fallbackRepositories });
    const log = { info: vi.fn(), error: vi.fn() };

    await installationRepositoriesAddedLabelBootstrapHandler.handle(
      createEvent("installation_repositories.added", { repositories_added: [] }, octokit, log),
      {},
    );

    expect(octokit.rest.apps.listReposAccessibleToInstallation).toHaveBeenCalledWith({
      per_page: 100,
      page: 1,
    });
    expect(octokit.rest.issues.createLabel).toHaveBeenCalledTimes(REQUIRED_REPOSITORY_LABELS.length);
    expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "repo-e" }),
    );
    expect(log.info).toHaveBeenCalledWith(
      `[installation_repositories.added] Label bootstrap summary: reposProcessed=1, reposFailed=0, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length}, labelsRenamed=0, labelsUpdated=0, labelsSkipped=0`,
    );
  });

  it("logs summary and throws aggregate error when a repository bootstrap fails", async () => {
    const octokit = createInstallationOctokit({
      createLabelImpl: async (params) => {
        if (params.repo === "repo-fail") {
          throw new Error("boom");
        }
        return {};
      },
    });
    const log = { info: vi.fn(), error: vi.fn() };

    await expect(
      installationCreatedLabelBootstrapHandler.handle(
        createEvent(
          "installation.created",
          {
            repositories: [
              { name: "repo-ok", full_name: "hivemoot/repo-ok" },
              { name: "repo-fail", full_name: "hivemoot/repo-fail" },
            ],
          },
          octokit,
          log,
        ),
        {},
      ),
    ).rejects.toThrow("1 repository label bootstrap operation(s) failed");

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      `[installation.created] Label bootstrap summary: reposProcessed=2, reposFailed=1, labelsCreated=${REQUIRED_REPOSITORY_LABELS.length}, labelsRenamed=0, labelsUpdated=0, labelsSkipped=0`,
    );
  });

  it("throws when repository owner cannot be derived from full_name", async () => {
    const octokit = createInstallationOctokit();
    const log = { info: vi.fn(), error: vi.fn() };

    await expect(
      installationCreatedLabelBootstrapHandler.handle(
        createEvent(
          "installation.created",
          {
            repositories: [
              { name: "repo-no-owner", full_name: "/repo-no-owner" },
            ],
          },
          octokit,
          log,
        ),
        {},
      ),
    ).rejects.toThrow("Unable to determine repository owner");
  });

  it("throws a clear error when installation repository listing client is missing", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const event: HandlerEvent = {
      name: "installation.created",
      context: {
        octokit: null,
        log,
        payload: {},
      },
    };

    await expect(
      installationCreatedLabelBootstrapHandler.handle(event, {}),
    ).rejects.toThrow(
      "[installation.created] Unable to list installation repositories: missing apps.listReposAccessibleToInstallation",
    );
  });

  it("logs zero-summary and returns when fallback repository listing is empty", async () => {
    const octokit = createInstallationOctokit({
      fallbackRepositoryPages: [[]],
    });
    const log = { info: vi.fn(), error: vi.fn() };

    await installationCreatedLabelBootstrapHandler.handle(
      createEvent("installation.created", {}, octokit, log),
      {},
    );

    expect(octokit.rest.issues.createLabel).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "[installation.created] No installation repositories available; skipping label bootstrap",
    );
    expect(log.info).toHaveBeenCalledWith(
      "[installation.created] Label bootstrap summary: reposProcessed=0, reposFailed=0, labelsCreated=0, labelsRenamed=0, labelsUpdated=0, labelsSkipped=0",
    );
  });
});
