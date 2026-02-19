/**
 * GET /api/auth/github/callback
 *
 * Handles the GitHub OAuth callback after the user authorizes the app.
 *
 * Security sequence:
 * 1. Validate `state` against Redis — reject if unknown/expired (CSRF protection)
 * 2. Exchange `code` for a user access token
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
  checkOrgAdmin,
} from "@/server/github-auth";
import { validateOAuthState, createSetupSession } from "@/server/setup-session";

/** Cookie name for the short-lived setup session token */
export const SETUP_SESSION_COOKIE = "setup_session";

/** How long the session cookie lives in the browser (matches Redis TTL) */
const SESSION_COOKIE_MAX_AGE = 600; // 10 minutes

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
    redisUrl,
    siteUrl,
  } = env.config;

  if (!githubClientId || !githubClientSecret || !githubAppId || !githubAppPrivateKey) {
    return NextResponse.json({ error: "GitHub is not configured on this server" }, { status: 503 });
  }
  if (!redisUrl) {
    return NextResponse.json({ error: "Session storage is not configured" }, { status: 503 });
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const errorParam = searchParams.get("error");

  // GitHub sends `error=access_denied` when the user cancels
  if (errorParam) {
    return NextResponse.redirect(`${siteUrl}/setup?auth=denied`);
  }

  if (!code || !state) {
    return NextResponse.json({ error: "Missing code or state" }, { status: 400 });
  }

  const redis = getRedisClient(redisUrl);

  // --- Step 1: Validate state (CSRF check) ---
  const installationId = await validateOAuthState(state, redis);
  if (!installationId) {
    return NextResponse.json(
      { error: "Invalid or expired OAuth state" },
      { status: 400 },
    );
  }

  let userToken: string;
  try {
    // --- Step 2: Exchange code for user access token ---
    userToken = await exchangeOAuthCode(code, githubClientId, githubClientSecret);
  } catch {
    return NextResponse.json({ error: "Failed to exchange authorization code" }, { status: 502 });
  }

  let user: { login: string; id: number };
  let installation: { account: { login: string; type: string } };

  try {
    // --- Step 3 & 4: Fetch user identity and installation in parallel ---
    const appJwt = generateAppJwt(githubAppId, githubAppPrivateKey);
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
      return NextResponse.redirect(
        `${siteUrl}/setup?installation_id=${installationId}&auth=forbidden&reason=not_org_admin`,
      );
    }
  } else {
    // User installation: authenticated user must be the installer
    if (user.login.toLowerCase() !== accountLogin.toLowerCase()) {
      return NextResponse.redirect(
        `${siteUrl}/setup?installation_id=${installationId}&auth=forbidden&reason=user_mismatch`,
      );
    }
  }

  // --- Step 6: Issue setup session token ---
  const token = await createSetupSession(
    { installationId, userId: user.id, userLogin: user.login },
    redis,
  );

  // --- Step 7: Redirect to setup page with session cookie ---
  const redirectUrl = `${siteUrl}/setup?installation_id=${installationId}&auth=ok`;
  const response = NextResponse.redirect(redirectUrl);

  response.cookies.set(SETUP_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_COOKIE_MAX_AGE,
    path: "/",
  });

  return response;
}
