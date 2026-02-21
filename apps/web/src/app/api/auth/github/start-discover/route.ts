/**
 * GET /api/auth/github/start-discover
 *
 * Initiates the GitHub OAuth flow for the "already installed" discovery path.
 *
 * Unlike /api/auth/github/start, this route does NOT require an installation_id.
 * It stores a "discover" sentinel in the OAuth state. After the user authorizes,
 * the callback detects the sentinel and resolves the real installation_id via
 * GET /user/installations.
 */

import { NextRequest, NextResponse } from "next/server";
import { validateEnv } from "@/server/env";
import { getRedisClient } from "@/server/redis";
import {
  createOAuthState,
  DISCOVER_SENTINEL,
  OAUTH_STATE_BINDING_COOKIE,
} from "@/server/setup-session";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const OAUTH_STATE_STORE_FAILED_CODE = "oauth_state_store_failed";
const OAUTH_STATE_COOKIE_MAX_AGE = 600;

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

  const redis = getRedisClient(redisUrl);

  let stateRecord: { state: string; stateBinding: string };
  try {
    stateRecord = await createOAuthState(DISCOVER_SENTINEL, redis);
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
  authorizeUrl.searchParams.set("scope", "read:org");

  const response = NextResponse.redirect(authorizeUrl.toString());
  response.cookies.set(OAUTH_STATE_BINDING_COOKIE, stateRecord.stateBinding, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: OAUTH_STATE_COOKIE_MAX_AGE,
    path: "/",
  });

  // Suppress Next.js static rendering check — request param is used
  // only to satisfy the dynamic route handler signature.
  void request;

  return response;
}
