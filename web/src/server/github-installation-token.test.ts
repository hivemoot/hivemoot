import { describe, it, expect, vi, beforeEach } from "vitest";

// Inject a mock for generateAppJwt so tests don't need a real RSA key.
vi.mock("@/server/github-auth", () => ({
  generateAppJwt: vi.fn(() => "fake.jwt.token"),
}));

import { generateAppJwt } from "@/server/github-auth";
import {
  mintInstallationToken,
  intersectPermissions,
  V1_PERMISSIONS,
  AppCredentialError,
  InstallationNotCoverageError,
  GitHubRateLimitedError,
  GitHubUnavailableError,
  InvalidMintRequestError,
  type MintOptions,
} from "./github-installation-token";
import type { GitHubPermissionLevel } from "./agent-token";

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

  it("computes hashed_token as base64 SHA-256 of the token", async () => {
    // Audit-correlation hash. Deterministic for a fixed token; lets
    // backend audit logs and apiarist mint logs cross-reference the
    // same token without either side holding the secret.
    const fetcher = vi.fn().mockResolvedValue(fakeResponse(201, successBody()));

    const result = await mintInstallationToken(VALID_OPTIONS, fetcher);

    const { createHash } = await import("crypto");
    const expected = createHash("sha256")
      .update("ghs_test_minted_token_value", "utf8")
      .digest("base64");
    expect(result.hashed_token).toBe(expected);
    // Sanity-check the shape: SHA-256 base64 is 44 chars, ends in "=".
    expect(result.hashed_token).toMatch(/^[A-Za-z0-9+/]{43}=$/);
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

  it("AppCredentialError keeps GitHub error text in internalDetail, not message", async () => {
    // Defense-in-depth: GitHub's response body (and any future
    // upstream error that grows a sensitive field) goes to
    // internalDetail for server-side logging; the public .message
    // is a fixed string the wire is allowed to see.
    const fetcher = vi.fn().mockResolvedValue(
      fakeResponse(401, { message: "this would be a leaky upstream error" }),
    );

    const err = await mintInstallationToken(VALID_OPTIONS, fetcher).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(AppCredentialError);
    expect(err.message).toBe(
      "Hivemoot Bot App credential rejected; see backend logs for details.",
    );
    expect(err.internalDetail).toMatch(/401/);
  });

  it("AppCredentialError from generateAppJwt also keeps detail server-side", async () => {
    // Same separation for the JWT-generation path. Imagine a future
    // Node openssl error echoing PEM bytes in `.message` — that text
    // ends up in internalDetail (logged server-side, never on the
    // wire), and the public .message stays the fixed string.
    mockJwt.mockImplementation(() => {
      throw new Error(
        "ASN1 parse error: -----BEGIN RSA PRIVATE KEY----- malformed",
      );
    });
    const fetcher = vi.fn();

    const err = await mintInstallationToken(VALID_OPTIONS, fetcher).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(AppCredentialError);
    expect(err.message).toBe(
      "Hivemoot Bot App credential rejected; see backend logs for details.",
    );
    expect(err.internalDetail).toContain("ASN1 parse error");
    // Critically: the wire-visible `.message` does NOT contain any
    // of the would-be-leaky fragments.
    expect(err.message).not.toContain("ASN1");
    expect(err.message).not.toContain("PRIVATE KEY");
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

// ---------------------------------------------------------------------------
// V1.6 — intersectPermissions helper
// ---------------------------------------------------------------------------

describe("intersectPermissions (V1.6)", () => {
  it("undefined narrow → returns defaults verbatim (V1.5 path)", () => {
    expect(intersectPermissions(V1_PERMISSIONS, undefined)).toEqual(V1_PERMISSIONS);
  });

  it("returns a fresh object (not the same reference as defaults)", () => {
    const result = intersectPermissions(V1_PERMISSIONS, undefined);
    expect(result).not.toBe(V1_PERMISSIONS);
  });

  it("token requesting same level as default → no change", () => {
    expect(
      intersectPermissions(V1_PERMISSIONS, {
        contents: "read",
        pull_requests: "write",
      }),
    ).toEqual(V1_PERMISSIONS);
  });

  it("token narrowing pull_requests: write → read", () => {
    const result = intersectPermissions(V1_PERMISSIONS, {
      pull_requests: "read",
    });
    expect(result.pull_requests).toBe("read");
    expect(result.contents).toBe("read");
    expect(result.issues).toBe("write");
    expect(result.metadata).toBe("read");
  });

  it("token requesting HIGHER than default → silently capped at default (no escalation)", () => {
    const result = intersectPermissions(V1_PERMISSIONS, {
      contents: "write",
    });
    expect(result.contents).toBe("read");
  });

  it("token requesting admin → still capped at default level for that permission", () => {
    const result = intersectPermissions(V1_PERMISSIONS, {
      pull_requests: "admin",
    });
    expect(result.pull_requests).toBe("write");
  });

  it("token mentioning a permission NOT in defaults is silently dropped + warned", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = intersectPermissions(V1_PERMISSIONS, {
      administration: "write" as GitHubPermissionLevel,
      contents: "read",
    });
    expect(Object.keys(result).sort()).toEqual(
      Object.keys(V1_PERMISSIONS).sort(),
    );
    expect(result).not.toHaveProperty("administration");
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("administration"),
    );
    consoleWarn.mockRestore();
  });

  it("read-only worker preset (all read) → all permissions = read", () => {
    const readOnlyPolicy: Record<string, GitHubPermissionLevel> = {
      contents: "read",
      pull_requests: "read",
      issues: "read",
      metadata: "read",
    };
    expect(intersectPermissions(V1_PERMISSIONS, readOnlyPolicy)).toEqual({
      contents: "read",
      pull_requests: "read",
      issues: "read",
      metadata: "read",
    });
  });
});

// ---------------------------------------------------------------------------
// V1.6 — mint with allowedPermissions
// ---------------------------------------------------------------------------

describe("mintInstallationToken — V1.6 allowedPermissions", () => {
  beforeEach(() => {
    mockJwt.mockClear();
    mockJwt.mockReturnValue("fake.jwt.token");
  });

  it("V1.5 path: omitted allowedPermissions sends V1_PERMISSIONS verbatim", async () => {
    const fetcher = vi.fn().mockResolvedValue(fakeResponse(201, successBody()));
    await mintInstallationToken(VALID_OPTIONS, fetcher);

    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.permissions).toEqual(V1_PERMISSIONS);
  });

  it("read-only worker: narrows pull_requests + issues to read", async () => {
    const fetcher = vi.fn().mockResolvedValue(fakeResponse(201, successBody()));
    await mintInstallationToken(
      {
        ...VALID_OPTIONS,
        allowedPermissions: {
          contents: "read",
          pull_requests: "read",
          issues: "read",
          metadata: "read",
        },
      },
      fetcher,
    );

    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.permissions).toEqual({
      contents: "read",
      pull_requests: "read",
      issues: "read",
      metadata: "read",
    });
  });

  it("attempt to escalate (write where default is read) is silently capped", async () => {
    const fetcher = vi.fn().mockResolvedValue(fakeResponse(201, successBody()));
    await mintInstallationToken(
      {
        ...VALID_OPTIONS,
        allowedPermissions: { contents: "write" },
      },
      fetcher,
    );

    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.permissions.contents).toBe("read");
  });

  it("partial narrow leaves unspecified defaults intact", async () => {
    const fetcher = vi.fn().mockResolvedValue(fakeResponse(201, successBody()));
    await mintInstallationToken(
      {
        ...VALID_OPTIONS,
        allowedPermissions: { pull_requests: "read" },
      },
      fetcher,
    );

    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.permissions).toEqual({
      contents: "read",
      pull_requests: "read",   // narrowed
      issues: "write",         // unchanged from V1_PERMISSIONS
      metadata: "read",
    });
  });
});
