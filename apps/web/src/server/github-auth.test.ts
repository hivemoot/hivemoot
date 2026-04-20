import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, createVerify } from "crypto";
import {
  buildOAuthAuthorizeUrl,
  isSafeNextPath,
  getOAuthStateCookieOptions,
  generateAppJwt,
  exchangeOAuthCode,
  getAuthenticatedUser,
  generateInstallationToken,
  getInstallation,
  getUserInstallations,
  checkOrgAdmin,
  GITHUB_AUTHORIZE_URL,
  OAUTH_STATE_COOKIE_MAX_AGE,
} from "./github-auth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string, init?: RequestInit) =>
      Promise.resolve(handler(url, init)),
    ),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// buildOAuthAuthorizeUrl
// ---------------------------------------------------------------------------

describe("buildOAuthAuthorizeUrl", () => {
  it("returns a URL pointing to the GitHub authorize endpoint", () => {
    const url = buildOAuthAuthorizeUrl("client-id", "https://example.com/callback", "state-nonce");
    expect(url.origin + url.pathname).toBe(GITHUB_AUTHORIZE_URL);
  });

  it("encodes client_id, redirect_uri, state, and scope as query params", () => {
    const url = buildOAuthAuthorizeUrl(
      "my-client",
      "https://app.example.com/api/callback",
      "xyz789",
    );
    expect(url.searchParams.get("client_id")).toBe("my-client");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/api/callback");
    expect(url.searchParams.get("state")).toBe("xyz789");
    expect(url.searchParams.get("scope")).toBe("read:org");
  });

  it("returns a URL object (not a string)", () => {
    const result = buildOAuthAuthorizeUrl("c", "https://r.example.com/cb", "s");
    expect(result).toBeInstanceOf(URL);
  });
});

// ---------------------------------------------------------------------------
// isSafeNextPath
// ---------------------------------------------------------------------------

describe("isSafeNextPath", () => {
  it("accepts ordinary same-origin paths", () => {
    expect(isSafeNextPath("/dashboard")).toBe(true);
    expect(isSafeNextPath("/dashboard/credentials")).toBe(true);
    expect(isSafeNextPath("/setup")).toBe(true);
    expect(isSafeNextPath("/")).toBe(true);
  });

  it("rejects protocol-relative URLs", () => {
    expect(isSafeNextPath("//evil.com")).toBe(false);
    expect(isSafeNextPath("//evil.com/steal")).toBe(false);
  });

  it("rejects strings that don't start with /", () => {
    expect(isSafeNextPath("https://evil.com")).toBe(false);
    expect(isSafeNextPath("http://evil.com/path")).toBe(false);
    expect(isSafeNextPath("evil.com")).toBe(false);
    expect(isSafeNextPath("")).toBe(false);
  });

  it("rejects backslash-relative paths (open-redirect bypass)", () => {
    expect(isSafeNextPath("/\\evil.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getOAuthStateCookieOptions
// ---------------------------------------------------------------------------

describe("getOAuthStateCookieOptions", () => {
  it("returns httpOnly true, sameSite lax, and path /", () => {
    const opts = getOAuthStateCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.path).toBe("/");
  });

  it("maxAge matches the OAUTH_STATE_COOKIE_MAX_AGE constant (600 seconds)", () => {
    const opts = getOAuthStateCookieOptions();
    expect(opts.maxAge).toBe(OAUTH_STATE_COOKIE_MAX_AGE);
    expect(opts.maxAge).toBe(600);
  });

  it("secure is false outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    const opts = getOAuthStateCookieOptions();
    expect(opts.secure).toBe(false);
    vi.unstubAllEnvs();
  });

  it("secure is true in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const opts = getOAuthStateCookieOptions();
    expect(opts.secure).toBe(true);
    vi.unstubAllEnvs();
  });
});

// ---------------------------------------------------------------------------
// generateAppJwt
// ---------------------------------------------------------------------------

describe("generateAppJwt", () => {
  let privateKey: string;
  let publicKey: string;

  beforeAll(() => {
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
  });

  function decodeJwtPart(b64url: string): unknown {
    return JSON.parse(Buffer.from(b64url, "base64url").toString("utf-8"));
  }

  it("returns a three-part JWT string", () => {
    const jwt = generateAppJwt("app-123", privateKey);
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("header encodes alg RS256 and typ JWT", () => {
    const jwt = generateAppJwt("app-123", privateKey);
    const [headerPart] = jwt.split(".");
    expect(decodeJwtPart(headerPart)).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("payload contains iss matching the provided appId", () => {
    const jwt = generateAppJwt("my-github-app-42", privateKey);
    const [, payloadPart] = jwt.split(".");
    const payload = decodeJwtPart(payloadPart) as Record<string, unknown>;
    expect(payload.iss).toBe("my-github-app-42");
  });

  it("payload exp is 660 seconds after iat (600s validity + 60s clock-skew backdating)", () => {
    const jwt = generateAppJwt("app-id", privateKey);
    const [, payloadPart] = jwt.split(".");
    const payload = decodeJwtPart(payloadPart) as { iat: number; exp: number };
    expect(payload.exp - payload.iat).toBe(660);
  });

  it("iat is backdated ~60 seconds relative to current time", () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = generateAppJwt("app-id", privateKey);
    const after = Math.floor(Date.now() / 1000);
    const [, payloadPart] = jwt.split(".");
    const { iat } = decodeJwtPart(payloadPart) as { iat: number };
    // iat should be roughly (now - 60), allowing 2s of test jitter
    expect(iat).toBeGreaterThanOrEqual(before - 62);
    expect(iat).toBeLessThanOrEqual(after - 58);
  });

  it("signature verifies against the corresponding public key", () => {
    const jwt = generateAppJwt("app-123", privateKey);
    const lastDot = jwt.lastIndexOf(".");
    const signingInput = jwt.slice(0, lastDot);
    const signature = jwt.slice(lastDot + 1);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingInput);
    expect(verifier.verify(publicKey, signature, "base64url")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// exchangeOAuthCode
// ---------------------------------------------------------------------------

describe("exchangeOAuthCode", () => {
  it("returns the access_token on a successful response", async () => {
    mockFetch(() => jsonResponse({ access_token: "ghu_token123" }));
    const token = await exchangeOAuthCode("code-abc", "client-id", "client-secret");
    expect(token).toBe("ghu_token123");
  });

  it("posts to the GitHub token endpoint with correct Accept header", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    mockFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse({ access_token: "tok" });
    });

    await exchangeOAuthCode("my-code", "cid", "csecret");
    expect(capturedUrl).toBe("https://github.com/login/oauth/access_token");
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>)["Accept"]).toBe("application/json");
  });

  it("throws the error_description when GitHub returns an error field", async () => {
    mockFetch(() =>
      jsonResponse({
        error: "bad_verification_code",
        error_description: "The code is invalid.",
      }),
    );
    await expect(exchangeOAuthCode("bad-code", "cid", "csec")).rejects.toThrow(
      "The code is invalid.",
    );
  });

  it("falls back to the error name when error_description is absent", async () => {
    mockFetch(() => jsonResponse({ error: "bad_verification_code" }));
    await expect(exchangeOAuthCode("code", "cid", "csec")).rejects.toThrow(
      "bad_verification_code",
    );
  });

  it("throws when access_token is missing from the response", async () => {
    mockFetch(() => jsonResponse({}));
    await expect(exchangeOAuthCode("code", "cid", "csec")).rejects.toThrow(
      "No access_token in GitHub response",
    );
  });

  it("throws when the GitHub token endpoint returns a non-OK status", async () => {
    mockFetch(() => new Response(null, { status: 500 }));
    await expect(exchangeOAuthCode("code", "cid", "csec")).rejects.toThrow(
      "GitHub token endpoint returned 500",
    );
  });
});

// ---------------------------------------------------------------------------
// getAuthenticatedUser
// ---------------------------------------------------------------------------

describe("getAuthenticatedUser", () => {
  it("returns login and id on a successful response", async () => {
    mockFetch(() => jsonResponse({ login: "alice", id: 42, name: "Alice (ignored)" }));
    const user = await getAuthenticatedUser("ghu_token");
    expect(user).toEqual({ login: "alice", id: 42 });
  });

  it("sends Authorization header with Bearer scheme", async () => {
    let capturedInit: RequestInit | undefined;
    mockFetch((_, init) => {
      capturedInit = init;
      return jsonResponse({ login: "bob", id: 7 });
    });

    await getAuthenticatedUser("my-user-token");
    expect((capturedInit?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer my-user-token",
    );
  });

  it("throws on non-OK status", async () => {
    mockFetch(() => new Response(null, { status: 401 }));
    await expect(getAuthenticatedUser("bad-token")).rejects.toThrow(
      "GitHub /user returned 401",
    );
  });
});

// ---------------------------------------------------------------------------
// generateInstallationToken
// ---------------------------------------------------------------------------

describe("generateInstallationToken", () => {
  it("returns the token on a successful response", async () => {
    mockFetch(() => jsonResponse({ token: "ghs_install_token" }));
    const token = await generateInstallationToken("456", "app-jwt");
    expect(token).toBe("ghs_install_token");
  });

  it("calls the correct installation access_tokens endpoint", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return jsonResponse({ token: "tok" });
    });

    await generateInstallationToken("789", "jwt");
    expect(capturedUrl).toBe(
      "https://api.github.com/app/installations/789/access_tokens",
    );
  });

  it("sends the app JWT as Authorization Bearer", async () => {
    let capturedInit: RequestInit | undefined;
    mockFetch((_, init) => {
      capturedInit = init;
      return jsonResponse({ token: "tok" });
    });

    await generateInstallationToken("1", "my-app-jwt");
    expect((capturedInit?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer my-app-jwt",
    );
  });

  it("throws when token is missing from the response", async () => {
    mockFetch(() => jsonResponse({}));
    await expect(generateInstallationToken("1", "jwt")).rejects.toThrow(
      "No token in GitHub installation token response",
    );
  });

  it("throws on non-OK status", async () => {
    mockFetch(() => new Response(null, { status: 403 }));
    await expect(generateInstallationToken("1", "jwt")).rejects.toThrow(
      "GitHub installation token endpoint returned 403",
    );
  });
});

// ---------------------------------------------------------------------------
// getInstallation
// ---------------------------------------------------------------------------

describe("getInstallation", () => {
  it("returns account login and type on success", async () => {
    mockFetch(() =>
      jsonResponse({ account: { login: "my-org", type: "Organization" } }),
    );
    const installation = await getInstallation("111", "jwt");
    expect(installation.account.login).toBe("my-org");
    expect(installation.account.type).toBe("Organization");
  });

  it("throws with installation-not-found message on 404", async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    await expect(getInstallation("999", "jwt")).rejects.toThrow(
      "Installation 999 not found",
    );
  });

  it("throws on other non-OK statuses", async () => {
    mockFetch(() => new Response(null, { status: 500 }));
    await expect(getInstallation("1", "jwt")).rejects.toThrow(
      "GitHub /app/installations returned 500",
    );
  });

  it("calls the correct installations endpoint", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return jsonResponse({ account: { login: "org", type: "Organization" } });
    });

    await getInstallation("42", "jwt");
    expect(capturedUrl).toBe("https://api.github.com/app/installations/42");
  });
});

// ---------------------------------------------------------------------------
// getUserInstallations
// ---------------------------------------------------------------------------

describe("getUserInstallations", () => {
  const APP_ID = "12345";

  it("returns installations matching the app_id", async () => {
    mockFetch(() =>
      jsonResponse({
        installations: [
          { id: 1, app_id: 12345, account: { login: "alice", type: "User" } },
          { id: 2, app_id: 99999, account: { login: "other-app", type: "Organization" } },
          { id: 3, app_id: 12345, account: { login: "my-org", type: "Organization" } },
        ],
      }),
    );

    const result = await getUserInstallations("token", APP_ID);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
    expect(result[1].id).toBe(3);
  });

  it("returns an empty array when no installations match app_id", async () => {
    mockFetch(() =>
      jsonResponse({
        installations: [
          { id: 5, app_id: 99999, account: { login: "other", type: "Organization" } },
        ],
      }),
    );

    const result = await getUserInstallations("token", APP_ID);
    expect(result).toHaveLength(0);
  });

  it("returns an empty array when the list is empty", async () => {
    mockFetch(() => jsonResponse({ installations: [] }));
    const result = await getUserInstallations("token", APP_ID);
    expect(result).toHaveLength(0);
  });

  it("throws on non-OK status", async () => {
    mockFetch(() => new Response(null, { status: 401 }));
    await expect(getUserInstallations("bad-token", APP_ID)).rejects.toThrow(
      "GitHub /user/installations returned 401",
    );
  });
});

// ---------------------------------------------------------------------------
// checkOrgAdmin
// ---------------------------------------------------------------------------

describe("checkOrgAdmin", () => {
  it("returns true when the user is an active admin", async () => {
    mockFetch(() => jsonResponse({ role: "admin", state: "active" }));
    const result = await checkOrgAdmin("token", "my-org");
    expect(result).toBe(true);
  });

  it("returns false when the role is member (not admin)", async () => {
    mockFetch(() => jsonResponse({ role: "member", state: "active" }));
    const result = await checkOrgAdmin("token", "my-org");
    expect(result).toBe(false);
  });

  it("returns false when the state is pending (not active)", async () => {
    mockFetch(() => jsonResponse({ role: "admin", state: "pending" }));
    const result = await checkOrgAdmin("token", "my-org");
    expect(result).toBe(false);
  });

  it("returns false on 404 (user is not a member)", async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    const result = await checkOrgAdmin("token", "my-org");
    expect(result).toBe(false);
  });

  it("returns false on 403 (user lacks permission to read membership)", async () => {
    mockFetch(() => new Response(null, { status: 403 }));
    const result = await checkOrgAdmin("token", "my-org");
    expect(result).toBe(false);
  });

  it("throws on unexpected API errors", async () => {
    mockFetch(() => new Response(null, { status: 500 }));
    await expect(checkOrgAdmin("token", "my-org")).rejects.toThrow(
      "GitHub org membership check returned 500",
    );
  });

  it("calls the org membership endpoint for the correct org", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return jsonResponse({ role: "admin", state: "active" });
    });

    await checkOrgAdmin("token", "my-specific-org");
    expect(capturedUrl).toBe(
      "https://api.github.com/user/memberships/orgs/my-specific-org",
    );
  });
});
