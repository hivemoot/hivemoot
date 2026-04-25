import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/server/agent-health-auth", () => ({
  authenticateAgentRequest: vi.fn(),
}));
vi.mock("@/server/github-installation-token", async () => {
  // Re-export the typed errors from the real module so tests can
  // construct realistic instances; only mint itself is mocked.
  const real = await vi.importActual<
    typeof import("@/server/github-installation-token")
  >("@/server/github-installation-token");
  return {
    ...real,
    mintInstallationToken: vi.fn(),
  };
});

import { authenticateAgentRequest } from "@/server/agent-health-auth";
import {
  mintInstallationToken,
  AppCredentialError,
  InstallationNotCoverageError,
  GitHubRateLimitedError,
  GitHubUnavailableError,
  InvalidMintRequestError,
} from "@/server/github-installation-token";
import { POST } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequest);
const mockedMint = vi.mocked(mintInstallationToken);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown, opts: { json?: boolean } = {}): NextRequest {
  // Note: don't annotate as RequestInit — Next.js's spec-extension type
  // differs slightly from the DOM lib's (signal nullability), and TS
  // strict mode rejects the cross-type assignment. Inline the object.
  const reqBody = opts.json !== false ? JSON.stringify(body) : (body as BodyInit);
  return new NextRequest(
    "https://www.hivemoot.dev/api/github/installation-tokens",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: reqBody,
    },
  );
}

function authOk(installationId = "67890") {
  return {
    ok: true as const,
    installationId,
    redis: {} as never,
  };
}

function authFailure(status = 401, code = "agent_health_not_authenticated") {
  return {
    ok: false as const,
    response: NextResponse.json({ code, message: "denied" }, { status }),
  };
}

function successMint() {
  return {
    token: "ghs_e2e_test_token",
    expires_at: "2026-04-25T19:30:00Z",
    installation_id: "67890",
    permissions: { contents: "read", pull_requests: "write" },
    repositories: [{ full_name: "owner/repo", id: 12345 }],
  };
}

// Stash original env so per-test mutations don't bleed.
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  mockedAuth.mockReset();
  mockedMint.mockReset();
  // Provide minimum env so server-misconfig branch doesn't fire.
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_APP_PRIVATE_KEY = "fake-pem";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// Auth (runs first — must reject before body inspection)
// ---------------------------------------------------------------------------

describe("POST /api/github/installation-tokens — auth", () => {
  it("returns 401 when bearer auth fails", async () => {
    mockedAuth.mockResolvedValue(authFailure());

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(401);
    expect(mockedMint).not.toHaveBeenCalled();
  });

  it("authenticates BEFORE inspecting body — bad auth + bad body yields 401", async () => {
    mockedAuth.mockResolvedValue(authFailure());

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

describe("POST /api/github/installation-tokens — body validation", () => {
  it("returns 400 when body is malformed JSON", async () => {
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(makeRequest("not-json", { json: false }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_request");
    expect(mockedMint).not.toHaveBeenCalled();
  });

  it("returns 400 when repo field is missing", async () => {
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(400);
  });

  it("returns 400 when repo field is empty / whitespace", async () => {
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(makeRequest({ repo: "   " }));

    expect(res.status).toBe(400);
  });

  it("returns 400 when repo field is wrong type", async () => {
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(makeRequest({ repo: 12345 }));

    expect(res.status).toBe(400);
  });

  it("trims surrounding whitespace from repo before passing to mint", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockResolvedValue(successMint());

    await POST(makeRequest({ repo: "  owner/repo  " }));

    expect(mockedMint).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "owner/repo" }),
    );
  });

  it("rejects 400 when agent_id is the wrong type", async () => {
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(
      makeRequest({ repo: "owner/repo", agent_id: 12345 }),
    );

    expect(res.status).toBe(400);
  });

  it("accepts optional agent_id field as a string", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockResolvedValue(successMint());

    const res = await POST(
      makeRequest({ repo: "owner/repo", agent_id: "builder-claude" }),
    );

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Server-config gate
// ---------------------------------------------------------------------------

describe("POST /api/github/installation-tokens — server config", () => {
  it("returns 503 when GITHUB_APP_ID env is missing", async () => {
    delete process.env.GITHUB_APP_ID;
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("server_misconfiguration");
    expect(mockedMint).not.toHaveBeenCalled();
  });

  it("returns 503 when GITHUB_APP_PRIVATE_KEY env is missing", async () => {
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    mockedAuth.mockResolvedValue(authOk());

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Mint success
// ---------------------------------------------------------------------------

describe("POST /api/github/installation-tokens — happy path", () => {
  it("returns 200 with the mint response", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockResolvedValue(successMint());

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe("ghs_e2e_test_token");
    expect(body.expires_at).toBe("2026-04-25T19:30:00Z");
    expect(body.installation_id).toBe("67890");
    expect(body.permissions).toEqual({
      contents: "read",
      pull_requests: "write",
    });
    expect(body.repositories).toEqual([{ full_name: "owner/repo", id: 12345 }]);
  });

  it("passes installation_id from auth + repo from body to mintInstallationToken", async () => {
    mockedAuth.mockResolvedValue(authOk("99999"));
    mockedMint.mockResolvedValue(successMint());

    await POST(makeRequest({ repo: "hivemoot/hivemoot" }));

    expect(mockedMint).toHaveBeenCalledWith({
      installationId: "99999",
      repo: "hivemoot/hivemoot",
      appId: "12345",
      appPrivateKeyPem: "fake-pem",
    });
  });
});

// ---------------------------------------------------------------------------
// Mint error mapping
// ---------------------------------------------------------------------------

describe("POST /api/github/installation-tokens — mint error mapping", () => {
  it("InstallationNotCoverageError → 403 with structured envelope", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockRejectedValue(new InstallationNotCoverageError("owner/repo"));

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("installation_not_coverage");
    expect(body.message).toContain("owner/repo");
  });

  it("GitHubRateLimitedError → 429", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockRejectedValue(new GitHubRateLimitedError());

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("github_rate_limited");
  });

  it("AppCredentialError → 503 (server misconfig)", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockRejectedValue(new AppCredentialError("Bad credentials"));

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("app_credential_invalid");
  });

  it("GitHubUnavailableError → 502", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockRejectedValue(new GitHubUnavailableError("HTTP 503"));

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("github_unavailable");
  });

  it("InvalidMintRequestError → 400", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockRejectedValue(new InvalidMintRequestError("malformed"));

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(400);
  });

  it("unexpected non-MintError → 500 (caught + logged, not leaked)", async () => {
    mockedAuth.mockResolvedValue(authOk());
    mockedMint.mockRejectedValue(new Error("totally unexpected"));

    const res = await POST(makeRequest({ repo: "owner/repo" }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal_error");
    // Critically: the unexpected error message is NOT echoed in the response,
    // only logged. Backend doesn't leak internals to apiarist.
    expect(body.message).not.toContain("totally unexpected");
  });
});
