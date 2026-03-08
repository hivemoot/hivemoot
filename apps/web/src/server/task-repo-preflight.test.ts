import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/env", () => ({ validateEnv: vi.fn() }));
vi.mock("@/server/github-auth", () => ({ generateAppJwt: vi.fn() }));

import { validateEnv } from "@/server/env";
import { generateAppJwt } from "@/server/github-auth";
import {
  preflightTaskRepos,
  TASK_REPO_PREFLIGHT_UNAVAILABLE_MESSAGE,
  TASK_REPO_UNAVAILABLE_MESSAGE,
} from "./task-repo-preflight";

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
  vi.clearAllMocks();

  vi.mocked(validateEnv).mockReturnValue({
    ok: true,
    config: {
      redisRestUrl: "https://redis.example",
      redisRestToken: "token",
      githubAppId: "99",
      githubAppPrivateKey: "private-key",
      githubClientId: "Iv1.test",
      githubClientSecret: "secret",
      byokActiveKeyVersion: "v1",
      byokMasterKeysJson: '{"v1":"' + "a".repeat(64) + '"}',
      siteUrl: "https://example.com",
      nodeEnv: "production",
    },
  });
  vi.mocked(generateAppJwt).mockReturnValue("app-jwt");
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("preflightTaskRepos", () => {
  it("accepts repos that belong to the active installation", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 123 }),
    } as Response);

    await expect(preflightTaskRepos(["hivemoot/hivemoot"], "123")).resolves.toEqual({ ok: true });

    expect(generateAppJwt).toHaveBeenCalledWith("99", "private-key");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/hivemoot/hivemoot/installation",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer app-jwt",
          "X-GitHub-Api-Version": "2022-11-28",
        }),
      }),
    );
  });

  it("rejects repos that are not installed for the current app selection", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response);

    await expect(preflightTaskRepos(["hivemoot/private"], "123")).resolves.toEqual({
      ok: false,
      reason: "repo_unavailable",
      message: TASK_REPO_UNAVAILABLE_MESSAGE,
    });
  });

  it("rejects repos when GitHub returns a different installation id", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 999 }),
    } as Response);

    await expect(preflightTaskRepos(["hivemoot/hivemoot"], "123")).resolves.toEqual({
      ok: false,
      reason: "repo_unavailable",
      message: TASK_REPO_UNAVAILABLE_MESSAGE,
    });
  });

  it("fails the whole request when any repo in a multi-repo task is unavailable", async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 123 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({}),
      } as Response);

    await expect(
      preflightTaskRepos(["hivemoot/hivemoot", "hivemoot/private"], "123"),
    ).resolves.toEqual({
      ok: false,
      reason: "repo_unavailable",
      message: TASK_REPO_UNAVAILABLE_MESSAGE,
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed when GitHub App credentials are unavailable", async () => {
    vi.mocked(validateEnv).mockReturnValue({
      ok: true,
      config: {
        redisRestUrl: "https://redis.example",
        redisRestToken: "token",
        githubAppId: undefined,
        githubAppPrivateKey: undefined,
        githubClientId: "Iv1.test",
        githubClientSecret: "secret",
        byokActiveKeyVersion: "v1",
        byokMasterKeysJson: '{"v1":"' + "a".repeat(64) + '"}',
        siteUrl: "https://example.com",
        nodeEnv: "production",
      },
    });

    await expect(preflightTaskRepos(["hivemoot/hivemoot"], "123")).resolves.toEqual({
      ok: false,
      reason: "server_error",
      message: TASK_REPO_PREFLIGHT_UNAVAILABLE_MESSAGE,
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fails closed when GitHub App JWT generation throws", async () => {
    vi.mocked(generateAppJwt).mockImplementation(() => {
      throw new Error("bad private key");
    });

    await expect(preflightTaskRepos(["hivemoot/hivemoot"], "123")).resolves.toEqual({
      ok: false,
      reason: "server_error",
      message: TASK_REPO_PREFLIGHT_UNAVAILABLE_MESSAGE,
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fails closed when GitHub returns malformed installation JSON", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("invalid JSON");
      },
    } as unknown as Response);

    await expect(preflightTaskRepos(["hivemoot/hivemoot"], "123")).resolves.toEqual({
      ok: false,
      reason: "server_error",
      message: TASK_REPO_PREFLIGHT_UNAVAILABLE_MESSAGE,
    });
  });
});
