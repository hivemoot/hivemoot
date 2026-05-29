/**
 * Pure helpers for auth-aware navigation, shared by the landing nav, the
 * hero CTAs, and the dashboard account menu. Kept free of React/DOM so the
 * decision logic is exhaustively unit-testable.
 */

/** Wire shape of GET /api/auth/session. */
export interface SessionStatus {
  authenticated: boolean;
  login: string | null;
  hasInstallation: boolean;
}

export const LOGGED_OUT_STATUS: SessionStatus = {
  authenticated: false,
  login: null,
  hasInstallation: false,
};

/**
 * Defensively parse an unknown /api/auth/session payload. Anything that
 * doesn't match the expected shape is treated as logged out — a malformed
 * response must never be read as "authenticated".
 */
export function parseSessionStatus(raw: unknown): SessionStatus {
  if (!raw || typeof raw !== "object") return LOGGED_OUT_STATUS;
  const obj = raw as Record<string, unknown>;
  if (obj.authenticated !== true) return LOGGED_OUT_STATUS;
  return {
    authenticated: true,
    login: typeof obj.login === "string" ? obj.login : null,
    hasInstallation: obj.hasInstallation === true,
  };
}

/** Resolved navigation model the UI renders from. */
export type NavState =
  | { kind: "loading" }
  // Currently signed in (valid server session).
  | { kind: "authenticated"; login: string | null; hasInstallation: boolean }
  // Not signed in, but we remember the last login — offer a one-tap re-auth.
  | { kind: "remembered"; login: string }
  // Never seen this browser sign in.
  | { kind: "anonymous" };

/**
 * Collapse the raw auth inputs into the single state the components switch on.
 *
 * Precedence: while the session probe is in flight we render `loading` (which
 * the components map to the signed-out default, matching SSR to avoid a
 * hydration mismatch). A valid session always wins; otherwise a remembered
 * login downgrades to a "continue as" affordance; otherwise anonymous.
 */
export function resolveNavState(args: {
  loading: boolean;
  authenticated: boolean;
  login: string | null;
  hasInstallation: boolean;
  remembered: string | null;
}): NavState {
  if (args.loading) return { kind: "loading" };
  if (args.authenticated) {
    return { kind: "authenticated", login: args.login, hasInstallation: args.hasInstallation };
  }
  if (args.remembered) return { kind: "remembered", login: args.remembered };
  return { kind: "anonymous" };
}

/** Fetch + parse the current session status. Never throws shape errors. */
export async function fetchSessionStatus(): Promise<SessionStatus> {
  const res = await fetch("/api/auth/session", {
    method: "GET",
    headers: { Accept: "application/json" },
    // same-origin sends the HttpOnly session cookie; never cache.
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) return LOGGED_OUT_STATUS;
  return parseSessionStatus(await res.json());
}

/** Sign out, then hard-navigate home. Exposed for the account menu. */
export async function signOutAndGoHome(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  } catch {
    // Even if the request fails, fall through to the redirect — the user
    // asked to leave. The next page load re-probes the (still-valid) session.
  }
  window.location.assign("/");
}
