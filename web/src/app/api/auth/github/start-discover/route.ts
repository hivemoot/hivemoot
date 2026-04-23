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
  SETUP_SESSION_COOKIE,
  getSetupSession,
} from "@/server/setup-session";
import { hasByokEnvelope } from "@/server/byok-store";
import { buildOAuthAuthorizeUrl, getOAuthStateCookieOptions, isSafeNextPath } from "@/server/github-auth";

const OAUTH_STATE_STORE_FAILED_CODE = "oauth_state_store_failed";

export async function GET(request: NextRequest) {
  const env = validateEnv();
  if (!env.ok) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 503 });
  }

  const { githubClientId, githubClientSecret, redisRestUrl, redisRestToken, siteUrl } = env.config;

  if (!githubClientId || !githubClientSecret) {
    return NextResponse.json(
      { error: "GitHub OAuth is not configured on this server" },
      { status: 503 },
    );
  }
  if (!redisRestUrl || !redisRestToken) {
    return NextResponse.json(
      { error: "Session storage is not configured on this server" },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const force = searchParams.get("force");
  const nextParam = searchParams.get("next");
  const safeNext = nextParam && isSafeNextPath(nextParam) ? nextParam : undefined;

  const redis = getRedisClient(redisRestUrl, redisRestToken);

  // Fast-path: if the user already has a valid session and isn't forcing re-auth,
  // skip OAuth and redirect directly to the dashboard or setup.
  if (force !== "1") {
    const existingToken = request.cookies.get(SETUP_SESSION_COOKIE)?.value;
    if (existingToken) {
      try {
        const session = await getSetupSession(existingToken, redis);
        if (session) {
          let destination = safeNext ?? "/dashboard";
          if (destination === "/dashboard") {
            // Verify BYOK to determine correct landing page.
            let setupComplete = false;
            try {
              setupComplete = await hasByokEnvelope(session.installationId, redis);
            } catch {
              // Fall through to dashboard on BYOK check failure.
            }
            if (!setupComplete) {
              destination = `/setup?installation_id=${encodeURIComponent(session.installationId)}&auth=ok`;
            }
          }
          return NextResponse.redirect(new URL(`${siteUrl}${destination}`).toString());
        }
      } catch {
        // Session check failed — fall through to OAuth flow.
      }
    }
  }

  let stateRecord: { state: string; stateBinding: string };
  try {
    stateRecord = await createOAuthState(DISCOVER_SENTINEL, redis, safeNext);
  } catch {
    return NextResponse.json(
      { error: "Failed to store OAuth state", code: OAUTH_STATE_STORE_FAILED_CODE },
      { status: 503 },
    );
  }

  const callbackUrl = `${siteUrl}/api/auth/github/callback`;
  const authorizeUrl = buildOAuthAuthorizeUrl(githubClientId, callbackUrl, stateRecord.state);

  const response = NextResponse.redirect(authorizeUrl.toString());
  response.cookies.set(OAUTH_STATE_BINDING_COOKIE, stateRecord.stateBinding, getOAuthStateCookieOptions());

  return response;
}
