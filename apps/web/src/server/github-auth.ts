/**
 * GitHub authentication helpers.
 *
 * - generateAppJwt: creates a short-lived GitHub App JWT (RS256) for App-level API calls
 * - exchangeOAuthCode: exchanges an OAuth authorization code for a user access token
 * - getAuthenticatedUser: fetches the authenticated GitHub user's identity
 * - getInstallation: fetches installation metadata using the App JWT
 * - checkOrgAdmin: verifies the user holds an "admin" role in the target org
 * - buildAuthorizeRedirect: builds the GitHub OAuth authorization redirect response
 * - isSafeNextPath: validates that a `next` param is a safe same-origin path
 */

import { createSign } from "crypto";
import { NextResponse } from "next/server";
import { OAUTH_STATE_BINDING_COOKIE } from "@/server/setup-session";

// ---------------------------------------------------------------------------
// OAuth start helpers (shared between /start and /start-discover)
// ---------------------------------------------------------------------------

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
/** OAuth scope requested from GitHub — read-only org membership check. */
export const GITHUB_OAUTH_SCOPE = "read:org";
/** Cookie max-age for the state binding cookie (10 min, aligned with Redis state TTL). */
export const OAUTH_STATE_COOKIE_MAX_AGE = 600;

/**
 * Validates that `next` is a safe same-origin path.
 * Blocks protocol-relative URLs (//evil.com), backslash-relative URLs (/\evil.com),
 * and absolute URLs.
 */
export function isSafeNextPath(next: string): boolean {
  return next.startsWith("/") && !next.startsWith("//") && !next.includes("\\");
}

/**
 * Builds the GitHub OAuth authorization redirect response with the state-binding cookie.
 *
 * @param callbackUrl - The OAuth callback URL to pass to GitHub.
 * @param clientId    - The GitHub OAuth App client ID.
 * @param state       - The random state nonce (stored in Redis).
 * @param stateBinding - The HMAC binding stored in the browser cookie.
 * @param isProduction - Whether to set the Secure flag on the cookie.
 */
export function buildAuthorizeRedirect(
  callbackUrl: string,
  clientId: string,
  state: string,
  stateBinding: string,
  isProduction: boolean,
): NextResponse {
  const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("scope", GITHUB_OAUTH_SCOPE);

  const response = NextResponse.redirect(authorizeUrl.toString());
  response.cookies.set(OAUTH_STATE_BINDING_COOKIE, stateBinding, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: OAUTH_STATE_COOKIE_MAX_AGE,
    path: "/",
  });
  return response;
}

// ---------------------------------------------------------------------------
// App JWT
// ---------------------------------------------------------------------------

/**
 * Generates a short-lived GitHub App JWT signed with the app's RSA private key.
 * Valid for 10 minutes; `iat` is backdated 60 s to absorb clock skew.
 */
export function generateAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString("base64url");

  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(privateKeyPem, "base64url");

  return `${signingInput}.${signature}`;
}

// ---------------------------------------------------------------------------
// OAuth code exchange
// ---------------------------------------------------------------------------

/**
 * Exchanges a GitHub OAuth `code` for a user access token.
 * Throws on a GitHub-level error (e.g. bad code, expired code).
 */
export async function exchangeOAuthCode(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token endpoint returned ${response.status}`);
  }

  const data = (await response.json()) as { access_token?: string; error?: string; error_description?: string };

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }
  if (!data.access_token) {
    throw new Error("No access_token in GitHub response");
  }

  return data.access_token;
}

// ---------------------------------------------------------------------------
// User identity
// ---------------------------------------------------------------------------

export interface GitHubUser {
  login: string;
  id: number;
}

/**
 * Fetches the identity of the user represented by `userToken`.
 */
export async function getAuthenticatedUser(userToken: string): Promise<GitHubUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${userToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub /user returned ${response.status}`);
  }

  const data = (await response.json()) as { login: string; id: number };
  return { login: data.login, id: data.id };
}

// ---------------------------------------------------------------------------
// Installation access token
// ---------------------------------------------------------------------------

/**
 * Exchanges a GitHub App JWT for a short-lived installation access token.
 *
 * Installation tokens are valid for 1 hour and authorize API calls scoped
 * to a specific installation (read/write repos the App is installed on).
 * Use these — not the App JWT — for GitHub Contents API calls.
 */
export async function generateInstallationToken(
  installationId: string,
  appJwt: string,
): Promise<string> {
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${appJwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub installation token endpoint returned ${response.status}`);
  }

  const data = (await response.json()) as { token: string };
  if (!data.token) {
    throw new Error("No token in GitHub installation token response");
  }
  return data.token;
}

// ---------------------------------------------------------------------------
// Installation metadata
// ---------------------------------------------------------------------------

export interface GitHubInstallation {
  account: {
    login: string;
    /** "Organization" or "User" */
    type: string;
  };
}

/**
 * Fetches installation metadata using the App JWT.
 * The installation endpoint is only accessible with App-level credentials,
 * not a user access token, which is why we generate the JWT here.
 */
export async function getInstallation(
  installationId: string,
  appJwt: string,
): Promise<GitHubInstallation> {
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${appJwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (response.status === 404) {
    throw new Error(`Installation ${installationId} not found`);
  }
  if (!response.ok) {
    throw new Error(`GitHub /app/installations returned ${response.status}`);
  }

  const data = (await response.json()) as {
    account: { login: string; type: string };
  };
  return { account: { login: data.account.login, type: data.account.type } };
}

// ---------------------------------------------------------------------------
// Installation discovery (for users who already have the app installed)
// ---------------------------------------------------------------------------

export interface UserInstallation {
  id: number;
  app_id: number;
  account: {
    login: string;
    type: string;
  };
}

/**
 * Lists the authenticated user's installations of a specific GitHub App.
 *
 * Uses `GET /user/installations` which returns all app installations the user
 * can access, then filters by app_id so we only return our own.
 */
export async function getUserInstallations(
  userToken: string,
  appId: string,
): Promise<UserInstallation[]> {
  const response = await fetch("https://api.github.com/user/installations", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${userToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub /user/installations returned ${response.status}`);
  }

  const data = (await response.json()) as {
    installations: Array<{
      id: number;
      app_id: number;
      account: { login: string; type: string };
    }>;
  };

  return data.installations.filter((i) => String(i.app_id) === appId);
}

// ---------------------------------------------------------------------------
// Authorization checks
// ---------------------------------------------------------------------------

/**
 * Returns true if the user has the "admin" role in the target org.
 */
export async function checkOrgAdmin(userToken: string, org: string): Promise<boolean> {
  const response = await fetch(
    `https://api.github.com/user/memberships/orgs/${org}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${userToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (response.status === 404 || response.status === 403) {
    // User is not a member or doesn't have permission to read membership
    return false;
  }
  if (!response.ok) {
    throw new Error(`GitHub org membership check returned ${response.status}`);
  }

  const data = (await response.json()) as { role: string; state: string };
  return data.role === "admin" && data.state === "active";
}
