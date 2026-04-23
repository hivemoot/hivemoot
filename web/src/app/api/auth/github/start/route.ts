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
 *
 * All error paths that occur during a browser-initiated flow redirect to
 * /setup/error with a code param instead of returning raw JSON.
 */

import { NextRequest, NextResponse } from "next/server";
import { validateEnv } from "@/server/env";
import { getRedisClient } from "@/server/redis";
import { createOAuthState, OAUTH_STATE_BINDING_COOKIE } from "@/server/setup-session";
import { buildOAuthAuthorizeUrl, getOAuthStateCookieOptions, isSafeNextPath } from "@/server/github-auth";

function setupErrorRedirect(
  request: NextRequest,
  code: string,
  installationId?: string,
): NextResponse {
  const url = new URL("/setup/error", request.url);
  url.searchParams.set("code", code);
  if (installationId) url.searchParams.set("installation_id", installationId);
  return NextResponse.redirect(url.toString());
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const installationId = searchParams.get("installation_id") ?? undefined;
  const nextParam = searchParams.get("next");
  const safeNext = nextParam && isSafeNextPath(nextParam) ? nextParam : undefined;

  const env = validateEnv();
  if (!env.ok) {
    return setupErrorRedirect(request, "server_misconfiguration", installationId);
  }

  const { githubClientId, githubClientSecret, redisRestUrl, redisRestToken, siteUrl } = env.config;

  if (!githubClientId || !githubClientSecret) {
    return setupErrorRedirect(request, "server_misconfiguration", installationId);
  }
  if (!redisRestUrl || !redisRestToken) {
    return setupErrorRedirect(request, "server_misconfiguration", installationId);
  }

  if (!installationId || !/^\d+$/.test(installationId)) {
    // Missing installation_id is a malformed link — redirect to setup root without an id
    return NextResponse.redirect(new URL("/setup", request.url).toString());
  }

  const redis = getRedisClient(redisRestUrl, redisRestToken);

  let stateRecord: { state: string; stateBinding: string };
  try {
    stateRecord = await createOAuthState(installationId, redis, safeNext);
  } catch (err) {
    console.error("[oauth-start] Failed to store OAuth state", { installationId, error: err });
    return setupErrorRedirect(request, "oauth_state_store_failed", installationId);
  }

  const callbackUrl = `${siteUrl}/api/auth/github/callback`;
  const authorizeUrl = buildOAuthAuthorizeUrl(githubClientId, callbackUrl, stateRecord.state);

  const response = NextResponse.redirect(authorizeUrl.toString());
  response.cookies.set(OAUTH_STATE_BINDING_COOKIE, stateRecord.stateBinding, getOAuthStateCookieOptions());
  return response;
}
