/**
 * GET /api/auth/github/start
 *
 * Initiates the GitHub OAuth flow for a given installation.
 *
 * Expects: ?installation_id=<numeric id>
 *
 * - Validates the installation_id is present
 * - Generates a cryptographically random state nonce bound to the installation
 * - Stores the state in Redis with a 10-minute TTL
 * - Redirects the browser to GitHub's OAuth authorization URL
 */

import { NextRequest, NextResponse } from "next/server";
import { validateEnv } from "@/server/env";
import { getRedisClient } from "@/server/redis";
import { createOAuthState, OAUTH_STATE_BINDING_COOKIE } from "@/server/setup-session";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const OAUTH_STATE_STORE_FAILED_CODE = "oauth_state_store_failed";
const OAUTH_STATE_COOKIE_MAX_AGE = 600; // 10 minutes, aligned with Redis state TTL

export async function GET(request: NextRequest) {
  const env = validateEnv();
  if (!env.ok) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 503 });
  }

  const { githubClientId, githubClientSecret, redisUrl, siteUrl } = env.config;

  if (!githubClientId || !githubClientSecret) {
    return NextResponse.json(
      { error: "GitHub OAuth is not configured on this server" },
      { status: 503 },
    );
  }
  if (!redisUrl) {
    return NextResponse.json(
      { error: "Session storage is not configured on this server" },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const installationId = searchParams.get("installation_id");

  if (!installationId || !/^\d+$/.test(installationId)) {
    return NextResponse.json(
      { error: "Missing or invalid installation_id" },
      { status: 400 },
    );
  }

  const redis = getRedisClient(redisUrl);

  let stateRecord: { state: string; stateBinding: string };
  try {
    stateRecord = await createOAuthState(installationId, redis);
  } catch {
    return NextResponse.json(
      { error: "Failed to store OAuth state", code: OAUTH_STATE_STORE_FAILED_CODE },
      { status: 503 },
    );
  }

  const callbackUrl = `${siteUrl}/api/auth/github/callback`;
  const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", githubClientId);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
  authorizeUrl.searchParams.set("state", stateRecord.state);
  // Request minimum scopes: we only need to read org membership
  authorizeUrl.searchParams.set("scope", "read:org");

  const response = NextResponse.redirect(authorizeUrl.toString());
  response.cookies.set(OAUTH_STATE_BINDING_COOKIE, stateRecord.stateBinding, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: OAUTH_STATE_COOKIE_MAX_AGE,
    path: "/",
  });
  return response;
}
