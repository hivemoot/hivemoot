/**
 * Cookie name constants shared between server code and Edge middleware.
 *
 * This file is intentionally free of Node.js built-ins and Redis imports
 * so it can be safely imported from Next.js Edge middleware, which runs
 * outside the Node.js runtime.
 */

/** Cookie name for the short-lived setup session token. */
export const SETUP_SESSION_COOKIE = "setup_session";

/** Browser binding cookie for OAuth state CSRF protection. */
export const OAUTH_STATE_BINDING_COOKIE = "oauth_state_binding";

/**
 * Long-lived cookie that remembers the last successfully authenticated
 * GitHub username. Contains only the public login string — no credentials.
 * Used by the landing page to show a "Continue as @username" shortcut.
 */
export const REMEMBERED_USER_COOKIE = "hm_remembered_user";

/**
 * GitHub login regex: alphanumeric + hyphens, 1–39 chars, no leading/trailing
 * hyphen. Used to validate the remembered-user cookie before any DOM or URL use
 * to prevent cookie-injection attacks.
 */
export const GITHUB_LOGIN_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9-]{0,37}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;
