/**
 * POST /api/auth/logout — sign the user out.
 *
 * Clears the HttpOnly `setup_session` cookie and the `hm_remembered_user`
 * hint cookie, and best-effort revokes the session in Redis so the token
 * cannot be replayed. POST + same-origin only, so a third-party page cannot
 * force-log-out the user via a drive-by request (logout CSRF).
 *
 * Fallback behavior: if Redis revocation fails, the cookies are still
 * cleared (the user IS signed out in the browser); the server-side session
 * simply lingers until its ≤24h TTL. We clear-first intent over strict
 * revocation because the user's explicit action is "sign me out here".
 */

import { NextRequest, NextResponse } from "next/server";
import { validateEnv } from "@/server/env";
import { getRedisClient } from "@/server/redis";
import { deleteSetupSession, SETUP_SESSION_COOKIE } from "@/server/setup-session";
import { REMEMBERED_USER_COOKIE } from "@/constants/cookies";

export const dynamic = "force-dynamic";

function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser / same-origin form posts omit Origin
  return origin === new URL(request.url).origin;
}

function clearAuthCookies(response: NextResponse): void {
  const secure = process.env.NODE_ENV === "production";
  response.cookies.set(SETUP_SESSION_COOKIE, "", {
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  response.cookies.set(REMEMBERED_USER_COOKIE, "", {
    secure,
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return NextResponse.json(
      { code: "forbidden", message: "Cross-origin logout is not allowed" },
      { status: 403 },
    );
  }

  const token = request.cookies.get(SETUP_SESSION_COOKIE)?.value;
  if (token) {
    const env = validateEnv();
    if (env.ok && env.config.redisRestUrl && env.config.redisRestToken) {
      try {
        const redis = getRedisClient(env.config.redisRestUrl, env.config.redisRestToken);
        await deleteSetupSession(token, redis);
      } catch (err) {
        // Cookies are still cleared below — the lingering Redis session
        // expires within its TTL. See the file-level fallback note.
        console.warn("[auth/logout] redis session revoke failed; cookies cleared anyway", err);
      }
    }
  }

  const response = NextResponse.json(
    { ok: true },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
  clearAuthCookies(response);
  return response;
}
