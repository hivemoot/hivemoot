import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OnboardingService,
  createOnboardingService,
  ONBOARDING_BRANCH,
  type OnboardingClient,
} from "./onboarding.js";

function makeClient(): { client: OnboardingClient; mocks: ReturnType<typeof buildMocks> } {
  const mocks = buildMocks();
  const client: OnboardingClient = {
    rest: {
      repos: {
        get: mocks.reposGet,
        getContent: mocks.reposGetContent,
        createOrUpdateFileContents: mocks.reposCreateOrUpdateFileContents,
      },
      git: {
        getRef: mocks.gitGetRef,
        createRef: mocks.gitCreateRef,
      },
      pulls: {
        list: mocks.pullsList,
        create: mocks.pullsCreate,
      },
    },
  };
  return { client, mocks };
}

function buildMocks() {
  return {
    reposGet: vi.fn().mockResolvedValue({
      data: { default_branch: "main", archived: false, disabled: false },
    }),
    reposGetContent: vi.fn().mockRejectedValue({ status: 404 }),
    reposCreateOrUpdateFileContents: vi.fn().mockResolvedValue({}),
    gitGetRef: vi.fn().mockResolvedValue({
      data: { object: { sha: "abc1234" } },
    }),
    gitCreateRef: vi.fn().mockResolvedValue({}),
    pullsList: vi.fn().mockResolvedValue({ data: [] }),
    pullsCreate: vi.fn().mockResolvedValue({
      data: { number: 42, html_url: "https://github.com/owner/repo/pull/42" },
    }),
  };
}

describe("createOnboardingService", () => {
  it("should throw on null", () => {
    expect(() => createOnboardingService(null)).toThrow();
  });

  it("should throw when rest.repos methods are missing", () => {
    expect(() => createOnboardingService({ rest: { git: {}, pulls: {} } })).toThrow();
  });

  it("should throw when rest.git methods are missing", () => {
    const { client } = makeClient();
    const broken = { ...client, rest: { ...client.rest, git: {} } };
    expect(() => createOnboardingService(broken)).toThrow();
  });

  it("should return a service for a valid client", () => {
    const { client } = makeClient();
    expect(createOnboardingService(client)).toBeInstanceOf(OnboardingService);
  });
});

describe("OnboardingService.createOnboardingPR", () => {
  let service: OnboardingService;
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(() => {
    const built = makeClient();
    service = new OnboardingService(built.client);
    mocks = built.mocks;
  });

  it("should skip archived repos", async () => {
    mocks.reposGet.mockResolvedValue({ data: { default_branch: "main", archived: true, disabled: false } });

    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: true, reason: "archived" });
    expect(mocks.pullsCreate).not.toHaveBeenCalled();
  });

  it("should skip disabled repos", async () => {
    mocks.reposGet.mockResolvedValue({ data: { default_branch: "main", archived: false, disabled: true } });

    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: true, reason: "disabled" });
    expect(mocks.pullsCreate).not.toHaveBeenCalled();
  });

  it("should skip when config file already exists", async () => {
    mocks.reposGetContent.mockResolvedValue({ data: { type: "file" } });

    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: true, reason: "config-exists" });
    expect(mocks.pullsCreate).not.toHaveBeenCalled();
  });

  it("should skip when an open onboarding PR already exists", async () => {
    mocks.pullsList.mockResolvedValue({
      data: [{ number: 7, html_url: "https://github.com/owner/repo/pull/7", state: "open" }],
    });

    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: true, reason: "pr-exists", prNumber: 7, prUrl: "https://github.com/owner/repo/pull/7" });
    expect(mocks.pullsCreate).not.toHaveBeenCalled();
  });

  it("should skip when a closed (dismissed) onboarding PR exists", async () => {
    mocks.pullsList.mockResolvedValue({
      data: [{ number: 8, html_url: "https://github.com/owner/repo/pull/8", state: "closed" }],
    });

    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: true, reason: "pr-dismissed", prNumber: 8, prUrl: "https://github.com/owner/repo/pull/8" });
    expect(mocks.pullsCreate).not.toHaveBeenCalled();
  });

  it("should skip empty repos (404 on getRef)", async () => {
    mocks.gitGetRef.mockRejectedValue({ status: 404 });

    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: true, reason: "empty-repo" });
    expect(mocks.pullsCreate).not.toHaveBeenCalled();
  });

  it("should create branch, file, and PR for fresh repos", async () => {
    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: false, prNumber: 42, prUrl: "https://github.com/owner/repo/pull/42" });

    expect(mocks.gitGetRef).toHaveBeenCalledWith({ owner: "owner", repo: "repo", ref: "heads/main" });
    expect(mocks.gitCreateRef).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      ref: `refs/heads/${ONBOARDING_BRANCH}`,
      sha: "abc1234",
    });
    expect(mocks.reposCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        path: ".github/hivemoot.yml",
        branch: ONBOARDING_BRANCH,
      })
    );
    expect(mocks.pullsCreate).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      title: "Configure Hivemoot",
      body: expect.stringContaining("Welcome to Hivemoot"),
      head: ONBOARDING_BRANCH,
      base: "main",
    });
  });

  it("should use base64-encoded content for the config file", async () => {
    await service.createOnboardingPR("owner", "repo");

    const call = mocks.reposCreateOrUpdateFileContents.mock.calls[0][0] as { content: string };
    const decoded = Buffer.from(call.content, "base64").toString("utf-8");
    expect(decoded).toContain("version: 1");
    expect(decoded).toContain("governance:");
  });

  it("should handle branch-already-exists (422 on createRef) and continue", async () => {
    mocks.gitCreateRef.mockRejectedValue({ status: 422 });

    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: false, prNumber: 42, prUrl: "https://github.com/owner/repo/pull/42" });
    expect(mocks.reposCreateOrUpdateFileContents).toHaveBeenCalled();
    expect(mocks.pullsCreate).toHaveBeenCalled();
  });

  it("should handle file-already-on-branch (422 on createOrUpdateFileContents) and continue", async () => {
    mocks.reposCreateOrUpdateFileContents.mockRejectedValue({ status: 422 });

    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: false, prNumber: 42, prUrl: "https://github.com/owner/repo/pull/42" });
    expect(mocks.pullsCreate).toHaveBeenCalled();
  });

  it("should propagate non-422 errors from createRef", async () => {
    mocks.gitCreateRef.mockRejectedValue({ status: 500 });

    await expect(service.createOnboardingPR("owner", "repo")).rejects.toEqual({ status: 500 });
    expect(mocks.pullsCreate).not.toHaveBeenCalled();
  });

  it("should propagate non-404 errors from getRef", async () => {
    mocks.gitGetRef.mockRejectedValue({ status: 500 });

    await expect(service.createOnboardingPR("owner", "repo")).rejects.toEqual({ status: 500 });
  });

  it("should propagate non-404 errors from getContent", async () => {
    mocks.reposGetContent.mockRejectedValue({ status: 403 });

    await expect(service.createOnboardingPR("owner", "repo")).rejects.toEqual({ status: 403 });
  });

  it("should use the repo's actual default branch (not hardcoded main)", async () => {
    mocks.reposGet.mockResolvedValue({ data: { default_branch: "master", archived: false, disabled: false } });

    await service.createOnboardingPR("owner", "repo");

    expect(mocks.gitGetRef).toHaveBeenCalledWith({ owner: "owner", repo: "repo", ref: "heads/master" });
    expect(mocks.pullsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ base: "master" })
    );
  });

  it("should query all PR states by owner:branch head format", async () => {
    await service.createOnboardingPR("owner", "repo");

    expect(mocks.pullsList).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      state: "all",
      head: `owner:${ONBOARDING_BRANCH}`,
      per_page: 1,
    });
  });

  it("should handle PR-already-exists (422 on pulls.create) and return skipped", async () => {
    mocks.pullsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [{ number: 99, html_url: "https://github.com/owner/repo/pull/99", state: "open" }],
      });
    mocks.pullsCreate.mockRejectedValue({ status: 422 });

    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: true, reason: "pr-exists", prNumber: 99, prUrl: "https://github.com/owner/repo/pull/99" });
    expect(mocks.pullsList).toHaveBeenCalledTimes(2);
  });

  it("should handle PR-dismissed (422 on pulls.create) and re-query finds closed PR", async () => {
    mocks.pullsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [{ number: 100, html_url: "https://github.com/owner/repo/pull/100", state: "closed" }],
      });
    mocks.pullsCreate.mockRejectedValue({ status: 422 });

    const result = await service.createOnboardingPR("owner", "repo");

    expect(result).toEqual({ skipped: true, reason: "pr-dismissed", prNumber: 100, prUrl: "https://github.com/owner/repo/pull/100" });
    expect(mocks.pullsList).toHaveBeenCalledTimes(2);
  });

  it("should rethrow 422 from pulls.create if re-query finds no PR", async () => {
    mocks.pullsList.mockResolvedValue({ data: [] });
    mocks.pullsCreate.mockRejectedValue({ status: 422 });

    await expect(service.createOnboardingPR("owner", "repo")).rejects.toEqual({ status: 422 });
  });

  it("should propagate non-422 errors from createOrUpdateFileContents", async () => {
    mocks.reposCreateOrUpdateFileContents.mockRejectedValue({ status: 500 });

    await expect(service.createOnboardingPR("owner", "repo")).rejects.toEqual({ status: 500 });
    expect(mocks.pullsCreate).not.toHaveBeenCalled();
  });

  it("should propagate non-422 errors from pulls.create", async () => {
    mocks.pullsCreate.mockRejectedValue({ status: 500 });

    await expect(service.createOnboardingPR("owner", "repo")).rejects.toEqual({ status: 500 });
  });
});
