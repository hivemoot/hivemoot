import { describe, it, expect, vi, beforeEach } from "vitest";

// Inject a mock for generateAppJwt so tests don't need a real RSA key.
vi.mock("@/server/github-auth", () => ({
  generateAppJwt: vi.fn(() => "fake.jwt.token"),
}));

import { generateAppJwt } from "@/server/github-auth";
import {
  mintInstallationToken,
  V1_PERMISSIONS,
  AppCredentialError,
  InstallationNotCoverageError,
  GitHubRateLimitedError,
  GitHubUnavailableError,
  InvalidMintRequestError,
  type MintOptions,
} from "./github-installation-token";

const mockJwt = vi.mocked(generateAppJwt);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_OPTIONS: MintOptions = Object.freeze({
  installationId: "67890",
  repo: "owner/repo",
  appId: "12345",
  appPrivateKeyPem: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
});

function successBody(overrides: Record<string, unknown> = {}) {
  return {
    token: "ghs_test_minted_token_value",
    expires_at: "2026-04-25T19:23:00Z",
    permissions: { contents: "read", pull_requests: "write" },
    repositories: [{ id: 12345, full_name: "owner/repo" }],
    ...overrides,
  };
}

function fakeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  mockJwt.mockReset();
  mockJwt.mockReturnValue("fake.jwt.token");
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("mintInstallationToken — happy path", () => {
  it("returns the parsed token when GitHub responds 201", async () => {
    const fetcher = vi.fn().mockResolvedValue(fakeResponse(201, successBody()));

    const result = await mintInstallationToken(VALID_OPTIONS, fetcher);

    expect(result.token).toBe("ghs_test_minted_token_value");
    expect(result.expires_at).toBe("2026-04-25T19:23:00Z");
    expect(result.installation_id).toBe("67890");
    expect(result.permissions).toEqual({
      contents: "read",
      pull_requests: "write",
    });
    expect(result.repositories).toEqual([{ id: 12345, full_name: "owner/repo" }]);
  });

  it("calls GitHub with App JWT, narrowed perms, narrowed repo", async () => {
    const fetcher = vi.fn().mockResolvedValue(fakeResponse(201, successBody()));

    await mintInstallationToken(VALID_OPTIONS, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.github.com/app/installations/67890/access_tokens");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer fake.jwt.token");
    expect(init.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");

    const body = JSON.parse(init.body);
    // Only the short repo name — GitHub's API takes the unqualified name.
    expect(body.repositories).toEqual(["repo"]);
    // Hard-coded V1 permissions — must match apiarist's _V1_PERMISSIONS.
    expect(body.permissions).toEqual(V1_PERMISSIONS);
  });

  it("URL-encodes the installation_id (defense against header injection)", async () => {
    const fetcher = vi.fn().mockResolvedValue(fakeResponse(201, successBody()));

    await mintInstallationToken(
      { ...VALID_OPTIONS, installationId: "abc/../def" },
      fetcher,
    );

    const [url] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.github.com/app/installations/abc%2F..%2Fdef/access_tokens");
  });

  it("returns empty repositories array when GitHub omits the field", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      fakeResponse(201, successBody({ repositories: undefined })),
    );

    const result = await mintInstallationToken(VALID_OPTIONS, fetcher);

    expect(result.repositories).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Repo validation (pre-fetch)
// ---------------------------------------------------------------------------

describe("mintInstallationToken — repo validation", () => {
  it("throws InvalidMintRequestError when repo is missing the slash", async () => {
    const fetcher = vi.fn();

    await expect(
      mintInstallationToken({ ...VALID_OPTIONS, repo: "no-slash" }, fetcher),
    ).rejects.toBeInstanceOf(InvalidMintRequestError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("throws InvalidMintRequestError when repo has too many slashes", async () => {
    const fetcher = vi.fn();

    await expect(
      mintInstallationToken({ ...VALID_OPTIONS, repo: "owner/sub/name" }, fetcher),
    ).rejects.toBeInstanceOf(InvalidMintRequestError);
  });

  it("throws InvalidMintRequestError when repo half is empty", async () => {
    const fetcher = vi.fn();

    await expect(
      mintInstallationToken({ ...VALID_OPTIONS, repo: "/name" }, fetcher),
    ).rejects.toBeInstanceOf(InvalidMintRequestError);
    await expect(
      mintInstallationToken({ ...VALID_OPTIONS, repo: "owner/" }, fetcher),
    ).rejects.toBeInstanceOf(InvalidMintRequestError);
  });

  it("does NOT call generateAppJwt when repo is malformed (cheap-fail-first)", async () => {
    const fetcher = vi.fn();

    await expect(
      mintInstallationToken({ ...VALID_OPTIONS, repo: "bad" }, fetcher),
    ).rejects.toBeInstanceOf(InvalidMintRequestError);

    expect(mockJwt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// JWT generation failure
// ---------------------------------------------------------------------------

describe("mintInstallationToken — JWT generation failure", () => {
  it("throws AppCredentialError when generateAppJwt raises", async () => {
    mockJwt.mockImplementation(() => {
      throw new Error("malformed PEM");
    });
    const fetcher = vi.fn();

    await expect(
      mintInstallationToken(VALID_OPTIONS, fetcher),
    ).rejects.toBeInstanceOf(AppCredentialError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HTTP error mapping
// ---------------------------------------------------------------------------

describe("mintInstallationToken — HTTP error mapping", () => {
  it("401 → AppCredentialError (App JWT rejected, server misconfig)", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      fakeResponse(401, { message: "Bad credentials" }),
    );

    await expect(
      mintInstallationToken(VALID_OPTIONS, fetcher),
    ).rejects.toBeInstanceOf(AppCredentialError);
  });

  it("403 → InstallationNotCoverageError (policy or repo not covered)", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      fakeResponse(403, { message: "Resource not accessible" }),
    );

    const err = await mintInstallationToken(VALID_OPTIONS, fetcher).catch((e) => e);
    expect(err).toBeInstanceOf(InstallationNotCoverageError);
    expect(err.httpStatus).toBe(403);
    expect(err.message).toContain("owner/repo");
    expect(err.message).toMatch(/Hivemoot Bot is installed/i);
  });

  it("404 → InstallationNotCoverageError (repo or installation missing)", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      fakeResponse(404, { message: "Not Found" }),
    );

    await expect(
      mintInstallationToken(VALID_OPTIONS, fetcher),
    ).rejects.toBeInstanceOf(InstallationNotCoverageError);
  });

  it("422 → InvalidMintRequestError with GitHub detail in message", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      fakeResponse(422, { message: "permissions.foo is not valid" }),
    );

    const err = await mintInstallationToken(VALID_OPTIONS, fetcher).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidMintRequestError);
    expect(err.message).toMatch(/permissions\.foo/);
  });

  it("429 → GitHubRateLimitedError", async () => {
    const fetcher = vi.fn().mockResolvedValue(fakeResponse(429, {}));

    await expect(
      mintInstallationToken(VALID_OPTIONS, fetcher),
    ).rejects.toBeInstanceOf(GitHubRateLimitedError);
  });

  it("500 → GitHubUnavailableError (upstream)", async () => {
    const fetcher = vi.fn().mockResolvedValue(fakeResponse(500, {}));

    await expect(
      mintInstallationToken(VALID_OPTIONS, fetcher),
    ).rejects.toBeInstanceOf(GitHubUnavailableError);
  });

  it("502 → GitHubUnavailableError (upstream)", async () => {
    const fetcher = vi.fn().mockResolvedValue(fakeResponse(502, {}));

    await expect(
      mintInstallationToken(VALID_OPTIONS, fetcher),
    ).rejects.toBeInstanceOf(GitHubUnavailableError);
  });

  it("unexpected non-201 success status → GitHubUnavailableError", async () => {
    // 200 instead of 201 — GitHub spec is 201 Created. Any drift is a
    // signal of API change worth surfacing rather than silently accepting.
    const fetcher = vi.fn().mockResolvedValue(fakeResponse(200, successBody()));

    await expect(
      mintInstallationToken(VALID_OPTIONS, fetcher),
    ).rejects.toBeInstanceOf(GitHubUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// Network + parse failures
// ---------------------------------------------------------------------------

describe("mintInstallationToken — network + parse", () => {
  it("network failure → GitHubUnavailableError", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const err = await mintInstallationToken(VALID_OPTIONS, fetcher).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubUnavailableError);
    expect(err.message).toContain("ECONNREFUSED");
  });

  it("non-JSON body in 201 → GitHubUnavailableError", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response("not json", { status: 201 }),
    );

    await expect(
      mintInstallationToken(VALID_OPTIONS, fetcher),
    ).rejects.toBeInstanceOf(GitHubUnavailableError);
  });

  it("missing token field → GitHubUnavailableError", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      fakeResponse(201, { ...successBody(), token: undefined }),
    );

    const err = await mintInstallationToken(VALID_OPTIONS, fetcher).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubUnavailableError);
    expect(err.message).toMatch(/missing required fields/i);
  });

  it("missing expires_at → GitHubUnavailableError", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      fakeResponse(201, { ...successBody(), expires_at: undefined }),
    );

    await expect(
      mintInstallationToken(VALID_OPTIONS, fetcher),
    ).rejects.toBeInstanceOf(GitHubUnavailableError);
  });

  it("non-string permission value → GitHubUnavailableError", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      fakeResponse(201, {
        ...successBody(),
        permissions: { contents: 123 }, // wrong type
      }),
    );

    await expect(
      mintInstallationToken(VALID_OPTIONS, fetcher),
    ).rejects.toBeInstanceOf(GitHubUnavailableError);
  });

  it("repository entry missing full_name → GitHubUnavailableError", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      fakeResponse(201, {
        ...successBody(),
        repositories: [{ id: 12345 }], // missing full_name
      }),
    );

    await expect(
      mintInstallationToken(VALID_OPTIONS, fetcher),
    ).rejects.toBeInstanceOf(GitHubUnavailableError);
  });
});
