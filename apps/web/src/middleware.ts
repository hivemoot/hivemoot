import { type NextRequest, NextResponse } from "next/server";
import { SETUP_SESSION_COOKIE } from "@/constants/cookies";

/**
 * Protect /dashboard from unauthenticated access.
 *
 * The middleware runs at the Edge and can only check cookie presence, not
 * validate the token against Redis. Full token validation happens in the
 * server component for each protected page. This guard prevents the page
 * from rendering for users who have no session token at all.
 *
 * Note: the setup session is short-lived (30 min). Users who return to
 * /dashboard after their session expires will be redirected to /setup.
 * This is expected behavior with the current auth model.
 */
export function middleware(request: NextRequest) {
  const sessionToken = request.cookies.get(SETUP_SESSION_COOKIE)?.value;

  if (!sessionToken) {
    return NextResponse.redirect(new URL("/setup", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Only apply to /dashboard and its sub-paths.
  // Explicit matcher prevents accidental gating of other routes as the app grows.
  matcher: ["/dashboard/:path*"],
};
