/**
 * GET /api/auth/github/callback
 *
 * Handles the GitHub OAuth callback after the user authorizes the app.
 *
 * Security sequence:
 * 1. Validate `state` against Redis — reject if unknown/expired (CSRF protection)
 * 2. Exchange `code` for a user access token
 * 2b. If state held the "discover" sentinel (user started from the "already installed"
 *     flow), resolve the real installationId via GET /user/installations
 * 3. Fetch authenticated user identity
 * 4. Fetch installation metadata (via App JWT)
 * 5. Authorization check:
 *    - Org installations: caller must have admin role in the org
 *    - User installations: authenticated login must match installation account
 * 6. Issue setup session token, store in Redis, set as HttpOnly cookie
 * 7. Redirect back to /setup
 */

import { NextRequest, NextResponse } from "next/server";
import { validateEnv } from "@/server/env";
import { getRedisClient } from "@/server/redis";
import {
  exchangeOAuthCode,
  generateAppJwt,
  getAuthenticatedUser,
  getInstallation,
  getUserInstallations,
  checkOrgAdmin,
} from "@/server/github-auth";
import {
  validateOAuthState,
  createSetupSession,
  DISCOVER_SENTINEL,
  OAUTH_STATE_BINDING_COOKIE,
  SETUP_SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "@/server/setup-session";
const OAUTH_STATE_READ_FAILED_CODE = "oauth_state_read_failed";
const SETUP_SESSION_CREATE_FAILED_CODE = "setup_session_create_failed";

function clearOAuthStateBindingCookie(response: NextResponse) {
  response.cookies.set(OAUTH_STATE_BINDING_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
}

export async function GET(request: NextRequest) {
  const env = validateEnv();
  if (!env.ok) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 503 });
  }

  const {
    githubClientId,
    githubClientSecret,
    githubAppId,
    githubAppPrivateKey,
    redisRestUrl,
    redisRestToken,
    siteUrl,
  } = env.config;

  if (!githubClientId || !githubClientSecret || !githubAppId || !githubAppPrivateKey) {
    return NextResponse.json({ error: "GitHub is not configured on this server" }, { status: 503 });
  }
  if (!redisRestUrl || !redisRestToken) {
    return NextResponse.json({ error: "Session storage is not configured" }, { status: 503 });
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const errorParam = searchParams.get("error");
  const oauthStateBinding = request.cookies.get(OAUTH_STATE_BINDING_COOKIE)?.value;
  const redis = getRedisClient(redisRestUrl, redisRestToken);

  // GitHub sends `error=access_denied` when the user cancels
  if (errorParam) {
    const deniedUrl = new URL(`${siteUrl}/setup`);
    deniedUrl.searchParams.set("auth", "denied");

    // Preserve installation context for retry CTA when state+cookie validate.
    // Skip if the state held the discover sentinel — there's no specific installation to preserve.
    if (state) {
      try {
        const deniedInstallationId = await validateOAuthState(state, oauthStateBinding, redis);
        if (deniedInstallationId && deniedInstallationId !== DISCOVER_SENTINEL) {
          deniedUrl.searchParams.set("installation_id", deniedInstallationId);
        }
      } catch {
        // Fall back to a plain denied redirect if state storage is unavailable.
      }
    }

    const deniedResponse = NextResponse.redirect(deniedUrl.toString());
    clearOAuthStateBindingCookie(deniedResponse);
    return deniedResponse;
  }

  if (!code || !state) {
    return NextResponse.json({ error: "Missing code or state" }, { status: 400 });
  }

  // --- Step 1: Validate state (CSRF check) ---
  let installationId: string | null;
  try {
    installationId = await validateOAuthState(state, oauthStateBinding, redis);
  } catch {
    return NextResponse.json(
      { error: "Failed to read OAuth state", code: OAUTH_STATE_READ_FAILED_CODE },
      { status: 503 },
    );
  }
  if (!installationId) {
    const response = NextResponse.json(
      { error: "Invalid or expired OAuth state" },
      { status: 400 },
    );
    clearOAuthStateBindingCookie(response);
    return response;
  }

  let userToken: string;
  try {
    // --- Step 2: Exchange code for user access token ---
    userToken = await exchangeOAuthCode(code, githubClientId, githubClientSecret);
  } catch {
    return NextResponse.json({ error: "Failed to exchange authorization code" }, { status: 502 });
  }

  // --- Step 2b: Discover installation if the user started from the "already installed" flow ---
  if (installationId === DISCOVER_SENTINEL) {
    try {
      const installations = await getUserInstallations(userToken, githubAppId!);
      if (installations.length === 0) {
        const notInstalledUrl = new URL(`${siteUrl}/setup`);
        notInstalledUrl.searchParams.set("auth", "not_installed");
        const response = NextResponse.redirect(notInstalledUrl.toString());
        clearOAuthStateBindingCookie(response);
        return response;
      }
      installationId = String(installations[0].id);
    } catch {
      return NextResponse.json({ error: "Failed to discover installations" }, { status: 502 });
    }
  }

  let user: { login: string; id: number };
  let installation: { account: { login: string; type: string } };

  try {
    // --- Step 3 & 4: Fetch user identity and installation in parallel ---
    const appJwt = generateAppJwt(githubAppId!, githubAppPrivateKey!);
    [user, installation] = await Promise.all([
      getAuthenticatedUser(userToken),
      getInstallation(installationId, appJwt),
    ]);
  } catch {
    return NextResponse.json({ error: "Failed to verify identity" }, { status: 502 });
  }

  // --- Step 5: Authorization check ---
  const accountType = installation.account.type;
  const accountLogin = installation.account.login;

  if (accountType === "Organization") {
    // Org installation: caller must be an org admin
    let isAdmin: boolean;
    try {
      isAdmin = await checkOrgAdmin(userToken, accountLogin);
    } catch {
      return NextResponse.json({ error: "Failed to check org membership" }, { status: 502 });
    }
    if (!isAdmin) {
      const forbiddenUrl = new URL(`${siteUrl}/setup`);
      forbiddenUrl.searchParams.set("installation_id", installationId);
      forbiddenUrl.searchParams.set("auth", "forbidden");
      forbiddenUrl.searchParams.set("reason", "not_org_admin");
      const response = NextResponse.redirect(forbiddenUrl.toString());
      clearOAuthStateBindingCookie(response);
      return response;
    }
  } else {
    // User installation: authenticated user must be the installer
    if (user.login.toLowerCase() !== accountLogin.toLowerCase()) {
      const forbiddenUrl = new URL(`${siteUrl}/setup`);
      forbiddenUrl.searchParams.set("installation_id", installationId);
      forbiddenUrl.searchParams.set("auth", "forbidden");
      forbiddenUrl.searchParams.set("reason", "user_mismatch");
      const response = NextResponse.redirect(forbiddenUrl.toString());
      clearOAuthStateBindingCookie(response);
      return response;
    }
  }

  // --- Step 6: Issue setup session token ---
  let token: string;
  try {
    token = await createSetupSession(
      { installationId, userId: user.id, userLogin: user.login },
      redis,
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to create setup session", code: SETUP_SESSION_CREATE_FAILED_CODE },
      { status: 503 },
    );
  }

  // --- Step 7: Redirect to setup page with session cookie ---
  const successUrl = new URL(`${siteUrl}/setup`);
  successUrl.searchParams.set("installation_id", installationId);
  successUrl.searchParams.set("auth", "ok");
  const response = NextResponse.redirect(successUrl.toString());

  response.cookies.set(SETUP_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  });
  clearOAuthStateBindingCookie(response);

  return response;
}
