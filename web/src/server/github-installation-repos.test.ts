/**
 * Tests for listInstallationRepos — enumerates an installation's accessible
 * repos via a whole-install mint + paginated `GET /installation/repositories`.
 *
 * NOTE on the test seam: the implementation goes through `fetch` (matching this
 * codebase's GitHub I/O convention — no GitHub call site uses an octokit
 * client), reads App credentials via `@/server/env`, and signs the App JWT via
 * `@/server/github-auth`. We mock the env + JWT signer and inject a fake fetcher
 * via the function's optional `fetcher` param (the same seam `mintInstallationToken`
 * uses). Asserted: pagination aggregates pages, the 60s cache avoids a second
 * fetch, and any failure throws `InstallationReposError` (fail-closed).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/env", () => ({
  // Mirrors the real `validateEnv` return shape: { ok: true, config: {...} }.
  validateEnv: vi.fn(() => ({
    ok: true,
    config: {
      githubAppId: "123",
      githubAppPrivateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
    },
  })),
}));

vi.mock("@/server/github-auth", () => ({
  generateAppJwt: vi.fn(() => "jwt-token"),
}));

import { validateEnv } from "@/server/env";
import { generateAppJwt } from "@/server/github-auth";
import {
  listInstallationRepos,
  InstallationReposError,
  __clearInstallationReposCache,
} from "@/server/github-installation-repos";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A mint response (201) carrying a `token`. */
function mintResponse(token = "ghs_install"): Response {
  return jsonResponse({ token, expires_at: "2099-01-01T00:00:00Z" }, 201);
}

beforeEach(() => {
  vi.clearAllMocks();
  __clearInstallationReposCache();
});

describe("listInstallationRepos", () => {
  it("mints a whole-install token (no repositories narrowing) then aggregates pages", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      // 1) mint
      .mockResolvedValueOnce(mintResponse())
      // 2) page 1 (full page of 100; here we shorten to 2 with total_count 3)
      .mockResolvedValueOnce(
        jsonResponse({
          total_count: 3,
          repositories: [{ full_name: "owner/a" }, { full_name: "owner/b" }],
        }),
      )
      // 3) page 2 (the remaining 1)
      .mockResolvedValueOnce(
        jsonResponse({ total_count: 3, repositories: [{ full_name: "owner/c" }] }),
      );

    const repos = await listInstallationRepos("inst-1", fetcher as unknown as typeof fetch);
    expect(repos).toEqual(["owner/a", "owner/b", "owner/c"]);

    // Credentials were read and the JWT signed.
    expect(validateEnv).toHaveBeenCalled();
    expect(generateAppJwt).toHaveBeenCalledWith("123", expect.stringContaining("BEGIN PRIVATE KEY"));

    // Mint POST carried an empty body (NO `repositories` narrowing → whole install).
    const [mintUrl, mintInit] = fetcher.mock.calls[0];
    expect(String(mintUrl)).toContain("/app/installations/inst-1/access_tokens");
    expect((mintInit as RequestInit).method).toBe("POST");
    expect(JSON.parse((mintInit as RequestInit).body as string)).toEqual({});

    // List GETs used the minted token with the `token` auth scheme.
    const [listUrl, listInit] = fetcher.mock.calls[1];
    expect(String(listUrl)).toContain("/installation/repositories?per_page=100&page=1");
    expect((listInit as RequestInit).method).toBe("GET");
    const headers = (listInit as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("token ghs_install");

    // 1 mint + 2 list pages = 3 calls.
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("caches a successful result for 60s — a second call within TTL does not re-fetch", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mintResponse())
      .mockResolvedValueOnce(jsonResponse({ total_count: 1, repositories: [{ full_name: "owner/a" }] }));

    const first = await listInstallationRepos("inst-cache", fetcher as unknown as typeof fetch);
    expect(first).toEqual(["owner/a"]);
    expect(fetcher).toHaveBeenCalledTimes(2);

    const second = await listInstallationRepos("inst-cache", fetcher as unknown as typeof fetch);
    expect(second).toEqual(["owner/a"]);
    // No additional fetch — served from cache.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns a defensive copy (mutating the result does not poison the cache)", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mintResponse())
      .mockResolvedValueOnce(jsonResponse({ total_count: 1, repositories: [{ full_name: "owner/a" }] }));

    const first = await listInstallationRepos("inst-copy", fetcher as unknown as typeof fetch);
    first.push("attacker/injected");
    const second = await listInstallationRepos("inst-copy", fetcher as unknown as typeof fetch);
    expect(second).toEqual(["owner/a"]);
  });

  it("fail-closed: mint non-201 → InstallationReposError, nothing cached", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ error: "no" }, 403));
    await expect(
      listInstallationRepos("inst-mintfail", fetcher as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(InstallationReposError);

    // A subsequent successful attempt must re-fetch (the failure was NOT cached).
    fetcher
      .mockResolvedValueOnce(mintResponse())
      .mockResolvedValueOnce(jsonResponse({ total_count: 1, repositories: [{ full_name: "owner/a" }] }));
    const repos = await listInstallationRepos("inst-mintfail", fetcher as unknown as typeof fetch);
    expect(repos).toEqual(["owner/a"]);
  });

  it("fail-closed: list page non-200 → InstallationReposError", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mintResponse())
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));
    await expect(
      listInstallationRepos("inst-listfail", fetcher as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(InstallationReposError);
  });

  it("fail-closed: malformed page body (missing full_name) → InstallationReposError", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mintResponse())
      .mockResolvedValueOnce(jsonResponse({ total_count: 1, repositories: [{ id: 5 }] }));
    await expect(
      listInstallationRepos("inst-malformed", fetcher as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(InstallationReposError);
  });

  it("fail-closed: network error while minting → InstallationReposError", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("ECONNREFUSED"));
    await expect(
      listInstallationRepos("inst-neterr", fetcher as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(InstallationReposError);
  });

  it("NEVER logs the minted installation token (success path)", async () => {
    const SECRET = "ghs_super_secret_install_token_value";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mintResponse(SECRET))
      .mockResolvedValueOnce(jsonResponse({ total_count: 1, repositories: [{ full_name: "owner/a" }] }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    try {
      const repos = await listInstallationRepos("inst-logsafe", fetcher as unknown as typeof fetch);
      expect(repos).toEqual(["owner/a"]);

      const allLogged = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls, ...debugSpy.mock.calls]
        .flat()
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" ");
      expect(allLogged).not.toContain(SECRET);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it("NEVER logs the minted installation token (error path: list page 500)", async () => {
    const SECRET = "ghs_secret_on_error_path";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mintResponse(SECRET))
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    try {
      await expect(
        listInstallationRepos("inst-logsafe-err", fetcher as unknown as typeof fetch),
      ).rejects.toBeInstanceOf(InstallationReposError);

      const allLogged = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls, ...debugSpy.mock.calls]
        .flat()
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" ");
      expect(allLogged).not.toContain(SECRET);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });
});
