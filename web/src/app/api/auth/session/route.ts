/**
 * GET /api/auth/session — cookie-session status probe for auth-aware UI.
 *
 * The landing page is statically generated and its nav reads this endpoint
 * client-side to decide whether to show "Sign in / Get Started" vs
 * "Dashboard / account". It reads the HttpOnly `setup_session` cookie and
 * validates it against Redis (mere cookie presence is not enough — the
 * session can be expired/revoked).
 *
 * Always returns 200. On a missing/invalid session OR any infra error it
 * returns the logged-out shape, so a Redis blip degrades the public nav to
 * "signed out" rather than throwing on the busiest page. The real
 * `/dashboard` still validates the session server-side, so this endpoint is
 * not a security boundary — only a UI hint.
 *
 * Never returns the raw installationId or any credential — only the public
 * GitHub login plus a boolean for whether an installation is attached.
 */

import { NextRequest, NextResponse } from "next/server";
import { validateEnv } from "@/server/env";
import { getRedisClient } from "@/server/redis";
import { getSetupSession, SETUP_SESSION_COOKIE } from "@/server/setup-session";

export const dynamic = "force-dynamic";

interface SessionStatus {
  authenticated: boolean;
  login: string | null;
  hasInstallation: boolean;
}

const LOGGED_OUT: SessionStatus = {
  authenticated: false,
  login: null,
  hasInstallation: false,
};

function statusResponse(body: SessionStatus): NextResponse {
  // no-store: this is per-user and must never be cached by the CDN that
  // serves the static landing page.
  return NextResponse.json(body, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(SETUP_SESSION_COOKIE)?.value;
  if (!token) return statusResponse(LOGGED_OUT);

  const env = validateEnv();
  if (!env.ok || !env.config.redisRestUrl || !env.config.redisRestToken) {
    // Fail closed to "logged out" — keeps the nav resilient when Redis/env
    // is unavailable instead of 500-ing the public page.
    return statusResponse(LOGGED_OUT);
  }

  try {
    const redis = getRedisClient(env.config.redisRestUrl, env.config.redisRestToken);
    const session = await getSetupSession(token, redis);
    if (!session) return statusResponse(LOGGED_OUT);

    return statusResponse({
      authenticated: true,
      login: session.userLogin,
      hasInstallation: session.installationId !== null,
    });
  } catch (err) {
    console.warn("[auth/session] status check failed; reporting logged out", err);
    return statusResponse(LOGGED_OUT);
  }
}
