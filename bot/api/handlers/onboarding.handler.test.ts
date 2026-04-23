import { describe, it, expect, vi } from "vitest";
import {
  installationCreatedOnboardingHandler,
  installationRepositoriesAddedOnboardingHandler,
} from "./onboarding.handler.js";
import type { HandlerEvent } from "./types.js";

function createOnboardingOctokit(options?: {
  archived?: boolean;
  configExists?: boolean;
  existingPR?: { number: number; html_url: string; state?: string } | null;
  headSha?: string;
  createRefError?: { status: number };
  createFileError?: { status: number };
  createPRResult?: { number: number; html_url: string };
  fallbackRepositories?: Array<{ name: string; full_name: string; owner?: { login?: string } | null }>;
}) {
  const archived = options?.archived ?? false;
  const configExists = options?.configExists ?? false;
  const existingPR = options?.existingPR ?? null;
  const headSha = options?.headSha ?? "abc1234";
  const createRefError = options?.createRefError ?? null;
  const createFileError = options?.createFileError ?? null;
  const createPRResult = options?.createPRResult ?? { number: 99, html_url: "https://github.com/o/r/pull/99" };
  const fallbackRepositories = options?.fallbackRepositories ?? [];

  return {
    rest: {
      repos: {
        get: vi.fn().mockResolvedValue({ data: { default_branch: "main", archived } }),
        getContent: configExists
          ? vi.fn().mockResolvedValue({})
          : vi.fn().mockRejectedValue({ status: 404 }),
        createOrUpdateFileContents: createFileError
          ? vi.fn().mockRejectedValue(createFileError)
          : vi.fn().mockResolvedValue({}),
      },
      git: {
        getRef: vi.fn().mockResolvedValue({ data: { object: { sha: headSha } } }),
        createRef: createRefError
          ? vi.fn().mockRejectedValue(createRefError)
          : vi.fn().mockResolvedValue({}),
      },
      pulls: {
        list: vi.fn().mockResolvedValue({ data: existingPR ? [existingPR] : [] }),
        create: vi.fn().mockResolvedValue({ data: createPRResult }),
      },
      apps: {
        listReposAccessibleToInstallation: vi.fn().mockResolvedValue({
          data: { repositories: fallbackRepositories },
        }),
      },
    },
  };
}

function createEvent(
  name: string,
  payload: Record<string, unknown>,
  octokit: ReturnType<typeof createOnboardingOctokit>,
  log: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> },
): HandlerEvent {
  return { name, context: { octokit, log, payload } };
}

describe("onboarding handlers", () => {
  it("creates onboarding PR for repos in installation.created payload", async () => {
    const octokit = createOnboardingOctokit();
    const log = { info: vi.fn(), error: vi.fn() };

    await installationCreatedOnboardingHandler.handle(
      createEvent(
        "installation.created",
        {
          repositories: [{ owner: { login: "acme" }, name: "app", full_name: "acme/app" }],
        },
        octokit,
        log,
      ),
      {},
    );

    expect(octokit.rest.pulls.create).toHaveBeenCalledOnce();
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "app" }),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("Onboarding PR #99 created for acme/app"),
    );
  });

  it("creates onboarding PR for repos in installation_repositories.added payload", async () => {
    const octokit = createOnboardingOctokit();
    const log = { info: vi.fn(), error: vi.fn() };

    await installationRepositoriesAddedOnboardingHandler.handle(
      createEvent(
        "installation_repositories.added",
        {
          repositories_added: [{ owner: { login: "acme" }, name: "app2", full_name: "acme/app2" }],
        },
        octokit,
        log,
      ),
      {},
    );

    expect(octokit.rest.pulls.create).toHaveBeenCalledOnce();
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "app2" }),
    );
  });

  it("fetches installation repos via fallback when installation.created has no repositories", async () => {
    const fallbackRepo = { owner: { login: "acme" }, name: "fallback", full_name: "acme/fallback" };
    const octokit = createOnboardingOctokit({ fallbackRepositories: [fallbackRepo] });
    const log = { info: vi.fn(), error: vi.fn() };

    await installationCreatedOnboardingHandler.handle(
      createEvent("installation.created", {}, octokit, log),
      {},
    );

    expect(octokit.rest.apps.listReposAccessibleToInstallation).toHaveBeenCalledOnce();
    expect(octokit.rest.pulls.create).toHaveBeenCalledOnce();
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "fallback" }),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("Repository list missing from payload; fetching installation repositories"),
    );
  });

  it("fetches installation repos via fallback when installation_repositories.added has empty repositories_added", async () => {
    const fallbackRepo = { owner: { login: "acme" }, name: "fallback2", full_name: "acme/fallback2" };
    const octokit = createOnboardingOctokit({ fallbackRepositories: [fallbackRepo] });
    const log = { info: vi.fn(), error: vi.fn() };

    await installationRepositoriesAddedOnboardingHandler.handle(
      createEvent("installation_repositories.added", { repositories_added: [] }, octokit, log),
      {},
    );

    expect(octokit.rest.apps.listReposAccessibleToInstallation).toHaveBeenCalledOnce();
    expect(octokit.rest.pulls.create).toHaveBeenCalledOnce();
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "fallback2" }),
    );
  });

  it("skips with log when fallback returns no repositories", async () => {
    const octokit = createOnboardingOctokit({ fallbackRepositories: [] });
    const log = { info: vi.fn(), error: vi.fn() };

    await installationCreatedOnboardingHandler.handle(
      createEvent("installation.created", {}, octokit, log),
      {},
    );

    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("No installation repositories available; skipping onboarding PR creation"),
    );
  });

  it("skips archived repositories", async () => {
    const octokit = createOnboardingOctokit({ archived: true });
    const log = { info: vi.fn(), error: vi.fn() };

    await installationCreatedOnboardingHandler.handle(
      createEvent(
        "installation.created",
        {
          repositories: [{ owner: { login: "acme" }, name: "archived", full_name: "acme/archived" }],
        },
        octokit,
        log,
      ),
      {},
    );

    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("skipped"),
    );
  });

  it("skips when config file already exists", async () => {
    const octokit = createOnboardingOctokit({ configExists: true });
    const log = { info: vi.fn(), error: vi.fn() };

    await installationCreatedOnboardingHandler.handle(
      createEvent(
        "installation.created",
        {
          repositories: [{ owner: { login: "acme" }, name: "configured", full_name: "acme/configured" }],
        },
        octokit,
        log,
      ),
      {},
    );

    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("config-exists"),
    );
  });

  it("skips when an open onboarding PR already exists", async () => {
    const existingPR = { number: 10, html_url: "https://github.com/acme/repo/pull/10" };
    const octokit = createOnboardingOctokit({ existingPR });
    const log = { info: vi.fn(), error: vi.fn() };

    await installationCreatedOnboardingHandler.handle(
      createEvent(
        "installation.created",
        {
          repositories: [{ owner: { login: "acme" }, name: "repo", full_name: "acme/repo" }],
        },
        octokit,
        log,
      ),
      {},
    );

    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("pr-exists"),
    );
  });

  it("logs error per repo but does not throw — other repos continue", async () => {
    const octokit = createOnboardingOctokit();
    octokit.rest.repos.get = vi.fn().mockRejectedValue(new Error("network failure"));
    const log = { info: vi.fn(), error: vi.fn() };

    await expect(
      installationCreatedOnboardingHandler.handle(
        createEvent(
          "installation.created",
          {
            repositories: [
              { owner: { login: "acme" }, name: "fail-repo", full_name: "acme/fail-repo" },
              { owner: { login: "acme" }, name: "ok-repo", full_name: "acme/ok-repo" },
            ],
          },
          octokit,
          log,
        ),
        {},
      ),
    ).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "acme/fail-repo" }),
      expect.stringContaining("Failed to create onboarding PR"),
    );
  });

  it("skips silently when onboarding service cannot be constructed", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const event: HandlerEvent = {
      name: "installation.created",
      context: {
        octokit: null,
        log,
        payload: {
          repositories: [{ owner: { login: "acme" }, name: "repo", full_name: "acme/repo" }],
        },
      },
    };

    await expect(
      installationCreatedOnboardingHandler.handle(event, {}),
    ).resolves.toBeUndefined();

    expect(log.info).toHaveBeenCalledWith(
      "[installation.created] Onboarding service unavailable; skipping onboarding PR creation",
    );
  });
});
