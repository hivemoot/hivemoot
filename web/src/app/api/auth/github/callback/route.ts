/**
 * GET /api/auth/github/callback
 *
 * Handles the GitHub OAuth callback after the user authorizes the app.
 *
 * Security sequence:
 * 1. Validate `state` against Redis — reject if unknown/expired (CSRF protection)
 * 2. Exchange `code` for a user access token
 * 2b. If state held the "discover" sentinel, resolve a GitHub App installation
 *     via GET /user/installations. If none exists, create a dashboard-only
 *     user scope so credentials, task execution, and health reporting still work.
 * 3. Fetch authenticated user identity
 * 4. Fetch installation metadata (via App JWT) only for installation-scoped sessions
 * 5. Authorization check for installation-scoped sessions:
 *    - Org installations: caller must have admin role in the org
 *    - User installations: authenticated login must match installation account
 * 6. Issue setup session token, store in Redis, set as HttpOnly cookie
 * 7. Smart redirect: /dashboard if BYOK already configured, otherwise /setup
 *
 * Error paths that occur during a browser-initiated flow redirect to
 * /setup/error with a code param instead of returning raw JSON.
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
  createUserScopeId,
  DISCOVER_SENTINEL,
  isGitHubInstallationScope,
  OAUTH_STATE_BINDING_COOKIE,
  SETUP_SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "@/server/setup-session";
import { REMEMBERED_USER_COOKIE } from "@/constants/cookies";
import { hasByokEnvelope } from "@/server/byok-store";

function clearOAuthStateBindingCookie(response: NextResponse) {
  response.cookies.set(OAUTH_STATE_BINDING_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
}

function setupErrorRedirect(
  siteUrl: string,
  code: string,
  installationId?: string | null,
): NextResponse {
  const url = new URL(`${siteUrl}/setup/error`);
  url.searchParams.set("code", code);
  if (installationId) url.searchParams.set("installation_id", installationId);
  return NextResponse.redirect(url.toString());
}

function setupErrorInstallationParam(installationId: string): string | undefined {
  return isGitHubInstallationScope(installationId) ? installationId : undefined;
}

export async function GET(request: NextRequest) {
  const env = validateEnv();
  if (!env.ok) {
    // Can't construct absolute URL without siteUrl — use request origin as fallback
    const origin = new URL(request.url).origin;
    const url = new URL(`${origin}/setup/error`);
    url.searchParams.set("code", "server_misconfiguration");
    return NextResponse.redirect(url.toString());
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
    return setupErrorRedirect(siteUrl, "server_misconfiguration");
  }
  if (!redisRestUrl || !redisRestToken) {
    return setupErrorRedirect(siteUrl, "server_misconfiguration");
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
        const deniedResult = await validateOAuthState(state, oauthStateBinding, redis);
        if (deniedResult && isGitHubInstallationScope(deniedResult.installationId)) {
          deniedUrl.searchParams.set("installation_id", deniedResult.installationId);
        }
      } catch (err) {
        console.warn("[oauth-callback] Failed to validate state during denied flow", { error: err });
      }
    }

    const deniedResponse = NextResponse.redirect(deniedUrl.toString());
    clearOAuthStateBindingCookie(deniedResponse);
    return deniedResponse;
  }

  if (!code || !state) {
    // Malformed callback — redirect to setup root
    return NextResponse.redirect(new URL(`${siteUrl}/setup`).toString());
  }

  // --- Step 1: Validate state (CSRF check) ---
  let installationId: string;
  let oauthNext: string | undefined;
  try {
    const stateResult = await validateOAuthState(state, oauthStateBinding, redis);
    if (!stateResult) {
      const expiredUrl = new URL(`${siteUrl}/setup`);
      expiredUrl.searchParams.set("auth", "expired");
      const response = NextResponse.redirect(expiredUrl.toString());
      clearOAuthStateBindingCookie(response);
      return response;
    }
    installationId = stateResult.installationId;
    oauthNext = stateResult.next;
  } catch (err) {
    console.error("[oauth-callback] Failed to validate OAuth state", { error: err });
    const errResponse = setupErrorRedirect(siteUrl, "oauth_state_read_failed");
    clearOAuthStateBindingCookie(errResponse);
    return errResponse;
  }

  let userToken: string;
  try {
    // --- Step 2: Exchange code for user access token ---
    userToken = await exchangeOAuthCode(code, githubClientId, githubClientSecret);
  } catch (err) {
    console.error("[oauth-callback] Failed to exchange OAuth code", { error: err });
    const errResponse = setupErrorRedirect(
      siteUrl,
      "server_error",
      setupErrorInstallationParam(installationId),
    );
    clearOAuthStateBindingCookie(errResponse);
    return errResponse;
  }

  let user: { login: string; id: number } | null = null;
  let installation: { account: { login: string; type: string } } | null = null;

  // --- Step 2b: Discover installation if the user started from the discovery flow ---
  if (installationId === DISCOVER_SENTINEL) {
    try {
      const [authenticatedUser, installations] = await Promise.all([
        getAuthenticatedUser(userToken),
        getUserInstallations(userToken, githubAppId!),
      ]);
      user = authenticatedUser;
      if (installations.length === 0) {
        installationId = createUserScopeId(user.id);
      } else {
        installationId = String(installations[0].id);
      }
    } catch (err) {
      console.error("[oauth-callback] Failed to discover user installations", { error: err });
      const errResponse = setupErrorRedirect(siteUrl, "server_error");
      clearOAuthStateBindingCookie(errResponse);
      return errResponse;
    }
  }

  if (isGitHubInstallationScope(installationId)) {
    try {
      // --- Step 3 & 4: Fetch user identity and installation metadata ---
      const appJwt = generateAppJwt(githubAppId!, githubAppPrivateKey!);
      if (user) {
        installation = await getInstallation(installationId, appJwt);
      } else {
        [user, installation] = await Promise.all([
          getAuthenticatedUser(userToken),
          getInstallation(installationId, appJwt),
        ]);
      }
    } catch (err) {
      console.error("[oauth-callback] Failed to fetch user/installation", { installationId, error: err });
      const errResponse = setupErrorRedirect(siteUrl, "server_error", installationId);
      clearOAuthStateBindingCookie(errResponse);
      return errResponse;
    }
    if (!user || !installation) {
      console.error("[oauth-callback] Missing user or installation after GitHub lookup", { installationId });
      const errResponse = setupErrorRedirect(siteUrl, "server_error", installationId);
      clearOAuthStateBindingCookie(errResponse);
      return errResponse;
    }

    // --- Step 5: Authorization check ---
    const accountType = installation.account.type;
    const accountLogin = installation.account.login;

    if (accountType === "Organization") {
      // Org installation: caller must be an org admin
      let isAdmin: boolean;
      try {
        isAdmin = await checkOrgAdmin(userToken, accountLogin);
      } catch (err) {
        console.error("[oauth-callback] Failed to check org admin status", { accountLogin, error: err });
        const errResponse = setupErrorRedirect(siteUrl, "server_error", installationId);
        clearOAuthStateBindingCookie(errResponse);
        return errResponse;
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
  }

  if (!user) {
    console.error("[oauth-callback] Missing authenticated user after OAuth callback", { installationId });
    const errResponse = setupErrorRedirect(
      siteUrl,
      "server_error",
      setupErrorInstallationParam(installationId),
    );
    clearOAuthStateBindingCookie(errResponse);
    return errResponse;
  }

  // --- Step 6: Issue setup session token ---
  let token: string;
  try {
    token = await createSetupSession(
      { installationId, userId: user.id, userLogin: user.login },
      redis,
    );
  } catch (err) {
    console.error("[oauth-callback] Failed to create setup session", { installationId, error: err });
    const errResponse = setupErrorRedirect(siteUrl, "setup_session_create_failed", installationId);
    clearOAuthStateBindingCookie(errResponse);
    return errResponse;
  }

  // --- Step 7: Smart redirect based on setup completion ---
  // Returning users who already configured BYOK go straight to the dashboard
  // (or the `next` URL from OAuth state if present and safe).
  // New users (or failed checks) go to the setup wizard.
  let setupComplete = false;
  try {
    setupComplete = await hasByokEnvelope(installationId, redis);
  } catch (err) {
    console.warn("[oauth-callback] BYOK check failed, defaulting to setup wizard", {
      installationId,
      error: err,
    });
  }

  let successUrl: URL;
  if (setupComplete) {
    const destination = oauthNext ?? "/dashboard";
    successUrl = new URL(`${siteUrl}${destination}`);
  } else if (oauthNext) {
    successUrl = new URL(`${siteUrl}${oauthNext}`);
  } else if (isGitHubInstallationScope(installationId)) {
    successUrl = new URL(`${siteUrl}/setup`);
    successUrl.searchParams.set("installation_id", installationId);
    successUrl.searchParams.set("auth", "ok");
  } else {
    successUrl = new URL(`${siteUrl}/dashboard/credentials`);
  }
  const response = NextResponse.redirect(successUrl.toString());

  response.cookies.set(SETUP_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  });

  // Remember the authenticated user for 30 days so the landing page can show
  // a "Continue as @username" shortcut on return visits. Not httpOnly because
  // the landing page reads it client-side to stay statically rendered. The
  // value is a public GitHub login — no credentials.
  response.cookies.set(REMEMBERED_USER_COOKIE, user.login, {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
  });

  clearOAuthStateBindingCookie(response);

  return response;
}
