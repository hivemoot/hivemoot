import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("octokit", () => ({
  App: vi.fn(),
  Octokit: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  setFailed: vi.fn(),
}));

vi.mock("../../api/lib/env-validation.js", () => ({
  getAppConfig: vi.fn().mockReturnValue({
    appId: 12345,
    privateKey: "test-private-key",
  }),
}));

vi.mock("../../api/lib/index.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    group: vi.fn(),
    groupEnd: vi.fn(),
  },
}));

import { App } from "octokit";
import * as core from "@actions/core";
import { logger } from "../../api/lib/index.js";
import { getAppConfig } from "../../api/lib/env-validation.js";
import { runForAllRepositories, runIfMain } from "./run-installations.js";

type MockInstallation = { id: number; account?: { login?: string } };
type MockRepo = { full_name: string; owner: { login: string }; name: string };

describe("run-installations shared runner", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let originalArgv1: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalArgv1 = process.argv[1];
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    process.argv[1] = originalArgv1;
    exitSpy.mockRestore();
  });

  function setupAppMock(params: {
    installations: MockInstallation[];
    installationRepos?: Record<number, MockRepo[]>;
    installationFailures?: number[];
  }): void {
    const { installations, installationRepos = {}, installationFailures = [] } = params;

    const appMock = {
      octokit: {
        paginate: vi.fn().mockResolvedValue(installations),
        rest: { apps: { listInstallations: vi.fn() } },
      },
      getInstallationOctokit: vi.fn(async (installationId: number) => {
        if (installationFailures.includes(installationId)) {
          throw new Error(`installation failure ${installationId}`);
        }
        return {
          paginate: vi
            .fn()
            .mockResolvedValue(installationRepos[installationId] ?? []),
          rest: { apps: { listReposAccessibleToInstallation: vi.fn() } },
        };
      }),
    };

    // App is instantiated with `new` in production code, so the mock must be constructible.
    vi.mocked(App).mockImplementation(function MockApp() {
      return appMock as never;
    } as unknown as typeof App);
  }

  it("processes multiple installations/repos and reports aggregate results", async () => {
    setupAppMock({
      installations: [
        { id: 1, account: { login: "org-one" } },
        { id: 2, account: { login: "org-two" } },
      ],
      installationRepos: {
        1: [
          { full_name: "org-one/repo-a", owner: { login: "org-one" }, name: "repo-a" },
          { full_name: "org-one/repo-b", owner: { login: "org-one" }, name: "repo-b" },
        ],
        2: [
          { full_name: "org-two/repo-c", owner: { login: "org-two" }, name: "repo-c" },
        ],
      },
    });

    const processRepository = vi.fn(async (_octokit, repo: MockRepo, appId: number) => {
      return `${repo.full_name}:${appId}`;
    });
    const afterAll = vi.fn();

    await runForAllRepositories({
      scriptName: "test-runner",
      processRepository,
      afterAll,
    });

    expect(processRepository).toHaveBeenCalledTimes(3);
    expect(processRepository).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ full_name: "org-one/repo-a" }),
      12345,
      { installationId: 1, installationLogin: "org-one" }
    );
    expect(processRepository).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ full_name: "org-one/repo-b" }),
      12345,
      { installationId: 1, installationLogin: "org-one" }
    );
    expect(processRepository).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.objectContaining({ full_name: "org-two/repo-c" }),
      12345,
      { installationId: 2, installationLogin: "org-two" }
    );
    expect(afterAll).toHaveBeenCalledWith({
      results: [
        { repo: "org-one/repo-a", result: "org-one/repo-a:12345" },
        { repo: "org-one/repo-b", result: "org-one/repo-b:12345" },
        { repo: "org-two/repo-c", result: "org-two/repo-c:12345" },
      ],
      failedRepos: [],
    });
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "Done - test-runner completed successfully"
    );
  });

  it("isolates repo failures, continues processing, then fails with repo summary", async () => {
    setupAppMock({
      installations: [{ id: 1, account: { login: "org" } }],
      installationRepos: {
        1: [
          { full_name: "org/repo-1", owner: { login: "org" }, name: "repo-1" },
          { full_name: "org/repo-2", owner: { login: "org" }, name: "repo-2" },
          { full_name: "org/repo-3", owner: { login: "org" }, name: "repo-3" },
        ],
      },
    });

    const processRepository = vi
      .fn()
      .mockResolvedValueOnce("ok-1")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok-3");
    const afterAll = vi.fn();

    await expect(
      runForAllRepositories({
        scriptName: "test-runner",
        processRepository,
        afterAll,
      })
    ).rejects.toThrow("process.exit:1");

    expect(processRepository).toHaveBeenCalledTimes(3);
    expect(afterAll).toHaveBeenCalledWith({
      results: [
        { repo: "org/repo-1", result: "ok-1" },
        { repo: "org/repo-3", result: "ok-3" },
      ],
      failedRepos: ["org/repo-2"],
    });
    expect(core.setFailed).toHaveBeenCalledWith("Failed to process: org/repo-2");
  });

  it("handles installation-level failures and reports generic installation error", async () => {
    setupAppMock({
      installations: [
        { id: 1, account: { login: "broken-org" } },
        { id: 2, account: { login: "ok-org" } },
      ],
      installationFailures: [1],
      installationRepos: {
        2: [
          { full_name: "ok-org/repo-a", owner: { login: "ok-org" }, name: "repo-a" },
        ],
      },
    });

    const processRepository = vi.fn().mockResolvedValue("ok");
    const afterAll = vi.fn();

    await expect(
      runForAllRepositories({
        scriptName: "test-runner",
        processRepository,
        afterAll,
      })
    ).rejects.toThrow("process.exit:1");

    expect(processRepository).toHaveBeenCalledTimes(1);
    expect(afterAll).toHaveBeenCalledWith({
      results: [{ repo: "ok-org/repo-a", result: "ok" }],
      failedRepos: [],
    });
    expect(core.setFailed).toHaveBeenCalledWith("Some installations failed to process");
  });

  it("prioritizes failed repo summary when both installation and repo failures occur", async () => {
    setupAppMock({
      installations: [
        { id: 1, account: { login: "broken-org" } },
        { id: 2, account: { login: "mixed-org" } },
      ],
      installationFailures: [1],
      installationRepos: {
        2: [
          { full_name: "mixed-org/repo-a", owner: { login: "mixed-org" }, name: "repo-a" },
          { full_name: "mixed-org/repo-b", owner: { login: "mixed-org" }, name: "repo-b" },
        ],
      },
    });

    const processRepository = vi
      .fn()
      .mockRejectedValueOnce(new Error("repo failure"))
      .mockResolvedValueOnce("ok");
    const afterAll = vi.fn();

    await expect(
      runForAllRepositories({
        scriptName: "test-runner",
        processRepository,
        afterAll,
      })
    ).rejects.toThrow("process.exit:1");

    expect(processRepository).toHaveBeenCalledTimes(2);
    expect(afterAll).toHaveBeenCalledWith({
      results: [{ repo: "mixed-org/repo-b", result: "ok" }],
      failedRepos: ["mixed-org/repo-a"],
    });
    expect(core.setFailed).toHaveBeenCalledWith("Failed to process: mixed-org/repo-a");
  });

  it("fails fast when app config loading throws", async () => {
    vi.mocked(getAppConfig).mockImplementationOnce(() => {
      throw new Error("Missing APP_ID");
    });

    await expect(
      runForAllRepositories({
        scriptName: "test-runner",
        processRepository: vi.fn(),
      })
    ).rejects.toThrow("process.exit:1");

    expect(core.setFailed).toHaveBeenCalledWith("Missing APP_ID");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("runIfMain", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let originalArgv1: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalArgv1 = process.argv[1];
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    process.argv[1] = originalArgv1;
    exitSpy.mockRestore();
  });

  it("runs main when caller URL matches process entry URL", async () => {
    process.argv[1] = "/tmp/scripts/example.ts";
    const main = vi.fn().mockResolvedValue(undefined);

    runIfMain("file:///tmp/scripts/example.ts", main);
    await Promise.resolve();

    expect(main).toHaveBeenCalledTimes(1);
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("skips main when caller URL does not match process entry URL", () => {
    process.argv[1] = "/tmp/scripts/not-this.ts";
    const main = vi.fn().mockResolvedValue(undefined);

    runIfMain("file:///tmp/scripts/example.ts", main);

    expect(main).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("marks workflow failed when main rejects", async () => {
    process.argv[1] = "/tmp/scripts/example.ts";
    exitSpy.mockImplementationOnce((() => undefined) as never);
    const main = vi.fn().mockRejectedValue(new Error("boom"));

    runIfMain("file:///tmp/scripts/example.ts", main);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(main).toHaveBeenCalledTimes(1);
    expect(core.setFailed).toHaveBeenCalledWith("Fatal error: boom");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
